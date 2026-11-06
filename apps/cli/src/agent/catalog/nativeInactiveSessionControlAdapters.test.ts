import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { activateInactiveUsageLimitResume } from '@/daemon/sessions/activateInactiveUsageLimitResume';
import { normalizeUsageLimitRecoveryOperationResult } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import { createConnectedServiceContinuationMessageDispatcher } from '@/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '@/daemon/connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { bindInactiveSessionControlLaunchScope } from '@/daemon/spawn/inactiveSessionControlLaunchScope';
import { createCodexNativeSessionControls } from '../../../../../packages/plugins/codex/src/agent/runtime/controls';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { SessionWorkStateV1Schema, writeSessionWorkStateV1ToMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createClaudeNativeGoalControl } from '../../../../../packages/plugins/claude/src/agent/runtime/goalControl/nativeControl';
import { createClaudeUnifiedGoalRuntime } from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/goalRuntime';
import type { Metadata } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';

import { buildTestAgentRuntimeDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';
import { rawSession, metadata, commonRouteParams } from './nativeInactiveSessionControlAdapters.testkit';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  type AgentRuntime,
  type AgentSessionGoalMutationResult,
  type AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveContributedAgentRoutingId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import { routeSessionUsageLimitRecoveryCheckNow } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';

import {
  createNativeInactiveCatalogAdapter,
  createNativeInactiveGoalAdapter,
  createNativeInactiveUsageAdapter,
} from './nativeInactiveSessionControlAdapters';

let releaseLaunchScope: (() => void) | undefined;
beforeEach(() => {
  releaseLaunchScope = bindInactiveSessionControlLaunchScope(async input => {
    // These synthetic plugin registries carry no Account selection. Keep the
    // ordinary native environment owner real for their unbound fixture scope.
    const result = await resolveSpawnChildEnvironment({ options: { directory: input.adapterParams.cwd ?? '/repo' },
      profileEnvironmentVariables: {}, processEnv: {}, daemonSpawnHooks: null,
      logDebug() {}, logInfo() {}, logWarn() {} });
    if (!result.ok) throw new Error('Native fixture scope unavailable');
    return { environment: result.extraEnvForChild, connectedAccounts: [], async assertCurrent() {}, async dispose() {} };
  });
});
afterEach(() => releaseLaunchScope?.());

it('refuses all inactive native facets when the admitted launch owner is unavailable', async () => {
  releaseLaunchScope?.();
  const controls = createCodexNativeSessionControls();
  const fixture = runtimeRegistryFixture({ agent: { pluginId: 'acme.controls', localId: 'native' },
    sessions: { ...controls, async open() { throw new Error('No native process is admitted'); } } });
  const dependencies = { acquireRuntimeRegistryLease: fixture.acquire };
  const input = { ...commonRouteParams('unadmitted'), cwd: '/repo', sessionMachineId: 'machine-local' };
  const goal = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
    native: { get: true, set: true, clear: true }, dependencies });
  const failure = { ok: false, errorCode: 'inactive_agent_launch_scope_unavailable' };
  await expect(goal.getGoal!(input)).resolves.toMatchObject(failure);
  await expect(goal.setGoal!({ ...input, request: { objective: 'Must not enter native state' } })).resolves.toMatchObject(failure);
  await expect(goal.clearGoal!(input)).resolves.toMatchObject(failure);
  const catalog = createNativeInactiveCatalogAdapter({ agentId: fixture.agentId,
    native: { vendorPlugins: true, skills: true }, dependencies });
  await expect(catalog.listVendorPlugins!(input)).resolves.toMatchObject({ unsupported: true, diagnostic: failure.errorCode });
  await expect(catalog.listSkills!(input)).resolves.toMatchObject({ unsupported: true, diagnostic: failure.errorCode });
  const usage = createNativeInactiveUsageAdapter({ agentId: fixture.agentId,
    native: { checkNow: true, consumeResetCredit: true }, dependencies });
  await expect(usage.checkNow!(input)).resolves.toMatchObject(failure);
  await expect(usage.consumeResetCredit!(input)).resolves.toMatchObject(failure);
});


function runtimeRegistryFixture(params: Readonly<{
  sessions: AgentSessionRuntimeFactory;
  agent?: Readonly<{ pluginId: string; localId: string; provenance?: 'first_party' | 'external' }>;
  isCurrent?: () => boolean;
  runtime?: AgentRuntime;
  createRuntime?: (options: Readonly<{ signal: AbortSignal }>) => Promise<AgentRuntime>;
  createServices?: (options: Readonly<{ signal: AbortSignal; environment?: Readonly<Record<string, string>> }>) => Promise<ReturnType<typeof createUnavailablePluginServices>>;
  activate?: () => Promise<readonly []>;
  release?: () => Promise<void>;
  includeRuntimeLease?: boolean;
  goalSet?: Readonly<{
    fields: readonly ('objective' | 'status' | 'tokenBudget')[];
    writableStatuses?: readonly ('active' | 'paused' | 'complete')[];
  }>;
}>): Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  agentId: string;
  acquire(): Promise<PluginRuntimeRegistryLease>;
}> {
  const isCurrent = params.isCurrent ?? (() => true);
  const runtime: AgentRuntime = params.runtime ?? { sessions: params.sessions };
  const pluginId = params.agent?.pluginId ?? 'codex-plugin';
  const localAgentId = params.agent?.localId ?? 'codex';
  const provenance = params.agent?.provenance ?? (params.agent ? 'external' : 'first_party');
  const agentId = resolveContributedAgentRoutingId({ pluginId, localId: localAgentId, provenance });
  const contribution = {
    id: agentId,
    pluginId,
    identity: { pluginId, localId: localAgentId },
    richDefinition: {
      provenance,
      definition: {
        id: localAgentId,
        title: 'Codex',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
            goals: {
              inactive: {
                get: true,
                clear: true,
                set: params.goalSet ?? { fields: ['objective', 'status', 'tokenBudget'] },
              },
              source: 'goals',
            },
            catalog: { inactive: ['vendorPlugins', 'skills'] },
            usageLimitRecovery: { inactive: ['checkNow', 'consumeResetCredit'] },
            workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
          },
        },
      },
    },
  };
  // This fixture supplies the exact runtime-registry boundary consumed by inactive controls;
  // unrelated registry families are intentionally omitted.
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([[agentId, contribution]]),
    },
    agentRuntimesByAgentId: new Map(params.includeRuntimeLease === false ? [] : [[agentId, {
      pluginId,
      pluginVersion: '1.0.0',
      agentId,
      localAgentId,
      occurrenceId: `${pluginId}:1`,
      generation: 'generation-1',
      hasPrimaryRuntime: true,
      isCurrent,
      createRuntime: params.createRuntime ?? (async () => runtime),
    }]]),
    activateContributionsOnDemand: params.activate ?? (async () => []),
    createAgentInvocationServices: params.createServices ?? (async () => createUnavailablePluginServices()),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return {
    registry,
    agentId,
    acquire: async () => ({
      registry,
      source: 'ephemeral',
      durableRevision: -1,
      release: params.release ?? (async () => undefined),
    }),
  };
}


