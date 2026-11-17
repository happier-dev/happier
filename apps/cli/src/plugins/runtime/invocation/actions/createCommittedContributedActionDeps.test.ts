import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import type { ActionSettlementV1 } from '@happier-dev/protocol/actions/executor/actionSettlement';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { admitPluginContributionGraph } from '@/plugins/projection/registry/normalize/admission';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { createPluginInvocationActionsService } from '../services/actions';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader,
  listRuntimeContributedActionDefinitions } from './createCommittedContributedActionDeps';

// Login storage is an external persistence boundary. Admission, activation,
// invocation, published error projection and public Action normalization stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

it('keeps input-sensitive plugin effects discoverable and settles only mutation inputs', async () => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  const common = { title: 'Catalog effect fixture', dangerLevel: 'safe', scopes: ['global'],
    surfaces: ['cli'], inputSchema: { type: 'object', properties: { mode: { type: 'string' } },
      additionalProperties: false }, run: (input: unknown) => input } as const;
  const authored = definePlugin({ id: 'example.committed-effect-catalog', version: '1.0.0',
    entrypoints: { daemon: './daemon.mjs' }, actions: {
      conditional: { ...common, readOnly: { op: 'eq', path: 'mode', value: 'preview' } },
      read: { ...common, readOnly: true },
      effect: { ...common, readOnly: false },
      scoped: { ...common, readOnly: true, approvalScope: 'environment' },
      health: { ...common, readOnly: false, approvalScope: 'healthCheck', inputSchema: {
        type: 'object', properties: { sourceInstanceId: { type: 'string' }, checkId: { type: 'string' },
          webhookEndpointId: { type: 'string' } }, required: ['sourceInstanceId', 'checkId'], additionalProperties: false,
      } },
      undeclared: common,
      recursive: { ...common, readOnly: false, surfaces: ['cli', 'plugin'],
        run: async (input: unknown, context: PluginInvocationContext) => {
          if (input && typeof input === 'object' && 'mode' in input && input.mode === 'outer') {
            return context.services.actions.execute({ pluginId: 'example.committed-effect-catalog', localId: 'recursive' }, { mode: 'inner' });
          }
          return { mode: 'inner' };
        } },
    } });
  const fixture = await runWithServerHttpBaseUrl('http://127.0.0.1:1', () => createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' },
    instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => {
      const loadResult = await loadInstalledPlugins({ happyHomeDir });
      return createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult, provenance: 'external',
        referenceGraph: admitPluginContributionGraph({ loadedPlugins: loadResult.loadedPlugins }) }));
    },
    runtimeOptions: { externalActionHomeBinding: { serverId: 'home', serverIdentityId: 'home' },
      scopedActionRuntime: { credentials: { token: 'fixture-plugin-effect-token', encryption: null },
      actionsSettingsProvider: createActionSettingsProvider() } },
  }));
  const events: ActionSettlementV1[] = [];
  const actionId = (localId: string) => formatQualifiedPluginActionId({ pluginId: authored.manifest.id, localId });
  const healthSubject = { kind: 'healthCheck', serverId: 'home', sourceInstanceId: 'saved-source', checkId: 'heartbeat' } as const;
  const skippedNotice = { code: 'action_automation_skipped', reason: 'machine_required',
    automationId: 'automation-effect', triggerId: 'after', workflowId: 'workflow' } as const;
  // The structural index and settlement transport are network boundaries; selection stays real.
  const port = createActionAutomationPortV1({ accountId: 'account',
    seed: async () => ({ v: 1, rows: [...['conditional', 'read', 'effect', 'undeclared', 'recursive'].map(localId => ({
      automationId: `automation-${localId}`, triggerId: 'after', triggerRevision: 1,
      workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'account', actionIds: [actionId(localId)], phase: 'after',
    })), { automationId: 'automation-health', triggerId: 'after', triggerRevision: 1,
      workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'account', actionIds: [actionId('health')],
      phase: 'after', subjectKind: 'healthCheck', subjectKey: automationSubjectKeyV1(healthSubject) }] }),
    settle: async request => { events.push(request.event);
      return request.event.actionId === actionId('effect') ? [skippedNotice] : []; },
  });
  try {
    const listDefinitions = (selection: Parameters<typeof listRuntimeContributedActionDefinitions>[1]) =>
      listRuntimeContributedActionDefinitions(fixture.registry, selection);
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      actionAutomations: port,
      listContributedActionDefinitions: listDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
      invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }),
    });
    const discover = async (localId: string) => {
      const result = await executor.execute('action.spec.get', {
        id: formatQualifiedPluginActionId({ pluginId: authored.manifest.id, localId }),
      }, { surface: 'cli' });
      if (!result.ok) throw new Error(`Action discovery refused (${result.errorCode}: ${result.error})`);
      return result;
    };
    expect(await discover('conditional')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'external' } } });
    expect(await discover('read')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'read' } } });
    expect(await discover('scoped')).toMatchObject({ ok: true, result: { actionSpec: { approvalScope: 'environment' } } });
    expect(await discover('effect')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'external' } } });
    const undeclared = await discover('undeclared');
    expect(undeclared).toMatchObject({ ok: true });
    expect(undeclared).not.toHaveProperty('result.actionSpec.sideEffectClass');
    const invoke = async (localId: string, mode: string) => {
      const result = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId }, input: { mode } },
        { surface: 'cli', authority: 'present_user', actionRequestId: `${localId}-${mode}`, serverId: 'home', serverIdentityId: 'home' });
      expect(result).toMatchObject({ ok: true });
      return result;
    };
    await invoke('conditional', 'preview');
    expect(events).toEqual([]);
    await invoke('conditional', 'save');
    expect(events).toMatchObject([{ actionId: actionId('conditional'), status: 'succeeded' }]);
    await invoke('read', 'save');
    expect(events).toHaveLength(1);
    expect(await invoke('effect', 'save')).toMatchObject({ automationNotices: [skippedNotice] });
    await invoke('undeclared', 'save');
    expect(events.map(event => event.actionId)).toEqual([actionId('conditional'), actionId('effect'), actionId('undeclared')]);
    await invoke('recursive', 'outer');
    expect(events.slice(3).map(event => event.actionId)).toEqual([actionId('recursive'), actionId('recursive')]);
    expect(new Set(events.slice(3).map(event => event.requestId)).size).toBe(2);
    const invokeHealth = (checkId: string) => executor.execute('action.invoke', {
      action: { pluginId: authored.manifest.id, localId: 'health' },
      input: { sourceInstanceId: 'saved-source', checkId, webhookEndpointId: 'private-endpoint' },
    }, { surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'home', actionRequestId: `health-${checkId}` });
    expect(await invokeHealth('other-check')).toMatchObject({ ok: true });
    expect(events).toHaveLength(5);
    expect(await invokeHealth('heartbeat')).toMatchObject({ ok: true });
    expect(events.slice(5)).toMatchObject([{ subjects: [{ role: 'operand', subject: healthSubject }] }]);
    expect(JSON.stringify(events.slice(5))).not.toContain('private-endpoint');
  } finally { port.dispose(); await fixture.dispose(); }
});

