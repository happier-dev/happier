import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import fastify from 'fastify';
import axios from 'axios';
import { accountSettingsParse, createActionExecutor, decodePlainArtifactStoredContent, getActionSpec, StoredApprovalRequestSchema } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { callSocketRpc } from '@happier-dev/sync-client';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { DaemonWorkspaceFileReplacePreviewResponseSchema, DaemonWorkspaceFileReplaceApplyResponseSchema, WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { applyWorkspaceFileReplace, previewWorkspaceFileReplace, registerWorkspaceFileReplaceHandlers } from './workspaceFileReplace';
import { registerSessionHandlers } from './registerSessionHandlers';
import { ApiMachineClient } from '@/api/apiMachine';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { adoptServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

// Keep the filesystem real while exposing its write boundary as a configurable spy.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The direct test transport supplies verified Home ingress, not a new IO owner. */
async function admittedPersonFacts(actionId: string, input: unknown, accountId = 'account', machineId = 'machine', home?: string) {
  const installationId = readOrCreateInstallationIdentitySync().installationId;
  const existingHome = await resolveServerProfileHomeIdentityId(configuration.activeServerId);
  const serverIdentityId = home ?? existingHome ?? 'srv_replace_owner_fixture';
  if (!existingHome) await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: configuration.activeServerId,
    createIfMissing: true, observation: 'exact', descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
      canonicalServerUrl: configuration.serverUrl, revision: 1, endpoints: [{ kind: 'https', url: configuration.serverUrl }] } });
  const target = { kind: 'machine' as const, machineId };
  return { machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId,
    installationId, role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true,
    callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-person', binding: {
      accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId, machineId,
      custodianAccountId: accountId, installationId, actionId, requestId: 'fixture-person-effect', target,
      accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
        ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'fixture-person-effect', target, input })),
    } }),
  };
}
describe('registered workspace replace transport', () => {
  let root: string;
  let handlers: Map<string, RpcHandler>;
  let dispose: (() => Promise<void>) | undefined;
  const matcher = { query: 'old', replacement: 'new', matchCase: true, regex: false };
  const personContext = (): RpcHandlerContext => ({ signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true });
  beforeEach(async () => {
    vi.mocked(filesystem.writeFile).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile);
    root = await mkdtemp(join(tmpdir(), 'happier-replace-'));
    handlers = new Map();
    dispose = undefined;
    registerWorkspaceFileReplaceHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      machineId: 'machine', actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
        workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
          previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      }),
    });
  });
  afterEach(async () => {
    vi.mocked(filesystem.writeFile).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile);
    vi.restoreAllMocks(); await dispose?.(); await rm(root, { recursive: true, force: true });
  });
  const preview = async (extra = {}) => DaemonWorkspaceFileReplacePreviewResponseSchema.parse(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher, ...extra }, personContext()));
  const apply = async (operation: unknown, signal?: AbortSignal) => DaemonWorkspaceFileReplaceApplyResponseSchema.parse(await applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' }, signal ? { signal } : undefined));

  it('retains a 300 KiB matching preview and its reversible receipt within the socket boundary', async () => {
    const text = `old ${'é😀'.repeat(55_000)}`;
    const replacement = `new ${'é😀'.repeat(55_000)}`;
    await writeFile(join(root, 'large.txt'), text);
    const page = await preview({ contextLines: 0, replacement });
    expect(page).toMatchObject({ ok: true, coverage: 'complete', hasMore: false,
      files: [{ path: 'large.txt', matches: [{ text, replacedText: text.replace('old', replacement) }] }] });
    const result = await apply({ kind: 'replace', matcher: { ...matcher, replacement }, files: [{ path: 'large.txt', expectedHash: hash(Buffer.from(text)) }] });
    expect(result).toMatchObject({ ok: true, results: [{ path: 'large.txt', status: 'replaced', edits: expect.any(Array) }] });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(300 * 1024);
    expect(await readFile(join(root, 'large.txt'), 'utf8')).toBe(text.replace('old', replacement));
    if (!result.ok) throw new Error('Expected the reversible replacement');
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path, expectedHash: file.hash, edits: file.edits })) }))
      .toMatchObject({ results: [{ status: 'restored' }] });
    expect(await readFile(join(root, 'large.txt'), 'utf8')).toBe(text);
  });

  it('finishes admitted preview and replacement after authority changes during a file read', async () => {
    await writeFile(join(root, 'a.txt'), 'old');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let current = true;
    const read = vi.spyOn(filesystem, 'readFile').mockImplementation(async (...args: Parameters<typeof filesystem.readFile>) => {
      const bytes = await actual.readFile(...args);
      current = false;
      return bytes;
    });
    const context = { signal: new AbortController().signal, assertCurrentAuthority: async () => {
      if (!current) throw Object.assign(new Error('Requester admission expired'), { code: 'filesystem_identity_custody_unavailable' });
    } };
    const previewed = await previewWorkspaceFileReplace({ rootPath: root, ...matcher }, root, { kind: 'osUser' }, context);
    expect(previewed).toMatchObject({ ok: true, files: [{ path: 'a.txt', matchCount: 1 }] });
    current = true;
    const replaced = await applyWorkspaceFileReplace({ rootPath: root, operation: { kind: 'replace', matcher,
      files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] } }, root, { kind: 'osUser' }, context);
    expect(replaced).toMatchObject({ ok: true, results: [{ status: 'replaced' }] });
    read.mockRestore();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new');
  });

  it('verifies Home once for an admitted multi-file Replace and refuses the next request after revocation', async () => {
    const f = await createInstalledFilesystemMachineFixture();
    const replace = f.machine.createWorkspaceFileReplaceActionExecutor(f.serverId);
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), workspaceFilesReplace: replace });
    const receiver: RpcActionExecutor = { execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: f.serverId }) };
    f.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
      stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: {
      currentServerId: f.serverId, executor: receiver, resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
    } });
    for (const path of ['a.txt', 'b.txt']) await writeFile(join(f.directory, path), 'old');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let revoked = false;
    const read = vi.spyOn(filesystem, 'readFile').mockImplementation(async (...args: Parameters<typeof filesystem.readFile>) => {
      if (args[0] === join(f.directory, 'b.txt') && !revoked) {
        expect(await actual.readFile(join(f.directory, 'a.txt'), 'utf8')).toBe('new');
        revoked = true;
        f.retire();
      }
      return actual.readFile(...args);
    });
    try {
      const before = f.admissionChecks();
      expect(await f.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY, { machineId: 'machine', rootPath: f.directory,
        operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(Buffer.from('old')) })) },
      })).toMatchObject({ ok: true, results: [{ path: 'a.txt', status: 'replaced' }, { path: 'b.txt', status: 'replaced' }] });
      expect(revoked).toBe(true);
      expect(f.admissionChecks() - before).toBe(1);
      for (const path of ['a.txt', 'b.txt']) expect(await actual.readFile(join(f.directory, path), 'utf8')).toBe('new');
      expect(await f.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, { rootPath: f.directory })).toHaveProperty('errorCode');
      expect(f.admissionChecks() - before).toBe(2);
    } finally { read.mockRestore(); await f.machine.shutdown(); }
  });

  it('refuses preview and replacement at production registration without an Action admission owner', async () => {
    handlers.clear();
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root).dispose;
    await writeFile(join(root, 'a.txt'), 'old');
    expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher }))
      .toMatchObject({ ok: false });
    expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ rootPath: root,
      operation: { kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] },
    })).toMatchObject({ ok: false });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old');
  });

  it.each(['ui', 'rpc'] as const)('honors the configured %s Ask override before registered preview reads files', async surface => {
    await writeFile(join(root, 'a.txt'), 'old');
    const requests: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'workspace.files.replace.preview': { approvalRequiredSurfaces: [surface] },
    } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      // The physical implementation is real; creating an Ask must prevent reaching it.
      workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
        previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'preview-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      readActionsSettings: () => settings,
    });
    // As in production, the receiving credential factory binds the Home; Action input does not.
    const receivingExecutor: RpcActionExecutor = {
      execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: 'home' }),
    };
    handlers.clear();
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      workspaceFileReplaceActionExecutor: receivingExecutor, workspaceFileReplaceMachineId: 'machine',
      filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    }).dispose;
    const outcome = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher }, {
      ...personContext(),
      localActionContext: { surface, authority: 'present_user', actionRequestId: 'preview-request' },
    });
    expect(outcome).toMatchObject({ kind: 'approval_request_created',
      actionId: 'workspace.files.replace.preview', artifactId: 'preview-approval' });
    expect(requests).toEqual([expect.objectContaining({ actionId: 'workspace.files.replace.preview',
      actionArgs: { machineId: 'machine', rootPath: root, ...matcher } })]);
  });

  it('previews raw BOM hashes then applies only selected matches and restores exact bytes through Actions', async () => {
    // Use the production composition for this seam test. Clearing the direct
    // owner registration makes removal/misbinding in registerSessionHandlers fail.
    handlers.clear();
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
        previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) =>
        applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
    });
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      workspaceFileReplaceActionExecutor: executor, workspaceFileReplaceMachineId: 'machine',
      filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    }).dispose;
    const bytes = Buffer.from('\uFEFFold old\r\n');
    await writeFile(join(root, 'a.txt'), bytes);
    const page = await preview();
    expect(page).toMatchObject({ ok: true, files: [{ path: 'a.txt', hash: hash(bytes), matchCount: 2 }] });
    if (!page.ok) return;
    const context = { ...personContext(), localActionContext: { surface: 'ui', authority: 'present_user' } } as const;
    const outcome = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ machineId: 'machine', rootPath: root,
      operation: { kind: 'replace', matcher,
        files: [{ path: 'a.txt', expectedHash: page.files[0].hash, excludedMatches: [{ line: page.files[0].matches[1].line, column16: page.files[0].matches[1].column16 }] }] },
    }, context);
    expect(outcome).toMatchObject({ ok: true, results: [{ status: 'replaced', matchCount: 1 }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew old\r\n'));
    const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(outcome);
    if (!result.ok) return;
    const restored = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ machineId: 'machine', rootPath: root,
      operation: { kind: 'restore', files: [{ path: 'a.txt', expectedHash: result.results[0].hash, edits: result.results[0].edits }] },
    }, context);
    expect(restored).toMatchObject({ results: [{ status: 'restored' }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
  });

  it.each(['replace', 'restore'] as const)('keeps %s behind agent approval at the Action boundary', async kind => {
    await writeFile(join(root, 'a.txt'), kind === 'replace' ? 'old' : 'new');
    const requests: unknown[] = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) =>
        applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      // Approval Artifact persistence is the boundary; policy and dispatch stay real.
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'replace-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      readActionsSettings: (context) => context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }),
    });
    const operation = kind === 'replace'
      ? { kind, matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] }
      : { kind, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('new')),
        edits: [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }] }] };
    const input = { machineId: 'machine', rootPath: root, operation };
    expect(await executor.execute('workspace.files.replace', input, {
      surface: 'agent', authority: 'account_automation', actionRequestId: 'replace-request',
      serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created',
      actionId: 'workspace.files.replace', artifactId: 'replace-approval' } });
    expect(requests).toEqual([expect.objectContaining({ actionId: 'workspace.files.replace', actionArgs: input })]);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(kind === 'replace' ? 'old' : 'new');
  });

  it('refuses stale, deleted, root-escaping and symlink-escaping files without writing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'happier-replace-outside-'));
    try {
      await writeFile(join(root, 'a.txt'), 'agent changed');
      await writeFile(join(outside, 'secret.txt'), 'old');
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const results = await apply({ kind: 'replace', matcher, files: [
        { path: 'a.txt', expectedHash: hash(Buffer.from('old')) },
        { path: 'missing.txt', expectedHash: hash(Buffer.from('old')) },
        { path: join(outside, 'secret.txt'), expectedHash: hash(Buffer.from('old')) },
        { path: 'link.txt', expectedHash: hash(Buffer.from('old')) },
      ] });
      expect(results).toMatchObject({ results: [{ status: 'changed' }, { status: 'changed' }, { status: 'failed' }, { status: 'failed' }] });
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('old');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('agent changed');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('finishes a published rename with its Undo receipt before observing Stop between files', async () => {
    const original = Buffer.from('old');
    await writeFile(join(root, 'a.txt'), original);
    await writeFile(join(root, 'b.txt'), original);
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const renameBoundary = vi.spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      await actual.rename(source, destination);
      if (destination === join(root, 'renamed.txt')) controller.abort();
    });
    const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'new' }];
    const outcome = await apply({ kind: 'editSet', files: [
      { path: 'a.txt', expectedHash: hash(original), edits, renameTo: 'renamed.txt' },
      { path: 'b.txt', expectedHash: hash(original), edits },
    ] }, controller.signal);
    expect(outcome).toMatchObject({ ok: true, results: [{ path: 'a.txt', status: 'replaced',
      renameTo: 'renamed.txt', hash: hash(Buffer.from('new')), edits: expect.any(Array) }], cancelled: ['b.txt'] });
    expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(root, 'b.txt'))).toEqual(original);
    renameBoundary.mockRestore();
    if (!outcome.ok) throw new Error('Expected a retained published rename');
    expect(await apply(buildWorkspaceFileRestoreOperation(outcome.results)))
      .toMatchObject({ ok: true, results: [{ path: 'renamed.txt', status: 'restored', renameTo: 'a.txt' }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(original);
    await expect(readFile(join(root, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the native accepted operation and partial cancellation inverse until the terminal acknowledgement', async () => {
    const bytes = Buffer.from('\uFEFFold\r\n');
    for (const path of ['a.txt', 'b.txt']) await writeFile(join(root, path), bytes);
    const f = await createInstalledFilesystemMachineFixture();
    const client = f.machine;
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'replace-operation' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      workspaceFilesReplace: client.createWorkspaceFileReplaceActionExecutor(f.serverId),
      workspaceFilesReplacePreview: client.createWorkspaceFileReplacePreviewActionExecutor(f.serverId),
      runActionOperation: runtime.runActionOperation });
    client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
      stopSession: async () => true, requestShutdown: () => {} }, { externalActionIngressOwner: {
      currentServerId: f.serverId, executor, resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
    } });
    const { rename: renameFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let cancellation: unknown;
    // Cancel after the first actual publication, not during temporary staging:
    // a cancellation before publication must now leave that file unchanged.
    const renameBoundary = vi.spyOn(filesystem, 'rename').mockImplementation(async (source, path) => {
      await renameFile(source, path);
      if (!cancellation && typeof path === 'string' && path === join(root, 'a.txt'))
        cancellation = await runtime.handlers.cancel({ operationId: 'replace-operation' });
    });
    try {
      expect(await executor.execute('workspace.files.replace.preview', { machineId: 'machine', rootPath: root, ...matcher },
        { ...await admittedPersonFacts('workspace.files.replace.preview', { machineId: 'machine', rootPath: root, ...matcher },
            'requester', 'machine', f.homeServerIdentityId),
          surface: 'ui', authority: 'present_user', serverId: f.serverId, runtimeAccountId: 'requester',
          externalActionTarget: { kind: 'machine', machineId: 'machine' } })).toMatchObject({ ok: true, result: {
            ok: true, files: [{ path: 'a.txt', hash: hash(bytes) }, { path: 'b.txt', hash: hash(bytes) }],
          } });
      const accepted = await executor.execute('workspace.files.replace', { machineId: 'machine', rootPath: root,
        operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(bytes) })) },
      }, { ...await admittedPersonFacts('workspace.files.replace', { machineId: 'machine', rootPath: root,
          operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(bytes) })) } },
          'requester', 'machine', f.homeServerIdentityId),
        surface: 'ui', authority: 'present_user', serverId: f.serverId, runtimeAccountId: 'requester',
        actionRequestId: 'replace-request', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      expect(accepted).toEqual({ ok: true, result: { operation: { operationId: 'replace-operation' } } });
      const terminal = await runtime.handlers.getV2({ operationId: 'replace-operation', waitForTerminal: true });
      expect(cancellation).toEqual({ kind: 'requested' });
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: {
        ok: true, results: [{ path: 'a.txt', status: 'replaced' }], cancelled: ['b.txt'],
      } } });
      if (terminal.kind !== 'found') return;
      const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(terminal.operation.result);
      if (!result.ok) return;
      expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew\r\n'));
      expect(await readFile(join(root, 'b.txt'))).toEqual(bytes);
      renameBoundary.mockRestore();
      expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path,
        expectedHash: file.hash, edits: file.edits })) })).toMatchObject({ results: [{ status: 'restored' }] });
      expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
    } finally {
      await client.shutdown();
    }
  });

  it.each([
    ['preview', 'current'], ['replace', 'current'], ['restore', 'current'], ['rename', 'current'], ['directory', 'current'],
    ['fileRename', 'current'], ['codeAction', 'current'], ['replace', 'implicit-target'], ['rename', 'implicit-target'],
    ['preview', 'foreign-home'], ['preview', 'foreign-input'], ['preview', 'missing-witness'], ['preview', 'retired'],
    ['preview', 'unreachable-witness'], ['preview', 'retired-during-witness'],
  ] as const)('replays approved %s through the native Machine dependency (%s)', async (kind, scenario) => {
    const origin = 'https://replace-approval.test';
    await withConfiguredDaemonTestHome({ prefix: 'happier-replace-approval-', env: {
      HAPPIER_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin, HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: root,
    } }, async () => {
      const app = fastify();
      const restore = installAxiosFastifyAdapter({ app, origin });
      const accountId = 'replace-owner';
      const serverIdentityId = 'srv_replace_approval';
      const serverId = configuration.activeServerId;
      const machineId = 'machine';
      const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null };
      const actionId = kind === 'preview' ? 'workspace.files.replace.preview'
        : kind === 'rename' ? 'code.rename.apply' : kind === 'fileRename' ? 'code.file.rename.apply'
          : kind === 'codeAction' ? 'code.codeAction.apply'
            : kind === 'directory' ? 'daemon.filesystem.createDirectory' : 'workspace.files.replace';
      const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['ui'] },
      } });
      const accountSettings = accountSettingsParse({ actionsSettingsV1: actionsSettings });
      const features = registerAccountHomeHttp(app, { accountId, serverId: serverIdentityId, settings: accountSettings });
      // Native Machine reads attach the Account observer. Its receipt writer
      // needs the same live Home channel as the real authenticated runtime.
      const channel = await createRequesterCurrentnessSocketHarness();
      onTestFinished(() => channel.close());
      let readingNativeWitness = false;
      let nativeWitnessRequests = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        if (readingNativeWitness) nativeWitnessRequests += 1;
        if (readingNativeWitness && scenario === 'unreachable-witness') return Response.json({}, { status: 503 });
        if (readingNativeWitness && scenario === 'retired-during-witness') client.setRPCHandlers({
          spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
          stopSession: async () => true, requestShutdown: () => {},
        });
        return Response.json(features);
      });
      const artifacts = registerPlainArtifactRoutes(app, accountId);
      const readApproval = (artifactId: string) => {
        const storedBody = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
        if (typeof storedBody !== 'object' || storedBody === null || !('body' in storedBody) || typeof storedBody.body !== 'string')
          throw new Error('Missing approval Artifact body');
        return StoredApprovalRequestSchema.parse(JSON.parse(storedBody.body));
      };
      readOrCreateInstallationIdentitySync();
      const client = new ApiMachineClient(token, { id: machineId, encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
        serverUrl: origin, resolveCurrentMachineId: () => machineId,
      });
      const previewEffect = client.createWorkspaceFileReplacePreviewActionExecutor(serverId);
      const replaceEffect = client.createWorkspaceFileReplaceActionExecutor(serverId);
      const languageEffect = client.createLanguageIntelligenceApplyActionExecutor(serverId);
      const filesystemEffect = client.createFilesystemActionExecutor(serverId);
      const { executor, deps } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId, serverIdentityId, serverHttpBaseUrl: origin,
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings, allowEnvironmentOverride: false }),
      }, {
        // The direct transport supplies this Home's current Machine proof;
        // native owners and the approved invocation's original authority stay real.
        workspaceFilesReplacePreview: async (request, context) => previewEffect(request, { ...context,
          ...await admittedPersonFacts('workspace.files.replace.preview', request, accountId, machineId, serverIdentityId) }),
        workspaceFilesReplace: async (request, context) => replaceEffect(request, { ...context,
          ...await admittedPersonFacts('workspace.files.replace', request, accountId, machineId, serverIdentityId) }),
        languageIntelligenceApply: async (request, context) => languageEffect(request, { ...context,
          ...await admittedPersonFacts(request.actionId, request.request, accountId, machineId, serverIdentityId) }),
        filesystemActionExecute: async request => filesystemEffect({ ...request, context: { ...request.context,
          ...await admittedPersonFacts(request.actionId, request.input, accountId, machineId, serverIdentityId) } }),
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
          serverId, machineId, serverApiUrl: origin, resolveCurrentMachineExecutionOriginContext,
        }),
      });
      client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown: () => {} }, { externalActionIngressOwner: {
        currentServerId: serverId, executor, resolveTarget: async () => ({ kind: 'machine', machineId }),
        ...(scenario === 'missing-witness' ? {} : { resolvePluginExecutionOriginContext: async () => {
          readingNativeWitness = true;
          try { return await resolveCurrentMachineExecutionOriginContext(); }
          finally { readingNativeWitness = false; }
        } }),
      } });
      await writeFile(join(root, 'a.txt'), Buffer.from('\uFEFFold\r\n'));
      let bytes = await readFile(join(root, 'a.txt'));
      const replaced = kind === 'restore' ? await apply({ kind: 'replace', matcher,
        files: [{ path: 'a.txt', expectedHash: hash(bytes) }] }) : null;
      if (replaced && !replaced.ok) throw new Error('Cannot prepare real inverse');
      const restoreOperation = replaced?.ok ? buildWorkspaceFileRestoreOperation(replaced.results) : null;
      if (restoreOperation) bytes = await readFile(join(root, 'a.txt'));
      const inputMachineId = scenario === 'foreign-input' ? 'another-machine' : machineId;
      const input = kind === 'preview' ? { machineId: inputMachineId, rootPath: root, ...matcher }
        : kind === 'directory' ? { rootPath: root, path: 'approved-directory' }
          : kind === 'rename' || kind === 'fileRename' ? getActionSpec(actionId).inputSchema.parse({ machineId, rootPath: root, path: 'a.txt', files: [{
            path: 'a.txt', expectedHash: hash(bytes), ...(kind === 'fileRename' ? { renameTo: 'approved-renamed.txt' } : {}),
            edits: kind === 'fileRename' ? [] : [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, text: 'new' }],
          }] }) : kind === 'codeAction' ? getActionSpec(actionId).inputSchema.parse({ machineId, rootPath: root, path: 'a.txt',
            operation: { kind: 'codeAction', expectedHash: hash(Buffer.from('stale query')), action: {
              serverId: 'fixture/server', title: 'Reviewed stale fix', hasCommand: false, files: [],
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
            } },
          })
            : { machineId, rootPath: root, operation: restoreOperation
              ?? { kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(bytes) }] } };
      try {
        // A different device owns the proposing UI profile. Do not run that
        // proposal through the deciding daemon's fixed-Home context wrapper.
        const proposal = await createActionExecutor(deps).execute(actionId, input, { surface: 'ui', authority: 'present_user',
          actionCaller: { kind: 'host' }, serverId: 'ui-home-profile', serverIdentityId, runtimeAccountId: accountId,
          actionRequestId: 'replace-proposal', ...(scenario === 'implicit-target' ? {}
            : { externalActionTarget: { kind: 'machine', machineId } as const }) });
        if (scenario === 'foreign-input') {
          expect(proposal).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
          expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
          return;
        }
        expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposal.ok || typeof proposal.result !== 'object' || proposal.result === null || !('artifactId' in proposal.result)
          || typeof proposal.result.artifactId !== 'string') throw new Error('Missing real approval request');
        const original = readApproval(proposal.result.artifactId);
        expect(original).toMatchObject({ v: 2, executionOriginV1: {
          serverId: 'ui-home-profile', serverIdentityId, machineId,
          ...(scenario === 'implicit-target' ? {} : { target: { kind: 'machine', machineId } }),
        } });
        if (scenario === 'implicit-target' && original.v === 2) expect(original.executionOriginV1).not.toHaveProperty('target');
        expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
        if (scenario === 'foreign-home') features.capabilities.serverIdentity.serverIdentityId = 'srv_another_home';
        if (scenario === 'retired') client.setRPCHandlers({
          spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
          stopSession: async () => true, requestShutdown: () => {},
        });
        const decision = await executor.execute('approval.request.decide', { artifactId: proposal.result.artifactId, decision: 'approve' },
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, serverIdentityId,
            runtimeAccountId: accountId, actionRequestId: 'replace-decision' });
        if (scenario === 'foreign-home') {
          expect(decision).toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false,
            details: { reason: 'home_changed' } });
          expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
          return;
        }
        if (scenario !== 'current' && scenario !== 'implicit-target') {
          expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
            ok: false, errorCode: 'target_unavailable',
          } } });
          expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
          return;
        }
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        const request = readApproval(proposal.result.artifactId);
        expect(request).toMatchObject({ status: 'executed', execution: { ok: true, result: kind === 'preview'
          ? { files: [{ path: 'a.txt', hash: hash(bytes) }] }
          : kind === 'directory' ? { success: true }
            : kind === 'codeAction' ? { status: 'error', errorCode: 'stale_query' }
            : { results: [{ path: 'a.txt', status: kind === 'restore' ? 'restored' : 'replaced',
              ...(kind === 'fileRename' ? { renameTo: 'approved-renamed.txt', edits: [] }
                : kind === 'restore' ? {} : { edits: [{ originalText: 'old', insertText: 'new' }] }),
            }] } } });
        if (kind === 'directory') {
          await expect(access(join(root, 'approved-directory'))).resolves.toBeUndefined();
          // The physical phase rechecks its owner, not the Home over HTTP again.
          expect(nativeWitnessRequests).toBe(1);
        }
        if (kind === 'fileRename') {
          await expect(access(join(root, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(root, 'approved-renamed.txt'))).toEqual(bytes);
          return;
        }
        expect(await readFile(join(root, 'a.txt'))).toEqual(kind === 'preview' || kind === 'directory' || kind === 'codeAction' ? bytes
          : Buffer.from(kind === 'restore' ? '\uFEFFold\r\n' : '\uFEFFnew\r\n'));
      } finally { await client.shutdown(); restore(); await app.close(); }
    });
  });

  it('restores only when the post-hash and inserted-text assertions both hold', async () => {
    await writeFile(join(root, 'a.txt'), 'new');
    const edit = { startUtf16: 0, deleteLength: 3, insertText: 'wrong', originalText: 'old' };
    expect(await apply({ kind: 'restore', files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('new')), edits: [edit] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await apply({ kind: 'restore', files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')), edits: [{ ...edit, insertText: 'new' }] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new');
  });

  it('applies one semantic edit set through the guarded writer and restores exact multiline bytes', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    const bytes = Buffer.from('\uFEFFconst old = 1;\r\nold();\r\n');
    await writeFile(join(root, 'a.ts'), bytes);
    await writeFile(join(root, 'b.ts'), 'old\n');
    const result = await apply({ kind: 'editSet', files: [
      { path: 'a.ts', expectedHash: hash(bytes), edits: [
        { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } }, text: 'renamed' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, text: 'renamed' },
      ] },
      { path: 'b.ts', expectedHash: hash(Buffer.from('old\n')), edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: 'renamed\n// done\n' },
      ] },
    ] });
    expect(result).toMatchObject({ ok: true, results: [{ status: 'replaced' }, { status: 'replaced' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('\uFEFFconst renamed = 1;\r\nrenamed();\r\n');
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path, expectedHash: file.hash, edits: file.edits })) }))
      .toMatchObject({ results: [{ status: 'restored' }, { status: 'restored' }] });
    expect(await readFile(join(root, 'a.ts'))).toEqual(bytes);
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('old\n');
  });

  it('rejects overlapping semantic edits and stale edit sets without writing', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    await writeFile(join(root, 'a.ts'), 'old();\n');
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'new' };
    expect(await apply({ kind: 'editSet', files: [{ path: 'a.ts', expectedHash: hash(Buffer.from('old();\n')), edits: [edit, edit] }] }))
      .toMatchObject({ results: [{ status: 'failed', reason: 'overlapping_edits' }] });
    expect(await apply({ kind: 'editSet', files: [{ path: 'a.ts', expectedHash: hash(Buffer.from('older')), edits: [edit] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('old();\n');
  });

  it.each(['replace', 'restore'] as const)('applies valid targets in ordinary %s when another preview target changed on disk', async kind => {
    const original = Buffer.from(kind === 'replace' ? '\uFEFFold\r\n' : '\uFEFFnew\r\n');
    await writeFile(join(root, 'a.ts'), original);
    await writeFile(join(root, 'b.ts'), original);
    await writeFile(join(root, 'c.ts'), original);
    const files = ['a.ts', 'b.ts', 'c.ts'].map(path => ({ path, expectedHash: hash(original) }));
    await writeFile(join(root, 'b.ts'), 'agent edit\r\n');
    const outcome = await apply(kind === 'replace'
      ? { kind, matcher, files }
      : { kind, files: files.map(file => ({ ...file, edits: [
        { startUtf16: 1, deleteLength: 3, insertText: 'new', originalText: 'old' },
      ] })) });
    expect(outcome).toMatchObject({ ok: true, results: [
      { path: 'a.ts', status: kind === 'replace' ? 'replaced' : 'restored' },
      { path: 'b.ts', status: 'changed' },
      { path: 'c.ts', status: kind === 'replace' ? 'replaced' : 'restored' },
    ] });
    expect(await readFile(join(root, 'a.ts'))).toEqual(Buffer.from(kind === 'replace' ? '\uFEFFnew\r\n' : '\uFEFFold\r\n'));
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('agent edit\r\n');
    expect(await readFile(join(root, 'c.ts'))).toEqual(Buffer.from(kind === 'replace' ? '\uFEFFnew\r\n' : '\uFEFFold\r\n'));
  });

  it('refuses the entire semantic edit set when the last preview target changed on disk', async () => {
    const original = Buffer.from('\uFEFFold\r\n');
    await writeFile(join(root, 'a.ts'), original);
    await writeFile(join(root, 'b.ts'), original);
    const files = ['a.ts', 'b.ts'].map(path => ({ path, expectedHash: hash(original) }));
    // The preview has already captured both hashes. An external writer changes
    // the later target before Apply, so even the first target must stay intact.
    await writeFile(join(root, 'b.ts'), 'agent edit\r\n');
    vi.mocked(filesystem.writeFile).mockClear();
    const outcome = await apply({ kind: 'editSet', files: files.map(file => ({ ...file, edits: [
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, text: 'new' },
      ] })) });
    expect(outcome).toMatchObject({ ok: true, results: [
      { path: 'a.ts', status: 'skipped', reason: 'edit_set_aborted' },
      { path: 'b.ts', status: 'changed' },
    ] });
    expect(await readFile(join(root, 'a.ts'))).toEqual(original);
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('agent edit\r\n');
    expect((await filesystem.readdir(root)).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('validates every semantic target before a source move or buffer write can begin', async () => {
    await writeFile(join(root, 'a.ts'), 'old');
    await writeFile(join(root, 'b.ts'), 'old');
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next' };
    expect(await apply({ kind: 'editSet', files: [
      { path: 'a.ts', expectedHash: hash(Buffer.from('old')), edits: [edit], renameTo: 'moved.ts' },
      { path: 'b.ts', expectedHash: hash(Buffer.from('old')), edits: [edit, edit] },
    ] })).toMatchObject({ results: [
      { status: 'skipped', reason: 'edit_set_aborted' },
      { status: 'failed', reason: 'overlapping_edits' },
    ] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('old');
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('old');
    await expect(readFile(join(root, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renames a semantic source with importer edits and guarded inverse rename without overwriting a destination', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'b.ts'), "import './a';\n");
    const originalHash = hash(Buffer.from('export const value = 1;\n'));
    const source = { path: 'a.ts', expectedHash: originalHash, edits: [], renameTo: 'renamed.ts' };
    const result = await apply({ kind: 'editSet', files: [source, { path: 'b.ts', expectedHash: hash(Buffer.from("import './a';\n")), edits: [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: 'renamed' },
    ] }] });
    expect(result).toMatchObject({ results: [{ status: 'replaced', renameTo: 'renamed.ts' }, { status: 'replaced' }] });
    await expect(readFile(join(root, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe("import './renamed';\n");
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({
      path: file.renameTo ?? file.path, expectedHash: file.hash, edits: file.edits,
      ...(file.renameTo ? { renameTo: file.path } : {}),
    })) })).toMatchObject({ results: [{ status: 'restored' }, { status: 'restored' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('export const value = 1;\n');
    await writeFile(join(root, 'renamed.ts'), 'user destination');
    expect(await apply({ kind: 'editSet', files: [source, { path: 'b.ts', expectedHash: hash(Buffer.from("import './a';\n")), edits: [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: 'renamed' },
    ] }] })).toMatchObject({ results: [{ status: 'changed', reason: 'expected_file_absent' }, { status: 'skipped', reason: 'edit_set_aborted' }] });
    expect(await readFile(join(root, 'renamed.ts'), 'utf8')).toBe('user destination');
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe("import './a';\n");
  });

  it('maps an agent write during staging to changed through the real guarded writer', async () => {
    const dest = join(root, 'a.txt');
    await writeFile(dest, 'old');
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // The filesystem is the boundary. The actual guarded writer and final
    // before-rename hash check both remain real.
    vi.mocked(filesystem.writeFile).mockImplementation(async (path, data, options) => {
      await write(path, data, options);
      if (path !== dest) await write(dest, 'agent changed');
    });
    const result = await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'changed', reason: 'hash_mismatch' }] });
    expect(await readFile(dest, 'utf8')).toBe('agent changed');
  });

  it('keeps importer Undo unattempted when the inverse file move conflicts', async () => {
    const current = "import './renamed';\n";
    await writeFile(join(root, 'a.ts'), 'new user file');
    await writeFile(join(root, 'renamed.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'b.ts'), current);
    const operation = buildWorkspaceFileRestoreOperation([
      { path: 'a.ts', status: 'replaced', hash: hash(Buffer.from('export const value = 1;\n')), edits: [], renameTo: 'renamed.ts' },
      { path: 'b.ts', status: 'replaced', hash: hash(Buffer.from(current)), edits: [{ startUtf16: 10, deleteLength: 1, insertText: 'renamed', originalText: 'a' }] },
    ]);
    const result = await applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    expect(result).toMatchObject({ results: [{ status: 'skipped', reason: 'edit_set_aborted' }, { status: 'changed' }] });
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe(current);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('new user file');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports the canonical writer refusal for read-only files', async () => {
    const dest = join(root, 'a.txt');
    await writeFile(dest, 'old');
    await chmod(dest, 0o444);
    const result = await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'failed', reason: 'file_replace_failed' }] });
    expect(await readFile(dest, 'utf8')).toBe('old');
  });

  it('reports every unattempted file on cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] }, controller.signal))
      .toEqual({ ok: true, results: [], cancelled: ['a.txt'] });
  });

  it('retains the cancelled apply acknowledgement and restores successful files byte-for-byte', async () => {
    const bytes = Buffer.from('\uFEFFold\r\n');
    for (const path of ['a.txt', 'b.txt']) await writeFile(join(root, path), bytes);
    const controller = new AbortController();
    const remote = new AbortController();
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.writeFile).mockImplementation(async (path, data, options) => {
      await write(path, data, options);
      controller.abort();
    });
    // Only the network is adapted: cancellation reaches the daemon signal,
    // while the shared caller, handler, decoder, inverse edits and writer are real.
    const socket = {
      connected: true,
      emit: (event: string, payload: unknown) => {
        expect(event).toBe('rpc-cancel');
        expect(payload).toEqual({ requestId: 'replace-cancel-test' });
        remote.abort();
      },
      emitWithAck: async (_event: string, payload: unknown) => {
        expect(payload).toMatchObject({ waitForResultOnCancel: true });
        const request = (payload as { params: unknown }).params;
        const result = await applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, { signal: remote.signal });
        return { ok: true, result };
      },
    };
    const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(await callSocketRpc({ socket,
      target: { kind: 'machine', id: 'machine' }, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY,
      params: { rootPath: root, operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(bytes) })) } },
      content: { mode: 'plain' }, requestId: 'replace-cancel-test', signal: controller.signal, waitForResultOnCancel: true,
    }));
    expect(result).toMatchObject({ results: [{ path: 'a.txt', status: 'replaced' }], cancelled: ['b.txt'] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew\r\n'));
    expect(await readFile(join(root, 'b.txt'))).toEqual(bytes);
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path, expectedHash: file.hash, edits: file.edits })) }))
      .toMatchObject({ results: [{ status: 'restored' }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
  });

  it('continues bounded previews without losing or reselecting matches across pages', async () => {
    const text = `old ${'é'.repeat(Math.floor(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES / 6))}\n`;
    for (const path of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, path), text);
    const paths: string[] = [];
    let pages = 0;
    let cursor: { path: string } | undefined;
    do {
      const page = await preview({ contextLines: 0, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      pages++;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
      paths.push(...page.files.map(file => file.path));
      cursor = page.cursor;
      expect(page.hasMore).toBe(Boolean(cursor));
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(paths).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  });

  it('skips invalid UTF8 and binary bytes while preserving text preview/apply parity', async () => {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([255, ...Buffer.from('old')]));
    await writeFile(join(root, 'binary.txt'), Buffer.from('old\0bytes'));
    await writeFile(join(root, 'plain.txt'), 'old old\r\n');
    const page = await preview();
    expect(page).toMatchObject({ ok: true, skipped: { notText: 2 }, files: [{ path: 'plain.txt', matchCount: 2 }] });
    if (!page.ok) return;
    const result = await apply({ kind: 'replace', matcher, files: page.files.map(file => ({ path: file.path, expectedHash: file.hash })) });
    expect(result).toMatchObject({ ok: true, results: [{ matchCount: page.files[0].matchCount }] });
  });

  it('uses JavaScript lookaround for preview and guarded apply after native discovery fallback', async () => {
    await writeFile(join(root, 'a.txt'), 'old token old other\n');
    const matcher = { query: 'old(?= token)', replacement: 'new', regex: true, matchCase: true };
    const page = await preview(matcher);
    expect(page).toMatchObject({ ok: true, files: [{ path: 'a.txt', matchCount: 1 }] });
    if (!page.ok) return;
    expect(await apply({ kind: 'replace', matcher, files: page.files.map(file => ({ path: file.path, expectedHash: file.hash })) }))
      .toMatchObject({ ok: true, results: [{ status: 'replaced', matchCount: 1 }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new token old other\n');
  });

  it('discovers zero-width matches in empty files and keeps JavaScript word-boundary semantics', async () => {
    await writeFile(join(root, 'empty.txt'), '');
    await writeFile(join(root, 'unicode.txt'), 'éfoo');
    const empty = await preview({ query: '^$', replacement: 'new', regex: true });
    expect(empty).toMatchObject({ ok: true, files: [{ path: 'empty.txt', matchCount: 1 }] });
    expect(await preview({ query: '\\bfoo', regex: true })).toMatchObject({ ok: true, files: [{ path: 'unicode.txt', matchCount: 1 }] });
  });

  it('does not write when the inverse edits cannot fit the transport result', async () => {
    await writeFile(join(root, 'a.txt'), 'old old');
    const result = await apply({ kind: 'replace', matcher: { ...matcher, replacement: 'n'.repeat(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES / 2) },
      files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'failed', reason: 'transport_ceiling' }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old old');
  });

  it('bounds rejected-file replies with explicit truncation before any file can be changed', async () => {
    const outside = `../${'x'.repeat(Math.ceil(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES / 2))}`;
    const result = await applyWorkspaceFileReplace({ rootPath: root, operation: { kind: 'replace', matcher,
      files: [0, 1, 2].map(index => ({ path: `${outside}${index}`, expectedHash: hash(Buffer.from('old')) })),
    } }, root, { kind: 'osUser' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
    expect(result).toMatchObject({ ok: true, truncated: true, results: [{ status: 'failed', reason: 'transport_ceiling' }] });
    expect(DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(result).success).toBe(true);
    expect(filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('reports incomplete coverage for an indivisible oversized file while keeping readable results', async () => {
    await writeFile(join(root, 'huge.txt'), `${'old '.repeat(3000)}\n`);
    await writeFile(join(root, 'small.txt'), 'old\n');
    const page = await preview();
    expect(page).toMatchObject({ ok: true, coverage: 'partial', hasMore: false, files: [{ path: 'small.txt' }] });
    if (page.ok) expect(page.files).toHaveLength(1);
  });
});