function claudeResumeGoalHarness() {
  const sessionId = 'claude-native-goal-resume';
  const native = createClaudeNativeGoalControl();
  let stored: Metadata = { ...metadata(), path: '/repo', host: 'host-local', homeDir: '/home/test',
    agentRuntimeDescriptorV1: buildTestAgentRuntimeDescriptorV1('claude', {}),
    happyHomeDir: '/home/test/.happier', happyLibDir: '/home/test/.happier/lib', happyToolsDir: '/home/test/.happier/tools' };
  let nativeObjective = 'Native A';
  let rejectNative = false;
  let beforeNativeEntry: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  // Terminal injection and transcript rows are the native process boundary;
  // the Claude effector, source, RPC handler, adapter and router stay real.
  const live = createClaudeUnifiedGoalRuntime({ backendId: 'claude', agentId: 'claude',
    getCurrentClaudeSessionId: () => 'native-claude-1',
    publishWorkStateSnapshot: snapshot => { stored = writeSessionWorkStateV1ToMetadata(stored, SessionWorkStateV1Schema.parse(snapshot)); },
    injectGoalCommand: async message => {
      await beforeNativeEntry?.();
      if (rejectNative) throw new Error('Native refused');
      nativeObjective = message.slice('/goal '.length);
      live.source.observeTranscriptMessage({ type: 'attachment', uuid: `goal:${nativeObjective}`,
        sessionId: 'native-claude-1', attachment: { type: 'goal_status', met: false, condition: nativeObjective } });
      return { kind: 'sent-to-terminal' };
    },
  });
  live.source.observeTranscriptMessage({ type: 'attachment', uuid: 'goal:A', sessionId: 'native-claude-1',
    attachment: { type: 'goal_status', met: false, condition: nativeObjective } });
  const handlers = new Map<string, RpcHandler>();
  const resume = vi.fn<NonNullable<Parameters<typeof routeSessionGoalControl>[0]['machineResumeTransport']>>(
    async () => {
      registerSessionControlHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        getSessionMetadata: () => stored,
        sessionRuntimeControls: { setGoal: live.setGoal, clearGoal: live.clearGoal, refreshGoal: async () => undefined },
      });
      return { type: 'success', sessionId };
    });
  const fixture = runtimeRegistryFixture({ agent: { pluginId: 'happier.agent.claude', localId: 'claude', provenance: 'first_party' },
    sessions: { goals: native.control, async open() { throw new Error('not used'); } },
    goalSet: { fields: ['objective'] } });
  const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
    native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
  const stageWorkStateMutation = vi.fn<NonNullable<Parameters<typeof routeSessionGoalControl>[0]['stageWorkStateMutation']>>(
    async mutation => { stored = writeSessionWorkStateV1ToMetadata(stored,
      mutation.op.kind === 'set' ? SessionWorkStateV1Schema.parse(mutation.op.value) : null); });
  const route = (operation: 'get' | 'set' | 'clear', wake = false) => routeSessionGoalControl({
    ...commonRouteParams(sessionId), metadata: stored, operation, credentials: { token: 'token', encryption: null },
    ...(operation === 'set' ? { request: { objective: 'Native B' } } : {}),
    signal: controller.signal, resumeInactiveWithInitialGoal: wake, executionAuthority: 'account_automation',
    resolveAdapter: async () => adapter, machineResumeTransport: resume, stageWorkStateMutation,
    callLiveSessionRpc: async () => {
      const method = operation === 'set' ? SESSION_RPC_METHODS.SESSION_GOAL_SET : SESSION_RPC_METHODS.SESSION_GOAL_GET;
      const handler = handlers.get(method);
      if (!handler) throw new Error('native_controls_not_ready');
      return await handler(operation === 'set' ? { objective: 'Native B' } : {}, { signal: controller.signal });
    },
  });
  return { route, resume, controller, stageWorkStateMutation, live,
    objective: () => nativeObjective,
    refuseNative: () => { rejectNative = true; },
    holdNative: (hold: () => Promise<void>) => { beforeNativeEntry = hold; } };
}

