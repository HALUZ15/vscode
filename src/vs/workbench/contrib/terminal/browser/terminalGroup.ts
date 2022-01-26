/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TERMINAL_VIEW_ID } from 'vs/workbench/contrib/terminal/common/terminal';
import { Event, Emitter } from 'vs/base/common/event';
import { IDisposable, Disposable, DisposableStore, dispose } from 'vs/base/common/lifecycle';
import { SplitView, Orientation, IView, Sizing } from 'vs/base/browser/ui/splitview/splitview';
import { IWorkbenchLayoutService, Parts } from 'vs/workbench/services/layout/browser/layoutService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITerminalInstance, Direction, ITerminalGroup, ITerminalService, ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ViewContainerLocation, IViewDescriptorService } from 'vs/workbench/common/views';
import { IShellLaunchConfig, ITerminalTabLayoutInfoById } from 'vs/platform/terminal/common/terminal';
import { TerminalStatus } from 'vs/workbench/contrib/terminal/browser/terminalStatusList';

const SPLIT_PANE_MIN_SIZE = 120;

class SplitPaneContainer extends Disposable {
	private _height: number;
	private _width: number;
	private _splitView!: SplitView;
	private readonly _splitViewDisposables = this._register(new DisposableStore());
	private _children: SplitPane[] = [];
	private _terminalToPane: Map<ITerminalInstance, SplitPane> = new Map();

	private _onDidChange: Event<number | undefined> = Event.None;
	get onDidChange(): Event<number | undefined> { return this._onDidChange; }

	constructor(
		private _container: HTMLElement,
		public orientation: Orientation,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService
	) {
		super();
		this._width = this._container.offsetWidth;
		this._height = this._container.offsetHeight;
		this._createSplitView();
		this._splitView.layout(this.orientation === Orientation.HORIZONTAL ? this._width : this._height);
	}

	private _createSplitView(): void {
		this._splitView = new SplitView(this._container, { orientation: this.orientation });
		this._splitViewDisposables.clear();
		this._splitViewDisposables.add(this._splitView.onDidSashReset(() => this._splitView.distributeViewSizes()));
	}

	split(instance: ITerminalInstance, index: number): void {
		this._addChild(instance, index);
	}

	resizePane(index: number, direction: Direction, amount: number): void {
		const isHorizontal = (direction === Direction.Left) || (direction === Direction.Right);

		if ((isHorizontal && this.orientation !== Orientation.HORIZONTAL) ||
			(!isHorizontal && this.orientation !== Orientation.VERTICAL)) {
			// Resize the entire pane as a whole
			if ((this.orientation === Orientation.HORIZONTAL && direction === Direction.Down) ||
				(this.orientation === Orientation.VERTICAL && direction === Direction.Right)) {
				amount *= -1;
			}
			this._layoutService.resizePart(Parts.PANEL_PART, amount, amount);
			return;
		}

		// Resize left/right in horizontal or up/down in vertical
		// Only resize when there is more than one pane
		if (this._children.length <= 1) {
			return;
		}

		// Get sizes
		const sizes: number[] = [];
		for (let i = 0; i < this._splitView.length; i++) {
			sizes.push(this._splitView.getViewSize(i));
		}

		// Remove size from right pane, unless index is the last pane in which case use left pane
		const isSizingEndPane = index !== this._children.length - 1;
		const indexToChange = isSizingEndPane ? index + 1 : index - 1;
		if (isSizingEndPane && direction === Direction.Left) {
			amount *= -1;
		} else if (!isSizingEndPane && direction === Direction.Right) {
			amount *= -1;
		} else if (isSizingEndPane && direction === Direction.Up) {
			amount *= -1;
		} else if (!isSizingEndPane && direction === Direction.Down) {
			amount *= -1;
		}

		// Ensure the size is not reduced beyond the minimum, otherwise weird things can happen
		if (sizes[index] + amount < SPLIT_PANE_MIN_SIZE) {
			amount = SPLIT_PANE_MIN_SIZE - sizes[index];
		} else if (sizes[indexToChange] - amount < SPLIT_PANE_MIN_SIZE) {
			amount = sizes[indexToChange] - SPLIT_PANE_MIN_SIZE;
		}

		// Apply the size change
		sizes[index] += amount;
		sizes[indexToChange] -= amount;
		for (let i = 0; i < this._splitView.length - 1; i++) {
			this._splitView.resizeView(i, sizes[i]);
		}
	}

