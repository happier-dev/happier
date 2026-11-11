import * as React from 'react';
import { Platform } from 'react-native';
import type { EntityDragCarry, EntityDragDropRuntime } from './entityDragDropTypes';
import { ENTITY_DRAG_DELIVERY_MIME_V1, entityDragKindV1, type EntityDragKindV1 } from '@happier-dev/protocol/plugins/ui';

import { isSecondaryEntityRowControl } from '@happier-dev/plugin-sdk/ui/client';
export { isSecondaryEntityRowControl };

let blankImage: HTMLImageElement | null = null;
/** A transparent 1×1 image, made once when the first source attaches, so it is decoded by the first drag. */
function blankDragImage(): HTMLImageElement {
    if (!blankImage) {
        blankImage = new Image(1, 1);
        blankImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }
    return blankImage;
}

export type EntityDragDomCarry = Pick<EntityDragCarry, 'move' | 'cancel'> & Partial<Pick<EntityDragCarry, 'release'>>;

// Window capture and nested targets receive the same browser event. Deliver its
// pointer once per realm; a later event at the same coordinates still revalidates
// current admission. Weak event keys retain neither the DOM target nor its carry.
const pointerDeliveries = new WeakMap<DragEvent, WeakSet<EntityDragDropRuntime>>();
function deliverDragPointer(runtime: EntityDragDropRuntime, event: DragEvent, move = runtime.move): void {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    let delivered = pointerDeliveries.get(event);
    if (delivered?.has(runtime)) return;
    if (!delivered) { delivered = new WeakSet(); pointerDeliveries.set(event, delivered); }
    delivered.add(runtime);
    move({ x: event.clientX, y: event.clientY });
}

type EntityDragDomBindingInput = Readonly<{
    runtime: EntityDragDropRuntime;
    enabled: boolean;
    canStart?: (event: DragEvent, host: HTMLElement) => boolean;
    describe?: () => string;
}> & Readonly<
    | { sourceId: string; begin?: never }
    | { sourceId?: never; begin: () => EntityDragDomCarry | null }
>;

/** Browser gesture boundary only: the carry handle is the sole lifecycle authority. */
export function useEntityDragDomBinding(input: EntityDragDomBindingInput): (node: unknown) => void {
    const latest = React.useRef(input);
    latest.current = input;
    const host = React.useRef<HTMLElement | null>(null);
    const requestedHost = React.useRef<HTMLElement | null>(null);
    const detach = React.useRef<(() => void) | null>(null);
    const carry = React.useRef<EntityDragDomCarry | null>(null);
    const stopMove = React.useRef<(() => void) | null>(null);
    const retireHost = React.useCallback(() => {
        detach.current?.();
        detach.current = null;
        stopMove.current?.();
        const active = carry.current;
        carry.current = null;
        host.current = null;
        active?.cancel('source-retired');
    }, []);
    React.useEffect(() => {
        host.current?.setAttribute('draggable', input.enabled ? 'true' : 'false');
        if (!input.enabled) { stopMove.current?.(); carry.current?.cancel('source-retired'); carry.current = null; }
    }, [input.enabled, input.runtime, input.sourceId]);
    React.useEffect(() => () => { requestedHost.current = null; retireHost(); }, [retireHost]);
    return React.useCallback((node: unknown) => {
        if (Platform.OS !== 'web') return;
        const candidate = node as HTMLElement | null;
        requestedHost.current = candidate?.addEventListener ? candidate : null;
        const element = requestedHost.current;
        if (element === host.current) return;
        if (!element) {
            // React platform/style wrappers can detach then reattach the same host
            // within a feedback commit. Retire only if it stays detached after that commit.
            queueMicrotask(() => { if (!requestedHost.current) retireHost(); });
            return;
        }
        retireHost();
        host.current = element;
        blankDragImage(); // Decoded before the first drag starts.
        element.setAttribute('draggable', latest.current.enabled ? 'true' : 'false');
        const move = (event: DragEvent) => {
            const active = carry.current;
            if (active) deliverDragPointer(latest.current.runtime, event, active.move);
        };
        const start = (event: DragEvent) => {
            if (event.defaultPrevented) return;
            const current = latest.current;
            if (!current.enabled || current.canStart?.(event, element) === false) { event.preventDefault(); return; }
            const handle = current.begin ? current.begin() : current.runtime.begin(current.sourceId, 'pointer');
            if (!handle) { event.preventDefault(); return; }
            carry.current = handle;
            window.addEventListener('dragover', move, true);
            stopMove.current = () => {
                window.removeEventListener('dragover', move, true);
                stopMove.current = null;
            };
            // Human-readable identity enables native browser drag delivery; it is never decoded.
            if (event.dataTransfer) {
                // The realm's carried card is the only thing that rides the pointer: no browser ghost of the row.
                event.dataTransfer.setDragImage?.(blankDragImage(), 0, 0);
                event.dataTransfer.effectAllowed = 'copyMove';
                event.dataTransfer.setData(ENTITY_DRAG_DELIVERY_MIME_V1, '');
                const description = current.describe?.();
                if (description) event.dataTransfer.setData('text/plain', description);
            }
            move(event);
            event.stopPropagation();
        };
        const end = () => {
            const active = carry.current;
            carry.current = null;
            stopMove.current?.();
            if (!active) return;
            // The browser delivers a drop only to a place that accepts the carry, so ending over a place the owner
            // refuses (or is still checking) never arrives as `drop`. That is still a release: it settles with the
            // owner's reason for the source to keep. Anywhere else, an unsuccessful dragend only cancels.
            const snapshot = latest.current.runtime.getSnapshot();
            if (active.release && snapshot.phase === 'carrying' && snapshot.targetId !== null && snapshot.admission?.status === 'refused') {
                void active.release();
            } else active.cancel('gesture-cancelled');
        };
        element.addEventListener('dragstart', start);
        element.addEventListener('dragend', end);
        detach.current = () => {
            element.removeEventListener('dragstart', start);
            element.removeEventListener('dragend', end);
            stopMove.current?.();
        };
    }, [retireHost]);
}

