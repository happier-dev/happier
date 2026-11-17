import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';

import { ProviderEnforcedPermissionHandler } from './handler';
import { createPluginSessionHandleCapabilitiesFactory } from '@/session/services/pluginSessionHandleCapabilities';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { createMcpPermissionChoices } from '@/mcp/runtime/mcpPermissionChoices';
import { createDeferred } from '@/testkit/async/deferred';
import { ServerBoundPermissionRpcHandlerManager } from '../testkit/serverBoundPermissionRpcHandlerManager';
import type { AgentState } from '@/api/types';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativePermissionEngine } from '../../../../../../packages/plugins/claude/src/agent/permissions/nativePermissionEngine';
import { createSdkExecFixture, createEventsFixture, createPluginContextFixture, createSessionHooksFixture, createTerminalHostFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ scopeKey: 'permission-test', source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
    rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
});
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

class FakeSession {
  sessionId = 'test-session-id';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
    await this.updateAgentState(updater);
  }

  getMetadataSnapshot() {
    return this.metadata;
  }
}

class DeferredUpdateSession extends FakeSession {
  private deferredUpdate: Promise<void> | null = null;
  private resolveDeferredUpdate: (() => void) | null = null;
  private deferredUpdater: ((state: any) => any) | null = null;

  deferNextUpdate(): void {
    this.deferredUpdate = new Promise<void>((resolve) => {
      this.resolveDeferredUpdate = resolve;
    });
  }

  releaseNextUpdate(): void {
    const update = this.deferredUpdater;
    this.deferredUpdater = null;
    if (update) this.agentState = update(this.agentState);
    this.resolveDeferredUpdate?.();
    this.resolveDeferredUpdate = null;
    this.deferredUpdate = null;
  }

  override updateAgentState(updater: any) {
    if (!this.deferredUpdate) return super.updateAgentState(updater);
    this.deferredUpdater = updater;
    return this.deferredUpdate;
  }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
    Promise.resolve(pending),
  ]);
  return result === pending ? 'pending' : result;
}

it.each(['Edit', 'mcp__docs__create'] as const)('preserves the coordinator occurrence and native metadata when an offline permission reconnects without a snapshot (%s)', async (toolName) => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'offline', limits: { maxEntries: 10, maxBytes: 10_000 } });
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'docs-id', name: 'docs', title: 'Docs', transport: 'stdio',
    stdio: { command: 'fixture-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    tools: { default: 'allow_read_only', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: 'fixture-machine',
      tools: [{ name: 'create', tokens: 10, annotations: { destructiveHint: true } }] } }], bindings: [] });
  const handler = new ProviderEnforcedPermissionHandler(deferred as never, { logPrefix: '[offline rebind]',
    getMcpToolContext: () => ({ catalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog },
      mcpServerIdentities: { docs: { serverId: 'docs-id', serverTitle: 'Docs' } } }) });
  const pending = handler.handleToolCall('offline-request', toolName, { file_path: 'a', old_string: 'a', new_string: 'b' }, {
    turnId: 'offline-turn', source: 'offline-source',
    owner: { kind: 'plugin', pluginId: 'fixture.plugin' },
    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
  });
  const rejected = expect(pending).rejects.toThrow();
  try {
    expect(deferred.getAgentStateSnapshot()).toBeNull();
    expect(deferred.getBufferStats().entryCount).toBeGreaterThan(0);
    now.mockReturnValue(2000);
    const connected = new FakeSession();
    handler.updateSession(connected as never);
    expect(connected.agentState.requests['offline-request']).toMatchObject({
      createdAt: 1000, source: 'offline-source', turnId: 'offline-turn',
      owner: { kind: 'plugin', pluginId: 'fixture.plugin' },
      ...(toolName.startsWith('mcp__') ? { mcpTool: { server: 'docs', tool: 'create', item: { serverId: 'docs-id' } } } : {}),
    });
  } finally {
    await handler.abortPendingRequestsAndFlush('test cleanup');
    await rejected;
    deferred.cancel();
    now.mockRestore();
  }
});

it('does not publish MCP preparation during a session rebind before the catalog admits it', async () => {
  let release!: () => void;
  const preparation = new Promise<void>(resolve => { release = resolve; });
  const session = new FakeSession();
  const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[catalog rebind]',
    getMcpToolContext: () => ({ catalog: null,
      mcpServerIdentities: { docs: { serverId: 'docs-id', serverTitle: 'Docs' } }, prepareCatalog: () => preparation }) });
  const pending = handler.handleToolCall('preparing-rebind', 'mcp__docs__create', {});
  const rejected = expect(pending).rejects.toThrow();
  const connected = new FakeSession();
  try {
    handler.updateSession(connected as never);
    expect(connected.agentState.requests).toEqual({});
  } finally {
    await handler.abortPendingRequestsAndFlush('test cleanup');
    await rejected;
    release();
    await preparation;
  }
});

it.each(['run', 'all', 'signal', 'reset', 'plugin', 'pluginTurn', 'mediatedTurn'] as const)('settles %s cancellation while MCP catalog preparation is held and never publishes the cancelled request', async cancellation => {
  const pluginId = 'fixture.plugin';
  let release!: () => void;
  const preparation = new Promise<void>(resolve => { release = resolve; });
  const session = new FakeSession();
  const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[catalog cancellation]',
    getMcpToolContext: () => ({ catalog: null,
      mcpServerIdentities: { docs: { serverId: 'docs-id', serverTitle: 'Docs' } }, prepareCatalog: () => preparation }) });
  const run = createRunScopedExecutionPermissionHandler({ runId: 'run', controllerOccurrenceId: 'occurrence', handler });
  const abort = new AbortController();
  const pending = cancellation === 'run'
    ? run.handler.handleToolCall('pending', 'mcp__docs__create', {})
    : handler.handleToolCall('pending', 'mcp__docs__create', {}, {
        signal: abort.signal, turnId: 'turn',
        ...(cancellation === 'mediatedTurn' ? {
          causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1Schema.parse({
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default', sourceAuthority: {
              kind: 'mediatedExternal', mediatorPluginId: pluginId, sourceRef: 'binding:ops', sourceRevisionOrEpoch: '1',
              admittedPermissionCeiling: 'default', remoteApprovalMaxScope: 'session',
            },
          }),
        } : { owner: { kind: 'plugin' as const, pluginId, runtimeId: 'runtime' } }),
      });
  const settlement = pending.then(() => 'fulfilled', () => 'rejected');
  let settled = false;
  void settlement.then(() => { settled = true; });
  try {
    if (cancellation === 'run') await run.dispose('Run stopped');
    else if (cancellation === 'all') await handler.abortPendingRequestsAndFlush('Session stopped');
    else if (cancellation === 'reset') await handler.reset();
    else if (cancellation === 'plugin') await handler.cancelByPlugin(pluginId, 'Plugin stopped');
    else if (cancellation === 'pluginTurn' || cancellation === 'mediatedTurn') await handler.cancelByPluginTurn(pluginId, 'turn', 'Turn stopped');
    else abort.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await settlement).toBe('rejected');
  } finally {
    release();
    await preparation;
  }
  expect(session.agentState.requests).toEqual({});
  await handler.abortPendingRequestsAndFlush('test cleanup');
});

