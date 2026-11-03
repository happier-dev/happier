import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDirectTransferImportSessionManager } from '@/machines/transfer/directTransferImportSession';
import { createDirectPeerTransferApp, requestDirectPeerTransferToFile } from '@/machines/transfer/directPeerTransport';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { runFilesystemEffectInternal } from './filesystemEffectInternal';
import { createFilesystemEffectChannel, createFilesystemEffectImportAdapter,
  initializeFilesystemEffectChannel, openFilesystemEffectDownload, openFilesystemEffectEntryExport,
  prepareFilesystemEffectEntryDestination } from './filesystemEffectChannel';
import { readTransferPayloadChunk, resolveTransferPayloadSizeBytes } from '@/machines/transfer/transferPayloadSource';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { FilesystemEffectConfiguration } from './filesystemEffectOperation';

async function openNativePipe(root: string, configuration: Partial<FilesystemEffectConfiguration> = {}) {
  // The process pipes are the genuine OS/process boundary. All native dispatch,
  // path policy, file IO, encryption and mounted transport owners remain real.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runFilesystemEffectInternal(stdin, stdout);
  const channel = createFilesystemEffectChannel({ input: stdin, output: stdout, dispose: async () => { await running; } });
  await initializeFilesystemEffectChannel(channel, { workingDirectory: root,
    accessPolicy: { kind: 'restrictedRoots', roots: [root] }, ...configuration });
  return channel;
}