/** Nested DOM targets consume an app carry once; OS files remain with their file owner. */
export function useEntityDropDomBinding(runtime: EntityDragDropRuntime | undefined,
    options?: Readonly<{
        captureKinds?: readonly EntityDragKindV1[];
        beforeRelease?: () => void;
    }>): (node: unknown) => void {
    const latest = React.useRef({ runtime, options });
    latest.current = { runtime, options };
    const detach = React.useRef<(() => void) | null>(null);
    React.useEffect(() => () => detach.current?.(), []);
    return React.useCallback((node: unknown) => {
        detach.current?.();
        detach.current = null;
        if (Platform.OS !== 'web') return;
        const element = node as HTMLElement | null;
        if (!element?.addEventListener) return;
        const over = (event: DragEvent) => {
            const owner = latest.current.runtime;
            if (!owner || owner.getSnapshot().phase !== 'carrying') return;
            deliverDragPointer(owner, event);
            if (!acceptsDelivery(owner)) return;
            event.preventDefault();
        };
        const drop = (event: DragEvent) => {
            const owner = latest.current.runtime;
            if (!owner || owner.getSnapshot().phase !== 'carrying') return;
            latest.current.options?.beforeRelease?.();
            deliverDragPointer(owner, event);
            if (!acceptsDelivery(owner)) return;
            event.preventDefault();
            event.stopPropagation();
            void owner.release();
        };
        // A domain wrapper can own an app kind before a nested editor handles it.
        // File ingress has no entity carry and therefore always reaches its child owner.
        const captures = () => {
            const snapshot = latest.current.runtime?.getSnapshot();
            return snapshot?.phase === 'carrying' && snapshot.item
                && latest.current.options?.captureKinds?.includes(entityDragKindV1(snapshot.item));
        };
        // Explicit kind capture shields nested editors even on refusal; ordinary targets
        // become browser drop targets only after the canonical owner admits the move.
        const acceptsDelivery = (owner: EntityDragDropRuntime) => owner.getSnapshot().phase === 'carrying'
            && (owner.getSnapshot().admission?.status === 'allowed' || captures());
        const captureOver = (event: DragEvent) => { if (captures()) { over(event); event.stopPropagation(); } };
        const captureDrop = (event: DragEvent) => { if (captures()) drop(event); };
        const bubbleOver = (event: DragEvent) => over(event);
        const bubbleDrop = (event: DragEvent) => drop(event);
        element.addEventListener('dragover', captureOver, true);
        element.addEventListener('drop', captureDrop, true);
        element.addEventListener('dragover', bubbleOver);
        element.addEventListener('drop', bubbleDrop);
        detach.current = () => {
            element.removeEventListener('dragover', captureOver, true);
            element.removeEventListener('drop', captureDrop, true);
            element.removeEventListener('dragover', bubbleOver);
            element.removeEventListener('drop', bubbleDrop);
        };
    }, []);
}