	resizePanes(relativeSizes: number[]): void {
		if (this._children.length <= 1) {
			return;
		}

		// assign any extra size to last terminal
		relativeSizes[relativeSizes.length - 1] += 1 - relativeSizes.reduce((totalValue, currentValue) => totalValue + currentValue, 0);
		let totalSize = 0;
		for (let i = 0; i < this._splitView.length; i++) {
			totalSize += this._splitView.getViewSize(i);
		}
		for (let i = 0; i < this._splitView.length; i++) {
			this._splitView.resizeView(i, totalSize * relativeSizes[i]);
		}
	}

	getRelativePaneSize(instance: ITerminalInstance): number {
		const paneForInstance = this._terminalToPane.get(instance);
		if (!paneForInstance) {
			return 0;
		}
		return ((this.orientation === Orientation.HORIZONTAL ? paneForInstance.element.clientWidth : paneForInstance.element.clientHeight) / (this.orientation === Orientation.HORIZONTAL ? this._width : this._height));
	}

	private _addChild(instance: ITerminalInstance, index: number): void {
		const child = new SplitPane(instance, this.orientation === Orientation.HORIZONTAL ? this._height : this._width);
		child.orientation = this.orientation;
		if (typeof index === 'number') {
			this._children.splice(index, 0, child);
		} else {
			this._children.push(child);
		}
		this._terminalToPane.set(instance, this._children[this._children.indexOf(child)]);

		this._withDisabledLayout(() => this._splitView.addView(child, Sizing.Distribute, index));
		this.layout(this._width, this._height);

		this._onDidChange = Event.any(...this._children.map(c => c.onDidChange));
	}

	remove(instance: ITerminalInstance): void {
		let index: number | null = null;
		for (let i = 0; i < this._children.length; i++) {
			if (this._children[i].instance === instance) {
				index = i;
			}
		}
		if (index !== null) {
			this._children.splice(index, 1);
			this._terminalToPane.delete(instance);
			this._splitView.removeView(index, Sizing.Distribute);
			instance.detachFromElement();
		}
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		if (this.orientation === Orientation.HORIZONTAL) {
			this._children.forEach(c => c.orthogonalLayout(height));
			this._splitView.layout(width);
		} else {
			this._children.forEach(c => c.orthogonalLayout(width));
			this._splitView.layout(height);
		}
	}

	setOrientation(orientation: Orientation): void {
		if (this.orientation === orientation) {
			return;
		}
		this.orientation = orientation;

		// Remove old split view
		while (this._container.children.length > 0) {
			this._container.removeChild(this._container.children[0]);
		}
		this._splitViewDisposables.clear();
		this._splitView.dispose();

		// Create new split view with updated orientation
		this._createSplitView();
		this._withDisabledLayout(() => {
			this._children.forEach(child => {
				child.orientation = orientation;
				this._splitView.addView(child, 1);
			});
		});
	}

	private _withDisabledLayout(innerFunction: () => void): void {
		// Whenever manipulating views that are going to be changed immediately, disabling
		// layout/resize events in the terminal prevent bad dimensions going to the pty.
		this._children.forEach(c => c.instance.disableLayout = true);
		innerFunction();
		this._children.forEach(c => c.instance.disableLayout = false);
	}
}

class SplitPane implements IView {
	minimumSize: number = SPLIT_PANE_MIN_SIZE;
	maximumSize: number = Number.MAX_VALUE;

	orientation: Orientation | undefined;

	private _onDidChange: Event<number | undefined> = Event.None;
	get onDidChange(): Event<number | undefined> { return this._onDidChange; }

	readonly element: HTMLElement;

