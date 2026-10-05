const noopDropZoneHandlers = {
    onDragEnter: () => {},
    onDragLeave: () => {},
    onDragOver: () => {},
    onDrop: () => {},
};

export function useWebFileDropZone(_params: ExternalFileDropTarget): Readonly<{
    onDragEnter: (event: WebFileDragEvent) => void;
    onDragLeave: (event: WebFileDragEvent) => void;
    onDragOver: (event: WebFileDragEvent) => void;
    onDrop: (event: WebFileDragEvent) => void;
}> {
    return noopDropZoneHandlers;
}
import type { ExternalFileDropTarget, WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
