/** @moduleRealm browser */
import { ENTITY_DRAG_DELIVERY_MIME_V1, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@happier-dev/protocol/plugins/ui/client';
import type { JsonValue } from '../identity.js';
import type { PluginUiEntityDropDestinationV1, PluginUiHostApi, PluginUiUpdateEntityDragDropRequestV1, PluginUiUpdateEntityDragDropResultV1, PluginUiEntityDragDropStateV1 } from './hostApi.js';
export type PluginHostedEntityDragMount = Readonly<{ ready: Promise<boolean>; dispose(): void }>;
export type PluginHostedEntityDragSourceMount = PluginHostedEntityDragMount & Readonly<{
    destinations: () => Promise<PluginUiUpdateEntityDragDropResultV1>;
    beginKeyboard: () => Promise<PluginUiUpdateEntityDragDropResultV1>;
    choose: (destination: PluginUiEntityDropDestinationV1) => Promise<PluginUiUpdateEntityDragDropResultV1>;
    commit: () => Promise<PluginUiUpdateEntityDragDropResultV1>;
    perform: (destination: PluginUiEntityDropDestinationV1) => Promise<PluginUiUpdateEntityDragDropResultV1>;
    cancel: () => Promise<PluginUiUpdateEntityDragDropResultV1>;
}>;
type MountInput = Readonly<{ hostApi: PluginUiHostApi; element: HTMLElement; mountId: string; onError?: (error: unknown) => void }>;

/** The primary row action may carry; sibling controls keep their own gestures. */
export function isSecondaryEntityRowControl(event: Event, element: HTMLElement): boolean {
    const primary = 'button,[role="button"],[role="tab"],[role="treeitem"],[role="option"],[role="menuitem"],a[href],[role="link"]';
    const control = (event.target as Element | null)?.closest?.(`${primary},input,textarea,select,[role="checkbox"],[role="switch"],[contenteditable="true"]`);
    // A menu/explicit secondary control stays secondary even when a noninteractive row has no primary button.
    if (control?.matches('[aria-haspopup]:not([aria-haspopup="false"]),[data-entity-drag-secondary="true"]')) return true;
    return control !== null && control !== undefined && control !== element && control !== element.querySelector(primary);
}

/** DOM delivery only; the single mounted host bridge owns event ordering and admission. */
function delivery(input: MountInput) {
    let disposed = false;
    const send = (command: PluginUiUpdateEntityDragDropRequestV1) => {
        const result = disposed && command.kind !== 'unmount' ? Promise.resolve({ accepted: false }) : input.hostApi.updateEntityDragDrop(command);
        void result.catch(error => { input.onError?.(error); });
        return result;
    };
    const viewport = () => ({ width: input.element.ownerDocument.defaultView?.innerWidth ?? 0, height: input.element.ownerDocument.defaultView?.innerHeight ?? 0 });
    const pointer = (event: Pick<MouseEvent, 'clientX' | 'clientY'>) => ({ pointer: { x: event.clientX, y: event.clientY }, viewport: viewport() });
    const hint = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(ENTITY_DRAG_DELIVERY_MIME_V1);
    return { send, viewport, pointer, hint, retire: () => { disposed = true; void send({ kind: 'unmount', mountId: input.mountId }); } };
}

/** Bind a declared custom source; host scope and reference-schema admission are never author-built. */
export function bindHostedEntityDragSource(input: Readonly<{
    hostApi: PluginUiHostApi;
    element: HTMLElement;
    mountId: string;
    onError?: (error: unknown) => void;
    sourceId: string;
    reference: JsonValue;
    handle?: HTMLElement;
    onState?: (state: PluginUiEntityDragDropStateV1) => void;
}>): PluginHostedEntityDragSourceMount {
    const bridge = delivery(input);
    let admitted = false;
    let disposed = false;
    let observation: Readonly<{ dispose(): void | Promise<void> }> | undefined;
    const previous = input.element.getAttribute('draggable');
    input.element.setAttribute('draggable', 'false');
    const ready = bridge.send({ kind: 'mountSource', mountId: input.mountId, sourceId: input.sourceId, reference: input.reference }).then(async result => {
        admitted = !disposed && result.accepted;
        if (disposed) return false;
        input.element.setAttribute('draggable', String(admitted));
        if (admitted && input.onState) {
            const subscription = await input.hostApi.watchEntityDragDrop({ mountId: input.mountId }, input.onState);
            if (disposed) void subscription.dispose(); else observation = subscription;
        }
        return admitted;
    });
    const start = (event: DragEvent) => {
        if (!admitted || isSecondaryEntityRowControl(event, input.element) || input.element.ownerDocument.getSelection()?.toString()) { event.preventDefault(); return; }
        event.stopPropagation();
        event.dataTransfer?.setData(ENTITY_DRAG_DELIVERY_MIME_V1, '');
        input.element.ownerDocument.addEventListener('dragover', move, true);
        void bridge.send({ kind: 'begin', mountId: input.mountId, ...bridge.pointer(event) });
    };
    const move = (event: DragEvent) => { if (bridge.hint(event)) void bridge.send({ kind: 'move', ...bridge.pointer(event) }); };
    const end = () => { input.element.ownerDocument.removeEventListener('dragover', move, true); void bridge.send({ kind: 'cancel', mountId: input.mountId, reason: 'gesture-end' }); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') void bridge.send({ kind: 'cancel', mountId: input.mountId }); };
    let touchStart: Readonly<{ id: number; x: number; y: number }> | null = null;
    let touchActivated = false;
    const touch = (event: PointerEvent) => {
        if (!admitted || event.pointerType === 'mouse') return;
        event.preventDefault(); event.stopPropagation();
        input.handle?.setPointerCapture?.(event.pointerId);
        touchStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
        touchActivated = false;
    };
    const touchMove = (event: PointerEvent) => {
        if (!touchStart || touchStart.id !== event.pointerId) return;
        if (!touchActivated && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) >= ENTITY_DRAG_ACTIVATION_DISTANCE_PX) {
            touchActivated = true;
            void bridge.send({ kind: 'begin', mountId: input.mountId, ...bridge.pointer(event) });
        } else if (touchActivated) void bridge.send({ kind: 'move', ...bridge.pointer(event) });
    };
    const touchEnd = (event: PointerEvent) => {
        if (event.pointerType === 'mouse' || !input.handle?.hasPointerCapture?.(event.pointerId)) return;
        input.handle.releasePointerCapture?.(event.pointerId);
        touchStart = null;
        if (touchActivated) void bridge.send(event.type === 'pointerup' ? { kind: 'release', ...bridge.pointer(event) } : { kind: 'cancel', mountId: input.mountId });
        touchActivated = false;
    };
    input.element.addEventListener('dragstart', start);
    input.element.addEventListener('dragend', end);
    input.element.ownerDocument.addEventListener('keydown', key);
    input.handle?.addEventListener('pointerdown', touch);
    input.handle?.addEventListener('pointermove', touchMove);
    input.handle?.addEventListener('pointerup', touchEnd);
    input.handle?.addEventListener('pointercancel', touchEnd);
    return { ready,
        destinations: () => bridge.send({ kind: 'destinations', mountId: input.mountId }),
        beginKeyboard: () => bridge.send({ kind: 'begin', mountId: input.mountId, pointer: { x: 0, y: 0 }, viewport: bridge.viewport(), input: 'keyboard' }),
        choose: destination => bridge.send({ kind: 'choose', mountId: input.mountId, targetId: destination.targetId, ...(destination.destination === undefined ? {} : { destination: destination.destination }) }),
        commit: () => bridge.send({ kind: 'commit', mountId: input.mountId }),
        perform: destination => bridge.send({ kind: 'perform', mountId: input.mountId, targetId: destination.targetId, ...(destination.destination === undefined ? {} : { destination: destination.destination }) }),
        cancel: () => bridge.send({ kind: 'cancel', mountId: input.mountId }),
        dispose() {
        disposed = true;
        admitted = false;
        void observation?.dispose();
        input.element.removeEventListener('dragstart', start);
        input.element.removeEventListener('dragend', end);
        input.element.ownerDocument.removeEventListener('dragover', move, true);
        input.element.ownerDocument.removeEventListener('keydown', key);
        input.handle?.removeEventListener('pointerdown', touch); input.handle?.removeEventListener('pointermove', touchMove);
        input.handle?.removeEventListener('pointerup', touchEnd); input.handle?.removeEventListener('pointercancel', touchEnd);
        if (previous === null) input.element.removeAttribute('draggable'); else input.element.setAttribute('draggable', previous);
        bridge.retire();
    } };
}

/** Bind local measured bounds to the host target; OS files and ordinary text drags are not consumed. */
export function bindHostedEntityDropTarget(input: Readonly<{
    hostApi: PluginUiHostApi;
    element: HTMLElement;
    mountId: string;
    onError?: (error: unknown) => void;
    targetId: string;
    input?: JsonValue;
    parentId?: string;
    onState?: (state: PluginUiEntityDragDropStateV1) => void;
}>): PluginHostedEntityDragMount {
    const bridge = delivery(input);
    let disposed = false;
    let observation: Readonly<{ dispose(): void | Promise<void> }> | undefined;
    const geometry = () => {
        const rect = input.element.getBoundingClientRect();
        return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: bridge.viewport() };
    };
    const ready = bridge.send({ kind: 'mountTarget', mountId: input.mountId, targetId: input.targetId, ...(input.input === undefined ? {} : { input: input.input }), ...(input.parentId === undefined ? {} : { parentId: input.parentId }), ...geometry() }).then(async result => {
        if (disposed || !result.accepted) return false;
        if (input.onState) {
            const subscription = await input.hostApi.watchEntityDragDrop({ mountId: input.mountId }, state => { if (!disposed) input.onState?.(state); });
            if (disposed) void subscription.dispose(); else observation = subscription;
        }
        return !disposed;
    });
    const layout = () => { void bridge.send({ kind: 'layout', mountId: input.mountId, ...geometry() }); };
    const over = (event: DragEvent) => {
        if (!bridge.hint(event)) return;
        event.preventDefault();
        layout();
        void bridge.send({ kind: 'move', ...bridge.pointer(event) });
    };
    const drop = (event: DragEvent) => {
        if (!bridge.hint(event)) return;
        event.preventDefault(); event.stopPropagation();
        layout();
        void bridge.send({ kind: 'release', ...bridge.pointer(event) });
    };
    const realm = input.element.ownerDocument.defaultView;
    const observer = realm?.ResizeObserver ? new realm.ResizeObserver(layout) : null;
    observer?.observe(input.element);
    realm?.addEventListener('scroll', layout, true);
    realm?.addEventListener('resize', layout);
    input.element.addEventListener('dragover', over);
    input.element.addEventListener('drop', drop);
    return { ready, dispose() {
        disposed = true;
        void observation?.dispose();
        observer?.disconnect(); realm?.removeEventListener('scroll', layout, true); realm?.removeEventListener('resize', layout);
        input.element.removeEventListener('dragover', over); input.element.removeEventListener('drop', drop);
        bridge.retire();
    } };
}