	constructor(
		readonly instance: ITerminalInstance,
		public orthogonalSize: number
	) {
		this.element = document.createElement('div');
		this.element.className = 'terminal-split-pane';
		this.instance.attachToElement(this.element);
	}

	layout(size: number): void {
		// Only layout when both sizes are known
		if (!size || !this.orthogonalSize) {
			return;
		}

		if (this.orientation === Orientation.VERTICAL) {
			this.instance.layout({ width: this.orthogonalSize, height: size });
		} else {
			this.instance.layout({ width: size, height: this.orthogonalSize });
		}
	}

	orthogonalLayout(size: number): void {
		this.orthogonalSize = size;
	}
}

export class TerminalGroup extends Disposable implements ITerminalGroup {
	private _terminalInstances: ITerminalInstance[] = [];
	private _splitPaneContainer: SplitPaneContainer | undefined;
	private _groupElement: HTMLElement | undefined;
	private _terminalLocation: ViewContainerLocation = ViewContainerLocation.Panel;
	private _instanceDisposables: Map<number, IDisposable[]> = new Map();

	private _activeInstanceIndex: number = -1;
	private _isVisible: boolean = false;

	get terminalInstances(): ITerminalInstance[] { return this._terminalInstances; }

	private _initialRelativeSizes: number[] | undefined;

	private readonly _onDidDisposeInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidDisposeInstance = this._onDidDisposeInstance.event;
	private readonly _onDidFocusInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidFocusInstance = this._onDidFocusInstance.event;
	private readonly _onDidChangeInstanceCapability: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidChangeInstanceCapability = this._onDidChangeInstanceCapability.event;
	private readonly _onDisposed: Emitter<ITerminalGroup> = this._register(new Emitter<ITerminalGroup>());
	readonly onDisposed = this._onDisposed.event;
	private readonly _onInstancesChanged: Emitter<void> = this._register(new Emitter<void>());
	readonly onInstancesChanged = this._onInstancesChanged.event;
	private readonly _onDidChangeActiveInstance = new Emitter<ITerminalInstance | undefined>();
	readonly onDidChangeActiveInstance = this._onDidChangeActiveInstance.event;
	private readonly _onPanelOrientationChanged = new Emitter<Orientation>();
	readonly onPanelOrientationChanged = this._onPanelOrientationChanged.event;

	constructor(
		private _container: HTMLElement | undefined,
		shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance | undefined,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IViewDescriptorService private readonly _viewDescriptorService: IViewDescriptorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
		if (shellLaunchConfigOrInstance) {
			this.addInstance(shellLaunchConfigOrInstance);
		}
		if (this._container) {
			this.attachToElement(this._container);
		}
		this._onPanelOrientationChanged.fire(this._terminalLocation === ViewContainerLocation.Panel ? Orientation.HORIZONTAL : Orientation.VERTICAL);
	}

	addInstance(shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance, parentTerminalId?: number): void {
		let instance: ITerminalInstance;
		// if a parent terminal is provided, find it
		// otherwise, parent is the active terminal
		const parentIndex = parentTerminalId ? this._terminalInstances.findIndex(t => t.instanceId === parentTerminalId) : this._activeInstanceIndex;
		if ('instanceId' in shellLaunchConfigOrInstance) {
			instance = shellLaunchConfigOrInstance;
		} else {
			instance = this._terminalInstanceService.createInstance(shellLaunchConfigOrInstance);
		}
		if (this._terminalInstances.length === 0) {
			this._terminalInstances.push(instance);
			this._activeInstanceIndex = 0;
		} else {
			this._terminalInstances.splice(parentIndex + 1, 0, instance);
		}
		this._initInstanceListeners(instance);

		if (this._splitPaneContainer) {
			this._splitPaneContainer!.split(instance, parentIndex + 1);
		}

		instance.setVisible(this._isVisible);

		this._onInstancesChanged.fire();
	}

	override dispose(): void {
		super.dispose();
		if (this._container && this._groupElement) {
			this._container.removeChild(this._groupElement);
			this._groupElement = undefined;
		}
		this._terminalInstances = [];
		this._onInstancesChanged.fire();
	}

