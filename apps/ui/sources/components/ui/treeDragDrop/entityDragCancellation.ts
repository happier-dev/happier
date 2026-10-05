import type { EntityDragDropRuntime } from './entityDragDropTypes';

/** One realm-owned event boundary, installed by the shared feedback host. */
export function installEntityDragCancellation(runtime: EntityDragDropRuntime, events: EventTarget): () => void {
    const cancel = (event: Event) => runtime.cancel(event.type);
    const keydown = (event: Event) => {
        if ('key' in event && event.key === 'Escape' && runtime.getSnapshot().phase === 'carrying') {
            event.preventDefault();
            runtime.cancel('escape');
        }
    };
    const leave = (event: Event) => {
        if ('relatedTarget' in event && event.relatedTarget == null) runtime.cancel('window-leave');
    };
    const cancellationEvents = ['blur', 'pointercancel', 'lostpointercapture', 'dragend'];
    for (const name of cancellationEvents) events.addEventListener(name, cancel);
    events.addEventListener('keydown', keydown);
    events.addEventListener('pointerleave', leave);
    return () => {
        for (const name of cancellationEvents) events.removeEventListener(name, cancel);
        events.removeEventListener('keydown', keydown);
        events.removeEventListener('pointerleave', leave);
        runtime.cancel('realm-unmount');
    };
}
