import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readTransferPayloadChunk, resolveTransferPayloadSizeBytes } from '@/machines/transfer/transferPayloadSource';
import { createWorkspaceSyncEntryExport, stageWorkspaceSyncEntryExport } from './workspaceSyncEntryTransfer';
import { observeWorkspaceSyncEntryAtRoot } from './workspaceSyncFileRead';

describe('workspace sync captured entry transfer', () => {
  it('rejects a staged blob that differs from the approved file', async () => {
    const captured = await mkdtemp(join(tmpdir(), 'workspace-sync-entry-captured-'));
    const staged = await mkdtemp(join(tmpdir(), 'workspace-sync-entry-staged-'));
    const bytes = Buffer.from([0, 1, 2, 255]);
    const source = join(captured, 'value.bin');
    await writeFile(source, bytes);
    const expectation = {
      kind: 'file' as const,
      digest: createHash('sha1').update(bytes).digest('hex'),
      executable: false,
      size: bytes.length,
    };
    const prepared = await createWorkspaceSyncEntryExport({
      operationId: 'resolution-tampered', expectation, materialPath: source,
    });
    try {
      await expect(stageWorkspaceSyncEntryExport({
        operationId: 'resolution-tampered', stagingDirectory: staged, expectation,
        requestPayload: async ({ transferId, destinationPath }) => {
          const payload = transferId === 'resolution-tampered'
            ? prepared.payloadSource
            : await prepared.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null });
          const size = await resolveTransferPayloadSizeBytes(payload);
          const content = await readTransferPayloadChunk({ source: payload, offset: 0, length: size });
          await writeFile(destinationPath, transferId === 'resolution-tampered' ? content : Buffer.from('other'));
        },
      })).rejects.toMatchObject({ code: 'conflict_changed' });
    } finally {
      await Promise.all([captured, staged].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });
  it('keeps large binary file contents file-backed while staging the exact approved tree', async () => {
    const captured = await mkdtemp(join(tmpdir(), 'workspace-sync-entry-captured-'));
    const staged = await mkdtemp(join(tmpdir(), 'workspace-sync-entry-staged-'));
    await mkdir(join(captured, 'nested'));
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 9, 0xa5);
    const source = join(captured, 'nested', 'large.bin');
    await writeFile(source, bytes);
    const expectation = await observeWorkspaceSyncEntryAtRoot({
      rootPath: dirname(captured), relativePath: basename(captured),
    });
    const prepared = await createWorkspaceSyncEntryExport({
      operationId: 'resolution-transfer', expectation, materialPath: captured,
    });
    expect(prepared.blobs).toEqual([{ transferId: expect.stringContaining('resolution-transfer:entry-blob:'), sizeBytes: bytes.length,
      manifestHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]);
    const published = new Map([["resolution-transfer", prepared.payloadSource]]);
    const materialPath = await stageWorkspaceSyncEntryExport({
      operationId: 'resolution-transfer', stagingDirectory: staged, expectation,
      requestPayload: async ({ transferId, destinationPath, expectedSizeBytes, expectedManifestHash }) => {
        expect(expectedSizeBytes === undefined).toBe(expectedManifestHash === undefined);
        const sourcePayload = published.get(transferId) ?? await prepared.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null });
        const size = await resolveTransferPayloadSizeBytes(sourcePayload);
        await writeFile(destinationPath, await readTransferPayloadChunk({ source: sourcePayload, offset: 0, length: size }));
      },
    });
    expect(materialPath).toBe(join(staged, 'entry'));
    await expect(readFile(join(staged, 'entry', 'nested', 'large.bin'))).resolves.toEqual(bytes);
    expect(createHash('sha1').update(bytes).digest('hex')).toHaveLength(40);
    await Promise.all([captured, staged].map(async (path) => await rm(path, { recursive: true, force: true })));
  });
});
