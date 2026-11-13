import { chmod, readdir, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { DaemonFilesystemListRootsResponseSchema } from '@happier-dev/protocol/machines/fileBrowser';

import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
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

async function openNativePipe(root: string, configuration: Partial<FilesystemEffectConfiguration> = {},
  onDirectoryPreflightRefused?: (diagnostic: unknown) => void) {
  // The process pipes are the genuine OS/process boundary. All native dispatch,
  // path policy, file IO, encryption and mounted transport owners remain real.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runFilesystemEffectInternal(stdin, stdout).then(() => ({ ok: true as const }), (error: unknown) => {
    stdout.destroy(error instanceof Error ? error : new Error(String(error)));
    return { ok: false as const, error };
  });
  const channel = createFilesystemEffectChannel({ input: stdin, output: stdout, onDirectoryPreflightRefused, dispose: async () => {
    const result = await running;
    if (!result.ok) throw result.error;
  } });
  try {
    await initializeFilesystemEffectChannel(channel, { workingDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] }, ...configuration });
  } catch (error) { await channel.dispose().catch(() => {}); throw error; }
  return channel;
}

describe('native filesystem mounted byte corridor', () => {
  it.skipIf(process.platform === 'win32')('starts member roots and directory preflight beyond traverse-only parents without listing them', async () => {
    await withTempDir('member-browser-traverse-', async root => {
      const parent = join(root, 'members');
      const home = join(parent, 'member');
      const workspace = join(home, 'workspace');
      const neighbor = join(parent, 'neighbor');
      await mkdir(workspace, { recursive: true });
      await mkdir(neighbor, { mode: 0o000 });
      await chmod(parent, 0o111);
      vi.stubEnv('HOME', home);
      vi.spyOn(process, 'cwd').mockReturnValue(workspace);
      const channel = await openNativePipe(workspace, { accessPolicy: { kind: 'osUser' }, capabilityAgentInstallExecutionScope: 'member' });
      try {
        await expect(readdir(parent)).rejects.toMatchObject({ code: 'EACCES' });
        const result = DaemonFilesystemListRootsResponseSchema.parse(await channel.request({ kind: 'filesystem.rpc',
          method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS, input: {} }));
        expect(result).toMatchObject({ ok: true, roots: [{ path: home }, { path: workspace }] });
        if (!result.ok) throw new Error(result.error);
        for (const { path } of result.roots) {
          await expect(channel.request({ kind: 'filesystem.rpc', method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            input: { path, includeFiles: false } })).resolves.toMatchObject({ ok: true, path });
          await expect(channel.request({ kind: 'filesystem.rpc', method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
            input: { directory: { kind: 'path', path } } })).resolves.toMatchObject({ ok: true, directory: path });
        }
        await expect(channel.request({ kind: 'filesystem.rpc', method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
          input: { path: neighbor } })).resolves.toMatchObject({ ok: false, errorCode: 'EACCES' });
      } finally {
        await channel.dispose();
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        await chmod(parent, 0o700); await chmod(neighbor, 0o700);
      }
    });
  });

  it('returns the worker preflight refusal facts over its private pipe without changing the public result', async () => {
    await withTempDir('happier-native-preflight-diagnostic-', async root => {
      const folder = join(root, 'not-a-folder');
      await writeFile(folder, 'file');
      const diagnostics: unknown[] = [];
      const channel = await openNativePipe(root, {}, diagnostic => diagnostics.push(diagnostic));
      const invoke = (path: string) => channel.request({ kind: 'filesystem.rpc',
        method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
        input: { directory: { kind: 'path', path } } });
      try {
        await expect(invoke(folder)).resolves.toEqual({ ok: false, code: 'invalid_directory' });
        expect(diagnostics).toEqual([{
          branch: 'directory_readiness', directoryKind: 'path', requestedDirectory: folder, directory: folder,
          ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}),
        }]);
        await expect(invoke(root)).resolves.toMatchObject({ ok: true, directory: root });
        expect(diagnostics).toHaveLength(1);
        await expect(invoke('relative/path')).resolves.toEqual({ ok: false, code: 'invalid_directory' });
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[1]).toEqual({ branch: 'canonical_path', directoryKind: 'path',
          requestedDirectory: 'relative/path', ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}) });
      } finally { await channel.dispose(); }
    });
  });

  it('retains Session attachment custody through encrypted upload, finalization and handle-only previews', async () => {
    await withTempDir('happier-native-attachment-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member); await mkdir(neighbor);
      const channel = await openNativePipe(member, { sessionAttachment: { sessionId: 'session-a' } });
      const foreign = await openNativePipe(neighbor, { sessionAttachment: { sessionId: 'session-b' } });
      const invoke = (method: string, input: unknown) => channel.request({ kind: 'rpc', method, input });
      const bytes = Buffer.from([255, 0, 128, 13, 10]);
      const request = { t: 'session_attachment_upload_v1', sessionId: 'session-a',
        messageLocalId: 'message-a', attachmentId: 'attachment-a', fileName: 'notes.dat', sizeBytes: bytes.length,
        uploadLocation: 'os_temp', workspaceRelativeDir: '.happier/attachments',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false };
      try {
        for (const input of [
          { ...request, sessionId: 'session-b' },
          { t: 'session_file_upload_v1', path: 'generic.dat', sizeBytes: 0 },
          { t: 'composer_media_stage_upload_v1', path: 'generic.dat', sizeBytes: 0 },
          { ...request, workspaceRelativeDir: '../member-b' },
        ]) await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, input))
          .resolves.toMatchObject({ response: { success: false } });

        // Caller workspace hints cannot replace the host-fixed Session directory.
        const opened = z.object({ response: z.object({ success: z.literal(true), uploadId: z.string(),
          recipientPublicKeyBase64: z.string() }), expiresAt: z.number() }).parse(
          await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { ...request,
            workingDirectory: neighbor, workspaceRootPath: neighbor }));
        const encrypted = createEncryptedTransferChunkEnvelope({ transferId: opened.response.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64 });
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
          { uploadId: opened.response.uploadId, index: 0, ...encrypted })).resolves.toMatchObject({ response: { success: true } });
        const finalized = z.object({ response: z.object({ success: z.literal(true), attachmentHandle: SessionAttachmentHandleV1Schema }),
          issuedAttachment: z.object({ handle: SessionAttachmentHandleV1Schema, filePath: z.string(),
            displayPath: z.string(), name: z.string(), sizeBytes: z.number(), attachmentId: z.string() }) }).parse(
          await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: opened.response.uploadId }));
        expect(finalized.issuedAttachment).toMatchObject({ handle: finalized.response.attachmentHandle,
          name: 'notes.dat', sizeBytes: bytes.length, attachmentId: 'attachment-a' });
        expect(finalized.issuedAttachment.filePath.startsWith(join(member, '.happier', 'attachments'))).toBe(true);
        expect(await readFile(finalized.issuedAttachment.filePath)).toEqual(bytes);

        const recipient = createTransferRecipientKeyPair();
        const preview = { t: 'session_attachment_download_v1', attachmentHandle: finalized.response.attachmentHandle,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
        for (const input of [
          { ...preview, attachmentHandle: { ...preview.attachmentHandle, sessionId: 'session-b' } },
          { ...preview, attachmentHandle: { ...preview.attachmentHandle, id: 'forged-handle' } },
          { ...preview, path: finalized.issuedAttachment.filePath },
          { t: 'session_file_download_v1', path: finalized.issuedAttachment.filePath,
            recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 },
        ]) await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, input))
          .resolves.toMatchObject({ response: { success: false } });
        await expect(foreign.request({ kind: 'rpc', method: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
          input: { ...preview, attachmentHandle: { ...preview.attachmentHandle, sessionId: 'session-b' } } }))
          .resolves.toMatchObject({ response: { success: false } });

        // Finalizing one preview must leave the issued handle with this Session owner.
        for (let index = 0; index < 2; index++) {
          const download = z.object({ response: z.object({ success: z.literal(true), downloadId: z.string() }) })
            .parse(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, preview));
          const chunk = z.object({ response: z.object({ success: z.literal(true), payloadBase64: z.string(),
            encryptedDataKeyEnvelopeBase64: z.string(), isLast: z.literal(true) }) }).parse(
            await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId: download.response.downloadId, index: 0 }));
          expect(decryptEncryptedTransferChunkEnvelope({ transferId: download.response.downloadId, sequence: 0,
            payloadBase64: chunk.response.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.response.encryptedDataKeyEnvelopeBase64,
            recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
          await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId: download.response.downloadId }))
            .resolves.toMatchObject({ response: { success: true } });
        }
      } finally { await foreign.dispose(); await channel.dispose(); }
    });
  });

  it('keeps Machine native transfer custody generic and refuses attachment intake', async () => {
    await withTempDir('happier-native-machine-transfer-', async root => {
      const channel = await openNativePipe(root);
      const invoke = (method: string, input: unknown) => channel.request({ kind: 'rpc', method, input });
      try {
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { t: 'session_attachment_upload_v1',
          sessionId: 'session-a', messageLocalId: 'message-a', fileName: 'notes.dat', sizeBytes: 0 }))
          .resolves.toMatchObject({ response: { success: false, errorCode: 'filesystem_identity_custody_unavailable' } });
        const opened = z.object({ response: z.object({ success: z.literal(true), uploadId: z.string() }) }).parse(
          await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { t: 'session_file_upload_v1', path: 'generic.dat', sizeBytes: 0 }));
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: opened.response.uploadId }))
          .resolves.toMatchObject({ response: { success: true } });
      } finally { await channel.dispose(); }
    });
  });

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