describe('native filesystem mounted byte corridor', () => {
  it('dispatches admitted capabilities through the native service with requester Account metadata', async () => {
    await withTempDir('happier-native-capabilities-', async root => {
      const channel = await openNativePipe(root);
      const invoke = (method: string, input: unknown) => channel.request({ kind: 'filesystem.rpc', method, input });
      try {
        await expect(invoke(RPC_METHODS.CAPABILITIES_DETECT, {
          requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [] } }],
        })).resolves.toMatchObject({ protocolVersion: 1, results: {
          'tool.acpAgentInventory': { ok: false, error: { code: 'account-unavailable' } },
        } });
        await expect(invoke(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.claude', method: 'unknown' }))
          .resolves.toMatchObject({ ok: false, error: { code: 'unsupported-method' } });
        await expect(invoke('unknown.native.method', {}))
          .rejects.toMatchObject({ code: 'filesystem_identity_custody_unavailable' });
      } finally { await channel.dispose(); }
      const selectedAccountChannel = await openNativePipe(root, { requesterAccountId: 'member-a' });
      try {
        await expect(selectedAccountChannel.request({ kind: 'filesystem.rpc', method: RPC_METHODS.CAPABILITIES_DETECT,
          input: { requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [] } }] },
        })).resolves.toMatchObject({ protocolVersion: 1, results: {
          'tool.acpAgentInventory': { ok: true, data: { items: [] } },
        } });
      } finally { await selectedAccountChannel.dispose(); }
    });
  });

  it('keeps registered predecessor and current RPC aliases inside the same native effect owner', async () => {
    await withTempDir('happier-native-rpc-alias-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member); await mkdir(neighbor);
      await writeFile(join(member, 'owned.txt'), 'native alias fixture');
      await writeFile(join(neighbor, 'private.txt'), 'neighbor fixture');
      const channel = await openNativePipe(member);
      const invoke = (method: string, input: unknown) => channel.request({ kind: 'filesystem.rpc', method, input });
      try {
        for (const method of ['readFile', 'daemon.filesystem.readFile']) {
          await expect(invoke(method, { path: join(member, 'owned.txt') })).resolves.toMatchObject({
            success: true, content: Buffer.from('native alias fixture').toString('base64'),
          });
          await expect(invoke(method, { path: join(neighbor, 'private.txt') }))
            .resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
        }
        await expect(invoke('listDirectory', { path: member })).resolves.toMatchObject({
          success: true, entries: [expect.objectContaining({ name: 'owned.txt' })],
        });
        await expect(invoke('writeFile', { path: join(member, 'written.txt'), content: Buffer.from('native write').toString('base64') }))
          .resolves.toMatchObject({ success: true });
        expect(await readFile(join(member, 'written.txt'), 'utf8')).toBe('native write');
        await expect(invoke('daemon.filesystem.writeFile', { rootPath: member, path: 'rooted.txt',
          content: Buffer.from('rooted native write').toString('base64') })).resolves.toMatchObject({ success: true });
        await expect(invoke('daemon.filesystem.copy', { rootPath: member, from: 'rooted.txt', to: 'rooted-copy.txt',
          overwrite: false, recursive: false })).resolves.toMatchObject({ success: true });
        expect(await readFile(join(member, 'rooted-copy.txt'), 'utf8')).toBe('rooted native write');
      } finally { await channel.dispose(); }
    });
  });

  it('captures and installs a prepared directory copy through the same native entry owners', async () => {
    await withTempDir('happier-native-entry-copy-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member); await mkdir(neighbor);
      await mkdir(join(member, 'source'));
      await writeFile(join(member, 'source', 'owned.txt'), 'copied fixture');
      await writeFile(join(neighbor, 'private.txt'), 'neighbor fixture');
      const channel = await openNativePipe(member);
      const exported = await openFilesystemEffectEntryExport(channel, { rootPath: member, path: join(member, 'source'), operationId: 'entry_copy' });
      const destination = await prepareFilesystemEffectEntryDestination(channel, { operationId: 'entry_copy',
        rootPath: member, path: join(member, 'destination'), overwrite: false, recursive: true, expectation: exported.entryTree.expectation });
      try {
        const payloads = [{ transferId: 'entry_copy', source: exported.payloadSource }, ...await Promise.all(exported.entryTree.blobs.map(async blob => ({
          transferId: blob.transferId, source: await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: blob.transferId, requestBody: null }),
        })))];
        const imported: Array<{ transferId: string; uploadId: string }> = [];
        for (const payload of payloads) {
          const sizeBytes = await resolveTransferPayloadSizeBytes(payload.source);
          const opened = await destination.importSession.openTrustedImportSession({ t: 'session_file_upload_v1',
            workingDirectory: member, path: 'entry-payload', sizeBytes, overwrite: false });
          if (!opened.success) throw new Error(opened.error);
          const bytes = await readTransferPayloadChunk({ source: payload.source, offset: 0, length: sizeBytes });
          const encrypted = createEncryptedTransferChunkEnvelope({ transferId: opened.response.uploadId, sequence: 0,
            payload: bytes, recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64 });
          await expect(destination.importSession.writeImportTransferChunk({ uploadId: opened.response.uploadId, index: 0,
            payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 })).resolves.toMatchObject({ success: true });
          await expect(destination.importSession.finalizeImportTransferSession({ uploadId: opened.response.uploadId })).resolves.toMatchObject({ success: true });
          imported.push({ transferId: payload.transferId, uploadId: opened.response.uploadId });
        }
        await expect(destination.apply(imported)).resolves.toMatchObject({ status: 'installed' });
        expect(await readFile(join(member, 'destination', 'owned.txt'), 'utf8')).toBe('copied fixture');
        await expect(openFilesystemEffectEntryExport(channel, { rootPath: neighbor, path: join(neighbor, 'private.txt'), operationId: 'denied_entry' }))
          .rejects.toMatchObject({ code: 'access_denied' });
      } finally { await destination.dispose(false); await exported.payloadSource.dispose(); await channel.dispose(); }
    });
  });

  it.each([false, true])('uploads encrypted mounted bytes (overwrite=%s) into the admitted tree and rejects a neighboring destination before mutation', async overwrite => {
    await withTempDir('happier-native-upload-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member); await mkdir(neighbor);
      await writeFile(join(neighbor, 'private.dat'), 'neighbor fixture');
      if (overwrite) await writeFile(join(member, 'binary.dat'), 'previous admitted contents');
      const channel = await openNativePipe(member);
      const nativeImport = createFilesystemEffectImportAdapter(channel);
      const manager = createDirectTransferImportSessionManager({ accessPolicy: { kind: 'osUser' } });
      const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
      const scope = { rootPath: member, requesterAccountId: 'member-a', nativeImport };
      try {
        const bytes = Buffer.from([0, 255, 128, 10]);
        const prepared = await manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: member,
          path: 'binary.dat', sizeBytes: bytes.length, overwrite }, scope);
        if (!prepared.success) throw new Error(prepared.error);
        const settlement = manager.waitForImportTransferSettlement(prepared.response.uploadId, scope);
        const encrypted = createEncryptedTransferChunkEnvelope({ transferId: prepared.response.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: prepared.response.recipientPublicKeyBase64 });
        const chunk = await app.inject({ method: 'PUT',
          url: `/machine-transfers/direct/imports/${prepared.response.uploadId}/chunks/0`,
          payload: { payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 } });
        expect(chunk.statusCode).toBe(200);
        const finalized = await app.inject({ method: 'POST', url: `/machine-transfers/direct/imports/${prepared.response.uploadId}/finalize` });
        expect(finalized.statusCode).toBe(200);
        await expect(settlement).resolves.toMatchObject({ success: true });
        expect(await readFile(join(member, 'binary.dat'))).toEqual(bytes);
        expect(manager.countActiveImportSessions()).toBe(0);
        await expect(manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: neighbor,
          path: 'private.dat', sizeBytes: bytes.length, overwrite: true,
          additionalAllowedWriteDirs: [neighbor] }, { ...scope, rootPath: neighbor }))
          .resolves.toMatchObject({ success: false });
        expect(await readFile(join(neighbor, 'private.dat'), 'utf8')).toBe('neighbor fixture');
      } finally { await app.close(); await manager.close(); await channel.dispose(); }
    });
  });

  it('serves real mounted binary downloads through native callbacks and refuses cross-root and symlink disclosure', async () => {
    await withTempDir('happier-native-download-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member); await mkdir(neighbor);
      const bytes = Buffer.from([255, 0, 128, 13, 10]);
      await writeFile(join(member, 'binary.dat'), bytes);
      await writeFile(join(neighbor, 'private.dat'), 'neighbor fixture');
      await symlink(join(neighbor, 'private.dat'), join(member, 'link.dat'));
      const channel = await openNativePipe(member);
      const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
      try {
        const source = await openFilesystemEffectDownload(channel, { path: 'binary.dat', asZip: false });
        const published = await lifecycle.publishTransferWhenReady({ transferId: 'native-member-download', payloadSource: source });
        const destinationPath = join(root, 'received.dat');
        await requestDirectPeerTransferToFile({ transferId: published.transferId,
          endpointCandidates: published.endpointCandidates, destinationPath });
        expect(await readFile(destinationPath)).toEqual(bytes);
        await expect(openFilesystemEffectDownload(channel, { path: join(neighbor, 'private.dat'), asZip: false })).rejects.toThrow();
        await expect(openFilesystemEffectDownload(channel, { path: 'link.dat', asZip: false })).rejects.toThrow();
      } finally { await lifecycle.stop(); await channel.dispose(); }
    });
  });

  it('ends a retained native pipe without leaving an incomplete upload target', async () => {
    await withTempDir('happier-native-upload-close-', async root => {
      const channel = await openNativePipe(root);
      const nativeImport = createFilesystemEffectImportAdapter(channel);
      const prepared = await nativeImport.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: root,
        path: 'incomplete.dat', sizeBytes: 4, overwrite: false });
      expect(prepared.success).toBe(true);
      await channel.dispose();
      await expect(readFile(join(root, 'incomplete.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(channel.request({ kind: 'action', actionId: 'daemon.filesystem.listDirectory', input: { rootPath: root, path: '.' } })).rejects.toThrow();
    });
  });
});
