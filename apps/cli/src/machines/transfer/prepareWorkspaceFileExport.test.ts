import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerMachineDirectTransferExportRpcHandlers } from '@/api/machine/rpcHandlers.directTransferExports';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER } from './directPeerTransport/protocol';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { prepareWorkspaceEntryExport, prepareWorkspaceFileExport } from './prepareWorkspaceFileExport';
import { buildDirectPeerTransferEndpointPath, requestDirectPeerTransferToFile } from './directPeerTransport';
import { resolveOwnServerImageArchivePathForHost, verifyOwnServerImageArchiveForHost } from '@/deployments/targets/ownServer/releaseProvenance';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from '@/deployments/targets/ownServer/paths';

describe('workspace file export custody', () => {
  // The existing native confined-parent producer is Linux-only; other hosts
  // retain ordinary owner IO and refuse this protected exact-file grant.
  it.runIf(process.platform === 'linux').each(['file', 'symlink', 'content'] as const)('retains exact archive byte custody across %s replacement', async replacement => {
    const root = await mkdtemp(join(tmpdir(), 'happier-export-exact-source-'));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const bytes = Buffer.from([0, 255, 128, 10]);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const deploymentRoot = join(root, 'deployments');
      const source = resolveOwnServerImageArchivePathForHost({ deploymentRoot,
        environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'), deploymentId: 'receipt' }, sha256);
      await mkdir(source.rootPath, { recursive: true, mode: 0o700 });
      await writeFile(source.path, bytes, { mode: 0o600 });
      const verified = await verifyOwnServerImageArchiveForHost({ deploymentRoot, serverId: 'home', environmentId: 'environment', selectedDeploymentId: 'receipt',
        source, retainReadFile: true });
      if (!verified.readFile) throw new Error('Missing exact host-acquired source custody');
      handle = verified.readFile.handle;
      if (replacement === 'content') await writeFile(source.path, Buffer.alloc(bytes.length, 7));
      else {
        await rename(source.path, `${source.path}.original`);
        if (replacement === 'symlink') {
          const outside = join(root, 'outside-private');
          await writeFile(outside, 'outside private fixture', { mode: 0o600 });
          await symlink(outside, source.path, 'file');
        } else await writeFile(source.path, 'substituted private fixture', { mode: 0o600 });
      }
      const prepare = () => prepareWorkspaceEntryExport({ lifecycle, rootPath: source.rootPath, path: source.path,
        operationId: 'archive-source', accessPolicy: { kind: 'osUser' },
        filesystemScope: { rootPath: source.rootPath, requesterAccountId: 'requester', destinationId: 'receiver' },
        assertCurrentAuthority: async () => {}, admittedReadFile: verified.readFile });
      if (replacement === 'content') {
        await expect(prepare()).rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
        expect(lifecycle.getState().publishedTransferCount).toBe(0);
        await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
        return;
      }
      const prepared = await prepare();
      const blob = prepared.entryTree.blobs[0];
      if (!blob) throw new Error('Missing admitted source blob');
      const endpointCandidates = prepared.prepared.endpointCandidates.map(candidate => {
        const url = new URL(candidate.url);
        url.pathname = buildDirectPeerTransferEndpointPath(blob.transferId);
        return { ...candidate, url: url.toString() };
      });
      const destinationPath = join(root, 'received');
      await requestDirectPeerTransferToFile({ transferId: blob.transferId, endpointCandidates, destinationPath });
      expect((await readFile(destinationPath)).equals(bytes)).toBe(true);
    } finally { await lifecycle.stop(); await handle?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('admits the captured filesystem owner before observing the source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-export-admission-'));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    try {
      const prepare = () => prepareWorkspaceFileExport({ lifecycle,
        request: { workingDirectory: root, path: 'not-present', asZip: false },
        filesystemScope: { rootPath: root, requesterAccountId: 'requester', assertCurrentAuthority: async () => {
          throw Object.assign(new Error('Filesystem identity custody is unavailable'), {
            errorCode: 'filesystem_identity_custody_unavailable',
          });
        } } });
      await expect(prepare()).rejects.toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
      const handlers = new Map<string, RpcHandler>();
      registerMachineDirectTransferExportRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
        prepareExportSession: prepare,
      });
      const invoke = handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
      if (!invoke) throw new Error('Missing registered export owner');
      await expect(invoke({ t: 'workspace_file_download_v1', workingDirectory: root, path: 'not-present', asZip: false }))
        .resolves.toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      expect(lifecycle.getState()).toMatchObject({ status: 'stopped', publishedTransferCount: 0 });
    } finally { await lifecycle.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['present_user', 'account_automation'] as const)('retains %s owner admission across mounted open, cached chunks and completion', async callerAuthority => {
    const root = await mkdtemp(join(tmpdir(), 'happier-export-mounted-custody-'));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    let current = true;
    let retireAfterAdmission = false;
    const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' });
    const context = { signal: new AbortController().signal, callerAuthority,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => current };
    const scope = { rootPath: root, requesterAccountId: 'requester', destinationId: 'receiver', assertCurrentAuthority: async () => {
      const failure = await admission.rpc(context);
      if (failure) throw Object.assign(new Error(failure.error), { errorCode: failure.errorCode });
      if (retireAfterAdmission) {
        retireAfterAdmission = false;
        queueMicrotask(() => { current = false; });
      }
    } };
    try {
      await writeFile(join(root, 'file.bin'), Buffer.from([0, 255, 128, 10]));
      const prepared = await prepareWorkspaceFileExport({ lifecycle,
        request: { workingDirectory: root, path: 'file.bin', asZip: false }, filesystemScope: scope });
      const endpoint = prepared.endpointCandidates.find(candidate => candidate.kind === 'http');
      if (!endpoint?.authorizationToken) throw new Error('Missing mounted transfer endpoint');
      const { recipientPublicKeyBase64 } = createTransferRecipientKeyPair();
      const headers = { authorization: `Bearer ${endpoint.authorizationToken}`,
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: recipientPublicKeyBase64 };
      const open = () => fetch(`${endpoint.url}/open`, { method: 'POST', headers });
      const chunk = () => fetch(`${endpoint.url}/chunks/0`, { headers });
      expect((await open()).status).toBe(200);
      expect((await chunk()).status).toBe(200);
      current = false;
      for (const response of [await open(), await chunk()]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      const complete = () => fetch(`${endpoint.url}/complete`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
          destinationId: 'receiver', success: true, sizeBytes: prepared.sizeBytes, manifestHash: prepared.manifestHash,
        }) });
      expect((await complete()).status).toBe(400);
      current = true;
      retireAfterAdmission = true;
      const retiredDuringRead = await chunk();
      expect(retiredDuringRead.status).toBe(401);
      expect(await retiredDuringRead.json()).toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
      current = true;
      expect((await chunk()).status).toBe(200);
      expect((await complete()).status).toBe(200);
      expect(lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await lifecycle.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