it.each([
  { state: 'failed', human: false }, { state: 'succeeded', human: false },
  { state: 'failed', human: true }, { state: 'succeeded', human: true },
] as const)('settles its admitted before-wait before entering a contributed handler: $state, human=$human', async ({ state, human }) => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', human ? JSON.stringify({ v: 1, actions: {
    [formatQualifiedPluginActionId({ pluginId: 'example.committed-before', localId: 'effect' })]: { approvalRequiredSurfaces: ['cli'] },
  } }) : '');
  let effects = 0;
  const authored = definePlugin({ id: 'example.committed-before', version: '1.0.0',
    entrypoints: { daemon: './daemon.mjs' }, actions: { effect: { title: 'Effect', dangerLevel: 'safe',
      readOnly: false, surfaces: ['cli'], inputSchema: { type: 'object', additionalProperties: false },
      ...(human ? { confirmation: { title: 'Apply effect' }, approvalInputCustody: 'live_only' as const } : {}),
      run: () => { effects++; return { applied: true }; } } } });
  const fixture = await runWithServerHttpBaseUrl('http://127.0.0.1:1', () => createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{ manifest: authored.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
      instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => {
      const loadResult = await loadInstalledPlugins({ happyHomeDir });
      return createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult, provenance: 'external',
        referenceGraph: admitPluginContributionGraph({ loadedPlugins: loadResult.loadedPlugins }) }));
    }, runtimeOptions: { externalActionHomeBinding: { serverId: 'home', serverIdentityId: 'home' },
      scopedActionRuntime: { credentials: { token: 'fixture-plugin-before-token', encryption: null },
        actionsSettingsProvider: createActionSettingsProvider() } },
  }));
  const actionId = formatQualifiedPluginActionId({ pluginId: authored.manifest.id, localId: 'effect' });
  const skippedNotice = { code: 'action_automation_skipped', reason: 'machine_required',
    automationId: 'skipped-automation', triggerId: 'before-skipped', workflowId: 'workflow' } as const;
  const port = createActionAutomationPortV1({ accountId: 'account',
    seed: async () => ({ v: 1, rows: [{ automationId: 'automation', triggerId: 'before', triggerRevision: 1,
      workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'account', actionIds: [actionId],
      phase: 'before', mode: 'wait', onFailure: 'refuse' }] }),
    start: async ({ selected }) => ({ runs: selected.map(row => ({ automationId: row.automationId,
      triggerId: row.triggerId, runId: 'failed-run' })), notices: [skippedNotice] }),
    settle: async () => {},
  });
  let stored: TargetActionApprovalRequestV1 | null = null;
  let changed: (() => void) | undefined;
  const read = async () => stored;
  const update: Parameters<typeof createTargetActionCurrentIntentAdapter>[0]['update'] = async ({ request }) => {
    if (!stored) throw new Error('Missing admitted target approval');
    const transition = admitTargetActionApprovalTransition(stored, request);
    if (transition.ok) { stored = request; changed?.(); }
    return transition;
  };
  const actionAutomations = { ...port, wait: async () => ({ state, ...(state === 'failed' ? { errorCode: 'step_failed' } : {}) }) };
  const decide = createTargetActionApprovalDecision({ read, update, actionAutomations, hasLiveInvocation: () => true });
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async (request, onReady) => {
      stored = request;
      expect(request.automaticChecks?.humanApprovalRequired).toBe(human);
      onReady?.({ artifactId: 'before-approval', request });
      if (human) setImmediate(() => { void decide({ artifactId: 'before-approval', decision: 'approve',
        context: { surface: 'ui', authority: 'present_user', runtimeAccountId: 'account' } }); });
      return { artifactId: 'before-approval' };
    },
    read, update,
    subscribeChanges: (_artifactId, onChange) => { changed = onChange; return { dispose() { changed = undefined; } }; },
  });
  try {
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      actionAutomations,
      isApprovalExecutionOriginCurrent: async () => true,
      invokeContributedAction: createCommittedContributedActionInvoker({
        requestCurrentIntent,
        acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }),
    });
    const result = await executor.execute('action.invoke', {
      action: { pluginId: authored.manifest.id, localId: 'effect' }, input: {},
    }, { surface: 'cli', authority: human ? 'account_automation' : 'present_user', actionCaller: { kind: 'host' },
      actionRequestId: 'contributed-before', serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account' });
    expect(effects).toBe(state === 'failed' ? 0 : 1);
    expect(result).toMatchObject(state === 'failed'
      ? { ok: false, errorCode: 'action_interception_rejected', effectAttempted: false }
      : { ok: true, result: { applied: true } });
    expect(result.automationNotices).toEqual([skippedNotice]);
  } finally { port.dispose(); await fixture.dispose(); }
});

