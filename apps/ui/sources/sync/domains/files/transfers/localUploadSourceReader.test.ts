/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeOpenSpy = vi.fn();
const nativeCloseSpy = vi.fn();

vi.mock('expo-file-system', () => {
    class FakeFileHandle {
        offset: number | null = 0;
        size: number | null;
        private readonly bytes: Uint8Array;

        constructor(bytes: Uint8Array) {
            this.bytes = bytes;
            this.size = bytes.byteLength;
        }

        close() {
            nativeCloseSpy();
        }

        readBytes(length: number): Uint8Array {
            const start = this.offset ?? 0;
            const chunk = this.bytes.slice(start, start + length);
            this.offset = start + chunk.byteLength;
            return chunk;
        }
    }

    class FakeFile {
        uri: string;
        size: number;

        constructor(uri: string) {
            this.uri = uri;
            this.size = 5;
        }

        open() {
            nativeOpenSpy();
            return new FakeFileHandle(new TextEncoder().encode('hello'));
        }
    }

    return { File: FakeFile };
});

afterEach(() => {
    nativeOpenSpy.mockReset();
    nativeCloseSpy.mockReset();
});

describe('localUploadSourceReader', () => {
    it('reads web file bytes without opening a native handle', async () => {
        const { openLocalUploadSourceReader } = await import('./localUploadSourceReader');
        const bytes = new TextEncoder().encode('hello');
        const file = {
            size: 5,
            slice: (start: number, end: number) => ({
                arrayBuffer: async () => bytes.slice(start, end).buffer,
            }),
        } as File;

        const reader = await openLocalUploadSourceReader({
            kind: 'web',
            file,
        });

        expect(reader.sizeBytes).toBe(5);
        expect(new TextDecoder().decode(await reader.readBytes(1, 3))).toBe('ell');
        await reader.close();
        expect(nativeOpenSpy).not.toHaveBeenCalled();
    });

    it('reuses and closes a native file handle while resolving size from the handle', async () => {
        const { openLocalUploadSourceReader, resolveLocalUploadSourceSizeBytes } = await import('./localUploadSourceReader');

        const resolvedSize = await resolveLocalUploadSourceSizeBytes({
            kind: 'native',
            uri: 'file:///tmp/hello.txt',
            sizeBytes: null,
        });

        expect(resolvedSize).toBe(5);
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);

        nativeOpenSpy.mockReset();
        nativeCloseSpy.mockReset();

        const reader = await openLocalUploadSourceReader({
            kind: 'native',
            uri: 'file:///tmp/hello.txt',
            sizeBytes: null,
        });

        expect(reader.sizeBytes).toBe(5);
        expect(new TextDecoder().decode(await reader.readBytes(0, 2))).toBe('he');
        expect(new TextDecoder().decode(await reader.readBytes(2, 2))).toBe('ll');
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);

        await reader.close();
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });
});
