export type FileSearchItem = Readonly<{
    fileName: string;
    filePath: string;
    fullPath: string;
    fileType: 'file' | 'folder';
}>;
