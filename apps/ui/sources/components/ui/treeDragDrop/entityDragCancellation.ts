import type { EntityDragDropRuntime } from './entityDragDropTypes';

/** One realm-owned event boundary, installed by the shared feedback host. */
export function installEntityDragCancellation(runtime: EntityDragDropRuntime, events: EventTarget): () => void {
    // HTML drag delivery retires the pointer stream after dragstart. Its carry lives until
    // drop/dragend, Escape or blur; pointercancel/lostcapture are not gesture cancellation.
    let htmlDragStart: Event | null = null;
    const startDrag = (event: Event) => { htmlDragStart = event; };
    const finishDrag = () => { htmlDragStart = null; };
    const cancel = (event: Event) => {
        if (htmlDragStart && !htmlDragStart.defaultPrevented
            && (event.type === 'pointercancel' || event.type === 'lostpointercapture')) return;
        finishDrag();
        runtime.cancel(event.type);
    };
    const keydown = (event: Event) => {
        if ('key' in event && event.key === 'Escape' && runtime.getSnapshot().phase === 'carrying') {
            event.preventDefault();
            finishDrag();
            runtime.cancel('escape');
        }
    };
    const leave = (event: Event) => {
        if ('relatedTarget' in event && event.relatedTarget == null) {
            finishDrag();
            runtime.cancel('window-leave');
        }
    };
    const cancellationEvents = ['blur', 'pointercancel', 'lostpointercapture', 'dragend'];
    for (const name of cancellationEvents) events.addEventListener(name, cancel);
    events.addEventListener('dragstart', startDrag, true);
    events.addEventListener('drop', finishDrag, true);
    events.addEventListener('dragend', finishDrag, true);
    events.addEventListener('keydown', keydown);
    events.addEventListener('pointerleave', leave);
    return () => {
        for (const name of cancellationEvents) events.removeEventListener(name, cancel);
        events.removeEventListener('dragstart', startDrag, true);
        events.removeEventListener('drop', finishDrag, true);
        events.removeEventListener('dragend', finishDrag, true);
        events.removeEventListener('keydown', keydown);
        events.removeEventListener('pointerleave', leave);
        runtime.cancel('realm-unmount');
    };
}