it.each(['provider_request_failed', 'plugin_disabled', 'authentication_required', 'present_user_required',
  'admission_unavailable', 'approval_execution_outcome_unknown'])(
  'preserves only the canonical published PluginError envelope across committed Action normalization (%s)', async code => {
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  const causeCode = code === 'approval_execution_outcome_unknown' ? 'present_user_required' : code;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const shared = { title: 'Fail', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], inputSchema: closed } as const;
  const authored = definePlugin({ id: 'example.committed-failure', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: {
      published: { ...shared, run: async () => { throw new PluginError({ code, retryable: false,
        failureCause: { phase: 'send', errorClass: 'Error', errorCode: causeCode, httpStatus: null },
        details: { phase: 'send', requestId: 'adapter-authored-request' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } }); } },
      unpublished: { ...shared, run: async () => { throw Object.assign(new Error('unpublished transport failure'), {
        data: { name: 'PluginError', code: 'provider_request_failed', details: { phase: 'send', rawPayload: 'unpublished' } },
      }); } },
    } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
  });
  try {
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }) });
    const published = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId: 'published' }, input: {} }, { surface: 'cli' });
    expect(ActionExecuteFailureSchema.parse(published)).toMatchObject({ ok: false, errorCode: code,
      failureCause: { errorCode: causeCode },
      details: { name: 'PluginError', code, retryable: false,
        details: { phase: 'send', requestId: 'adapter-authored-request' }, remediation: { kind: 'openSettings', path: 'accounts/provider' } } });
    const unpublished = await executor.execute('action.invoke', { action: { pluginId: authored.manifest.id, localId: 'unpublished' }, input: {} }, { surface: 'cli' });
    expect(ActionExecuteFailureSchema.parse(unpublished)).toMatchObject({ ok: false, errorCode: 'plugin_action_execution_failed' });
    expect(unpublished).not.toHaveProperty('details.details.rawPayload');
    expect(unpublished).not.toHaveProperty('details.details.phase');
  } finally { await fixture.dispose(); }
});


