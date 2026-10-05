import * as React from 'react';
import { Platform } from 'react-native';
import type { EntityDragCarry, EntityDragDropRuntime } from './entityDragDropTypes';
import { ENTITY_DRAG_DELIVERY_MIME_V1, entityDragKindV1, type EntityDragKindV1 } from '@happier-dev/protocol/plugins/ui';

import { isSecondaryEntityRowControl } from '@happier-dev/plugin-sdk/ui/client';
export { isSecondaryEntityRowControl };

/** Browser gesture boundary only: the carry handle is the sole lifecycle authority. */
export function useEntityDragDomBinding(input: Readonly<{
    runtime: EntityDragDropRuntime;
    sourceId: string;
    enabled: boolean;
    canStart?: (event: DragEvent, host: HTMLElement) => boolean;
    describe?: () => string;
}>): (node: unknown) => void {
    const latest = React.useRef(input);
    latest.current = input;
    const host = React.useRef<HTMLElement | null>(null);
    const detach = React.useRef<(() => void) | null>(null);
    const carry = React.useRef<EntityDragCarry | null>(null);
    const stopMove = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        host.current?.setAttribute('draggable', input.enabled ? 'true' : 'false');
        if (!input.enabled) { stopMove.current?.(); carry.current?.cancel('source-retired'); carry.current = null; }
    }, [input.enabled, input.runtime, input.sourceId]);
    React.useEffect(() => () => { detach.current?.(); stopMove.current?.(); carry.current?.cancel('source-retired'); }, []);
    return React.useCallback((node: unknown) => {
        detach.current?.();
        detach.current = null;
        carry.current?.cancel('source-retired');
        stopMove.current?.();
        carry.current = null;
        host.current = null;
        if (Platform.OS !== 'web') return;
        const element = node as HTMLElement | null;
        if (!element?.addEventListener) return;
        host.current = element;
        element.setAttribute('draggable', latest.current.enabled ? 'true' : 'false');
        const move = (event: DragEvent) => {
            if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) carry.current?.move({ x: event.clientX, y: event.clientY });
        };
        const start = (event: DragEvent) => {
            const current = latest.current;
            if (!current.enabled || current.canStart?.(event, element) === false) { event.preventDefault(); return; }
            const handle = current.runtime.begin(current.sourceId, 'pointer');
            if (!handle) { event.preventDefault(); return; }
            carry.current = handle;
            window.addEventListener('dragover', move, true);
            stopMove.current = () => {
                window.removeEventListener('dragover', move, true);
                stopMove.current = null;
            };
            // Human-readable identity enables native browser drag delivery; it is never decoded.
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'copyMove';
                event.dataTransfer.setData(ENTITY_DRAG_DELIVERY_MIME_V1, '');
                const description = current.describe?.();
                if (description) event.dataTransfer.setData('text/plain', description);
            }
            move(event);
            event.stopPropagation();
        };
        const end = () => {
            // A successful drop target releases. An unsuccessful dragend only cancels.
            carry.current?.cancel('gesture-cancelled');
            carry.current = null;
            stopMove.current?.();
        };
        element.addEventListener('dragstart', start);
        element.addEventListener('dragend', end);
        detach.current = () => {
            element.removeEventListener('dragstart', start);
            element.removeEventListener('dragend', end);
            stopMove.current?.();
        };
    }, []);
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
            owner.move({ x: event.clientX, y: event.clientY });
            event.preventDefault();
        };
        const drop = (event: DragEvent) => {
            const owner = latest.current.runtime;
            if (!owner || owner.getSnapshot().phase !== 'carrying') return;
            latest.current.options?.beforeRelease?.();
            owner.move({ x: event.clientX, y: event.clientY });
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