describe('native inactive Agent session controls', () => {
  it('projects a populated Codex vendor catalog through inactive routing into the Action output contract', async () => {
    await withCodexNativeAttachFixture(async native => {
      const controls = createCodexNativeSessionControls();
      const fixture = runtimeRegistryFixture({
        sessions: { ...controls, async open() { throw new Error('Catalog reads must not open a Session'); } },
        createServices: async () => ({ ...createUnavailablePluginServices(), exec: native.exec }),
      });
      const adapter = createNativeInactiveCatalogAdapter({ agentId: fixture.agentId,
        native: { vendorPlugins: true, skills: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
      const result = await routeSessionCatalogControl({ ...commonRouteParams('vendor-catalog-session'),
        operation: 'vendorPlugins', resolveAdapter: async () => adapter });
      const parsed = getActionSpec('session.vendor_plugin_catalog.list').outputSchema!.parse(result);
      expect(parsed).toMatchObject({ vendorPlugins: [{
        v: 1, backendId: fixture.agentId, agentId: fixture.agentId,
        vendorPluginRef: 'plugin://mail@curated', name: 'mail', displayName: 'Mail',
        installed: true, enabled: true, mentionable: true,
      }] });
    }, { pluginListResponse: { marketplaces: [{ name: 'curated', plugins: [{
      name: 'mail', interface: { displayName: 'Mail' }, installed: true, enabled: true,
    }] }] } });
  });

  it.each([true, false])('projects external vendor catalogs with populated=%s into the same Action contract', async populated => {
    // The external contribution is the plugin boundary; host routing and projection stay real.
    const fixture = runtimeRegistryFixture({ agent: { pluginId: 'acme.catalog', localId: 'native' }, sessions: {
      catalog: { async list() { return { status: 'ok', kind: 'vendorPlugins', items: populated ? [{
        id: 'plugin://review@acme', name: 'review', displayName: 'Review', description: 'Review changes',
        installed: false, enabled: false, mentionable: false,
      }] : [] }; } },
      async open() { throw new Error('Catalog reads must not open a Session'); },
    } });
    const adapter = createNativeInactiveCatalogAdapter({ agentId: fixture.agentId,
      native: { vendorPlugins: true, skills: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    const result = await routeSessionCatalogControl({ ...commonRouteParams('external-catalog-session'),
      operation: 'vendorPlugins', resolveAdapter: async () => adapter });
    expect(getActionSpec('session.vendor_plugin_catalog.list').outputSchema!.parse(result)).toEqual({
      vendorPlugins: populated ? [{ v: 1, backendId: fixture.agentId, agentId: fixture.agentId,
        vendorPluginRef: 'plugin://review@acme', name: 'review', displayName: 'Review', description: 'Review changes',
        installed: false, enabled: false, mentionable: false }] : [],
    });
  });

  it.each(['unsupported', 'wrong-kind'] as const)('keeps native vendor catalog %s results schema-valid', async outcome => {
    const fixture = runtimeRegistryFixture({ agent: { pluginId: 'acme.catalog', localId: 'native' }, sessions: {
      catalog: { async list() { return outcome === 'unsupported'
        ? { status: 'unsupported', diagnostic: { code: 'acme_catalog_unsupported', severity: 'error' } }
        : { status: 'ok', kind: 'skills', items: [] }; } },
      async open() { throw new Error('Catalog reads must not open a Session'); },
    } });
    const adapter = createNativeInactiveCatalogAdapter({ agentId: fixture.agentId,
      native: { vendorPlugins: true, skills: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    const result = await routeSessionCatalogControl({ ...commonRouteParams('unavailable-catalog-session'),
      operation: 'vendorPlugins', resolveAdapter: async () => adapter });
    expect(getActionSpec('session.vendor_plugin_catalog.list').outputSchema!.parse(result)).toEqual({
      unsupported: true, vendorPlugins: [], diagnostic: outcome === 'unsupported'
        ? 'acme_catalog_unsupported' : 'native_vendor_plugin_catalog_kind_mismatch',
    });
  });

  it.each([
    { status: 'unavailable' as const, facet: { phase: 'native_effect' as const }, expected: { phase: 'native_effect' } },
    { status: 'rejected' as const, facet: { phase: 'host_publication_rejected' as const }, expected: { phase: 'host_publication_rejected' } },
    { status: 'unsupported' as const, facet: { phase: 'missing_matching_publication' as const }, expected: { phase: 'missing_matching_publication' } },
    { status: 'unavailable' as const, facet: { phase: 'native_effect' as const, privateText: 'must not disclose' }, expected: undefined },
  ])('preserves only closed external Goal evidence for $status / $facet', async ({ status, facet, expected }) => {
    // This is an external plugin contribution, not a replacement for host logic.
    const details = status === 'unavailable'
      ? { stage: 'client_creation', errorClass: 'PluginError', errorCode: 'plugin_exec_native_launch_unavailable' }
      : { stage: 'initialize', errorClass: 'JsonRpcApplicationError', errorCode: '-32000' };
    const fail = async () => ({ status,
      diagnostic: { code: 'external_goal_refused', severity: 'error' as const, details }, retryable: false, goalControlFailure: facet });
    const fixture = runtimeRegistryFixture({ agent: { pluginId: 'test.external-goals', localId: 'goal-agent' },
      sessions: { goals: { get: fail, set: fail, clear: fail }, async open() { throw new Error('not used'); } } });
    const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
      native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    for (const operation of ['get', 'set', 'clear'] as const) {
      const result = await routeSessionGoalControl({ ...commonRouteParams('external-goal-failure'), operation,
        ...(operation === 'set' ? { request: { objective: 'Keep original refusal' } } : {}),
        resolveAdapter: async () => adapter });
      expect(result).toMatchObject({ ok: false, status, errorCode: 'external_goal_refused', details,
        ...(expected ? { goalControlFailure: expected } : {}) });
      if (!expected) expect(result).not.toHaveProperty('goalControlFailure');
    }
  });

  it('resumes real Claude and applies its native Goal before receipt, readback and the next person turn', async () => {
    const harness = claudeResumeGoalHarness();
    expect(harness.objective()).toBe('Native A');
    const receipt = await harness.route('set', true);
    expect(harness.objective()).toBe('Native B');
    expect(SessionWorkStateGetResponseV1Schema.parse(receipt).workState?.items).toEqual([
      expect.objectContaining({ title: 'Native B' }),
    ]);
    expect(harness.resume).toHaveBeenCalledOnce();
    expect(harness.resume.mock.calls[0]?.[1]).not.toHaveProperty('initialGoal');
    expect(harness.stageWorkStateMutation).not.toHaveBeenCalled();
    expect(SessionWorkStateGetResponseV1Schema.parse(await harness.route('get')).workState?.items).toEqual([
      expect.objectContaining({ title: 'Native B' }),
    ]);
    harness.live.source.observeTranscriptMessage({ type: 'user', uuid: 'person-turn', sessionId: 'native-claude-1',
      message: { content: 'Continue with the current objective' } });
    expect(harness.objective()).toBe('Native B');
    expect(SessionWorkStateGetResponseV1Schema.parse(await harness.route('get')).workState?.items[0]?.title).toBe('Native B');
  });

  it.each(['set', 'clear'] as const)('truthfully refuses real inactive Claude %s without Resume or display publication', async operation => {
    const harness = claudeResumeGoalHarness();
    await expect(harness.route(operation)).resolves.toMatchObject({ ok: false, status: 'unsupported' });
    expect(harness.objective()).toBe('Native A');
    expect(harness.stageWorkStateMutation).not.toHaveBeenCalled();
    expect(harness.resume).not.toHaveBeenCalled();
    expect(SessionWorkStateGetResponseV1Schema.parse(await harness.route('get')).workState?.items[0]?.title).toBe('Native A');
  });

  it('preserves real Claude native refusal and Resume failure without publishing the requested Goal', async () => {
    const refused = claudeResumeGoalHarness();
    refused.refuseNative();
    await expect(refused.route('set', true)).resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
    expect(refused.objective()).toBe('Native A');
    expect(refused.stageWorkStateMutation).not.toHaveBeenCalled();
    const failedResume = claudeResumeGoalHarness();
    failedResume.resume.mockResolvedValueOnce({ type: 'error', errorMessage: 'Resume refused' });
    await expect(failedResume.route('set', true)).resolves.toMatchObject({ ok: false, errorCode: 'resume_failed' });
    expect(failedResume.objective()).toBe('Native A');
    expect(failedResume.stageWorkStateMutation).not.toHaveBeenCalled();
  });

  it('retires a resumed Claude caller receipt on cancellation while keeping a late native Goal truthful', async () => {
    const harness = claudeResumeGoalHarness();
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    harness.holdNative(async () => { entered(); await acknowledgement; });
    const setting = harness.route('set', true);
    const cancelled = expect(setting).rejects.toMatchObject({ name: 'AbortError' });
    await entry;
    expect(harness.objective()).toBe('Native A');
    harness.controller.abort();
    await cancelled;
    release();
    await vi.waitFor(() => expect(harness.objective()).toBe('Native B'));
    expect(harness.stageWorkStateMutation).not.toHaveBeenCalled();
  });

  it('does not enter the resumed Claude effector when the caller cancels during Resume', async () => {
    const harness = claudeResumeGoalHarness();
    harness.resume.mockImplementationOnce(async () => {
      harness.controller.abort();
      return { type: 'success', sessionId: 'claude-native-goal-resume' };
    });
    await expect(harness.route('set', true)).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.objective()).toBe('Native A');
    expect(harness.stageWorkStateMutation).not.toHaveBeenCalled();
  });
  it.each([undefined, { pluginId: 'test.external-goals', localId: 'goal-agent' }].flatMap(agent =>
    (['activation', 'creation', 'services'] as const).map(phase => ({ agent, phase })),
  ))('cancels inactive Goal preparation during $phase before native entry ($agent)', async ({ agent, phase }) => {
    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    let entered = false;
    const signals: AbortSignal[] = [];
    const hold = async () => { entered = true; await held; };
    const set = vi.fn(async () => ({ status: 'applied' as const, revision: 'unexpected' }));
    const sessions: AgentSessionRuntimeFactory = {
      goals: { set, get: vi.fn(), clear: vi.fn() },
      async open() { throw new Error('not used'); },
    };
    const release = vi.fn(async () => undefined);
    const fixture = runtimeRegistryFixture({ agent, sessions, release,
      activate: async () => { if (phase === 'activation') await hold(); return []; },
      createRuntime: async ({ signal }) => {
        signals.push(signal);
        if (phase === 'creation') await hold();
        return { sessions };
      },
      createServices: async ({ signal }) => {
        signals.push(signal);
        if (phase === 'services') await hold();
        return createUnavailablePluginServices();
      },
    });
    const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
      native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    const controller = new AbortController();
    let outcome: unknown;
    const route = routeSessionGoalControl({ ...commonRouteParams('cancel-preparation'),
      operation: 'set', request: { objective: 'Must not enter native' }, signal: controller.signal,
      resolveAdapter: async () => adapter,
    }).then(value => { outcome = value; }, (error: unknown) => { outcome = error; });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      controller.abort();
      await vi.waitFor(() => expect(outcome).toMatchObject({ name: 'AbortError' }));
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(release).not.toHaveBeenCalled();
    } finally {
      unblock();
      await route;
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    }
    expect(set).not.toHaveBeenCalled();
  });

  it.each([undefined, { pluginId: 'test.external-goals', localId: 'goal-agent' }].flatMap(agent =>
    (['native', 'durable'] as const).map(phase => ({ agent, phase })),
  ))('retires an inactive Goal receipt during $phase acknowledgement and retains the late effect ($agent)', async ({ agent, phase }) => {
    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    let entered = false;
    let nativeSignal: AbortSignal | undefined;
    let stored: unknown;
    const release = vi.fn(async () => undefined);
    const fixture = runtimeRegistryFixture({ agent, release, sessions: {
      goals: {
        async set(_mutation, context, options) {
          nativeSignal = context.signal;
          expect(options?.signal).toBe(nativeSignal);
          if (phase === 'native') { entered = true; await held; }
          // Native I/O may already be admitted and ignore cancellation. Its
          // acknowledged effect must still reach the canonical durable owner.
          await context.goalSource.publish({ sourceSequence: 1, observedAtMs: 1,
            items: [{ localId: 'goal', kind: 'goal', origin: 'vendor', status: 'active',
              title: 'Late applied goal', updatedAtMs: 1 }], primaryLocalId: 'goal' });
          return { status: 'applied', revision: 'native-1' };
        },
        get: vi.fn(), clear: vi.fn(),
      },
      async open() { throw new Error('not used'); },
    } });
    const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
      native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    const controller = new AbortController();
    const resume = vi.fn();
    let outcome: unknown;
    const route = routeSessionGoalControl({ ...commonRouteParams('cancel-acknowledgement'),
      credentials: { token: 'token', encryption: null },
      operation: 'set', request: { objective: 'Late applied goal' }, signal: controller.signal,
      resumeInactiveWithInitialGoal: true, machineResumeTransport: resume,
      resolveAdapter: async () => adapter,
      stageWorkStateMutation: async (mutation, options) => {
        options?.signal?.throwIfAborted();
        if (phase === 'durable') { entered = true; await held; }
        stored = mutation.op.kind === 'set' ? mutation.op.value : null;
      },
    }).then(value => { outcome = value; }, (error: unknown) => { outcome = error; });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      controller.abort();
      await vi.waitFor(() => expect(outcome).toMatchObject({ name: 'AbortError' }));
      expect(nativeSignal?.aborted).toBe(true);
      expect(stored).toBeUndefined();
      if (phase === 'native') expect(release).not.toHaveBeenCalled();
    } finally {
      unblock();
      await route;
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    }
    await vi.waitFor(() => expect(stored).toMatchObject({ items: [expect.objectContaining({ title: 'Late applied goal' })] }));
    expect(resume).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ name: 'AbortError' });
  });

  it.each([undefined, { pluginId: 'test.external-goals', localId: 'goal-agent' }])(
    'acknowledges the stopped Goal write before ordinary resume and immediately reads it back (%j)', async agent => {
      const sessionId = 'goal-resume-session';
      let sourceSequence = 0;
      let rejectWrite = false;
      const fixture = runtimeRegistryFixture({ agent, sessions: {
        goals: {
          async set(mutation, context) {
            if (rejectWrite || typeof mutation.objective !== 'string') {
              return { status: 'rejected', retryable: false,
                diagnostic: { code: 'goal_write_rejected', severity: 'error' } };
            }
            const publication = await context.goalSource.publish({
              sourceSequence: ++sourceSequence, observedAtMs: sourceSequence,
              items: [{ localId: 'goal', kind: 'goal', origin: 'vendor', status: 'active',
                title: mutation.objective, updatedAtMs: sourceSequence }],
              primaryLocalId: 'goal',
            });
            if (publication.status !== 'applied' && publication.status !== 'unchanged') {
              throw new Error(`Goal publication failed: ${publication.status}`);
            }
            return { status: publication.status, revision: publication.revision };
          },
          async get() { return { status: 'unchanged', revision: 'current' }; },
          async clear() { throw new Error('not used'); },
        },
        async open() { throw new Error('not used'); },
      } });
      const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
        native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
      let storedMetadata: Record<string, unknown> = metadata();
      let holdAcknowledgement = false;
      let rejectAcknowledgement = false;
      let releaseAcknowledgement!: () => void;
      const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
      let writeIssued = false;
      const signal = new AbortController().signal;
      const resume = vi.fn<NonNullable<Parameters<typeof routeSessionGoalControl>[0]['machineResumeTransport']>>(
        async (_method, _request, options) => {
          expect(options?.signal).toBe(signal);
          return { type: 'success', sessionId };
        },
      );
      const route = (objective?: string, wake = false) => routeSessionGoalControl({
        ...commonRouteParams(sessionId), metadata: storedMetadata,
        credentials: { token: 'token', encryption: null },
        operation: objective === undefined ? 'get' : 'set',
        ...(objective === undefined ? {} : { request: { objective } }),
        resumeInactiveWithInitialGoal: wake,
        executionAuthority: 'account_automation', signal,
        resolveAdapter: async () => adapter,
        machineResumeTransport: resume,
        // This is the acknowledged HTTP persistence boundary; the real router,
        // external/native facet and work-state projection remain composed.
        stageWorkStateMutation: async (mutation, options) => {
          expect(options?.signal).toBe(signal);
          if (rejectAcknowledgement) throw new Error('goal_ack_failed');
          if (holdAcknowledgement) { writeIssued = true; await acknowledgement; }
          storedMetadata = { ...storedMetadata, sessionWorkStateV1: mutation.op.kind === 'set' ? mutation.op.value : null };
        },
      });
      await route('Previous goal');
      holdAcknowledgement = true;
      const setting = route('Resumed goal', true);
      await vi.waitFor(() => expect(writeIssued).toBe(true));
      expect(resume).not.toHaveBeenCalled();
      releaseAcknowledgement();
      const result = await setting;
      expect(SessionWorkStateGetResponseV1Schema.parse(result).workState?.items).toEqual([
        expect.objectContaining({ title: 'Resumed goal' }),
      ]);
      expect(resume).toHaveBeenCalledOnce();
      expect(resume.mock.calls[0]?.[1]).not.toHaveProperty('initialGoal');
      expect(resume.mock.calls[0]?.[1]).not.toHaveProperty('executionAuthorization');
      expect(SessionWorkStateGetResponseV1Schema.parse(await route()).workState?.items).toEqual([
        expect.objectContaining({ title: 'Resumed goal' }),
      ]);
      rejectWrite = true;
      await expect(route('Rejected goal', true)).resolves.toMatchObject({ ok: false, errorCode: 'goal_write_rejected' });
      expect(resume).toHaveBeenCalledOnce();
      rejectWrite = false;
      rejectAcknowledgement = true;
      await expect(route('Unacknowledged goal', true)).rejects.toThrow('goal_ack_failed');
      expect(resume).toHaveBeenCalledOnce();
      rejectAcknowledgement = false;
      resume.mockResolvedValueOnce({ type: 'error', errorMessage: 'Resume refused' });
      await expect(route('Retained goal', true)).resolves.toMatchObject({ ok: false, errorCode: 'resume_failed' });
      expect(SessionWorkStateGetResponseV1Schema.parse(await route()).workState?.items).toEqual([
        expect.objectContaining({ title: 'Retained goal' }),
      ]);
    },
  );

  it('does not expose a retired catalog-adapter fallback when no native facet is declared', () => {
    const legacyList = vi.fn(async () => ({ skills: [{ id: 'legacy-skill' }] }));
    const retiredParams = {
      agentId: 'codex',
      legacy: { listSkills: legacyList },
      native: { vendorPlugins: false, skills: false },
    } as unknown as Parameters<typeof createNativeInactiveCatalogAdapter>[0];

    const adapter = createNativeInactiveCatalogAdapter(retiredParams);

    expect(adapter).not.toHaveProperty('listSkills');
    expect(legacyList).not.toHaveBeenCalled();
  });

  it.each(['applied', 'unchanged', 'pending', 'scheduledForResume'] as const)(
    'routes goals through the current native facet and returns its canonical work-state publication (%s)', async status => {
    const set = vi.fn(async (mutation, context) => {
      expect(mutation).toEqual({ objective: 'Ship G6', status: 'active' });
      expect(context.invokedAtMs).toEqual(expect.any(Number));
      expect(context.session).toMatchObject({
        id: 'goal-session',
        cwd: '/repo',
        activity: 'inactive',
        providerSessionId: 'thread-1',
      });
      const published = await context.goalSource.publish({
        sourceSequence: 1,
        observedAtMs: 100,
        items: [{
          localId: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship G6',
          updatedAtMs: 100,
        }],
        primaryLocalId: 'goal:thread-1',
      });
      expect(published.status).toBe('applied');
      return status === 'pending'
        ? { status, operationId: 'provider-operation-1', diagnostic: {
          code: 'external_goal_pending', severity: 'info' as const, message: 'private pending upstream text',
          details: { localPath: '/private/native/config' },
        } }
        : { status, revision: 'provider-1' };
    });
    const fixture = runtimeRegistryFixture({
      agent: { pluginId: 'test.external-goals', localId: 'goal-agent' },
      sessions: {
        goals: {
          set,
          get: async () => ({ status: 'unchanged', revision: 'provider-1' }),
          clear: async context => {
            await context.goalSource.publish({ sourceSequence: 2, observedAtMs: 101, items: [], primaryLocalId: null });
            return { status: 'applied', revision: 'provider-2' };
          },
        },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveGoalAdapter({
      agentId: fixture.agentId,
      native: { get: true, set: true, clear: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    const result = await routeSessionGoalControl({
      ...commonRouteParams('goal-session'),
      operation: 'set',
      request: { objective: 'Ship G6', status: 'active' },
      resolveAdapter: async () => adapter,
    });

    expect(result).toMatchObject({
      status,
      metadata: {
        sessionWorkStateV1: {
          v: 1,
          primaryItemId: expect.any(String),
          items: [expect.objectContaining({ title: 'Ship G6', status: 'active' })],
        },
      },
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('diagnostic');
    const publication = SessionWorkStateGetResponseV1Schema.parse(result);
    const readBack = await routeSessionGoalControl({
      ...commonRouteParams('goal-session'),
      metadata: { ...metadata(), sessionWorkStateV1: publication.workState },
      operation: 'get',
      resolveAdapter: async () => adapter,
    });
    expect(SessionWorkStateGetResponseV1Schema.parse(readBack).workState).toEqual(publication.workState);
    const cleared = await routeSessionGoalControl({
      ...commonRouteParams('goal-session'),
      metadata: { ...metadata(), sessionWorkStateV1: publication.workState },
      operation: 'clear',
      resolveAdapter: async () => adapter,
    });
    expect(SessionWorkStateGetResponseV1Schema.parse(cleared).workState?.items).toEqual([]);
  });

  it('fails closed when an inactive goal mutation exceeds the declared native fields', async () => {
    const set = vi.fn(async () => ({ status: 'applied' as const, revision: 'unexpected' }));
    const fixture = runtimeRegistryFixture({
      goalSet: { fields: ['objective'] },
      sessions: {
        goals: { set, get: vi.fn(), clear: vi.fn() },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveGoalAdapter({
      agentId: 'codex',
      native: { get: true, set: true, clear: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionGoalControl({
      ...commonRouteParams('goal-fields-session'),
      operation: 'set',
      request: { objective: 'Ship G6', status: 'active' },
      resolveAdapter: async () => adapter,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'inactive_agent_goal_field_unsupported',
      error: 'inactive_agent_goal_field_unsupported',
      status: 'unsupported',
      diagnostic: { code: 'inactive_agent_goal_field_unsupported' },
    });
    expect(set).not.toHaveBeenCalled();
  });

  it.each((['get', 'set', 'clear'] as const).flatMap(operation =>
    (['rejected', 'unavailable', 'unsupported'] as const).map(status => ({ operation, status })),
  ))('projects a native $operation $status refusal into the Goal RPC failure contract', async ({ operation, status }) => {
    const diagnostic = { code: 'external_goal_refused', severity: 'error' as const,
        message: 'private upstream text', details: { localPath: '/private/native/config', token: 'synthetic-review-secret' },
        remediation: { kind: 'openSettings' as const, path: '/private/native/config' } };
    const failure: AgentSessionGoalMutationResult = status === 'unsupported'
      ? { status, diagnostic }
      : { status, retryable: status === 'unavailable', diagnostic };
    const fixture = runtimeRegistryFixture({ agent: { pluginId: 'test.external-goals', localId: 'goal-agent' }, sessions: {
      goals: { get: async () => failure, set: async () => failure, clear: async () => failure },
      open: async () => { throw new Error('not used'); },
    } });
    const adapter = createNativeInactiveGoalAdapter({ agentId: fixture.agentId,
      native: { get: true, set: true, clear: true }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
    const result = await routeSessionGoalControl({ ...commonRouteParams('goal-refusal-session'), operation,
      ...(operation === 'set' ? { request: { objective: 'Finish' } } : {}), resolveAdapter: async () => adapter });
    expect(result).toEqual({ ok: false, status, errorCode: 'external_goal_refused', error: 'external_goal_refused',
      ...(status === 'unsupported' ? {} : { retryable: status === 'unavailable' }) });
  });

  it('denies a generation that becomes stale during native catalog invocation without legacy fallback', async () => {
    let current = true;
    const fixture = runtimeRegistryFixture({
      isCurrent: () => current,
      sessions: {
        catalog: {
          async list() {
            current = false;
            return { status: 'ok', kind: 'skills', items: [] };
          },
        },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveCatalogAdapter({
      agentId: 'codex',
      native: { vendorPlugins: true, skills: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionCatalogControl({
      ...commonRouteParams('catalog-session'),
      operation: 'skills',
      resolveAdapter: async () => adapter,
    })).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'inactive_agent_runtime_generation_retired',
    });
  });

  it('admits a Pending continuation after the real Codex control reports quota ready', async () => {
    await withCodexNativeAttachFixture(async native => {
      const controls = createCodexNativeSessionControls();
      const fixture = runtimeRegistryFixture({
        sessions: { ...controls, async open() { throw new Error('Quota readiness must not open a Session'); } },
        createServices: async () => ({ ...createUnavailablePluginServices(), exec: native.exec }),
      });
      const adapter = createNativeInactiveUsageAdapter({ agentId: fixture.agentId,
        native: { checkNow: true, consumeResetCredit: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
      const sessionId = 'c123456789012345678901234';
      const credentials = { token: 'native-quota-recovery-test', encryption: null };
      const occurredAt = Date.now() - 2_000;
      const resetAtMs = occurredAt + 60_000;
      let stored: Record<string, unknown> = { ...metadata(), sessionUsageLimitRecoveryV1: {
        v: 1, status: 'waiting', resumePromptMode: 'standard',
        issueFingerprint: `usage-limit:codex:interrupted-turn:${occurredAt}:${resetAtMs}`,
        armedAtMs: occurredAt, resetAtMs, nextCheckAtMs: resetAtMs,
        attemptCount: 0, maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
      } };
      const raw = createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain',
        metadata: JSON.stringify(stored), latestTurnId: 'canonical-failed-turn', latestTurnStatus: 'failed',
        lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit',
          agentId: 'codex', agentTurnId: 'interrupted-turn', occurredAt,
          usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } },
      });
      // HTTP is the external boundary; native protocol, routing, continuation authoring and Pending stay real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        } };
        if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: { ...raw, metadata: JSON.stringify(stored) } } };
        throw new Error(`Unexpected read: ${url}`);
      });
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false } });
      try {
        const result = await routeSessionUsageLimitRecoveryCheckNow({ ...commonRouteParams(sessionId),
          credentials, rawSession: raw, metadata: stored, request: { sessionId, agentId: 'codex' },
          stageUsageLimitRecoveryMutation: async mutation => {
            if (mutation.op.kind === 'set') stored = { ...stored, sessionUsageLimitRecoveryV1: mutation.op.value };
          },
          resolveAdapter: async () => adapter,
          resumeInactiveSessionWhenReady: async input => await activateInactiveUsageLimitResume({ ...input, credentials }),
        });
        expect(result).toMatchObject({ ok: true, status: 'resumed' });
        expect(post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
          expect.objectContaining({ deliveryMode: 'continuation_if_no_queued_user_input',
            requestedAction: { v: 1, kind: 'send_now' } }), expect.anything());
        expect(native.requests.some(request => request.method === 'account/rateLimits/read')).toBe(true);
      } finally { get.mockRestore(); post.mockRestore(); }
    });
  });

  it('does not author repeated continuation turns while the real Codex quota control remains exhausted', async () => {
    let exhausted = true;
    await withCodexNativeAttachFixture(async native => {
      const fixture = runtimeRegistryFixture({
        sessions: { ...createCodexNativeSessionControls(), async open() { throw new Error('Quota checks must not open a Session'); } },
        createServices: async () => ({ ...createUnavailablePluginServices(), exec: native.exec }),
      });
      const adapter = createNativeInactiveUsageAdapter({ agentId: fixture.agentId,
        native: { checkNow: true, consumeResetCredit: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
      const rows = new Map<string, unknown>();
      const prompts: string[] = [];
      const dispatcher = createConnectedServiceContinuationMessageDispatcher({
        credentials: { token: 'dummy-native-quota-continuation', encryption: null },
        // Pending HTTP is the boundary; quota control, scheduler and prompt construction stay real.
        sendMessage: async input => {
          prompts.push(input.message);
          return { ok: true, sessionId: input.idOrPrefix, localId: input.localId!, waited: false,
            admissionResult: { status: 'accepted', localId: input.localId! } };
        },
      });
      const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: Date.now,
        store: { read: key => rows.get(key) ?? null, write: (key, value) => { rows.set(key, value); } },
        readUsageLimitReadiness: async () => {
          const result = normalizeUsageLimitRecoveryOperationResult(await adapter.checkNow!({
            ...commonRouteParams('native-limited-session'), cwd: native.directory, sessionMachineId: 'machine-local',
          }), { sessionId: 'native-limited-session' });
          if (!result.ok) return { status: 'unavailable', errorCode: result.errorCode };
          return result.status === 'ready' ? { status: 'ready' } : { status: 'waiting', retryAfterMs: result.retryAfterMs };
        },
        resume: async intent => {
          await dispatcher.enqueueInterruptedOriginContinuation({ sessionId: intent.sessionId,
            attemptId: intent.issueFingerprint, interruptedOriginId: intent.continuation!.interruptedOriginId,
            interruption: 'provider_failed_turn', resumePromptMode: 'standard', recoveryKind: 'usage_limit' });
          return { status: 'continued' };
        },
      });
      try {
        for (let turn = 0; turn < 3; turn += 1) {
          await scheduler.enable({ sessionId: 'native-limited-session', serviceId: 'openai-codex',
            profileId: 'dummy-exhausted-account', groupId: null, issueFingerprint: 'usage-limit',
            continuation: { interruptedOriginId: `failed-turn-${turn}`, resumePromptMode: 'standard',
              customResumePrompt: null, recoveryKind: 'usage_limit' } });
          await scheduler.wake({ sessionId: 'native-limited-session', reason: 'manual' });
        }
        expect(prompts).toHaveLength(0);
        exhausted = false;
        await scheduler.wake({ sessionId: 'native-limited-session', reason: 'manual' });
        expect(prompts).toEqual(['Continue where you left off']);
        expect(native.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
      } finally { scheduler.dispose(); }
    }, { rateLimitsRead: () => ({ rateLimits: { primary: { usedPercent: exhausted ? 100 : 20 } } }) });
  });

  it('retains native quota snapshot timing for an untimed interrupted turn', async () => {
    const nowMs = Date.now();
    const resetAtMs = Math.floor((nowMs + 60_000) / 1_000) * 1_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      await withCodexNativeAttachFixture(async native => {
        const controls = createCodexNativeSessionControls();
        const fixture = runtimeRegistryFixture({
          sessions: { ...controls, async open() { throw new Error('Quota readiness must not open a Session'); } },
          createServices: async () => ({ ...createUnavailablePluginServices(), exec: native.exec }),
        });
        const adapter = createNativeInactiveUsageAdapter({ agentId: fixture.agentId,
          native: { checkNow: true, consumeResetCredit: false }, dependencies: { acquireRuntimeRegistryLease: fixture.acquire } });
        const sessionId = 'native-quota-snapshot-timing';
        const issue = { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
          source: 'usage_limit' as const, code: 'usage_limit', agentId: 'codex', agentTurnId: 'untimed-turn', occurredAt: nowMs - 2_000,
          usageLimit: { v: 1 as const, resetAtMs: null, retryAfterMs: null, quotaScope: 'account' as const, recoverability: 'wait' as const } };
        let stored: Record<string, unknown> = { ...metadata(), sessionUsageLimitRecoveryV1: {
          v: 1, status: 'waiting', resumePromptMode: 'standard', issueFingerprint: buildUsageLimitIssueFingerprint(issue),
          armedAtMs: issue.occurredAt, resetAtMs: null, nextCheckAtMs: nowMs + 600_000,
          attemptCount: 0, maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
        } };
        const raw = createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain',
          metadata: JSON.stringify(stored), latestTurnId: 'canonical-untimed-turn', latestTurnStatus: 'failed', lastRuntimeIssue: issue });
        const result = await routeSessionUsageLimitRecoveryCheckNow({ ...commonRouteParams(sessionId),
          credentials: { token: 'native-quota-snapshot-test', encryption: null }, rawSession: raw,
          metadata: stored, request: { sessionId, agentId: 'codex' },
          stageUsageLimitRecoveryMutation: async mutation => {
            if (mutation.op.kind === 'set') stored = { ...stored, sessionUsageLimitRecoveryV1: mutation.op.value };
          }, resolveAdapter: async () => adapter,
        });
        expect(result).toMatchObject({ ok: true, status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: {
          issueFingerprint: buildUsageLimitIssueFingerprint(issue), resetAtMs, nextCheckAtMs: resetAtMs,
        } } });
        expect(raw.lastRuntimeIssue).toMatchObject({ usageLimit: { resetAtMs: null } });
        expect(native.requests.some(request => request.method === 'account/rateLimits/read')).toBe(true);
      }, { rateLimitsRead: () => ({ rateLimits: { primary: { usedPercent: 100, resetsAt: resetAtMs / 1_000 } } }) });
    } finally { clock.mockRestore(); }
  });

  it('routes usage recovery through the native inactive facet', async () => {
    const execute = vi.fn(async (_request, context) => {
      expect(context.session.activity).toBe('inactive');
      return { status: 'ready' as const };
    });
    const fixture = runtimeRegistryFixture({
      sessions: {
        usageLimitRecovery: { execute },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-session'),
      ctx: null,
      request: { sessionId: 'usage-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'usage-session' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'checkNow' }),
      expect.objectContaining({ session: expect.objectContaining({ activity: 'inactive' }) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not call inactive usage recovery when the runtime factory resolves after generation retirement', async () => {
    let current = true;
    let resolveRuntime!: (runtime: AgentRuntime) => void;
    const lateRuntime = new Promise<AgentRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const execute = vi.fn(async () => ({ status: 'ready' as const }));
    const createRuntime = vi.fn(async () => await lateRuntime);
    const release = vi.fn(async () => undefined);
    const sessions: AgentSessionRuntimeFactory = {
      usageLimitRecovery: { execute },
      open: async () => { throw new Error('not used'); },
    };
    const fixture = runtimeRegistryFixture({
      sessions,
      isCurrent: () => current,
      createRuntime,
      release,
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    const checking = routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-retired-during-runtime-create'),
      ctx: null,
      request: { sessionId: 'usage-retired-during-runtime-create', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    current = false;
    resolveRuntime({ sessions });

    await expect(checking).resolves.toMatchObject({
      ok: false,
      errorCode: 'inactive_agent_runtime_generation_retired',
      status: 'inactive',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps inactive issue intent and durable backoff state with the host adapter when a native facet exists', async () => {
    const execute = vi.fn(async () => ({ status: 'ready' as const }));
    const fixture = runtimeRegistryFixture({
      sessions: {
        usageLimitRecovery: { execute },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      backoffPolicy: {
        providerId: 'pi',
        fallbackBackoffEnvKey: 'HAPPIER_TEST_FALLBACK_BACKOFF_MS',
        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
        defaultFallbackBackoffMs: 60_000,
        defaultMaxAttempts: 3,
      },
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });
    const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);
    const occurredAt = Date.now();
    const resetAtMs = occurredAt + 60_000;

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-host-state-session'),
      ctx: null,
      credentials: {
        token: 'token',
        encryption: null,
      },
      rawSession: {
        ...rawSession('usage-host-state-session'),
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          agentId: 'pi',
          agentTurnId: 'turn-1',
          occurredAt,
          usageLimit: {
            v: 1,
            resetAtMs,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
      } as RawSessionRecord,
      request: { sessionId: 'usage-host-state-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation,
      resolveAdapter: async () => adapter,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          issueFingerprint: `usage-limit:pi:turn-1:${occurredAt}:${resetAtMs}`,
          resetAtMs,
          nextCheckAtMs: resetAtMs,
          attemptCount: 0,
          maxAttempts: 3,
        },
      },
    });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.usageLimitRecovery',
      source: 'daemon',
      deliveryClass: 'durable_required',
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports native usage recovery unavailable when the declared current runtime is absent', async () => {
    const fixture = runtimeRegistryFixture({
      includeRuntimeLease: false,
      sessions: {
        usageLimitRecovery: { execute: vi.fn() },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-absent-session'),
      ctx: null,
      request: { sessionId: 'usage-absent-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'inactive_agent_runtime_unavailable',
      status: 'inactive',
    });
  });

});
