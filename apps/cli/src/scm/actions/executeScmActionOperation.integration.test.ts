import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';
import axios from 'axios';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, AccountProfileSchema, AccountSettingsV2GetResponseSchema, ApprovalRequestSchema, createActionExecutor, FeaturesResponseSchema, RPC_METHODS } from '@happier-dev/protocol';
import type { RpcHandler } from '@/api/rpc/types';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions';
import { ScmChangeDiscardResponseSchema, ScmDiffFileResponseSchema } from '@happier-dev/protocol/scm';

import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createBareGitRemoteFixture, createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { executeScmActionOperation } from './executeScmActionOperation';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';

describe('SCM Action execution at the Git backend', () => {
  const registration = createGitScmBackendRuntimeRegistration();
  const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
    executableDefinition: registration.runtime!, registration,
    hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
  })]);
  const repositories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  afterAll(async () => {
    await Promise.all(repositories.map((path) => rm(path, { recursive: true, force: true })));
  });

  it('retains a 300 KiB Discard Undo receipt inside the actual socket reply limit', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-undo-reply-' });
    repositories.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const baseline = await readFile(file);
    const edited = Buffer.from('é😀'.repeat(55_000));
    await writeFile(file, edited);
    const response = ScmChangeDiscardResponseSchema.parse(await executeScmActionOperation({ actionId: 'scm.change.discard',
      input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
        against: { source: { kind: 'workingTree' } }, includeUndo: true }] },
      registry, workingDirectory: fixture.rootPath,
    }));
    expect(response).toMatchObject({ success: true, entries: [{ status: 'restored' }] });
    const previous = response.entries?.[0]?.previous;
    expect(previous && 'inlineBase64' in previous && Buffer.from(previous.inlineBase64, 'base64').equals(edited)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(300 * 1024);
    expect(await readFile(file)).toEqual(baseline);
  });

  it('emits one HEAD discard note only for files changed before the successful Action', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-head-note-' });
    repositories.push(fixture.rootPath);
    const notes: unknown[] = [];
    const execute = () => executeScmActionOperation({ actionId: 'scm.change.discard',
      input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'modified' }] },
      registry, workingDirectory: fixture.rootPath, sessionId: 'review-session',
      emitFileReviewNote: async note => { notes.push(note); } });
    expect(await execute()).toMatchObject({ success: true });
    expect(notes).toEqual([]);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'changed before discard\n');
    expect(await execute()).toMatchObject({ success: true, noteDelivery: { status: 'queued' } });
    expect(notes).toEqual([{ sessionId: 'review-session', action: 'discard', paths: [fixture.trackedPath] }]);
    expect(await execute()).toMatchObject({ success: true });
    expect(notes).toHaveLength(1);
  });

  it('preserves a completed HEAD discard while reporting unavailable note evidence or delivery', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-head-note-failure-' });
    repositories.push(fixture.rootPath);
    const registered = createGitScmBackendRuntimeRegistration();
    // A real contribution without status support exercises the adapter's ordinary
    // unsupported result; no domain service or state machine is mocked.
    const noStatus = { ...registered, handlers: { ...registered.handlers,
      read: { ...registered.handlers.read, statusSnapshot: undefined } } };
    const noStatusRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registered.runtime!, registration: noStatus,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    const input = { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'modified' }] };
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'discard without status evidence\n');
    const notes: unknown[] = [];
    expect(await executeScmActionOperation({ actionId: 'scm.change.discard', input, registry: noStatusRegistry,
      workingDirectory: fixture.rootPath, sessionId: 'review-session', emitFileReviewNote: async note => { notes.push(note); } }))
      .toMatchObject({ success: true, noteDelivery: { status: 'failed' } });
    expect(notes).toEqual([]);
    expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--name-only'])).toBe('');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'discard with unavailable Home\n');
    expect(await executeScmActionOperation({ actionId: 'scm.change.discard', input, registry,
      workingDirectory: fixture.rootPath, sessionId: 'review-session', emitFileReviewNote: async () => { throw new Error('Home unavailable'); } }))
      .toMatchObject({ success: true, noteDelivery: { status: 'failed' } });
    expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--name-only'])).toBe('');
  });

  it('returns blame ranges through the registered RPC and canonical Action, and refuses unsupported leaves', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-blame-action-' });
    repositories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'uncommitted line\n');
    const handlers = new Map<string, RpcHandler>();
    const executor = createActionExecutor({ ...createCliActionDeps({ token: 'blame-ingress-token', sessionId: '', mode: 'plain', ctx: null }),
      scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({ actionId, input, registry, workingDirectory: fixture.rootPath }),
    });
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, fixture.rootPath,
      { registry, machineId: 'blame-machine', actionExecutor: executor });
    const handler = handlers.get('scm.blame.file');
    expect(handler, 'Blame RPC must reach the canonical SCM Action dispatcher').toBeTypeOf('function');
    const input = { cwd: fixture.rootPath, path: fixture.trackedPath };
    const action = await executeScmActionOperation({ actionId: 'scm.blame.get', input, registry, workingDirectory: fixture.rootPath });
    expect(action).toMatchObject({ success: true, ranges: [{ startLine: 1, lineCount: 1, commitIndex: null }], commits: [] });
    expect(await handler!(input)).toEqual(action);
    expect(await handler!({ ...input, expectedHash: '0'.repeat(64) })).toMatchObject({ success: false, errorCode: 'stale_file' });
    expect(await handler!({ ...input, unknownAuthority: true })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const registered = createGitScmBackendRuntimeRegistration();
    const noBlameRegistration = { ...registered,
      handlers: { ...registered.handlers, read: { ...registered.handlers.read, blameFile: undefined } },
    };
    const unsupportedRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: noBlameRegistration.runtime!, registration: noBlameRegistration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    expect(await executeScmActionOperation({ actionId: 'scm.blame.get', input, registry: unsupportedRegistry, workingDirectory: fixture.rootPath }))
      .toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
  });

  it('returns a typed invalid-request response at raw RPC ingress before any Git effect', async () => {
    await expect(executeScmActionOperation({
      actionId: 'scm.change.include', input: { paths: ['../outside'] },
      registry, workingDirectory: '/not-used', rpcCompatibility: true,
    })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
  });

  it('undoes an observed commit through the registered semantic Action and refuses replay on newer HEAD', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-undo-action-' });
    repositories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'undo through Action\n');
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-am', 'undo through Action']);
    const expectedHeadOid = runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD']);
    await expect(executeScmActionOperation({
      actionId: 'scm.commit.undoLast', input: { cwd: fixture.rootPath, expectedHeadOid },
      registry, workingDirectory: fixture.rootPath,
    })).resolves.toMatchObject({ success: true, undoneCommitSha: expectedHeadOid, headOid: fixture.headCommit, outcome: { kind: 'succeeded' } });
    expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.headCommit);
    expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--cached', '--name-only'])).toBe(fixture.trackedPath);
    await expect(executeScmActionOperation({
      actionId: 'scm.commit.undoLast', input: { cwd: fixture.rootPath, expectedHeadOid },
      registry, workingDirectory: fixture.rootPath,
    })).resolves.toMatchObject({ success: false, errorCode: 'COMMIT_UNDO_HEAD_CHANGED', outcome: { kind: 'needs_input' } });
  });

  it('admits advanced pull and expected-OID lease Actions from the Git contribution', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-policy-action-' });
    const remote = createBareGitRemoteFixture('happier-scm-policy-action-remote-');
    repositories.push(fixture.rootPath, remote.remotePath);
    runScmExecutable(fixture.rootPath, 'git', ['remote', 'add', 'origin', remote.remotePath]);
    runScmExecutable(fixture.rootPath, 'git', ['push', '-u', 'origin', fixture.branchName]);
    await writeFile(join(fixture.rootPath, 'local.txt'), 'preserved local work\n');

    await expect(executeScmActionOperation({
      actionId: 'scm.remote.pull',
      input: { cwd: fixture.rootPath, dirtyPolicy: 'autostash', reconcile: 'rebase' },
      registry, workingDirectory: fixture.rootPath,
    })).resolves.toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
    expect(runScmExecutable(fixture.rootPath, 'git', ['status', '--porcelain'])).toBe('?? local.txt');
    expect(runScmExecutable(fixture.rootPath, 'git', ['stash', 'list'])).toBe('');

    await expect(executeScmActionOperation({
      actionId: 'scm.remote.push',
      input: {
        cwd: fixture.rootPath, remote: 'origin', branch: fixture.branchName,
        pushMode: 'force_with_lease', expectedRemoteOid: fixture.headCommit,
      },
      registry, workingDirectory: fixture.rootPath,
    })).resolves.toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
    expect(runScmExecutable(remote.remotePath, 'git', ['rev-parse', `refs/heads/${fixture.branchName}`])).toBe(fixture.headCommit);
  });

  it.each([
    { surface: 'agent', actionId: 'scm.change.include', moved: false },
    { surface: 'agent', actionId: 'scm.change.discard', moved: false },
    { surface: 'mcp', actionId: 'scm.change.discard', moved: false },
    { surface: 'agent', actionId: 'scm.change.discard', moved: true },
  ] as const)('waits for delayed $surface approval of $actionId (moved=$moved) and settles its real Git result', async ({ surface, actionId, moved }) => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-action-' });
    repositories.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join('');
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-am', 'discovery base']);
    const changed = before.replace('line 3\n', 'person change\n').replace('line 30\n', 'own change\n');
    await writeFile(file, changed);
    const sessionId = 'c111111111111111111111111';
    const machineId = 'machine-action-test';
    const serverApiUrl = 'https://scm-action-approval.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-action-test' })).toString('base64url')}.signature`, encryption: null };
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }),
      ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: fixture.rootPath, machineId } } } });
    // Replace only Home HTTP transport; replay identity, Account eligibility,
    // Session locality and the blocking approval coordinator remain real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.origin === serverApiUrl && url.pathname === '/v1/features') {
        return Response.json(FeaturesResponseSchema.parse({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: 'srv_scm_action_approval' } } }));
      }
      throw new Error(`Unexpected Home HTTP request: ${url}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url) === `${serverApiUrl}/v1/account/profile`) {
        return { status: 200, data: AccountProfileSchema.parse({ id: 'account-action-test' }) };
      }
      if (String(url) === `${serverApiUrl}/v1/account/encryption/currentness`) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      }
      if (String(url) === `${serverApiUrl}/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
      if (String(url) === `${serverApiUrl}/v2/account/settings`) {
        return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
      }
      throw new Error(`Unexpected Home HTTP request: ${String(url)}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method === 'POST' && String(config.url) === `${serverApiUrl}${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}`) {
        return { status: 200, data: { tokens: [] } };
      }
      throw new Error(`Unexpected Home HTTP request: ${String(config.url)}`);
    });
    // The running host has loaded its Account policy before accepting Actions.
    await runWithServerHttpBaseUrl(serverApiUrl, () => bootstrapAccountSettingsContext({
      credentials, mode: 'blocking', refresh: 'force',
    }));
    const isApprovalExecutionOriginCurrent = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials, machineId, serverId: configuration.activeServerId, serverApiUrl,
    });
    expect(isApprovalExecutionOriginCurrent).toBeDefined();
    let approved = false;
    let requestedAction: string | undefined;
    const approvalCoordinator = createBlockingApprovalCoordinator();
    let ready!: (value: Parameters<typeof approvalCoordinator.resolveBlockingDecision>[0]) => void;
    const waiting = new Promise<Parameters<typeof approvalCoordinator.resolveBlockingDecision>[0]>(resolve => { ready = resolve; });
    const unused = async (): Promise<never> => { throw new Error('Unrelated Action dependency was invoked'); };
    const executor = createActionExecutor({
      executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
      detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
      sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
      pathsListRecent: unused, machinesList: unused, serversList: unused, reviewEnginesList: unused,
      agentsBackendsList: unused, agentsModelsList: unused, sessionSendMessage: unused,
      sessionPermissionRespond: unused, sessionUserActionAnswer: unused, sessionTargetPrimarySet: unused,
      sessionTargetTrackedSet: unused, sessionList: unused, sessionActivityGet: unused,
      sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
      sessionModeSet: unused, sessionModesList: unused,
      daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
      isApprovalExecutionOriginCurrent,
      // These are durable-artifact and human-decision transport boundaries.
      // The Action admission and live blocking coordinator remain real.
      approvalsCreate: async ({ request }) => {
        requestedAction = request.actionId;
        expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--cached', '--name-only'])).toBe('');
        return { artifactId: 'git-action-approval' };
      },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ artifactId, request, signal }) => {
        const pending = approvalCoordinator.waitForDecision({ artifactId, request, ...(signal ? { signal } : {}) });
        ready({ artifactId, request: { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: Date.now() } }, decision: 'approve' });
        const decision = await pending;
        if (!('actionId' in decision.request)) throw new Error('Expected a canonical Action approval decision');
        return { ...decision, request: ApprovalRequestSchema.parse(decision.request) };
      },
      scmActionExecute: async ({ actionId, input }) => {
        if (actionId !== 'scm.diff.file') expect(approved).toBe(true);
        return executeScmActionOperation({ actionId, input, registry, workingDirectory: fixture.rootPath });
      },
    });

    const context = { surface, authority: 'account_automation' as const, serverId: configuration.activeServerId,
      actionRequestId: 'scm-include-action-test',
      defaultSessionId: sessionId, defaultSessionMachineId: machineId };
    const bridge = createActionToolExecutorBridge({ surface, executor: {
      execute: (id, input, toolContext) => executor.execute(id, input, { ...context, ...toolContext }),
    } });
    const server = new McpServer({ name: 'happier', version: '1' });
    registerHappierMcpBuiltInTools(server, { sessionId, sessionMachineId: machineId, workingDirectory: fixture.rootPath, surface,
      deps: { ...bridge, changeTitle: unused, resolveActionOptions: args => bridge.resolveActionOptions(args, sessionId) } });
    // Replace only the Agent process connection; MCP dispatch, approval, SCM
    // registration, content-key projection and Git operations all remain real.
    const client = new Client({ name: 'scm-discovery-agent', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    onTestFinished(async () => { await client.close(); await server.close(); approvalCoordinator.dispose(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const execute = async (id: string, input: unknown): Promise<unknown> => {
      const result = CallToolResultSchema.parse(await callMcpToolWithResolvedTimeout({ client, toolName: 'action_execute', args: { actionId: id, input } }));
      const content = result.content.find(item => item.type === 'text');
      if (!content || content.type !== 'text') throw new Error('Missing MCP Action result');
      const value: unknown = JSON.parse(content.text);
      expect(result.isError).not.toBe(true);
      return value;
    };
    const diff = ScmDiffFileResponseSchema.parse(await execute('scm.diff.file', { cwd: fixture.rootPath, path: fixture.trackedPath, area: 'both' }));
    expect(diff).toMatchObject({ success: true, reviewUnits: expect.any(Array) });
    // Read the proposed projection as a consumer without a cast or requiring
    // the producer type to exist before this regression earns its first RED.
    const { reviewUnits } = z.object({ reviewUnits: z.array(z.object({ key: z.string() })) }).parse(diff);
    expect(reviewUnits).toHaveLength(2);
    if (actionId === 'scm.change.include') {
      const pending = ScmDiffFileResponseSchema.parse(await execute('scm.diff.file', { cwd: fixture.rootPath, path: fixture.trackedPath }));
      expect(pending.success).toBe(true);
      expect(pending).not.toHaveProperty('reviewUnits');
    }
    const ownKey = reviewUnits[1]!.key;
    const input = actionId === 'scm.change.include' ? { cwd: fixture.rootPath, paths: [fixture.trackedPath] }
      : { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
        against: { source: { kind: 'workingTree' } }, changeKeys: [ownKey], includeUndo: true }] };
    let settled = false;
    const execution = execute(actionId, input).then(result => { settled = true; return result; });
    const decision = await Promise.race([waiting, execution.then(() => { throw new Error('Action returned before approval'); })]);
    expect(await readFile(file, 'utf8')).toBe(changed);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    expect(approvalCoordinator.getLiveWaiterCount(decision.artifactId)).toBe(1);
    vi.useRealTimers();
    if (moved) await writeFile(file, changed.replace('own change\n', 'changed again\n'));
    approved = true;
    expect(await approvalCoordinator.resolveBlockingDecision(decision)).toEqual({ resolved: true });
    const result = await execution;

    expect(requestedAction).toBe(actionId);
    if (moved) {
      expect(ScmChangeDiscardResponseSchema.parse(result)).toMatchObject({ success: false, errorCode: 'CHANGE_MOVED_ON' });
      expect(await readFile(file, 'utf8')).toBe(changed.replace('own change\n', 'changed again\n'));
    } else if (actionId === 'scm.change.include') {
      expect(result).toMatchObject({ success: true });
      expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--cached', '--name-only'])).toBe(fixture.trackedPath);
    } else {
      expect(result).toMatchObject({ success: true, entries: [{ status: 'reverted' }] });
      expect(await readFile(file, 'utf8')).toBe(before.replace('line 3\n', 'person change\n'));
      expect(runScmExecutable(fixture.rootPath, 'git', ['diff', '--cached', '--name-only'])).toBe('');
    }
  });

  it('projects only the legacy RPC outer failure code while retaining the canonical outcome', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-compat-' });
    repositories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Requires signing\n');
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['config', 'commit.gpgSign', 'true']);
    runScmExecutable(fixture.rootPath, 'git', ['config', 'gpg.program', 'happier-test-signing-program-that-does-not-exist']);
    const request = { cwd: fixture.rootPath, message: 'Signing fails' };
    const base = { actionId: 'scm.commit.create' as const, registry, workingDirectory: fixture.rootPath };
    await expect(executeScmActionOperation({ ...base, input: request, rpcCompatibility: true })).resolves.toMatchObject({
      success: false, errorCode: 'COMMAND_FAILED', outcome: { kind: 'failed', errorCode: 'COMMIT_SIGNING_FAILED' },
    });
    for (const input of [request, { ...request, outcomeVersion: 1 }]) {
      await expect(executeScmActionOperation({ ...base, input, ...(input === request ? {} : { rpcCompatibility: true as const }) })).resolves.toMatchObject({
        success: false, errorCode: 'COMMIT_SIGNING_FAILED', outcome: { kind: 'failed', errorCode: 'COMMIT_SIGNING_FAILED' },
      });
    }
  });

  it('projects a new operation kind only on the legacy outer RPC state', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-state-compat-' });
    repositories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'middle\n');
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-am', 'middle']);
    const middle = runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD']);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'last\n');
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-am', 'last']);
    expect(() => runScmExecutable(fixture.rootPath, 'git', ['revert', '--no-edit', middle])).toThrow();
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, fixture.rootPath, { registry });
    const status = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!status) throw new Error('Status handler was not registered');
    const [legacyStatus, richStatus] = await Promise.all([
      status({ cwd: fixture.rootPath }),
      status({ cwd: fixture.rootPath, operationStateVersion: 1, outcomeVersion: 1 }),
    ]);
    expect(legacyStatus).toMatchObject({ snapshot: { operationState: null } });
    expect(richStatus).toMatchObject({ snapshot: { operationState: { kind: 'revert' } } });
    await expect(status({ cwd: fixture.rootPath })).resolves.toMatchObject({ snapshot: { operationState: null } });
    await expect(status({ cwd: fixture.rootPath, operationStateVersion: 1, outcomeVersion: 1 })).resolves.toMatchObject({ snapshot: { operationState: { kind: 'revert' } } });
    const base = { actionId: 'scm.branch.operation.continue' as const, registry, workingDirectory: fixture.rootPath, rpcCompatibility: true as const };
    const input = { cwd: fixture.rootPath, operation: 'revert' };
    await expect(executeScmActionOperation({ ...base, input })).resolves.toMatchObject({
      success: false, operationState: null, outcome: { repositoryState: { operation: { kind: 'revert' } } },
    });
    await expect(executeScmActionOperation({ ...base, input: { ...input, outcomeVersion: 1 } })).resolves.toMatchObject({
      success: false, operationState: { kind: 'revert' }, outcome: { repositoryState: { operation: { kind: 'revert' } } },
    });
  });
});
