import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import type { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';

type WebFileDataTransfer = NonNullable<Parameters<typeof extractWebAttachmentFilesFromDataTransfer>[0]>
    & { types?: unknown; dropEffect?: string };

/** OS handles remain at the DOM boundary; they never enter a portable entity envelope. */
export type WebFileDragEvent = Readonly<{
    dataTransfer?: WebFileDataTransfer | null;
    target?: EventTarget | null;
    currentTarget?: EventTarget | null;
    relatedTarget?: EventTarget | null;
    nativeEvent?: object;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

export type WebDragDropHandlers = Readonly<{
    onDragEnter?: (event: WebFileDragEvent) => void;
    onDragLeave?: (event: WebFileDragEvent) => void;
    onDragOver?: (event: WebFileDragEvent) => void;
    onDrop?: (event: WebFileDragEvent) => void;
}>;

/** Native listeners preserve innermost-first delivery across RN Web and React editors. */
export function attachWebDragDropHandlers(host: HTMLElement, read: () => WebDragDropHandlers) {
    const enter = (event: DragEvent) => read().onDragEnter?.(event);
    const leave = (event: DragEvent) => read().onDragLeave?.(event);
    const over = (event: DragEvent) => read().onDragOver?.(event);
    const drop = (event: DragEvent) => read().onDrop?.(event);
    host.addEventListener('dragenter', enter);
    host.addEventListener('dragleave', leave);
    host.addEventListener('dragover', over);
    host.addEventListener('drop', drop);
    return () => {
        host.removeEventListener('dragenter', enter);
        host.removeEventListener('dragleave', leave);
        host.removeEventListener('dragover', over);
        host.removeEventListener('drop', drop);
    };
}

export type ExternalFileDropTarget = Readonly<{
    enabled: boolean;
    /** An optional textarea with no file callback is ordinary editor input. */
    present?: boolean;
    onFilesDropped: (event: WebFileDragEvent) => void | Promise<void>;
    onFileDragActiveChange?: ((active: boolean) => void) | null;
}>;

type Binding = Readonly<{ read: () => ExternalFileDropTarget }>;

/** One boundary lifecycle for all OS-file consumers in this mounted browser realm. */
const claimedEvents = new WeakSet<object>();
let active: Binding | null = null;
let depth = 0;
let bindingCount = 0;
let cancelled = false;
let detachCancellation: (() => void) | null = null;

function retire() {
    const previous = active;
    active = null;
    depth = 0;
    previous?.read().onFileDragActiveChange?.(false);
}

function activate(binding: Binding) {
    if (active === binding) return;
    retire();
    active = binding;
    binding.read().onFileDragActiveChange?.(true);
}

function claim(binding: Binding, event: WebFileDragEvent) {
    if (binding.read().present === false || !isWebFileDragEvent(event)) return false;
    const nativeEvent = event.nativeEvent ?? event;
    if (claimedEvents.has(nativeEvent)) return false;
    claimedEvents.add(nativeEvent);
    event.stopPropagation?.();
    return true;
}

export function createExternalFileDropBinding(read: () => ExternalFileDropTarget) {
    const binding: Binding = { read };
    return {
        mount() {
            if (bindingCount === 0) cancelled = false;
            bindingCount += 1;
            if (!detachCancellation && typeof window !== 'undefined') {
                const cancel = () => { cancelled = true; retire(); };
                const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
                const leaveWindow = (event: DragEvent) => {
                    if (event.relatedTarget == null && (event.target === document || event.target === document.documentElement)) cancel();
                };
                window.addEventListener('dragend', cancel);
                window.addEventListener('blur', cancel);
                window.addEventListener('keydown', keydown);
                window.addEventListener('dragleave', leaveWindow);
                detachCancellation = () => {
                    window.removeEventListener('dragend', cancel);
                    window.removeEventListener('blur', cancel);
                    window.removeEventListener('keydown', keydown);
                    window.removeEventListener('dragleave', leaveWindow);
                };
            }
            return () => {
                if (active === binding) { cancelled = true; retire(); }
                bindingCount -= 1;
                if (bindingCount === 0) {
                    detachCancellation?.();
                    detachCancellation = null;
                }
            };
        },
        refresh() {
            if (active === binding && (!read().enabled || read().present === false)) {
                cancelled = true;
                retire();
            }
        },
        handlers: {
            onDragEnter(event: WebFileDragEvent) {
                if (!claim(binding, event)) return;
                cancelled = false;
                if (!read().enabled) { retire(); return; }
                activate(binding);
                depth += 1;
            },
            onDragLeave(event: WebFileDragEvent) {
                if (!claim(binding, event) || active !== binding) return;
                depth = Math.max(0, depth - 1);
                const host = event.currentTarget;
                // Real DOM transitions within a target do not retire its outcome.
                if (host && 'contains' in host && typeof host.contains === 'function' && event.relatedTarget) {
                    if (host.contains(event.relatedTarget)) return;
                    retire();
                    return;
                }
                if (depth === 0) retire();
            },
            onDragOver(event: WebFileDragEvent) {
                if (!claim(binding, event)) return;
                event.preventDefault?.();
                if (!read().enabled || cancelled) {
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
                    retire();
                    return;
                }
                activate(binding);
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            },
            onDrop(event: WebFileDragEvent) {
                if (!claim(binding, event)) return;
                event.preventDefault?.();
                // Disabled inner targets still own the event: refusal cannot upload to an ancestor.
                if (read().enabled && !cancelled) void read().onFilesDropped(event);
                retire();
            },
        },
    };
}
