import { constants, existsSync, statSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createDirectTransferImportSessionManager, type DirectTransferImportOpenRequest } from '../../../../../../../../cli/src/machines/transfer/directTransferImportSession';
import { createDirectPeerTransferApp } from '../../../../../../../../cli/src/machines/transfer/directPeerTransport';
import { expandHomeDirPath } from '../../../../../../../../cli/src/utils/path/expandHomeDirPath';
import { abortOwnedDirectImportSession, finalizeDirectImportSession, prepareDirectImportSession, sendDirectImportChunk } from './directTransferImportClient';
import { createDirectTransferFinalizeRecovery } from './directTransferFinalizeRecovery';
import type { MachineCarrierHttpLease } from './machineCarrierHttpLease';
import { classifyTransferFailure } from './transferFailureCode';
import { createPreparedFilesystemTransferClient } from '../../../../../../../../cli/src/machines/transfer/preparedFilesystemTransferClient';
import { FilesystemUploadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { applyNewSessionDraftSeedV1 } from '@/components/sessions/new/newSessionDraftSeed';
import { buildNewSessionAuthoringDraftFromPersistedDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { resolveNewSessionInitialPlacement } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { createMachineFixture } from '@/dev/testkit';

const crossDeviceRoot = process.platform === 'linux' && existsSync('/dev/shm')
  && statSync('/dev/shm').dev !== statSync(tmpdir()).dev ? '/dev/shm' : null;

describe('import carrier deadline ownership', () => {
  it.each([
    ['native_http', undefined], ['browser_stream', undefined], ['server_rpc', 23],
  ] as const)('retains the request deadline for %s with caller budget %s', async (carrierKind, timeoutMs) => {
    vi.useFakeTimers();
    try {
      const params = { baseUrl: 'http://localhost/machine-transfers/direct/imports/deadline', carrierKind, timeoutMs,
        index: 0, payloadBase64: '', encryptedDataKeyEnvelopeBase64: '',
        request: async (_url: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json({ success: true })), 6_000);
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
        }) };
      const outcome = sendDirectImportChunk(params).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(timeoutMs ?? 5_000);
      expect(await outcome).toMatchObject({ error: { errorCode: 'MACHINE_RPC_TIMEOUT' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('preserves explicit Home RPC caller cancellation before any transfer effect', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled import');
    controller.abort(reason);
    let effects = 0;
    const params = { baseUrl: 'http://localhost/machine-transfers/direct/imports/cancelled', carrierKind: 'server_rpc' as const,
      index: 0, payloadBase64: '', encryptedDataKeyEnvelopeBase64: '', signal: controller.signal,
      request: async (_url: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        effects += 1;
        return Response.json({ success: true });
      } };
    await expect(sendDirectImportChunk(params)).rejects.toBe(reason);
    expect(effects).toBe(0);
  });

  it.each(['chunk', 'finalize', 'cleanup', 'recovery_finalize', 'recovery_discard'] as const)(
    'allows valid Home RPC %s work beyond the direct HTTP deadline', async phase => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-import-carrier-deadline-'));
      const manager = createDirectTransferImportSessionManager();
      const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
      try {
        const opened = await manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
          path: 'file.bin', sizeBytes: 1, overwrite: false });
        if (!opened.success) throw new Error('Import was not prepared');
        const chunk = createEncryptedTransferChunkEnvelope({ transferId: opened.response.uploadId, sequence: 0,
          payload: Buffer.from([1]), recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64 });
        if (phase === 'finalize' || phase === 'recovery_finalize') {
          expect(await manager.writeImportTransferChunk({ uploadId: opened.response.uploadId, index: 0, ...chunk }))
            .toEqual({ success: true });
        }
        const endpointUrl = `http://localhost/machine-transfers/direct/imports/${opened.response.uploadId}`;
        let requestStarted!: () => void;
        const started = new Promise<void>(resolve => { requestStarted = resolve; });
        let networkSignal: AbortSignal | null | undefined;
        // Only the network and clock are substituted; the import handler, encrypted
        // chunk reader, deadline owner, preparation and recovery lifecycle stay real.
        const carrier: MachineCarrierHttpLease = { kind: 'server_rpc', release: async () => {},
          request: async (url, init) => {
            networkSignal = init?.signal;
            requestStarted();
            await new Promise<void>((resolve, reject) => {
              const signal = init?.signal;
              const abort = () => { clearTimeout(timer); reject(signal?.reason); };
              const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 6_000);
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            });
            const result = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : 'POST',
              url: new URL(String(url)).pathname,
              ...(typeof init?.body === 'string' ? { headers: { 'content-type': 'application/json' }, payload: init.body } : {}) });
            return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
          } };
        const prepared = await prepareDirectImportSession({ machineId: 'machine', request: { t: 'session_file_upload_v1',
          workingDirectory: directory, path: 'file.bin', sizeBytes: 1, overwrite: false },
          preparedImport: { ...opened.response, endpointCandidates: [{ kind: 'http', url: endpointUrl, expiresAt: opened.response.expiresAt }] },
          acquirePreparedCarrier: async () => carrier });
        if (!prepared.success) throw new Error('Prepared carrier was not admitted');
        const request = { ...prepared.session, baseUrl: prepared.session.baseUrls[0]! };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const operation = phase === 'chunk'
          ? sendDirectImportChunk({ ...request, index: 0, ...chunk })
          : phase === 'finalize'
            ? finalizeDirectImportSession(request)
            : phase === 'cleanup'
              ? abortOwnedDirectImportSession({ machineId: 'machine', uploadId: prepared.session.uploadId,
                filesystemRootPath: directory, preparedSession: prepared.session })
              : createDirectTransferFinalizeRecovery({ machineId: 'machine', uploadId: prepared.session.uploadId,
                filesystemRootPath: directory, baseUrl: endpointUrl, expiresAt: prepared.session.expiresAt,
                acquireCarrier: async () => carrier, parseFinalizeResponse: value => value.finalized })
                .invoke(phase === 'recovery_finalize' ? 'retry_finalize' : 'discard_staged');
        const outcome = operation.then(value => ({ value }), error => ({ error }));
        await started;
        await vi.advanceTimersByTimeAsync(5_001);
        expect.soft(networkSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(999);
        if (phase === 'cleanup') expect(await outcome).toEqual({ value: null });
        else if (phase === 'recovery_discard') expect(await outcome).toEqual({ value: { status: 'discarded' } });
        else if (phase === 'recovery_finalize') expect(await outcome).toMatchObject({ value: { status: 'finalized' } });
        else expect(await outcome).toMatchObject({ value: { success: true } });
      } finally {
        vi.useRealTimers();
        await app.close();
        await manager.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('attachment import finalization through HTTP and the UI client', () => {
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('seeds a guest Session in its writable home rather than the foreign-owned filesystem root and imports its attachment', async () => {
    const guestHome = await mkdtemp(join(tmpdir(), 'happier-guest-home-'));
    const manager = createDirectTransferImportSessionManager({ attachmentUpload: {
      resolveSessionWorkingDirectory: async () => workingDirectory,
    } });
    const seeded = applyNewSessionDraftSeedV1({ existingDraft: null, updatedAt: 1,
      seed: { placement: { kind: 'exactTarget', serverId: 'home', machineId: 'guest' } } });
    const hydrated = buildNewSessionAuthoringDraftFromPersistedDraft(seeded);
    const placement = resolveNewSessionInitialPlacement({ serverId: 'home',
      machines: [createMachineFixture({ id: 'guest', metadata: { homeDir: guestHome } })],
      recentMachinePaths: [], resolveRecentPathsForMachine: () => [],
      persistedExecutionTarget: hydrated.executionTarget, persistedMachineId: seeded.selectedMachineId,
      persistedPath: hydrated.directory });
    // Placement carries home intent; the target's native environment owns its
    // expansion before the Session publishes its working directory for uploads.
    const workingDirectory = expandHomeDirPath(placement.path, { HOME: guestHome, USERPROFILE: guestHome });
    try {
      // Real OS ownership, not a mocked EACCES: the guest user can traverse the
      // system root but cannot create /.happier. No write to that root is attempted.
      expect(statSync('/').uid).not.toBe(process.getuid?.());
      await expect(access('/', constants.W_OK)).rejects.toBeDefined();
      expect((await stat(guestHome)).uid).toBe(process.getuid?.());
      expect(placement.path).toBe('~');
      expect(workingDirectory).toBe(guestHome);
      const payload = Buffer.alloc(36, 'a');
      const opened = await manager.openTrustedImportSession({ t: 'session_attachment_upload_v1',
        workingDirectory, workspaceRootPath: workingDirectory, sessionId: 'hosted-session',
        messageLocalId: 'message-1', fileName: 'attachment.txt', sizeBytes: payload.length,
        uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false });
      if (!opened.success) throw new Error('Attachment preparation failed');
      const { uploadId, recipientPublicKeyBase64 } = opened.response;
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence: 0, payload, recipientPublicKeyBase64 });
      expect(await manager.writeImportTransferChunk({ uploadId, index: 0, ...chunk })).toEqual({ success: true });
      const result = await manager.finalizeImportTransferSession({ uploadId });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Attachment finalization failed');
      const file = join(workingDirectory, result.finalized.path);
      expect(await readFile(file)).toEqual(payload);
      expect((await stat(file)).uid).toBe(process.getuid?.());
    } finally {
      await manager.close();
      await rm(guestHome, { recursive: true, force: true });
    }
  });

  it.each(['file', 'directory'] as const)('keeps the canonical filesystem code and retained custody through headless HTTP for a destination %s collision', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-import-collision-'));
    const destination = join(directory, 'collision');
    const sourcePath = join(directory, 'source');
    const payload = Buffer.from([0, 255, 128, 42]);
    await writeFile(sourcePath, payload);
    if (kind === 'file') await writeFile(destination, 'existing');
    else await mkdir(destination);
    const manager = createDirectTransferImportSessionManager();
    const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
    const finalizeResponses: { status: number; code?: string; keepSession?: boolean }[] = [];
    let aborts = 0;
    app.addHook('onSend', async (request, reply, body) => {
      if (request.url.endsWith('/finalize') && typeof body === 'string') {
        const result = JSON.parse(body) as { errorCode?: string; keepSession?: boolean };
        finalizeResponses.push({ status: reply.statusCode, code: result.errorCode, keepSession: result.keepSession });
      }
      if (request.url.endsWith('/abort')) aborts += 1;
      return body;
    });
    try {
      const origin = await app.listen({ port: 0, host: '127.0.0.1' });
      const source = { sourceId: 'collision-source', sizeBytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
      const opened = await manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
        path: 'collision', sizeBytes: source.sizeBytes, sha256: source.sha256, overwrite: false });
      if (!opened.success) throw new Error('Import was not prepared');
      const receipt = FilesystemUploadOutputSchema.parse({ success: true, status: 'accepted', operationId: 'collision',
        sourceId: source.sourceId, prepared: { ...opened.response, endpointCandidates: [{ kind: 'http',
          url: `${origin}/machine-transfers/direct/imports/${opened.response.uploadId}`, expiresAt: opened.response.expiresAt }] } });
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Upload was not prepared');
      const client = createPreparedFilesystemTransferClient({
        executeAction: async () => { throw new Error('Upload admission must not be repeated'); },
        openMachineTunnel: async () => ({ localPort: Number(new URL(origin).port), observedPath: 'direct', close: async () => {} }),
      });
      const result = await client.upload({ targetMachineId: 'destination', rootPath: directory,
        path: 'collision', sourcePath, source, overwrite: false, preparedAdmission: receipt });
      const code = kind === 'file' ? 'EEXIST' : 'EISDIR';
      expect(finalizeResponses).toEqual([{ status: 400, code, keepSession: true }]);
      expect(result).toMatchObject({ success: false, status: 'unknown', errorCode: code });
      expect(aborts).toBe(0);
      expect(manager.countActiveImportSessions()).toBe(1);
      if (kind === 'file') expect(await readFile(destination, 'utf8')).toBe('existing');
      else expect((await stat(destination)).isDirectory()).toBe(true);
    } finally {
      await app.close();
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('redacts a returned target refusal at the shared lifecycle before RPC serialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-returned-finalize-'));
    const workspace = join(directory, 'project');
    await mkdir(workspace, { mode: 0o500 });
    const manager = createDirectTransferImportSessionManager();
    try {
      const opened = await manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: workspace,
        path: 'file.bin', sizeBytes: 0, overwrite: true });
      if (!opened.success) throw new Error('Import was not prepared');
      const result = await manager.finalizeImportTransferSession({ uploadId: opened.response.uploadId });
      expect(result).toMatchObject({ success: false, errorCode: 'file_replace_failed', keepSession: true });
      expect(JSON.stringify(result)).not.toContain(directory);
    } finally {
      await manager.close();
      await chmod(workspace, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('preserves an authoritative finalize refusal in the headless prepared-file consumer', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-headless-finalize-'));
    const destination = join(rootPath, 'blocked');
    const sourcePath = join(rootPath, 'source');
    await mkdir(destination, { mode: 0o500 });
    const payload = Buffer.alloc(36, 'a');
    await writeFile(sourcePath, payload);
    const manager = createDirectTransferImportSessionManager();
    const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
    let finalizeAttempts = 0;
    app.addHook('onRequest', async request => {
      if (request.url.endsWith('/finalize')) finalizeAttempts += 1;
    });
    const source = { sourceId: 'source', sizeBytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
    try {
      const origin = await app.listen({ port: 0, host: '127.0.0.1' });
      const opened = await manager.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: rootPath,
        path: 'blocked/attachment.txt', sizeBytes: source.sizeBytes, sha256: source.sha256, overwrite: false });
      if (!opened.success) throw new Error('Import was not prepared');
      // The external Machine admission envelope carries the real import producer's
      // capability; this test concerns its HTTP consumer, not Action admission.
      const receipt = FilesystemUploadOutputSchema.parse({ success: true, status: 'accepted', operationId: 'finalize-refusal',
        sourceId: source.sourceId, prepared: { ...opened.response, endpointCandidates: [{ kind: 'http',
          url: `${origin}/machine-transfers/direct/imports/${opened.response.uploadId}`, expiresAt: opened.response.expiresAt }] } });
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Upload was not prepared');
      const client = createPreparedFilesystemTransferClient({
        executeAction: async () => { throw new Error('Upload admission must not be repeated'); },
        openMachineTunnel: async () => ({ localPort: Number(new URL(origin).port), observedPath: 'direct', close: async () => {} }),
      });
      const result = await client.upload({ targetMachineId: 'destination', serverId: 'home', rootPath,
        path: 'blocked/attachment.txt', sourcePath, source, overwrite: false, preparedAdmission: receipt });
      expect(result).toMatchObject({ success: false, status: 'failed', errorCode: 'EACCES' });
      expect(JSON.stringify(result)).not.toContain(rootPath);
      expect(finalizeAttempts).toBe(1);
    } finally {
      await app.close();
      await manager.close();
      await chmod(destination, 0o700);
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['EACCES', 'EACCES', 'permission'],
    ['ENOENT', 'ENOENT', 'other'],
    ['EXDEV', 'EXDEV', 'other'],
    ['private-path-secret', 'TRANSFER_FINALIZE_FAILED', 'other'],
  ] as const)('carries closed %s failures to the existing presenter with no retry or private text', async (code, expectedCode, reason) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-import-finalize-'));
    const workspace = join(directory, 'home', 'happier', 'project');
    await mkdir(workspace, { recursive: true });
    const manager = createDirectTransferImportSessionManager({
      attachmentUpload: { resolveSessionWorkingDirectory: async () => workspace },
      // OS copy failure is the only substituted filesystem boundary.
      finalizeFileOperations: () => ({ copyFile: async () => {
        throw Object.assign(new Error(`copyfile private-token ${directory}`), { code });
      } }),
    });
    const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
    try {
      const payload = Buffer.alloc(36, 'a');
      const input: DirectTransferImportOpenRequest = { t: 'session_attachment_upload_v1',
        workingDirectory: workspace, workspaceRootPath: workspace, sessionId: 'hosted-session',
        messageLocalId: 'message-1', fileName: 'attachment.txt', sizeBytes: payload.length,
        uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false };
      const authorization = manager.issueImportOpenAuthorizationToken(input);
      const opened = await app.inject({ method: 'POST', url: '/machine-transfers/direct/imports/open',
        headers: { authorization: `Bearer ${authorization.authorizationToken}` }, payload: input });
      expect(opened.statusCode).toBe(200);
      const prepared = opened.json<{ uploadId: string; recipientPublicKeyBase64: string }>();
      const baseUrl = `http://localhost/machine-transfers/direct/imports/${prepared.uploadId}`;
      const responses: number[] = [];
      // Substitute the network only; Fastify still runs the real handler and serializer.
      const request = async (url: string, init?: RequestInit): Promise<Response> => {
        const result = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : 'POST',
          url: new URL(url).pathname, headers: init?.body ? { 'content-type': 'application/json' } : {},
          ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
        responses.push(result.statusCode);
        if (new URL(url).pathname.endsWith('/finalize')) {
          expect(result.body).not.toContain(directory);
          expect(result.body).not.toMatch(/private-token|private-path-secret/);
        }
        return new Response(result.body, { status: result.statusCode,
          headers: { 'content-type': String(result.headers['content-type']) } });
      };
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: prepared.uploadId, sequence: 0,
        payload, recipientPublicKeyBase64: prepared.recipientPublicKeyBase64 });
      expect(await sendDirectImportChunk({ baseUrl, index: 0, ...chunk, request })).toEqual({ success: true });
      const finalized = await finalizeDirectImportSession({ baseUrl, request });
      expect(finalized).toMatchObject({ success: false, errorCode: expectedCode });
      expect(classifyTransferFailure(finalized.success === false ? finalized : {})).toBe(reason);
      expect(JSON.stringify(finalized)).not.toMatch(/private-token|private-path-secret/);
      expect(JSON.stringify(finalized)).not.toContain(directory);
      expect(responses).toEqual([200, 400]);
      expect(manager.countActiveImportSessions()).toBe(0);
    } finally {
      await app.close();
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['existing', 'missing', ...(crossDeviceRoot ? ['cross-device'] : [])])('commits one small encrypted attachment into a %s hosted project root', async layout => {
    const directory = await mkdtemp(join(layout === 'cross-device' ? crossDeviceRoot! : tmpdir(), 'happier-managed-layout-'));
    const workspace = join(directory, 'home', 'happier', 'project');
    if (layout !== 'missing') await mkdir(workspace, { recursive: true });
    if (layout === 'cross-device') expect((await stat(directory)).dev).not.toBe((await stat(tmpdir())).dev);
    const manager = createDirectTransferImportSessionManager({ attachmentUpload: {
      resolveSessionWorkingDirectory: async () => workspace,
    } });
    try {
      const payload = Buffer.alloc(36, 'a');
      const opened = await manager.openTrustedImportSession({ t: 'session_attachment_upload_v1',
        workingDirectory: workspace, workspaceRootPath: workspace, sessionId: 'hosted-session',
        messageLocalId: 'message-1', fileName: 'attachment.txt', sizeBytes: payload.length,
        uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false });
      expect(opened.success).toBe(true);
      if (!opened.success) throw new Error('Attachment preparation failed');
      const { uploadId, recipientPublicKeyBase64 } = opened.response;
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence: 0, payload, recipientPublicKeyBase64 });
      expect(await manager.writeImportTransferChunk({ uploadId, index: 0, ...chunk })).toEqual({ success: true });
      const result = await manager.finalizeImportTransferSession({ uploadId });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Attachment finalization failed');
      expect(result.finalized.sizeBytes).toBe(36);
      expect(await readFile(join(workspace, result.finalized.path))).toEqual(payload);
      if (process.getuid) expect((await stat(workspace)).uid).toBe(process.getuid());
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('identifies an actual service-user filesystem refusal after successful preparation and chunk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-import-permission-'));
    const workspace = join(directory, 'project');
    await mkdir(workspace, { mode: 0o500 });
    const manager = createDirectTransferImportSessionManager({ attachmentUpload: {
      resolveSessionWorkingDirectory: async () => workspace,
    } });
    try {
      const payload = Buffer.alloc(36, 'a');
      const opened = await manager.openTrustedImportSession({ t: 'session_attachment_upload_v1', workingDirectory: workspace,
        workspaceRootPath: workspace, sessionId: 'hosted-session', messageLocalId: 'message-1', fileName: 'attachment.txt',
        sizeBytes: payload.length, uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false });
      expect(opened.success).toBe(true);
      if (!opened.success) throw new Error('Attachment preparation failed');
      const { uploadId, recipientPublicKeyBase64 } = opened.response;
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence: 0, payload, recipientPublicKeyBase64 });
      expect(await manager.writeImportTransferChunk({ uploadId, index: 0, ...chunk })).toEqual({ success: true });
      const result = await manager.finalizeImportTransferSession({ uploadId });
      expect(result).toMatchObject({ success: false, errorCode: 'EACCES' });
      expect(classifyTransferFailure(result.success === false ? result : {})).toBe('permission');
      expect(JSON.stringify(result)).not.toContain(directory);
    } finally {
      await manager.close();
      await chmod(workspace, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
