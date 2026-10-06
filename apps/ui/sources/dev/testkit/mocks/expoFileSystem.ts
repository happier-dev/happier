import { vi } from 'vitest';

/** Modern Expo File/Directory boundary with observable bytes and exact URI custody. */
export function createExpoFileSystemFileMock(cacheUri = 'file:///cache') {
    const files = new Map<string, number[]>();
    const close = vi.fn((_uri: string) => {});
    const deleteFile = vi.fn((uri: string) => {
        if (!files.delete(uri)) throw new Error('File already removed');
    });
    const open = vi.fn((_uri: string) => {});
    const create = vi.fn((uri: string) => {
        if (new TextEncoder().encode(uri.split('/').at(-1)!).byteLength > 255) throw new Error('Filename exceeds filesystem component limit');
        if (files.has(uri)) throw new Error('File already exists');
        files.set(uri, []);
    });
    const writes = vi.fn((_uri: string, _bytes: Uint8Array) => {});
    const writeBytes = vi.fn((uri: string, bytes: Uint8Array) => {
        const content = files.get(uri);
        if (!content) throw new Error('File does not exist');
        writes(uri, bytes);
        content.push(...bytes);
    });
    class Directory {
        readonly uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const uri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${uri.replace(/\/+$/, '')}/${name}` : uri;
        }
        create() {}
    }
    class File {
        readonly uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const uri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${uri.replace(/\/+$/, '')}/${name}` : uri;
        }
        get exists() { return files.has(this.uri); }
        create() { create(this.uri); }
        delete() { deleteFile(this.uri); }
        write(content: string | Uint8Array, options?: { append?: boolean }) {
            if (!files.has(this.uri)) create(this.uri);
            const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
            writes(this.uri, bytes);
            files.set(this.uri, [...(options?.append ? files.get(this.uri)! : []), ...bytes]);
        }
        async text() {
            const bytes = files.get(this.uri);
            if (!bytes) throw new Error('File does not exist');
            return new TextDecoder().decode(new Uint8Array(bytes));
        }
        open() {
            open(this.uri);
            return { offset: 0, writeBytes: (bytes: Uint8Array) => writeBytes(this.uri, bytes), close: () => close(this.uri) };
        }
    }
    return { module: { Directory, File, Paths: { cache: cacheUri } }, files, close, deleteFile, open, create, writeBytes, writes };
}
