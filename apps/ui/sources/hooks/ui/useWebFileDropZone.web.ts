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
    const dragDepthRef = React.useRef(0);
    const setActive = React.useCallback((active: boolean) => {
        params.onFileDragActiveChange?.(active);
    }, [params]);

    const onDragEnter = React.useCallback((event: any) => {
        if (!params.enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        dragDepthRef.current += 1;
        setActive(true);
    }, [params.enabled, setActive]);

    const onDragLeave = React.useCallback((event: any) => {
        if (!params.enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setActive(false);
        }
    }, [params.enabled, setActive]);

    const onDragOver = React.useCallback((event: any) => {
        if (!params.enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        event.preventDefault?.();
    }, [params.enabled]);

    const onDrop = React.useCallback((event: any) => {
        if (!params.enabled) return;
        if (!isWebFileDragEvent(event as DragEventLike)) return;
        event.preventDefault?.();
        dragDepthRef.current = 0;
        setActive(false);
        void params.onFilesDropped(event);
    }, [params.enabled, params.onFilesDropped, setActive]);

    return { onDragEnter, onDragLeave, onDragOver, onDrop };
}
