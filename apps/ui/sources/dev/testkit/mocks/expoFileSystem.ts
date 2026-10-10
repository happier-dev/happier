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
    const writeBytes = vi.fn((uri: string, bytes: Uint8Array, offset?: number) => {
        const content = files.get(uri);
        if (!content) throw new Error('File does not exist');
        writes(uri, bytes);
        content.splice(Math.min(offset ?? content.length, content.length), bytes.length, ...bytes);
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
        get size() { return files.get(this.uri)?.length ?? 0; }
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
        async bytes() {
            const bytes = files.get(this.uri);
            if (!bytes) throw new Error('File does not exist');
            return new Uint8Array(bytes);
        }
        open() {
            if (!files.has(this.uri)) throw new Error('File does not exist');
            open(this.uri);
            let offset = 0;
            let closed = false;
            const requireOpen = () => {
                if (closed) throw new Error('File handle is closed');
            };
            const uri = this.uri;
            return {
                get offset() { return closed ? null : offset; },
                set offset(value: number | null) {
                    requireOpen();
                    if (value === null) throw new TypeError('An open file offset must be a number');
                    offset = value;
                },
                get size() { return closed ? null : files.get(uri)!.length; },
                readBytes(length: number) {
                    requireOpen();
                    const bytes = new Uint8Array(files.get(uri)!.slice(offset, offset + length));
                    offset += bytes.length;
                    return bytes;
                },
                writeBytes(bytes: Uint8Array) {
                    requireOpen();
                    offset = Math.min(offset, files.get(uri)!.length);
                    writeBytes(uri, bytes, offset);
                    offset += bytes.length;
                },
                close() { closed = true; close(uri); },
            };
        }
    }
    return { module: { Directory, File, Paths: { cache: cacheUri } }, files, close, deleteFile, open, create, writeBytes, writes };
}
