import { setup, DOWNLOAD_PLUGIN_ID, transferRootToken } from './approvedTransferCustody.testkit';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemDownloadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';
import { requestDirectPeerTransferToFile } from './directPeerTransport';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('installed filesystem Action operation custody', () => {
  it('downloads stored Session media through the installed physical custodian Account Action', async () => {
    const fixture = await setup(false);
    try {
      const bytes = Buffer.from([26, 69, 223, 163, 0, 255, 128, 1]);
      await writeFile(join(fixture.directory, 'recording.webm'), bytes);
      let admission: unknown;
      const client = createPreparedFilesystemTransferClient({
        executeAction: async (actionId, input) => {
          if (actionId !== 'daemon.filesystem.download') throw new Error(`Unexpected Action: ${actionId}`);
          const result = await fixture.invoke(actionId, input, 'stored-recording-download', false, 'alice', 'ui');
          admission = result;
          return result;
        },
        openMachineTunnel: async () => ({ localPort: await fixture.lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} }),
      });
      const downloaded = await client.download({ targetMachineId: 'machine', rootPath: fixture.directory, path: 'recording.webm', asZip: false,
        destinationId: 'stored-recording-viewer', destinationPath: join(fixture.directory, 'playback.webm') });
      expect(admission, JSON.stringify(admission)).toMatchObject({ ok: true, result: { success: true, status: 'accepted' } });
      expect(downloaded).toMatchObject({ success: true, status: 'completed', destinationId: 'stored-recording-viewer', sizeBytes: bytes.length });
      expect(await readFile(join(fixture.directory, 'playback.webm'))).toEqual(bytes);
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await fixture.close(); }
  });
  it.each(['agent deferred approval', 'present-person structured RPC'] as const)('completes a physical provider download as its original requester through %s until receiver ACK', async ingress => {
    const fixture = await setup(false, true, true);
    let executionFailureCode: string | null = null;
    let downloadStatus: string | null = null;
    try {
      const destination = { destinationId: 'provider-reader' };
      const rpc = ingress === 'present-person structured RPC';
      const requested = await fixture.invoke('action.invoke', { action: { pluginId: DOWNLOAD_PLUGIN_ID, localId: 'download' },
        input: { destination } }, 'provider-download', rpc, 'bob', rpc ? 'ui' : 'agent');
      if (!requested.ok) executionFailureCode = requested.errorCode ?? null;
      if (rpc && requested.ok) {
        const native = FilesystemDownloadOutputSchema.safeParse(requested.result);
        if (native.success) {
          downloadStatus = native.data.status;
          if (!native.data.success) executionFailureCode = native.data.errorCode ?? null;
        } else if (ActionApprovalRequestCreatedResultSchema.safeParse(requested.result).success) downloadStatus = 'approval_request_created';
      }
      let download: unknown;
      if (rpc) {
        expect(requested, JSON.stringify({ downloadStatus, executionFailureCode }))
          .toMatchObject({ ok: true, result: { status: 'accepted' } });
        expect(fixture.approvalOwnerAccountId()).toBeUndefined();
        if (!requested.ok) throw new Error('Present-person provider download was refused');
        download = requested.result;
      } else {
        expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        // The custodian's real approval writer created this Artifact; do not invent cross-Account edit access.
        expect(fixture.approvalOwnerAccountId()).toBe('alice');
        expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
        const decided = await fixture.approve('alice');
        expect(decided, decided.ok ? undefined : `${decided.errorCode}: ${decided.error}`)
          .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'accepted' } } } });
        if (!decided.ok || !decided.result || typeof decided.result !== 'object' || !('execution' in decided.result)
          || !decided.result.execution || typeof decided.result.execution !== 'object' || !('result' in decided.result.execution)) {
          throw new Error('Approved provider download did not return its transfer receipt');
        }
        download = decided.result.execution.result;
      }
      const receipt = FilesystemDownloadOutputSchema.parse(download);
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Expected provider transfer acceptance');
      const operationId = receipt.operationId;
      if (!operationId) throw new Error('Expected the real contributed operation identity');
      expect((await fixture.list()).items).toMatchObject([{ operationId,
        actionId: buildQualifiedPluginContributionKey({ pluginId: DOWNLOAD_PLUGIN_ID, localId: 'download' }), requestId: 'provider-download', state: 'running' }]);
      expect((await fixture.list('alice')).items).toEqual([]);
      expect(await fixture.read(operationId, false)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      expect(fixture.postDownloadReadRoots()).toEqual([]);
      const receivedPath = join(fixture.directory, 'provider.bin');
      // The normal receiver substitutes its established Machine tunnel port.
      // This in-process transport boundary reaches that real listener directly.
      const localPort = await fixture.lifecycle.ensureListening();
      const endpointCandidates = receipt.prepared.endpointCandidates.map(candidate => {
        const url = new URL(candidate.url);
        url.hostname = '127.0.0.1';
        url.port = String(localPort);
        return { ...candidate, url: url.toString() };
      });
      const received = await requestDirectPeerTransferToFile({ transferId: receipt.prepared.transferId,
        endpointCandidates, destinationPath: receivedPath,
        expectedSizeBytes: receipt.prepared.sizeBytes, expectedManifestHash: receipt.prepared.manifestHash });
      expect(await readFile(receivedPath)).toEqual(Buffer.from([0, 255, 137, 80]));
      expect(await fixture.read(operationId, false)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      const endpoint = endpointCandidates[0];
      if (!endpoint) throw new Error('Expected the admitted receiver endpoint');
      const acknowledgment = await fetch(`${endpoint.url}/complete`, { method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${endpoint.authorizationToken}` },
        body: JSON.stringify({ success: true, destinationId: receipt.destinationId, sizeBytes: received.sizeBytes, manifestHash: received.manifestHash }) });
      expect(acknowledgment.ok).toBe(true);
      const settled = await fixture.read(operationId);
      expect(settled, JSON.stringify({ error: settled.kind === 'found' ? settled.operation.error : settled.kind,
        continuationReads: fixture.postDownloadReadRoots().length, transferActivity: (await fixture.lifecycle.activity.read()).items.length }))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'completed' } } });
      expect(fixture.postDownloadReadRoots()).toEqual([
        transferRootToken('bob', 'action.invoke', 'provider-download'),
        transferRootToken('bob', 'action.invoke', 'provider-download'),
      ]);
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await fixture.close(); }
  });
  it('refuses revoked original provider custody instead of borrowing the approval decider credentials', async () => {
    const fixture = await setup(false, true);
    try {
      expect(await fixture.invoke('action.invoke', { action: { pluginId: DOWNLOAD_PLUGIN_ID, localId: 'download' },
        input: { destination: { destinationId: 'revoked-provider-reader' } } }, 'revoked-provider-download', false, 'bob', 'agent'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const before = fixture.originalRootVerifications();
      fixture.revokeRequester();
      expect(await fixture.approve('alice')).toMatchObject({ ok: false, errorCode: 'approval_stale' });
      expect(fixture.originalRootVerifications()).toBeGreaterThan(before);
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await fixture.close(); }
  });
  it.each(['caller-authored-account', 'bob', 'alice'])('refuses caller-authored Account label %s at the native acquired-byte publisher without admitted requester custody', async accountId => {
    const fixture = await setup(false);
    try {
      expect(await fixture.publishWithoutRequester(accountId)).toMatchObject({ success: false, status: 'failed', errorCode: 'filesystem_transfer_custody_required' });
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await fixture.close(); }
  });
  it.each(['decision', 'direct', 'rpcDecision', 'rpcDirect'] as const)('retains requester download custody through %s', async route => {
    const needsApproval = route === 'decision' || route === 'rpcDecision';
    const fixture = await setup(needsApproval);
    try {
      const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
      await writeFile(join(fixture.directory, 'annotation.png'), bytes);
      let operationId: string | undefined;
      const client = createPreparedFilesystemTransferClient({
        executeAction: async (actionId, input) => {
          if (actionId !== 'daemon.filesystem.download') throw new Error(`Unexpected Action: ${actionId}`);
          const result = await fixture.invoke(actionId, input, 'annotation-download', route === 'rpcDecision' || route === 'rpcDirect');
          const receipt = FilesystemDownloadOutputSchema.safeParse(result.ok ? result.result : null);
          if (receipt.success && receipt.data.success && receipt.data.status === 'accepted') operationId = receipt.data.operationId;
          return result;
        },
        openMachineTunnel: async () => {
          expect((await fixture.list()).items).toMatchObject([{ operationId, actionId: 'daemon.filesystem.download',
            requestId: 'annotation-download', state: 'running' }]);
          expect((await fixture.list(false)).items).toEqual([]);
          return { localPort: await fixture.lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} };
        },
      });
      const downloading = client.download({ targetMachineId: 'machine', rootPath: fixture.directory, path: 'annotation.png', asZip: false,
        destinationId: 'annotation-reader', destinationPath: join(fixture.directory, 'read-back.png') });
      if (needsApproval) {
        await Promise.race([fixture.approvalCreated, downloading.then(result => {
          throw new Error(`Download settled before requesting approval: ${JSON.stringify(result)}`);
        })]);
        expect((await fixture.list()).items).toEqual([]);
        await fixture.approve();
      }
      const downloaded = await downloading;
      expect(downloaded, JSON.stringify(downloaded)).toMatchObject({ success: true, status: 'completed', destinationId: 'annotation-reader', sizeBytes: bytes.length });
      expect(await readFile(join(fixture.directory, 'read-back.png'))).toEqual(bytes);
      if (!operationId) throw new Error('Expected the admitted operation identity');
      expect(await fixture.read(operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      if (needsApproval) { await fixture.approve(); expect((await fixture.list()).items).toHaveLength(1); }
    } finally { await fixture.close(); }
  });
  it('stops the actual contributed download operation and retracts its accepted source before receiver ACK', async () => {
    const fixture = await setup(false, true);
    try {
      expect(await fixture.invoke('action.invoke', { action: { pluginId: DOWNLOAD_PLUGIN_ID, localId: 'download' },
        input: { destination: { destinationId: 'stopped-provider-reader' } } }, 'stopped-provider-download', false, 'bob', 'agent'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const accepted = await fixture.approve('alice');
      expect(accepted, accepted.ok ? undefined : `${accepted.errorCode}: ${accepted.error}`)
        .toMatchObject({ ok: true, result: { execution: { ok: true, result: { success: true, status: 'accepted' } } } });
      if (!accepted.ok || !accepted.result || typeof accepted.result !== 'object' || !('execution' in accepted.result)
        || !accepted.result.execution || typeof accepted.result.execution !== 'object' || !('result' in accepted.result.execution)) {
        throw new Error('Approved provider Stop fixture did not return its transfer receipt');
      }
      const receipt = FilesystemDownloadOutputSchema.parse(accepted.result.execution.result);
      if (!receipt.success || receipt.status !== 'accepted' || !receipt.operationId) throw new Error('Expected actual provider operation acceptance');
      expect(await fixture.read(receipt.operationId, false)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      expect(await fixture.cancel(receipt.operationId)).toEqual({ kind: 'requested' });
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
      expect(await fixture.read(receipt.operationId)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { await fixture.close(); }
  });
  it.each(['receiver_refused', 'owner_stopped'] as const)('projects actual native provider settlement %s without succeeding on failure JSON', async reason => {
    const fixture = await setup(false, true);
    try {
      expect(await fixture.invoke('action.invoke', { action: { pluginId: DOWNLOAD_PLUGIN_ID, localId: 'download' },
        input: { destination: { destinationId: 'failed-provider-reader' } } }, 'failed-provider-download', false, 'bob', 'agent'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const accepted = await fixture.approve('alice');
      expect(accepted).toMatchObject({ ok: true, result: { execution: { ok: true, result: { status: 'accepted' } } } });
      if (!accepted.ok || !accepted.result || typeof accepted.result !== 'object' || !('execution' in accepted.result)
        || !accepted.result.execution || typeof accepted.result.execution !== 'object' || !('result' in accepted.result.execution)) {
        throw new Error('Approved provider fixture did not return its transfer receipt');
      }
      const receipt = FilesystemDownloadOutputSchema.parse(accepted.result.execution.result);
      if (!receipt.success || receipt.status !== 'accepted' || !receipt.operationId) throw new Error('Expected actual provider operation acceptance');
      expect(await fixture.read(receipt.operationId, false)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      if (reason === 'receiver_refused') {
        const candidate = receipt.prepared.endpointCandidates[0];
        if (!candidate) throw new Error('Expected an admitted transfer endpoint');
        const url = new URL(candidate.url);
        url.hostname = '127.0.0.1';
        url.port = String(await fixture.lifecycle.ensureListening());
        const refused = await fetch(`${url.toString()}/complete`, { method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${candidate.authorizationToken}` },
          body: JSON.stringify({ success: false, destinationId: receipt.destinationId,
            errorCode: 'receiver_refused', error: 'The receiver refused the destination' }) });
        expect(refused.ok).toBe(true);
      } else {
        // The real isolated native listener owner retires without any receiver ACK.
        await fixture.lifecycle.stop();
      }
      expect(await fixture.read(receipt.operationId)).toMatchObject({ kind: 'found', operation: reason === 'receiver_refused'
        ? { state: 'failed', error: { errorCode: 'receiver_refused' } }
        : { state: 'running', observation: { kind: 'outcome_uncertain', code: 'indeterminate' } } });
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await fixture.close(); }
  });
});