	get activeInstance(): ITerminalInstance | undefined {
		if (this._terminalInstances.length === 0) {
			return undefined;
		}
		return this._terminalInstances[this._activeInstanceIndex];
	}

	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById {
		const instances = this.terminalInstances.filter(instance => typeof instance.persistentProcessId === 'number' && instance.shouldPersist);
		return {
			isActive: isActive,
			activePersistentProcessId: this.activeInstance ? this.activeInstance.persistentProcessId : undefined,
			terminals: instances.map(t => {
				return {
					relativeSize: this._splitPaneContainer?.getRelativePaneSize(t) || 0,
					terminal: t.persistentProcessId || 0
				};
			})
		};
	}

	private _initInstanceListeners(instance: ITerminalInstance) {
		this._instanceDisposables.set(instance.instanceId, [
			instance.onDisposed(instance => {
				this._onDidDisposeInstance.fire(instance);
				this._handleOnDidDisposeInstance(instance);
			}),
			instance.onDidFocus(instance => {
				this._setActiveInstance(instance);
				this._onDidFocusInstance.fire(instance);
			}),
			instance.capabilities.onDidAddCapability(() => this._onDidChangeInstanceCapability.fire(instance)),
			instance.capabilities.onDidRemoveCapability(() => this._onDidChangeInstanceCapability.fire(instance)),
		]);
	}

