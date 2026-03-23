export function useWebFileDropZone(_params: Readonly<{
    enabled: boolean;
    onFilesDropped: (event: any) => void | Promise<void>;
    onFileDragActiveChange?: ((active: boolean) => void) | null;
}>): Readonly<{
    onDragEnter: (event: any) => void;
    onDragLeave: (event: any) => void;
    onDragOver: (event: any) => void;
    onDrop: (event: any) => void;
}> {
    return {
        onDragEnter: () => {},
        onDragLeave: () => {},
        onDragOver: () => {},
        onDrop: () => {},
    };
}