it.each(['committed CLI', 'daemon external', 'daemon current-process'] as const)(
    'captures a nested SDK with-origin call through %s and rejects mismatched routing', async path => {
  let effects = 0;
  const pluginId = 'example.committed-origin';
  const machineId = 'origin-machine';
  const serverIdentityId = 'srv_committed_origin';
  const authored = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: { read: { title: 'Read', dangerLevel: 'safe', surfaces: ['plugin'],
      inputSchema: { type: 'object', additionalProperties: false },
      run() { effects++; return { received: true }; },
    } } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
    files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: authored.activate }) }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    runtimeOptions: { resolveCurrentMachineId: () => machineId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) },
  });
  try {
    const acquireRuntimeRegistryLease = () => fixture.controller.acquireRuntimeRegistry();
    const invoke = path === 'daemon external'
      ? createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease })
      : createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease });
    const localExecutor = createCliActionExecutor({ token: 'fixture-token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(fixture.registry, selection),
      invokeContributedAction: invoke });
    const actionExecutor = path === 'daemon current-process'
      ? createDaemonPluginActionExecutor({ base: localExecutor,
          executeInCurrentProcess: async (actionId, input, context) => {
            if (actionId !== 'action.invoke') throw new Error('Expected contributed Action dispatch');
            return { matched: true, result: await localExecutor.execute(actionId, input, context) };
          },
          requestPluginActionExecution: async () => { throw new Error('A bound plugin invocation must remain local'); } })
      : localExecutor;
    const service = createPluginInvocationActionsService({
      invokeContributedAction: async () => { throw new Error('Targeted operations are outside this ordinary-ref test'); },
      seed: { plugin: { id: pluginId, version: '1.0.0' }, contribution: { id: 'read', qualifiedId: `${pluginId}/actions/read` },
        occurrenceId: fixture.registry.readPluginOccurrenceId!(pluginId)!,
        sourceCustody: fixture.registry.readPluginSourceCustody!(pluginId)!,
        surface: 'cli', signal: new AbortController().signal, isOccurrenceCurrent: () => true },
      actionExecutor,
    });
    const action = { pluginId, localId: 'read' };
    const routing = { serverIdentityId, machineId, pluginId };
    await expect(service.executeWithExecutionOrigin(action, {}, { expectedExecutionRouting: routing }))
      .resolves.toMatchObject({ result: { received: true }, executionOrigin: { serverIdentityId } });
    expect(effects).toBe(1);
    await expect(service.executeWithExecutionOrigin(action, {}, { expectedExecutionRouting: { ...routing, machineId: 'other-machine' } }))
      .rejects.toMatchObject({ code: 'plugin_action_execution_origin_mismatch' });
    expect(effects).toBe(1);
  } finally { await fixture.dispose(); }
});
