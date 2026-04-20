import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const xzReadableStreamCtorMock = vi.hoisted(() => vi.fn());
const tarXMock = vi.hoisted(() => vi.fn());

vi.mock('xz-decompress', () => ({
    XzReadableStream: undefined,
    default: {
        XzReadableStream: xzReadableStreamCtorMock,
    },
}));

vi.mock('tar', () => ({
    x: tarXMock,
}));

import { extractArchivePayloadToDirectory } from './extractArchivePayloadToDirectory';

describe('extractArchivePayloadToDirectory', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('treats .tgz archives as gzip-compressed tar payloads', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cli-common-extract-archive-'));
        try {
            const archivePath = join(root, 'payload.tgz');
            const extractDir = join(root, 'extract');
            writeFileSync(archivePath, 'compressed payload\n', 'utf8');

            await expect(
                extractArchivePayloadToDirectory({
                    archivePath,
                    archiveName: 'payload.tgz',
                    extractDir,
                }),
            ).resolves.toBeUndefined();

            expect(tarXMock).toHaveBeenCalledWith({
                file: archivePath,
                cwd: extractDir,
                strict: true,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the xz-decompress default export when extracting tar.xz archives', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cli-common-extract-archive-'));
        try {
            const archivePath = join(root, 'payload.tar.xz');
            const extractDir = join(root, 'extract');
            writeFileSync(archivePath, 'compressed payload\n', 'utf8');

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                },
            });
            xzReadableStreamCtorMock.mockImplementation(() => stream);
            tarXMock.mockReturnValue(
                new Writable({
                    write(_chunk, _encoding, callback) {
                        callback();
                    },
                }),
            );

            await expect(
                extractArchivePayloadToDirectory({
                    archivePath,
                    archiveName: 'payload.tar.xz',
                    extractDir,
                }),
            ).resolves.toBeUndefined();

            expect(xzReadableStreamCtorMock).toHaveBeenCalledTimes(1);
            expect(tarXMock).toHaveBeenCalledWith({ cwd: extractDir, strict: true });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
