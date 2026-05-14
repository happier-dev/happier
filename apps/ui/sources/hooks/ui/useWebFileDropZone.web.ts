import * as React from 'react';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';

type DragEventLike = Readonly<{
    dataTransfer?: Readonly<{ types?: readonly string[]; items?: any; files?: any }> | null;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

export function useWebFileDropZone(params: Readonly<{
    enabled: boolean;
    onFilesDropped: (event: any) => void | Promise<void>;
    onFileDragActiveChange?: ((active: boolean) => void) | null;
}>): Readonly<{
    onDragEnter: (event: any) => void;
    onDragLeave: (event: any) => void;
    onDragOver: (event: any) => void;
    onDrop: (event: any) => void;
}> {
    const { enabled, onFileDragActiveChange, onFilesDropped } = params;
    const dragDepthRef = React.useRef(0);
    const activeRef = React.useRef(false);
    const setActive = React.useCallback((active: boolean) => {
        if (activeRef.current === active) return;
        activeRef.current = active;
        onFileDragActiveChange?.(active);
    }, [onFileDragActiveChange]);

    React.useEffect(() => {
        if (enabled) return;
        dragDepthRef.current = 0;
        setActive(false);
    }, [enabled, setActive]);

    const onDragEnter = React.useCallback((event: any) => {
        if (!enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        dragDepthRef.current += 1;
        if (dragDepthRef.current === 1) {
            setActive(true);
        }
    }, [enabled, setActive]);

    const onDragLeave = React.useCallback((event: any) => {
        if (!enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setActive(false);
        }
    }, [enabled, setActive]);

    const onDragOver = React.useCallback((event: any) => {
        if (!enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        event.preventDefault?.();
    }, [enabled]);

    const onDrop = React.useCallback((event: any) => {
        if (!enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        event.preventDefault?.();
        dragDepthRef.current = 0;
        setActive(false);
        void onFilesDropped(event);
    }, [enabled, onFilesDropped, setActive]);

    return React.useMemo(() => ({
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDrop,
    }), [onDragEnter, onDragLeave, onDragOver, onDrop]);
}