describe('QA Edit button payloads at the native permission owner', () => {
  const buttons = [
    { name: 'allow once', fields: {} },
    { name: 'accept edits for session', fields: {
      mode: 'acceptEdits' as const,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    } },
  ];

  it.each(buttons)('settles $name with exact custody and preserves its provider update', async ({ fields }) => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[QA Edit]' });
    const pending = handler.handleToolCall('qa-edit', 'Edit', { file_path: 'src/alpha.txt', old_string: 'before', new_string: 'after' }, {
      turnId: 'qa-turn',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    });
    await vi.waitFor(() => expect(session.agentState.requests['qa-edit']).toMatchObject({ tool: 'Edit', turnId: 'qa-turn' }));
    // These are the Action normalizer's actual allow-once/all-edits carriers;
    // Session transport adds executing-client evidence, not another decision.
    const payload = { ...buildSessionPermissionRespondRpcParamsV1({ id: 'qa-edit', turnId: 'qa-turn', decision: 'allow', ...fields }),
      answeringClientCategory: 'web' as const };
    const respond = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    await expect(respond(payload)).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['qa-edit']).toBeUndefined();
    expect(session.agentState.completedRequests['qa-edit']).toMatchObject({
      status: 'approved', decision: 'approved', turnId: 'qa-turn', answeringClientCategory: 'web',
      ...('updatedPermissions' in fields ? { updatedPermissions: fields.updatedPermissions } : {}),
      permissionDecisionActorV1: { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' },
    });
    await expect(respond(payload)).resolves.toBeUndefined();
    // A setMode update is for the native provider; it must not turn the answer
    // into a reusable host tool grant or a different RPC decision.
    expect(handler.getImmediateDecision('another-edit', 'Edit', { file_path: 'src/beta.txt' })).toBeNull();
    await handler.reset();
  });

  it.each(buttons)('refuses stale custody and unattributable actors for $name without consuming the request', async ({ fields }) => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[QA Edit]' });
    const pending = handler.handleToolCall('qa-edit', 'Edit', { file_path: 'src/alpha.txt' }, { turnId: 'qa-turn' });
    await vi.waitFor(() => expect(session.agentState.requests['qa-edit']).toMatchObject({ turnId: 'qa-turn' }));
    const respond = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    const payload = { ...buildSessionPermissionRespondRpcParamsV1({ id: 'qa-edit', turnId: 'qa-turn', decision: 'allow', ...fields }),
      answeringClientCategory: 'web' as const };
    for (const invalidCustody of [{ id: 'unknown' }, { turnId: 'previous-turn' }, { turnId: undefined }]) {
      await expect(respond({ ...payload, ...invalidCustody })).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
    }
    for (const authorization of [undefined, { kind: 'session.permission.respond', sessionId: 'another-session',
      actor: { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' } },
      { kind: 'session.permission.respond', sessionId: session.sessionId, actor: { kind: 'accountUser', accountId: '' } }]) {
      await expect(respond(payload, { signal: new AbortController().signal, authorization })).resolves.toMatchObject({
        ok: false, errorCode: 'permission_actor_unattributable',
      });
    }
    expect(await respond({ ...payload, mode: 'accept-edits' })).toMatchObject({
      ok: false, errorCode: 'permission_response_invalid',
    });
    await expect(respond({ ...payload, updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['qa-edit']).toMatchObject({ turnId: 'qa-turn' });
    expect(session.agentState.completedRequests['qa-edit']).toBeUndefined();
    await expect(respond(payload)).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    await handler.reset();
  });
});

describe('native Agent tool approval policy', () => {
  it.each(['Read', 'read', 'rEaD', 'scoped'])(
    'projects %s configuration into native launch tools and enforces the same host policy', async spelling => {
      const directory = mkdtempSync(join(tmpdir(), 'happier-claude-policy-'));
      const attachments = join(directory, 'attachments');
      mkdirSync(attachments);
      const inside = join(attachments, 'lead.txt');
      const outside = join(directory, 'canary.txt');
      writeFileSync(inside, 'lead');
      writeFileSync(outside, 'private');
      const allowedTools = [spelling === 'scoped' ? `rEaD(${attachments}/**)` : spelling, 'wEbSeArCh', 'mcp__wilson__*'];
      const session = new FakeSession();
      session.metadata = { allowedTools, unlistedTools: 'deny' };
      const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], { logPrefix: '[Native projection]' });
      handler.setPermissionMode('yolo');
      const services = createNativeAgentSessionServices({ permissionHandler: handler,
        pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
        sessionId: session.sessionId, occurrenceId: 'projection-occurrence',
        signal: new AbortController().signal, isCurrent: () => true });
      const exec = createSdkExecFixture();
      const hooks = createSessionHooksFixture();
      const hostOwners = createNativeAgentSessionHostServiceOwners({
        runtimeRegistry: null,
        identity: { pluginId: 'happier.agent.claude', agentId: 'claude', occurrenceId: 'projection-occurrence' },
        backend: {
          id: 'claude', agentId: 'claude', provenance: 'first_party', source: { kind: 'bundled' },
          definition: { kindVersion: 1, id: 'claude', agentId: 'claude' },
          runtimeKind: 'custom', pluginId: 'happier.agent.claude',
        },
        agent: {
          id: 'claude', provenance: 'first_party', source: { kind: 'bundled' },
          definition: { kindVersion: 1, id: 'claude', ownedBackendIds: ['claude'] },
          pluginId: 'happier.agent.claude',
        },
        hostSession: { session, machineId: 'machine-1', permissionHandler: handler },
        sessionId: session.sessionId, directory, happyHomeDir: directory,
        signal: new AbortController().signal,
      });
      const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
        { exec: exec.service, sessionHooks: hooks.service, toolExecution: hostOwners.toolExecution });
      const permissionEngine = createClaudeNativePermissionEngine({ services } as unknown as Parameters<typeof createClaudeNativePermissionEngine>[0]);
      const operations = createClaudeAgentSdkTurnOperations({ ctx, permissionEngine, directory,
        happierSessionId: session.sessionId, launchEnv: {}, permissionMode: 'yolo', allowedTools, unlistedTools: 'deny' });
      try {
        await operations.sendProviderTurnPrompt('process the attachment');
        const args = exec.spawnClient.mock.calls[0]?.[0].launch.args ?? [];
        expect(args[args.indexOf('--tools') + 1]).toBe('Read,WebSearch');
        const nativeReadRule = spelling === 'scoped' ? `Read(${attachments}/**)` : 'Read';
        expect(args[args.indexOf('--allowedTools') + 1]).toBe(`${nativeReadRule},WebSearch,mcp__wilson__*`);
        const hook = hooks.service.startServer.mock.calls[0]?.[0].onPermissionHook;
        for (const [name, input, allowed] of [
          ['Read', { file_path: inside }, true],
          ['Read', { file_path: outside }, spelling !== 'scoped'],
          ['WebSearch', { query: 'lead' }, true],
          ['Bash', { command: 'echo private' }, false],
        ] as const) {
          const response = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
          expect(response.hookSpecificOutput.permissionDecision).toBe(allowed ? 'allow' : 'deny');
        }
        expect(session.agentState.requests).toEqual({});
      } finally {
        await operations.disposeProviderSession();
        await hostOwners.dispose();
        await handler.reset();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('keeps a birth-approved builtin writer below an admitted read-only ceiling without denying selected external MCP', async () => {
    const session = new FakeSession();
    session.metadata = { allowedTools: ['Write', 'mcp__wilson-intake__*'], unlistedTools: 'deny' };
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], {
      logPrefix: '[Test]', getWorkspaceWrites: () => readSessionWorkspaceWritesV1(session.getMetadataSnapshot()),
    });
    handler.setPermissionMode('yolo');
    const context = { causalPermissionAuthority: {
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
    } } as const;
    try {
      await expect(handler.handleToolCall('listed-write-readonly', 'Write', { file_path: '/tmp/example', content: 'not authorized' }, context))
        .resolves.toMatchObject({ decision: 'denied' });
      await expect(handler.handleToolCall('listed-mcp-readonly', 'mcp__wilson-intake__intake_lead', {}, context))
        .resolves.toMatchObject({ decision: 'approved_for_session' });
      expect(session.agentState.requests).toEqual({});
    } finally { await handler.reset(); }
  });

  it('denies unlisted safe built-ins and questions through native interactions without publishing asks', async () => {
    const session = new FakeSession();
    session.metadata = { allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny' };
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], {
      logPrefix: '[Test]', getWorkspaceWrites: () => readSessionWorkspaceWritesV1(session.getMetadataSnapshot()),
    });
    handler.setPermissionMode('yolo');
    const services = createNativeAgentSessionServices({
      permissionHandler: handler,
      pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
      sessionId: session.sessionId, occurrenceId: 'confined-occurrence',
      signal: new AbortController().signal, isCurrent: () => true,
    });
    for (const name of ['Read', 'Bash', 'WebFetch', 'AskUserQuestion']) {
      await expect(services.interactions.requestApproval({
        kind: 'approval', title: 'Tool request', subject: { kind: 'tool', name, input: {} },
      })).resolves.toMatchObject({ status: 'declined' });
    }
    handler.setPermissionMode('read-only');
    const listed = services.interactions.requestApproval({
      kind: 'approval', title: 'Tool request',
      subject: { kind: 'tool', name: 'mcp__wilson-intake__intake_lead', input: {} },
    });
    await vi.waitFor(() => {
      const outstanding = Object.values(session.agentState.requests);
      expect(outstanding).toEqual([]);
      expect(Object.values(session.agentState.completedRequests)).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: 'mcp__wilson-intake__intake_lead', status: 'approved' }),
      ]));
    });
    await expect(listed).resolves.toMatchObject({ status: 'approved' });
    const fromMail = handler.handleToolCall('listed-from-mail', 'mcp__wilson-intake__intake_lead', {}, {
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
        sourceAuthority: {
          kind: 'mediatedExternal', mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:intake', sourceRevisionOrEpoch: '1:1',
          admittedPermissionCeiling: 'read-only', remoteApprovalMaxScope: 'request',
        },
      },
    });
    void fromMail.catch(() => {});
    try {
      await vi.waitFor(() => expect(session.agentState.requests).toEqual({}));
      await expect(fromMail).resolves.toMatchObject({ decision: 'approved' });
    } finally { await handler.reset(); }
    expect(session.agentState.requests).toEqual({});
    await handler.reset();
  });

  it('uses an existing session grant without widening a once-only native approval', async () => {
    const session = new FakeSession();
    // Session state/RPC is the transport boundary; grant policy and interaction owners remain real.
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], { logPrefix: '[Test]' });
    const services = createNativeAgentSessionServices({
      permissionHandler: handler,
      pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
      sessionId: session.sessionId, occurrenceId: 'permission-occurrence',
      signal: new AbortController().signal, isCurrent: () => true,
    });
    const request = {
      kind: 'approval' as const, title: 'Claude permission',
      subject: { kind: 'tool' as const, name: 'Bash', input: { command: 'echo granted' } },
    };
    const pending = services.interactions.requestApproval({ ...request, allowSessionPersistence: true });
    await vi.waitFor(() => expect(Object.keys(session.agentState.requests)).toHaveLength(1));
    const id = Object.keys(session.agentState.requests)[0]!;
    await session.rpcHandlerManager.handlers.get('permission')?.({ id, approved: true, decision: 'approved_for_session' });
    await expect(pending).resolves.toMatchObject({ status: 'approved', persistence: 'session' });

    await expect(services.interactions.requestApproval(request)).resolves.toMatchObject({ status: 'approved', persistence: 'once' });
    expect(Object.keys(session.agentState.requests)).toEqual([]);
  });

  it('rejects reusable grants before settling a once-only native tool approval', async () => {
    const session = new FakeSession();
    // Session state/RPC is the transport boundary; admission, grant policy and interaction owners remain real.
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], { logPrefix: '[Test]' });
    const services = createNativeAgentSessionServices({
      permissionHandler: handler,
      pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
      sessionId: session.sessionId, occurrenceId: 'permission-occurrence',
      signal: new AbortController().signal, isCurrent: () => true,
    });
    const request = {
      kind: 'approval' as const, title: 'Claude permission',
      subject: { kind: 'tool' as const, name: 'Bash', input: { command: 'echo once' } },
    };
    const pending = services.interactions.requestApproval(request);
    await vi.waitFor(() => expect(Object.keys(session.agentState.requests)).toHaveLength(1));
    const id = Object.keys(session.agentState.requests)[0]!;
    const respond = session.rpcHandlerManager.handlers.get('permission');
    for (const grant of [
      { decision: 'approved_for_session' },
      { allowedTools: ['Bash'] },
    ]) {
      await respond?.({ id, approved: true, ...grant });
      expect(session.agentState.requests[id]).toBeDefined();
      expect(session.agentState.completedRequests[id]).toBeUndefined();
      expect(await settledState(pending)).toBe('pending');
    }

    await respond?.({ id, approved: true, decision: 'approved' });
    await expect(pending).resolves.toMatchObject({ status: 'approved', persistence: 'once' });
    const repeated = services.interactions.requestApproval(request);
    let repeatedSettled = false;
    void repeated.then(() => { repeatedSettled = true; });
    await vi.waitFor(() => expect(repeatedSettled || Object.keys(session.agentState.requests).length > 0).toBe(true));
    const repeatedIds = Object.keys(session.agentState.requests);
    for (const repeatedId of repeatedIds) {
      await respond?.({ id: repeatedId, approved: false, decision: 'denied' });
    }
    expect(repeatedIds).toHaveLength(1);
    await expect(repeated).resolves.toMatchObject({ status: 'declined' });
  });

  it.each(['read-only', 'plan'] as const)('retains real Action input and its %s ceiling through transient approval', async (permissionMode) => {
    const session = new FakeSession();
    // The fixture is the Session API/network boundary; the permission and interaction owners remain real.
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ConstructorParameters<typeof ProviderEnforcedPermissionHandler>[0], { logPrefix: '[Test]' });
    handler.setPermissionMode(permissionMode);
    const services = createNativeAgentSessionServices({
      permissionHandler: handler,
      pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
      sessionId: session.sessionId, occurrenceId: 'permission-occurrence',
      signal: new AbortController().signal, isCurrent: () => true,
    });
    const pending = services.interactions.requestApproval({
      kind: 'approval', title: 'Claude permission',
      subject: { kind: 'tool', name: 'mcp__happier__action_execute', input: { actionId: 'session.board.item.remove' } },
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled || Object.keys(session.agentState.requests).length > 0).toBe(true));
    const requestIds = Object.keys(session.agentState.requests);
    for (const id of requestIds) {
      await session.rpcHandlerManager.handlers.get('permission')?.({ id, approved: false, decision: 'denied' });
    }
    await expect(pending).resolves.toMatchObject({ kind: 'approval', status: 'declined' });
    expect(requestIds).toEqual([]);
    await expect(services.interactions.requestApproval({
      kind: 'approval', title: 'Claude permission',
      subject: { kind: 'tool', name: 'mcp__happier__action_execute', input: { actionId: 'session.board.get' } },
    })).resolves.toMatchObject({ kind: 'approval', status: 'approved' });
  });
});