	private _handleOnDidDisposeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);
	}

	removeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);

		// Dispose instance event listeners
		const disposables = this._instanceDisposables.get(instance.instanceId);
		if (disposables) {
			dispose(disposables);
			this._instanceDisposables.delete(instance.instanceId);
		}
	}

	private _removeInstance(instance: ITerminalInstance) {
		const index = this._terminalInstances.indexOf(instance);
		if (index === -1) {
			return;
		}

		const wasActiveInstance = instance === this.activeInstance;
		this._terminalInstances.splice(index, 1);

		// Adjust focus if the instance was active
		if (wasActiveInstance && this._terminalInstances.length > 0) {
			const newIndex = index < this._terminalInstances.length ? index : this._terminalInstances.length - 1;
			this.setActiveInstanceByIndex(newIndex);
			// TODO: Only focus the new instance if the group had focus?
			if (this.activeInstance) {
				this.activeInstance.focus(true);
			}
		} else if (index < this._activeInstanceIndex) {
			// Adjust active instance index if needed
			this._activeInstanceIndex--;
		}

		this._splitPaneContainer?.remove(instance);

		// Fire events and dispose group if it was the last instance
		if (this._terminalInstances.length === 0) {
			this._onDisposed.fire(this);
			this.dispose();
		} else {
			this._onInstancesChanged.fire();
		}
	}

	moveInstance(instance: ITerminalInstance, index: number): void {
		const sourceIndex = this.terminalInstances.indexOf(instance);
		if (sourceIndex === -1) {
			return;
		}
		this._terminalInstances.splice(sourceIndex, 1);
		this._terminalInstances.splice(index, 0, instance);
		if (this._splitPaneContainer) {
			this._splitPaneContainer.remove(instance);
			this._splitPaneContainer.split(instance, index);
		}
		this._onInstancesChanged.fire();
	}

	private _setActiveInstance(instance: ITerminalInstance) {
		this.setActiveInstanceByIndex(this._getIndexFromId(instance.instanceId));
	}

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.instanceId === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}

	setActiveInstanceByIndex(index: number, force?: boolean): void {
		// Check for invalid value
		if (index < 0 || index >= this._terminalInstances.length) {
			return;
		}

		const oldActiveInstance = this.activeInstance;
		this._activeInstanceIndex = index;
		if (oldActiveInstance !== this.activeInstance || force) {
			this._onInstancesChanged.fire();
			this._onDidChangeActiveInstance.fire(this.activeInstance);
		}
	}

	attachToElement(element: HTMLElement): void {
		this._container = element;

		// If we already have a group element, we can reparent it
		if (!this._groupElement) {
			this._groupElement = document.createElement('div');
			this._groupElement.classList.add('terminal-group');
		}

		this._container.appendChild(this._groupElement);
		if (!this._splitPaneContainer) {
			this._terminalLocation = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
			const orientation = this._terminalLocation === ViewContainerLocation.Panel ? Orientation.HORIZONTAL : Orientation.VERTICAL;
			this._splitPaneContainer = this._instantiationService.createInstance(SplitPaneContainer, this._groupElement, orientation);
			this.terminalInstances.forEach(instance => this._splitPaneContainer!.split(instance, this._activeInstanceIndex + 1));
			if (this._initialRelativeSizes) {
				this.resizePanes(this._initialRelativeSizes);
				this._initialRelativeSizes = undefined;
			}
		}
		this.setVisible(this._isVisible);
	}

	get title(): string {
		if (this._terminalInstances.length === 0) {
			// Normally consumers should not call into title at all after the group is disposed but
			// this is required when the group is used as part of a tree.
			return '';
		}
		let title = this.terminalInstances[0].title + this._getBellTitle(this.terminalInstances[0]);
		if (this.terminalInstances[0].description) {
			title += ` (${this.terminalInstances[0].description})`;
		}
		for (let i = 1; i < this.terminalInstances.length; i++) {
			const instance = this.terminalInstances[i];
			if (instance.title) {
				title += `, ${instance.title + this._getBellTitle(instance)}`;
				if (instance.description) {
					title += ` (${instance.description})`;
				}
			}
		}
		return title;
	}

	private _getBellTitle(instance: ITerminalInstance) {
		if (this._terminalService.configHelper.config.enableBell && instance.statusList.statuses.find(e => e.id === TerminalStatus.Bell)) {
			return '*';
		}
		return '';
	}

	setVisible(visible: boolean): void {
		this._isVisible = visible;
		if (this._groupElement) {
			this._groupElement.style.display = visible ? '' : 'none';
		}
		this.terminalInstances.forEach(i => i.setVisible(visible));
	}

	split(shellLaunchConfig: IShellLaunchConfig): ITerminalInstance {
		const instance = this._terminalInstanceService.createInstance(shellLaunchConfig);
		this.addInstance(instance, shellLaunchConfig.parentTerminalId);
		this._setActiveInstance(instance);
		return instance;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}

	layout(width: number, height: number): void {
		if (this._splitPaneContainer) {
			// Check if the panel position changed and rotate panes if so
			const newTerminalLocation = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
			const terminalPositionChanged = newTerminalLocation !== this._terminalLocation;
			if (terminalPositionChanged) {
				const newOrientation = newTerminalLocation === ViewContainerLocation.Panel ? Orientation.HORIZONTAL : Orientation.VERTICAL;
				this._splitPaneContainer.setOrientation(newOrientation);
				this._terminalLocation = newTerminalLocation;
				this._onPanelOrientationChanged.fire(this._splitPaneContainer.orientation);
			}
			this._splitPaneContainer.layout(width, height);
		}
	}

	focusPreviousPane(): void {
		const newIndex = this._activeInstanceIndex === 0 ? this._terminalInstances.length - 1 : this._activeInstanceIndex - 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	focusNextPane(): void {
		const newIndex = this._activeInstanceIndex === this._terminalInstances.length - 1 ? 0 : this._activeInstanceIndex + 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	resizePane(direction: Direction): void {
		if (!this._splitPaneContainer) {
			return;
		}

		const isHorizontal = (direction === Direction.Left || direction === Direction.Right);
		const font = this._terminalService.configHelper.getFont();
		// TODO: Support letter spacing and line height
		const amount = isHorizontal ? font.charWidth : font.charHeight;
		if (amount) {
			this._splitPaneContainer.resizePane(this._activeInstanceIndex, direction, amount);
		}
	}

	resizePanes(relativeSizes: number[]): void {
		if (!this._splitPaneContainer) {
			this._initialRelativeSizes = relativeSizes;
			return;
		}

		this._splitPaneContainer.resizePanes(relativeSizes);
	}
}