describe('ProviderEnforcedPermissionHandler always-auto-approve matching', () => {
  afterEach(() => {
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    __resetToolTraceForTests();
  });

  it('hard-denies an explicitly malformed causal permission authority', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('default');

    await expect(handler.handleToolCall(
      'malformed-causal-authority-provider',
      'writeTextFile',
      { path: '/tmp/x', content: 'hi' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'not-a-real-mode',
        },
      } as never,
    )).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['malformed-causal-authority-provider']).toBeUndefined();
    expect(session.agentState.completedRequests['malformed-causal-authority-provider']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
  });

  it('does not let a later mutable mode widening auto-approve a causally bounded provider request', () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision(
      'causal-ceiling-provider-1',
      'Bash',
      { command: 'echo hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as any,
    )).toBeNull();
  });

  it('does not persist or return a stale yolo Bash approval after host write policy narrows during its AgentState update', async () => {
    const session = new DeferredUpdateSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.deferNextUpdate();

    const result = handler.handleToolCall(
      'direct-provider-auto-mode-currentness',
      'Bash',
      { command: 'echo hi' },
      { origin: 'host_acp_fs_write' },
    );
    handler.setPermissionMode('read-only');
    session.releaseNextUpdate();

    await expect(result).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['direct-provider-auto-mode-currentness']).toBeUndefined();
    expect(session.agentState.completedRequests['direct-provider-auto-mode-currentness']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
    expect(session.agentState.completedRequests['direct-provider-auto-mode-currentness'].allowedTools).toBeUndefined();
  });

  it('keeps a failed automatic host-fs denial live and preserves that currentness for a restarted response', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    let reloadedHandler: ProviderEnforcedPermissionHandler | null = null;

    try {
      const pending = handler.handleToolCall(
        'provider-automatic-persistence-restart',
        'Bash',
        { command: 'echo hi' },
        { origin: 'host_acp_fs_write' },
      );
      void pending.catch(() => undefined);
      expect(session.agentState.requests['provider-automatic-persistence-restart']).toBeDefined();

      session.updateAgentState = async () => {
        throw new Error('updateAgentState failed');
      };
      handler.setPermissionMode('read-only');

      expect(await settledState(pending)).toBe('pending');
      expect(session.agentState.requests['provider-automatic-persistence-restart']).toBeDefined();
      expect(session.agentState.completedRequests['provider-automatic-persistence-restart']).toBeUndefined();

      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      reloadedHandler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Reloaded]' });
      reloadedHandler.setPermissionMode('read-only');

      await session.rpcHandlerManager.handlers.get('permission')?.({
        id: 'provider-automatic-persistence-restart',
        approved: true,
        decision: 'approved',
      });

      expect(session.agentState.completedRequests['provider-automatic-persistence-restart']).toEqual(
        expect.objectContaining({
          status: 'denied',
          decision: 'denied',
        }),
      );
    } finally {
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      await reloadedHandler?.reset();
      await handler.reset();
    }
  });

  it('keeps a causally bounded provider request pending when the mutable mode later widens', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const pending = handler.handleToolCall(
      'causal-pending-provider-1',
      'Bash',
      { command: 'echo hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    );
    expect(session.agentState.requests['causal-pending-provider-1']).toBeTruthy();

    handler.setPermissionMode('yolo');

    expect(session.agentState.requests['causal-pending-provider-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'causal-pending-provider-1',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('auto-approves known safe tools and recognized Actions but not substring collisions', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-2', 'mcp__happier__change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-3', 'happier_change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-4', 'mcp__happier__session_title_set', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-5', 'happier_action_execute', { actionId: 'session.title.set' })).resolves.toEqual({ decision: 'approved' });
    const idOnlyPending = handler.handleToolCall('mcp__happier__change_title-1', 'other', {});
    expect(session.agentState.requests['mcp__happier__change_title-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'mcp__happier__change_title-1',
      approved: false,
      decision: 'denied',
    });
    await expect(idOnlyPending).resolves.toEqual({ decision: 'denied' });

    await expect(handler.handleToolCall('execution-run-1', 'mcp__happier__execution_run_start', {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    })).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['execution-run-1']).toBeUndefined();

    const pending = handler.handleToolCall('pending-1', 'think_malware', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'pending-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['pending-1']).toBeFalsy();
  });

  it('delegates recognized Happier Action confirmation to the shared Action executor', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('list-1', 'mcp__happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('list-2', 'happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['list-1']).toBeFalsy();
    expect(session.agentState.requests['list-2']).toBeFalsy();

    await expect(
      handler.handleToolCall('status-1', 'happier_action_execute', { actionId: 'session.status.get' }),
    ).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['status-1']).toBeFalsy();

    await expect(handler.handleToolCall('remove-1', 'happier_action_execute', {
      actionId: 'session.board.item.remove',
    })).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['remove-1']).toBeFalsy();
  });

  it.each(['read-only', 'plan'] as const)(
    'denies mutating Happier Actions in %s mode without publishing a provider request',
    async (permissionMode) => {
      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
      handler.setPermissionMode(permissionMode);

      await expect(handler.handleToolCall(`remove-${permissionMode}`, 'happier_action_execute', {
        actionId: 'session.board.item.remove',
      })).resolves.toEqual({ decision: 'denied' });
      expect(session.agentState.requests[`remove-${permissionMode}`]).toBeFalsy();

      await expect(handler.handleToolCall(`read-${permissionMode}`, 'happier_action_execute', {
        actionId: 'session.board.get',
      })).resolves.toEqual({ decision: 'approved' });
      expect(session.agentState.requests[`read-${permissionMode}`]).toBeFalsy();
    },
  );

  it('auto-approves the policy-gated meta tool without publishing a native prompt', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    await expect(handler.handleToolCall('unknown-action', 'happier_action_execute', {
      actionId: 'not.a.happier.action',
    })).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['unknown-action']).toBeUndefined();
  });

  it('auto-approves ACP fs bridge tool names to avoid duplicate host-side permission prompts', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('fs-read-1', 'readTextFile', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('fs-write-1', 'writeTextFile', {})).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['fs-read-1']).toBeFalsy();
    expect(session.agentState.requests['fs-write-1']).toBeFalsy();
  });

  it('denies every host ACP fs write alias in Read Only and Plan modes before default or custom safe-tool matching', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      alwaysAutoApproveToolNameIncludes: ['write_text_file'],
    });
    const aliases = [
      'writeTextFile',
      'writetextfile',
      'write_text_file',
      'mcp__happier__write_text_file',
      'happier_writeTextFile',
    ];
    for (const permissionMode of ['read-only', 'plan'] as const) {
      handler.setPermissionMode(permissionMode);
      expect(handler.getImmediateDecision(`fs-read-${permissionMode}`, 'readTextFile', {})).toEqual({
        decision: 'approved',
      });

      for (const [index, toolName] of aliases.entries()) {
        const toolCallId = `custom-safe-write-${permissionMode}-${index}`;
        await expect(
          handler.handleToolCall(toolCallId, toolName, {}, { origin: 'host_acp_fs_write' }),
        ).resolves.toEqual({ decision: 'denied' });
        expect(session.agentState.requests[toolCallId]).toBeFalsy();
      }
    }
  });

  it('keeps provider-native operations named writeTextFile under provider enforcement in low-privilege modes', async () => {
    for (const permissionMode of ['read-only', 'plan'] as const) {
      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
      handler.setPermissionMode(permissionMode);

      await expect(
        handler.handleToolCall(`provider-write-${permissionMode}`, 'writeTextFile', {
          path: 'provider-owned-path',
        }),
      ).resolves.toEqual({ decision: 'approved' });
    }
  });

  it('resolves the title decision through the session profile, not the Account value alone', async () => {
    // Exercise the shared title gate through the live permission owner.
    const session = new FakeSession();
    session.metadata = { profileId: 'focused' };
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
        profiles: [{
          v: 2,
          id: 'focused',
          name: 'Focused',
          extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {},
          defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {},
          codingPromptBehaviorOverrides: { sessionTitleUpdates: 'ongoing' },
          createdAt: 1,
          updatedAt: 1,
        }],
      } as any),
    });

    await expect(
      handler.handleToolCall('title-1', 'mcp__happier__change_title', { title: 'Renamed' }),
    ).resolves.toEqual({ decision: 'approved' });
  });

  it('denies session title tool calls when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    await expect(handler.handleToolCall('title-1', 'mcp__happier__change_title', { title: 'Renamed' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('title-2', 'happier_action_execute', { actionId: 'session.title.set' })).resolves.toEqual({
      decision: 'denied',
    });
    expect(session.agentState.requests['title-1']).toBeFalsy();
    expect(session.agentState.requests['title-2']).toBeFalsy();
    expect(session.agentState.completedRequests['title-1']).toMatchObject({
      tool: 'mcp__happier__change_title',
      status: 'denied',
      decision: 'denied',
    });
  });

  it('exposes immediate decisions for always-auto-approved tools', () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    expect(handler.getImmediateDecision('fs-read-1', 'readTextFile', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('fs-write-1', 'writeTextFile', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-1', 'action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-2', 'mcp__happier__action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-3', 'happier_action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('execution-run-1', 'mcp__happier__execution_run_start', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('execution-run-2', 'mcp__happier__subagents_delegate_start', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('perm-1', 'bash', { command: 'pwd' })).toBeNull();
    const nativeChoices = createMcpPermissionChoices('first-party-discovery', null);
    expect(handler.getImmediateDecision('native-discovery', 'mcp__happier__action_spec_search', {}, { nativeChoices }))
      .toEqual({ decision: 'approved', nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'approved' } });
    expect(handler.getImmediateDecision('native-shell', 'bash', { command: 'pwd' }, { nativeChoices })).toBeNull();
  });

  it('applies the native Happier Action choice before completing the Session permission request', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[native Action]' });
    const nativeChoices = createMcpPermissionChoices('native-action-application', null);
    const expected = { decision: 'approved', nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'approved' } };
    const started = createDeferred<void>();
    const application = createDeferred<void>();
    const pending = handler.handleToolCall('native-action', 'mcp__happier__action_spec_search', { query: 'scm' }, {
      nativeChoices, acknowledgeDecisionApplication: async decision => {
        expect(decision).toEqual(expected);
        started.resolve();
        await application.promise;
      },
    });
    try {
      await started.promise;
      expect(await settledState(pending)).toBe('pending');
    } finally { application.resolve(); }
    await expect(pending).resolves.toEqual(expected);
  });

  it('keeps the immediate-decision probe side-effect free until handleToolCall records the approval', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    expect(handler.getImmediateDecision('fs-read-1', 'readTextFile', {})).toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['fs-read-1']).toBeUndefined();

    await expect(handler.handleToolCall('fs-read-1', 'readTextFile', {})).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['fs-read-1']).toMatchObject({
      tool: 'readTextFile',
      decision: 'approved',
      status: 'approved',
    });
  });

  it('auto-approves provider permission requests in full-access modes without suppressing user actions', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pendingBeforeModeChange = handler.handleToolCall('perm-before-mode-change', 'bash', { command: 'echo later' });
    expect(session.agentState.requests['perm-before-mode-change']).toBeTruthy();

    handler.setPermissionMode('bypassPermissions');

    await expect(pendingBeforeModeChange).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['perm-before-mode-change']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-before-mode-change']).toMatchObject({
      tool: 'bash',
      status: 'approved',
      decision: 'approved',
    });

    expect(handler.getImmediateDecision('perm-1', 'bash', { command: 'echo hello' })).toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('perm-1', 'bash', { command: 'echo hello' })).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['perm-1']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-1']).toMatchObject({
      tool: 'bash',
      status: 'approved',
      decision: 'approved',
    });

    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision('perm-2', 'TodoWrite', { todos: [] })).toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('perm-2', 'TodoWrite', { todos: [] })).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['perm-2']).toBeFalsy();

    const pending = handler.handleToolCall('ask-1', 'AskUserQuestion', {
      questions: [{ id: 'language', question: 'Which language?' }],
    });

    expect(session.agentState.requests['ask-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({
      id: 'ask-1',
      approved: true,
      decision: 'approved',
      answers: { language: 'TypeScript' },
    });
    await expect(pending).resolves.toEqual({
      decision: 'approved',
      answers: { language: ['TypeScript'] },
    });
    expect(session.agentState.requests['ask-1']).toBeFalsy();
  });

  it('does not acknowledge a user-action RPC until the requester applies the decision', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    let finishApplication!: () => void;
    const applicationFinished = new Promise<void>((resolve) => { finishApplication = resolve; });
    const acknowledgeDecisionApplication = vi.fn(async () => applicationFinished);
    const pending = handler.handleToolCall('dialog-ack-1', 'AskUserQuestion', {
      questions: [{ id: 'choice', question: 'Continue?' }],
    }, {
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      acknowledgeDecisionApplication,
    });

    let rpcSettled = false;
    const rpc = Promise.resolve(session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
      id: 'dialog-ack-1',
      approved: true,
      answers: { choice: ['Yes'] },
    })).then((result) => {
      rpcSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(acknowledgeDecisionApplication).toHaveBeenCalledTimes(1));
    expect(rpcSettled).toBe(false);
    expect(await settledState(pending)).toBe('pending');

    finishApplication();
    await expect(rpc).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'approved', answers: { choice: ['Yes'] } });
  });

  it('keeps the user action pending when provider application fails', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const pending = handler.handleToolCall('dialog-ack-failed', 'AskUserQuestion', {
      questions: [{ id: 'choice', question: 'Continue?' }],
    }, {
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      acknowledgeDecisionApplication: async () => {
        throw new Error('terminal answer failed');
      },
    });

    await expect(session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
      id: 'dialog-ack-failed',
      approved: true,
      answers: { choice: ['Yes'] },
    })).rejects.toThrow('terminal answer failed');
    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['dialog-ack-failed']).toBeTruthy();
  });

  it('does not locally settle a pending provider-native request when switching to Read Only or Plan', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const pending = handler.handleToolCall('provider-pending', 'Edit', { path: 'provider-owned-path' });

    handler.setPermissionMode('read-only');
    expect(await settledState(pending)).toBe('pending');
    handler.setPermissionMode('plan');
    expect(await settledState(pending)).toBe('pending');

    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'provider-pending',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('cancels only pending requests owned by the deactivated plugin', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pluginA = handler.handleToolCall('plugin-a-request', 'Bash', { command: 'echo a' }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const pluginB = handler.handleToolCall('plugin-b-request', 'Bash', { command: 'echo b' }, {
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    handler.cancelByPlugin('plugin-a', 'plugin_deactivated');

    await expect(pluginA).rejects.toThrow('plugin_deactivated');
    expect(await settledState(pluginB)).toBe('pending');
    expect(session.agentState.requests['plugin-a-request']).toBeFalsy();
    expect(session.agentState.completedRequests['plugin-a-request']).toMatchObject({
      status: 'canceled',
      reason: 'plugin_deactivated',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    expect(session.agentState.requests['plugin-b-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    const respond = session.rpcHandlerManager.handlers.get('permission');
    await respond?.({ id: 'plugin-b-request', approved: false, decision: 'denied' });
    await expect(pluginB).resolves.toEqual({ decision: 'denied' });
  });

  it('terminalizes a caller-aborted plugin request and rejects a later user-action answer as not found', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const abort = new AbortController();

    // A structured question deliberately outlives its native waiter (it stays
    // answerable by the durable Session), so the terminalizing contract is
    // exercised on an ordinary plugin tool request.
    const first = handler.handleToolCall('plugin-caller-aborted', 'Bash', {
      command: 'echo caller-aborted',
    }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
      signal: abort.signal,
    });
    expect(session.agentState.requests['plugin-caller-aborted']).toBeTruthy();

    abort.abort();
    const racingAnswer = session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'plugin-caller-aborted',
      approved: true,
      decision: 'approved',
    });

    await expect(first).rejects.toThrow('Permission request aborted');
    expect(session.agentState.requests['plugin-caller-aborted']).toBeFalsy();
    expect(session.agentState.completedRequests['plugin-caller-aborted']).toMatchObject({
      status: 'canceled',
      decision: 'abort',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    await expect(racingAnswer).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'plugin-caller-aborted',
    });

    const second = handler.handleToolCall('plugin-second-request', 'AskUserQuestion', {
      questions: [{ id: 'language', question: 'Language?' }],
    }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    await session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
      id: 'plugin-second-request',
      approved: true,
      decision: 'approved',
      answers: { language: ['Rust'] },
    });
    await expect(second).resolves.toEqual({ decision: 'approved', answers: { language: ['Rust'] } });
    expect(Object.keys(session.agentState.completedRequests).sort()).toEqual([
      'plugin-caller-aborted',
      'plugin-second-request',
    ]);
  });

  it('does not publish or auto-decide a request whose caller signal was already aborted', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const abort = new AbortController();
    abort.abort();

    await expect(handler.handleToolCall('plugin-pre-aborted', 'think', {}, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
      signal: abort.signal,
    })).rejects.toThrow('Permission request aborted');
    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests).toEqual({});
  });

  it('projects a caller-owned source separately from tool input', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pending = handler.handleToolCall('plugin-dialog-request', 'AskUserQuestion', {
      happierDialog: { dialogId: 'trust_folder' },
    }, {
      owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
      source: 'claude_unified_terminal_dialog_choice',
    });

    expect(session.agentState.requests['plugin-dialog-request']).toMatchObject({
      tool: 'AskUserQuestion',
      source: 'claude_unified_terminal_dialog_choice',
      owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
    });

    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'plugin-dialog-request',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('does not reuse plugin-owned approved-for-session decisions across plugin owners', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'echo shared' };

    const pluginA = handler.handleToolCall('plugin-a-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'plugin-a-request', approved: true, decision: 'approved_for_session' });
    await expect(pluginA).resolves.toEqual({ decision: 'approved_for_session' });

    const pluginASiblingRuntime = handler.handleToolCall('plugin-a-sibling-runtime-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-b' },
    });

    expect(await settledState(pluginASiblingRuntime)).toBe('pending');
    expect(session.agentState.requests['plugin-a-sibling-runtime-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-b' },
    });

    await respond?.({ id: 'plugin-a-sibling-runtime-request', approved: false, decision: 'denied' });
    await expect(pluginASiblingRuntime).resolves.toEqual({ decision: 'denied' });

    const pluginB = handler.handleToolCall('plugin-b-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    expect(await settledState(pluginB)).toBe('pending');
    expect(session.agentState.requests['plugin-b-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    await respond?.({ id: 'plugin-b-request', approved: false, decision: 'denied' });
    await expect(pluginB).resolves.toEqual({ decision: 'denied' });
  });

  it('reuses approved-for-session decisions across invocations of one stable plugin runtime owner', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const owner = { kind: 'plugin' as const, pluginId: 'acme.plugin', runtimeId: 'acme.plugin/actions/run' };
    const input = { command: 'echo stable-owner' };

    const firstInvocation = handler.handleToolCall('ordinary-invocation-one', 'Bash', input, { owner });
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'ordinary-invocation-one',
      approved: true,
      decision: 'approved_for_session',
    });
    await expect(firstInvocation).resolves.toEqual({ decision: 'approved_for_session' });

    await expect(handler.handleToolCall('ordinary-invocation-two', 'Bash', input, { owner }))
      .resolves.toEqual({ decision: 'approved_for_session' });
    expect(session.agentState.requests['ordinary-invocation-two']).toBeUndefined();
  });

  it('does not let a rejected plugin duplicate mark an unowned request as plugin-owned', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'echo shared' };

    const unowned = handler.handleToolCall('shared-request-id', 'Bash', input);
    await expect(handler.handleToolCall('shared-request-id', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    })).rejects.toBeInstanceOf(Error);

    const pluginOwned = handler.handleToolCall('plugin-owned-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const respond = session.rpcHandlerManager.handlers.get('permission');
    await respond?.({ id: 'plugin-owned-request', approved: true, decision: 'approved_for_session' });
    await expect(pluginOwned).resolves.toEqual({ decision: 'approved_for_session' });

    expect(await settledState(unowned)).toBe('pending');
    expect(session.agentState.requests['shared-request-id']).toMatchObject({
      tool: 'Bash',
    });
    expect(session.agentState.requests['shared-request-id']?.owner).toBeUndefined();

    await respond?.({ id: 'shared-request-id', approved: false, decision: 'denied' });
    await expect(unowned).resolves.toEqual({ decision: 'denied' });
  });

  it('records permission-request tool trace events when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-provider-enforced-'));
    try {
      const filePath = join(dir, 'tool-trace.jsonl');
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, {
        logPrefix: '[Test]',
        toolTrace: () => ({ protocol: 'acp', agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' } }),
      } as any);

      const pending = handler.handleToolCall('perm-1', 'Bash', { command: 'echo hello' });

      expect(existsSync(filePath)).toBe(true);
      const lines = readFileSync(filePath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        direction: 'outbound',
        sessionId: 'test-session-id',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
        kind: 'permission-request',
        payload: expect.objectContaining({
          type: 'permission-request',
          permissionId: 'perm-1',
          toolName: 'Bash',
        }),
      });

      const respond = session.rpcHandlerManager.handlers.get('permission');
      expect(respond).toBeTruthy();
      await respond?.({ id: 'perm-1', approved: false, decision: 'denied' });
      await expect(pending).resolves.toEqual({ decision: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts source-owned terminal dialog prompts and options from tool traces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-source-dialog-'));
    try {
      const filePath = join(dir, 'tool-trace.jsonl');
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, {
        logPrefix: '[Test]',
        toolTrace: () => ({ protocol: 'native', agent: { pluginId: 'happier.agent.claude', localId: 'claude' } }),
      });
      const pending = handler.handleToolCall('dialog-1', 'AskUserQuestion', {
        happierDialog: {
          kind: 'unrecognized',
          mode: 'generic',
          dialogId: 'unrecognized_confirmation',
        },
        questions: [{
          question: 'private prompt text must not reach the trace',
          options: [
            { label: 'private option one', description: 'sensitive description one' },
            { label: 'private option two', description: 'sensitive description two' },
          ],
        }],
      }, {
        source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
        owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
      });

      const raw = readFileSync(filePath, 'utf8');
      expect(raw).not.toContain('private prompt text');
      expect(raw).not.toContain('private option');
      expect(raw).not.toContain('sensitive description');
      expect(JSON.parse(raw.trim())).toMatchObject({
        kind: 'permission-request',
        payload: {
          type: 'permission-request',
          permissionId: 'dialog-1',
          toolName: 'AskUserQuestion',
          options: {
            input: {
              redacted: true,
            },
          },
        },
      });

      await session.rpcHandlerManager.handlers.get('permission')?.({
        id: 'dialog-1',
        approved: false,
        decision: 'denied',
      });
      await expect(pending).resolves.toEqual({ decision: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('observed native occurrence question settlement', () => {
  const owner = { kind: 'plugin', pluginId: 'fixture.plugin', runtimeId: 'native-runtime' } as const;
  const source = 'fixture.native.dialog';
  const input = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] };

  it('records actual native answers and keeps another occurrence pending across waiter cancellation', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[native settlement]' });
    const abort = new AbortController();
    const context = { owner, source, origin: 'host_occurrence_question', lifetime: 'occurrence' } as const;
    const first = handler.handleToolCall('native-A', 'AskUserQuestion', input, { ...context, signal: abort.signal });
    const second = handler.handleToolCall('native-B', 'AskUserQuestion', input, context).catch(() => null);
    const answers = { 'Continue?': ['No'] };
    const scope = createPluginSessionHandleCapabilitiesFactory({
      // This test exercises no credential-consuming operation.
      credentials: {} as never,
      caller: { pluginId: owner.pluginId, runtimeId: owner.runtimeId, contributionId: 'agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' } },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'fixture',
      resolveLiveCapabilities: () => ({ scopeId: liveScope, permissionHandler: handler, readPermissionMode: () => 'default' }),
    })(session.sessionId).permissions;
    const liveScope = Symbol('native-runtime');
    if (!scope?.settleObservedDecision) throw new Error('Native settlement capability is missing');
    try {
      await vi.waitFor(() => expect(session.agentState.requests['native-A']).toBeDefined());
      await expect(handler.settleObservedDecision({ requestId: 'native-A', source, owner: { ...owner, runtimeId: 'other' }, decision: 'approved', answers })).resolves.toBe(false);
      await expect(scope.settleObservedDecision({ requestId: 'native-A', source: 'other', decision: 'approved', answers })).resolves.toBe(false);
      const incumbent = session.agentState.requests['native-A'];
      session.agentState.requests['native-A'] = { ...incumbent, createdAt: incumbent.createdAt + 1 };
      await expect(scope.settleObservedDecision({ requestId: 'native-A', source, decision: 'approved', answers })).resolves.toBe(false);
      session.agentState.requests['native-A'] = incumbent;
      await expect(scope.settleObservedDecision({ requestId: 'native-A', source, decision: 'approved', answers })).resolves.toBe(true);
      abort.abort();
      await expect(first).resolves.toEqual({ decision: 'approved', answers });
      expect(session.agentState.completedRequests['native-A']).toMatchObject({ status: 'approved', decision: 'approved', structuredAnswersV1: answers });
      expect(session.agentState.requests['native-B']).toBeDefined();
      expect(await settledState(second)).toBe('pending');
      await expect(handler.settleObservedDecision({ requestId: 'native-A', source, owner, decision: 'abort' })).resolves.toBe(false);
    } finally {
      await handler.abortPendingRequestsAndFlush('test cleanup');
      await second;
    }
  });

  it('retires a rich native occurrence question after its waiter expires and rejects a late app answer', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[native expiry]' });
    const liveScope = Symbol('native-expiry');
    const permissions = createPluginSessionHandleCapabilitiesFactory({
      // This test exercises no credential-consuming operation.
      credentials: {} as never,
      caller: { pluginId: owner.pluginId, runtimeId: owner.runtimeId, contributionId: 'agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' } },
      signal: new AbortController().signal, isCurrent: () => true, readAgentId: async () => 'fixture',
      resolveLiveCapabilities: () => ({ scopeId: liveScope, permissionHandler: handler, readPermissionMode: () => 'default' }),
    })(session.sessionId).permissions;
    if (!permissions) throw new Error('Native permission capability is missing');
    const abort = new AbortController();
    const pending = permissions.requestDecision({ requestId: 'native-expired', source, toolName: 'AskUserQuestion', input }, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow('Permission request aborted');
    await vi.waitFor(() => expect(session.agentState.requests['native-expired']).toMatchObject({ lifetime: 'occurrence' }));
    abort.abort();
    await rejected;
    expect(session.agentState.requests['native-expired']).toBeUndefined();
    expect(session.agentState.completedRequests['native-expired']).toMatchObject({ status: 'canceled', decision: 'abort' });
    await expect(session.rpcHandlerManager.handlers.get('permission')?.({ id: 'native-expired', approved: true, decision: 'approved', answers: { 'Continue?': ['Yes'] } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
    await handler.abortPendingRequestsAndFlush('test cleanup');
  });

  it.each([
    { decision: 'approved', rejectAck: true, matches: false },
    { decision: 'abort', rejectAck: true, matches: false },
    { decision: 'approved', rejectAck: false, matches: false },
    { decision: 'approved', rejectAck: false, matches: true },
  ] as const)('retains observed $decision with rejectAck=$rejectAck, matches=$matches', async ({ decision, rejectAck, matches }) => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[native ACK]' });
    let acknowledged!: () => void;
    const started = new Promise<void>(resolve => { acknowledged = resolve; });
    let release!: () => void;
    const applying = new Promise<void>(resolve => { release = resolve; });
    const pending = handler.handleToolCall('native-ACK', 'AskUserQuestion', input, {
      owner, source, origin: 'host_occurrence_question', lifetime: 'occurrence',
      acknowledgeDecisionApplication: async () => { acknowledged(); await applying; if (rejectAck) throw new Error('native answer differs'); },
    });
    try {
      await vi.waitFor(() => expect(session.agentState.requests['native-ACK']).toBeDefined());
      const answer = session.rpcHandlerManager.handlers.get('permission')?.({ id: 'native-ACK', approved: true, decision: 'approved', answers: { 'Continue?': ['Yes'] } });
      const appOutcome = Promise.resolve(answer).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error }));
      await started;
      const answers = decision === 'approved' ? { 'Continue?': [matches ? 'Yes' : 'No'] } : undefined;
      await expect(handler.settleObservedDecision({ requestId: 'native-ACK', source, owner, decision, ...(answers ? { answers } : {}) })).resolves.toBe(true);
      release();
      const outcome = await appOutcome;
      if (rejectAck) expect(outcome).toMatchObject({ ok: false, error: { message: 'native answer differs' } });
      else if (matches) expect(outcome).toEqual({ ok: true, result: undefined });
      else expect(outcome).toMatchObject({ ok: true, result: { ok: false, errorCode: 'permission_request_not_found' } });
      await expect(pending).resolves.toEqual({ decision, ...(answers ? { answers } : {}) });
      expect(session.agentState.requests['native-ACK']).toBeUndefined();
      expect(session.agentState.completedRequests['native-ACK']).toMatchObject({ status: decision === 'abort' ? 'canceled' : 'approved', decision, ...(answers ? { structuredAnswersV1: answers } : {}) });
    } finally {
      release();
      await handler.abortPendingRequestsAndFlush('test cleanup');
    }
  });
});
