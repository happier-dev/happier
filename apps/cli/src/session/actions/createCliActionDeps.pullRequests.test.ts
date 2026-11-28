import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { AutomationConversationActionInputSchemasV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
  AutomationDefinitionReconcileRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { getAutomationDefinition } from '@/api/automations';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createManifestTargetedContributionsService } from '@happier-dev/cli-common/plugins/registration';
import type { JsonValue, PluginInvocationContext, PluginServices } from '@happier-dev/plugin-sdk';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '@happier-dev/plugins-channels/manifest';
import { TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { GITHUB_PLUGIN } from '@happier-dev/plugins-scm-github/manifest';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { parseActionExecuteFailure, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import {
  SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SESSION_PULL_REQUEST_LINKS_ACTION_ID_V1, SessionPullRequestBindingInputV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginInvocationActionsService, type PluginActionsHostExecutor, type PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import { projectDaemonContributedActionDefinition } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createPluginInvocationServiceBinding, createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readConversationBindingUpdateRow, readConversationConnectionUpdateRow, withConversationConnectionPayload } from '../../../../../packages/plugins/channels/src/accountLocalBindingPolicy';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_FIELD, CHANNEL_STATE_RECORD_KIND } from '../../../../../packages/plugins/channels/src/collections';
import { runConversationCheckpointedPollForInvocation } from '../../../../../packages/plugins/channels/src/ingress';
import { MemoryCollection } from '../../../../../packages/plugins/channels/src/testkit/memoryCollection';
import { activate as activateChannelsAccount } from '../../../../../packages/plugins/channels/src/accountRuntime';
import { withChannelStateSessionIdentity } from '../../../../../packages/plugins/channels/src/collectionMigrations';
import { channelsProviderDescriptorFixture } from '../../../../../packages/plugins/channels/src/testkit/operationOnlyTargetedContributionsFixture';
import { sessionPullRequestBindingFixture } from '../../../../../packages/plugins/channels/src/testkit/sessionPullRequestBindingFixture';
import { logger } from '@/ui/logger';

const boundary = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn(), rpc: vi.fn() }));
// Only authenticated HTTP and Machine RPC are replaced; Session routing and Actions stay real.
vi.mock('axios', async original => {
  const actual = await original<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get, post: boundary.post, request: boundary.request, isAxiosError: () => false } };
});
vi.mock('@/session/transport/rpc/machineRpc', async (original) => ({
  ...await original<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: boundary.rpc, callExactMachineRpc: boundary.rpc,
}));
const sessionId = 'c111111111111111111111111';
const pullRequest = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
  number: 42, title: 'Fix', url: 'https://github.com/acme/widgets/pull/42', baseBranch: 'main', headBranch: 'fix', state: 'open' };
describe('CLI session pull request binding', () => {
  beforeEach(() => {
    boundary.get.mockReset(); boundary.post.mockReset(); boundary.request.mockReset(); boundary.rpc.mockReset();
    boundary.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/v3/automations/query')) return { status: 200, data: { automations: [], nextCursor: null } };
      if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      throw new Error(`unexpected_http:${url}`);
    });
    boundary.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.includes('/v3/automations?')) return { status: 200, data: { automations: [], nextCursor: null } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadata: JSON.stringify({ machineId: 'session-machine', path: '/repo' }), metadataVersion: 1,
        agentState: null, agentStateVersion: 0 } } };
      throw new Error(`unexpected_http:${url}`);
    });
  });
  it.each([sessionId, 'different-session'] as const)('accepts only PR-link reads qualified for the requested Session: %s', async (echoSessionId) => {
    boundary.rpc.mockResolvedValue({ kind: 'links', sessionId: echoSessionId, pullRequestLinks: [{
      provider: 'github', repository: 'acme/widgets', number: 42, url: pullRequest.url,
    }] });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
      }) }),
    });
    const result = await deps.workflowAction!({ actionId: 'workflow.trigger.list', input: { lifetimeSession: { sessionId } }, context: { surface: 'cli', actionCaller: { kind: 'host' } } });
    expect(result).toMatchObject(echoSessionId === sessionId
      ? { lifetimeSession: { sessionId }, pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 42 }] }
      : { lifetimeSession: { sessionId }, sets: [], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable', diagnostic: { reason: 'channels_session_mismatch' } } });
  });
  it('lets a Session agent read retained PR links under the requester Account and refuses a foreign Session', async () => {
    const installedAccountId = 'installed-account';
    const requesterAccountId = 'requester-account';
    const foreignSessionId = 'foreign-session';
    const serverId = 'channels-link-home';
    const state = new MemoryCollection();
    for (const [id, targetSessionId, number] of [['requester-pr', sessionId, 42], ['foreign-pr', foreignSessionId, 87]] as const) {
      const row = sessionPullRequestBindingFixture(id, targetSessionId, number);
      await state.put(withChannelStateSessionIdentity(row, row.payload.target), { expectedRevision: 'absent' });
    }
    const manifest = normalizePluginManifestV2(CHANNELS_MANIFEST);
    const declaration = manifest.contributes.actions.find(action => action.id === SESSION_PULL_REQUEST_LINKS_ACTION_ID_V1);
    if (!declaration) throw new Error('Missing Channels PR links Action');
    const definition = projectDaemonContributedActionDefinition(manifest, declaration);
    const kit = await createPluginTestkit({ manifest: CHANNELS_MANIFEST,
      module: { activate: CHANNELS_PLUGIN.activate, activateAccount: activateChannelsAccount },
      services: {
        storage: { account: { collection: () => state } } as unknown as PluginServices['storage'],
        targetedContributions: channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest),
      },
    });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: installedAccountId })).toString('base64url')}.signature`;
    const targets: Array<{ accountId: string | undefined; sessionId: string | undefined }> = [];
    const reads = vi.spyOn(state, 'query');
    const { executor } = createCliActionExecutorHarness({
      token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null, serverId,
    }, {
      listContributedActionDefinitions: () => [definition],
      // Model the authenticated Home membership boundary. Both rows exist in
      // storage, so skipping Session admission exposes the foreign PR.
      resolveSessionReference: async ({ sessionId: id, context }) => {
        targets.push({ accountId: context.runtimeAccountId, sessionId: id });
        return id === sessionId && context.runtimeAccountId === requesterAccountId
          ? { kind: 'unique', address: { serverId, sessionId: id } } : { kind: 'none' };
      },
      invokeContributedAction: async ({ input, context }) => ({ ok: true, result: await kit.invokeAction(declaration.id, input, {
        surface: context.surface === 'agent' ? 'agent' : 'ui',
        accountScope: { serverId, accountId: context.runtimeAccountId ?? installedAccountId },
        sessionTargetsV1: context.sessionTargetsV1,
      }) }),
    });
    const read = (targetSessionId: string, surface: 'ui' | 'agent') => executor.execute('action.invoke', {
      action: { pluginId: manifest.id, localId: declaration.id }, input: { sessionId: targetSessionId },
    }, { surface, serverId, runtimeAccountId: requesterAccountId, defaultSessionId: sessionId,
      authority: surface === 'agent' ? 'account_automation' : 'present_user',
      actionCaller: surface === 'agent' ? { kind: 'session', sessionId, starterDepth: 0, turnDepth: 1 } : { kind: 'host' },
    });
    try {
      const expected = { ok: true, result: { kind: 'links', sessionId,
        pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 42, url: pullRequest.url }] } };
      await expect(read(sessionId, 'ui')).resolves.toEqual(expected);
      await expect(read(sessionId, 'agent')).resolves.toEqual(expected);
      await expect(read(foreignSessionId, 'agent')).resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
      expect(definition.surfaces).toMatchObject({ ui: true, agent: true, mcp: true });
      expect(targets).toEqual([sessionId, sessionId, foreignSessionId].map(id => ({ accountId: requesterAccountId, sessionId: id })));
      expect(reads.mock.calls.map(([query]) => query.prefix?.[2])).toEqual([sessionId, sessionId]);
    } finally { await kit.dispose(); }
  });
  it.each(['session_transport_absent', 'session_machine_absent', 'caller_fallback_unsupported', 'channels_result_invalid', 'channels_session_mismatch', 'channels_operation_mismatch', 'malformed_failure_envelope'] as const)(
    'retains the binding refusal reason after native PR creation: %s', async scenario => {
      const reason = scenario === 'malformed_failure_envelope' ? 'channels_result_invalid' : scenario;
      const ordinaryRead = boundary.get.getMockImplementation()!;
      if (reason === 'session_transport_absent') boundary.get.mockImplementation(async (url: string) =>
        url.endsWith(`/v2/sessions/${sessionId}`) ? { status: 404, data: { error: 'Session not found' } }
          : /\/v2\/sessions(?:\/archived)?\?/.test(url) ? { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } } : ordinaryRead(url));
      if (reason === 'session_machine_absent') boundary.get.mockImplementation(async (url: string) => !url.endsWith(`/v2/sessions/${sessionId}`) ? ordinaryRead(url) : ({ status: 200, data: { session: {
        id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode: 'plain',
        dataEncryptionKey: null, metadata: '{}', metadataVersion: 1, agentState: null, agentStateVersion: 0,
      } } }));
      boundary.rpc.mockImplementation(async ({ method }: { method: string }) => method === 'scm.pullRequest.openOrReuse'
        ? { success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } }
        : reason === 'channels_session_mismatch' ? { kind: 'links', sessionId: 'other-session', pullRequestLinks: [] }
          : reason === 'channels_operation_mismatch' ? { kind: 'links', sessionId, pullRequestLinks: [] }
            : scenario === 'malformed_failure_envelope' ? { ok: false } : { malformed: true });
      const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
      expect(await deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo' },
        context: { surface: reason === 'caller_fallback_unsupported' ? 'agent' : 'cli', defaultSessionId: sessionId,
          externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
        executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
      })).toMatchObject({ success: true, pullRequest, outcome: { kind: 'effect_applied_with_warning',
        effect: { kind: 'pull_request', number: 42, url: pullRequest.url },
        message: expect.stringContaining(reason) } });
    });
  it('lists Session triggers with unavailable PR links when the Session Machine is offline', async () => {
    boundary.rpc.mockRejectedValue(new Error('Machine offline'));
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
      }) }),
    });
    await expect(deps.workflowAction!({ actionId: 'workflow.trigger.list', input: { lifetimeSession: { sessionId } }, context: { surface: 'cli', actionCaller: { kind: 'host' } } }))
      .resolves.toMatchObject({ lifetimeSession: { sessionId }, sets: [], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } });
  });
  it.each(['created', 'reused'] as const)('links a successful %s PR on the originating Session machine', async (result) => {
    const effects: unknown[] = [];
    const nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result, nextAction: { kind: 'none' } });
    boundary.rpc.mockImplementation(async (request: { machineId: string; method: string; request: unknown }) => {
      if (request.method === 'scm.pullRequest.openOrReuse') return nativeResponse;
      if (request.method === 'action.invoke') { effects.push(request); return { kind: 'attached', bindingId: 'binding-one' }; }
      throw new Error(`unexpected_rpc:${request.method}`);
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo', base: { kind: 'branch', name: 'main' } },
      context: { surface: 'cli', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toBe(nativeResponse);
    expect(effects).toEqual([expect.objectContaining({ machineId: 'session-machine', request: expect.objectContaining({
      input: { action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }, input: { kind: 'attach', sessionId, pullRequest: { repository: 'acme/widgets', number: 42 } } },
      defaultSessionId: sessionId,
    }) })]);
    // The CLI owns native open + canonical attach, never a parallel Widget placement effect.
    expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual(['scm.pullRequest.openOrReuse', 'action.invoke']);
  });
  it.each([
    { label: 'native failure', response: { success: false, errorCode: 'COMMAND_FAILED', error: 'Native PR creation failed' } },
    { label: 'native authentication refusal', response: { success: false, errorCode: 'REMOTE_AUTH_REQUIRED', error: 'Authentication required' } },
    { label: 'unsent compose page', response: { success: true, result: 'opened_compose',
      composeUrl: 'https://github.com/acme/widgets/compare/main...fix', nextAction: { kind: 'none' } } },
  ])('preserves $label without writing a Session link or placement', async ({ response }) => {
    const nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse(response);
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
      if (method !== 'scm.pullRequest.openOrReuse') throw new Error(`Uncommitted native result must not cause ${method}`);
      return nativeResponse;
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo', base: { kind: 'branch', name: 'main' } },
      context: { surface: 'cli', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toBe(nativeResponse);
    expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual(['scm.pullRequest.openOrReuse']);
    expect(boundary.get.mock.calls.some(([url]) => url.endsWith(`/v2/sessions/${sessionId}`))).toBe(false);
  });
  it('keeps an originless successful PR out of Session binding writes', async () => {
    boundary.rpc.mockResolvedValue({ success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo' },
      context: { externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toMatchObject({ success: true });
    expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual(['scm.pullRequest.openOrReuse']);
  });
  it('surfaces failed link admission without concealing the already-created native PR', async () => {
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => method === 'action.invoke'
      ? { ok: false, errorCode: 'denied', error: 'denied' }
      : { success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo' },
      context: { defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toMatchObject({ success: true, pullRequest, outcome: { kind: 'effect_applied_with_warning',
      effect: { kind: 'pull_request', number: 42, url: pullRequest.url }, message: expect.stringContaining('denied') } });
  });

  it.each(['current', 'first poll settles', 'first poll wins the binding CAS', 'provider retired', 'connection changed', 'comments permission denied',
    'connected workflow trigger', 'unconnected workflow trigger', 'workflow attachment transport exception',
    'remove a single workflow trigger', 'preserve an originless workflow trigger binding'] as const)(
    'composes PR attachment in a Team Session with a fresh repository (%s)', async (authority) => {
    const pollWinsBindingCas = authority === 'first poll wins the binding CAS';
    const reopenAfterTriggerDeletion = authority === 'connected workflow trigger';
    const unexpectedAttachmentFailure = authority === 'workflow attachment transport exception';
    const removeSingleTrigger = authority === 'remove a single workflow trigger';
    const originless = authority === 'preserve an originless workflow trigger binding';
    const workflowTrigger = authority === 'connected workflow trigger' || authority === 'unconnected workflow trigger'
      || unexpectedAttachmentFailure || removeSingleTrigger || originless;
    const accountId = 'original-account';
    const token = workflowTrigger ? `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` : 'token';
    const ordinaryRead = boundary.get.getMockImplementation()!;
    boundary.get.mockImplementation(async (url: string) => {
      if (workflowTrigger && url.endsWith('/v1/machines/session-machine')) return { status: 200, data: { machine: {
        id: 'session-machine', kind: 'persistent', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId, displayName: 'Fixture owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      } } };
      const response = await ordinaryRead(url);
      if (url.endsWith(`/v2/sessions/${sessionId}`)) {
        const metadata = JSON.parse(response.data.session.metadata);
        response.data.session.metadata = JSON.stringify({ ...metadata, teamShareStatementV1: { v: 1, teamIds: ['team-muse'] } });
      }
      return response;
    });
    const controller = new AbortController();
    const linkedSession = { serverId: 'srv_plugin_testkit', sessionId };
    const widgetSurface = { serverId: linkedSession.serverId, accountId: 'original-account', owner: { kind: 'companion', sessionId } } as const;
    const definition = { kind: 'installed', surface: { pluginId: TRIAGE_PLUGIN.manifest.id, localId: 'session-pull-request' } } as const;
    const credentialRef = { service: { pluginId: GITHUB_PLUGIN.manifest.id, localId: 'github-account' }, accountId: '99' };
    const state = new MemoryCollection<Record<string, JsonValue>>();
    const linkRequestId = 'pr-link-request';
    const warn = vi.fn<PluginServices['logger']['warn']>();
    let providerRetired = false;
    let credentialConnected = true;
    let providerRefusal: { code: string; firstFrame: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1>['stackFrames'][number] | undefined } | undefined;
    let channelsContext: PluginInvocationContext | undefined;
    let firstPollSettled = false;
    const settleFirstPoll = async (connectionId: string) => {
      if (!channelsContext) throw new Error('Expected Channels invocation services');
      const poll = await runConversationCheckpointedPollForInvocation({ connectionId, waitMs: 0 }, channelsContext);
      expect(poll).toMatchObject({ kind: 'committed' });
      expect((await state.get(connectionId))?.value.payload).toMatchObject({
        historyGap: { reason: 'providerHistoryUnavailable' },
      });
      firstPollSettled = true;
    };
    const commitState = state.batch.bind(state);
    if (pollWinsBindingCas) {
      vi.spyOn(state, 'batch').mockImplementation(async operations => {
        const guard = operations[0];
        if (!firstPollSettled && operations.some(operation => operation.kind === 'put'
          && operation.expectedRevision === 'absent' && operation.value !== null && typeof operation.value === 'object'
          && CHANNEL_STATE_FIELD.recordKind in operation.value
          && operation.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.binding)
          && guard?.kind === 'assert' && typeof guard.rowId === 'string') {
          // Let the real first poll settle after attach read its guard, just
          // before storage evaluates the binding transaction.
          await settleFirstPoll(guard.rowId);
        }
        return commitState(operations);
      });
    }
    let instances: WidgetInstanceV1[] = [];
    let adds = 0;
    let savedRow: ReturnType<typeof AutomationDefinitionDetailSchema.parse> | undefined;
    let readWorkflowTriggers: NonNullable<ReturnType<typeof createCliActionDeps>['workflowAction']>;
    const hostBoundary: PluginActionsHostExecutor = { async execute(actionId, rawInput, context) {
      if (actionId === 'account.profile.get' || actionId === 'widgets.catalog.list'
        || actionId === 'widgets.item.list' || actionId === 'widgets.item.add') {
        expect(context?.actionCaller).toMatchObject({ kind: 'plugin', pluginId: TRIAGE_PLUGIN.manifest.id,
          sourceCustody: createManagedPluginSourceCustody(TRIAGE_PLUGIN.manifest.id) });
      }
      if (actionId === 'account.profile.get') return { ok: true, result: { id: widgetSurface.accountId, timestamp: 1,
        name: null, firstName: null, lastName: null, username: null, avatar: null } };
      if (actionId === 'session.transcript.get') {
        // Both effects happen at genuine host boundaries after the audience
        // resolved, while Channels is establishing the Session baseline.
        if (rawInput && typeof rawInput === 'object' && 'cursor' in rawInput && rawInput.cursor === 'tail') {
          if (authority === 'provider retired') providerRetired = true;
          if (authority === 'connection changed' || (authority === 'first poll settles' && !firstPollSettled)) {
            const connection = [...state.rows.values()].find(row =>
              row.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.connection);
            if (!connection) throw new Error('Expected an acknowledged fresh connection');
            if (authority === 'first poll settles') {
              await settleFirstPoll(connection.rowId);
            } else {
              const { payload } = readConversationConnectionUpdateRow({ row: connection, connectionId: connection.rowId });
              await state.put(withConversationConnectionPayload({ row: connection, payload: {
                ...payload, enabled: false,
                historyGap: { reason: 'providerHistoryUnavailable', reportedAt: Date.now() },
              } }),
                { expectedRevision: connection.revision });
            }
          }
        }
        return { ok: true, result: { ok: true, projection: 'externalShareableV1',
          sessionId, items: [], scannedThroughSeq: 0, hasMore: false } };
      }
      if (actionId === 'session.targets.resolve') return { ok: true, result: { coverage: 'complete', addresses: [linkedSession], error: null } };
      if (actionId === 'session.status.get') return { ok: true, result: { session: {
        id: sessionId, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryption: null,
      }, acceptedWorkspace: {
        checkout: { serverId: linkedSession.serverId, workspaceId: 'workspace', machineId: 'session-machine', rootPath: '/repo' },
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
      } } };
      if (actionId === 'plugins.settings.list') return { ok: true, result: { ok: true, kind: actionId,
        data: { scope: { kind: 'account' }, target: { kind: 'account' }, revision: '1', fields: [] } } };
      if (actionId === 'widgets.catalog.list') return { ok: true, result: WidgetInstanceActionOutputSchemasV1[actionId].parse({ surface: widgetSurface,
        entries: [{ definition, availability: 'available', title: 'Pull request', fields: [], instanceCount: instances.length,
          sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, presentation: { sizes: ['medium'], defaultSize: 'medium' } }],
        presentation: { sizes: ['medium'], defaultSize: 'medium' } }) };
      if (actionId === 'widgets.item.list') return { ok: true, result: WidgetInstanceActionOutputSchemasV1[actionId].parse({
        surface: widgetSurface, canEdit: true, instances: instances.map(instance => ({ instance })),
      }) };
      if (actionId === 'widgets.item.add') {
        const input = WidgetInstanceActionInputSchemasV1[actionId].parse(rawInput);
        expect(input.surface).toEqual(widgetSurface);
        instances.push(input.instance); adds++;
        return { ok: true, result: { ref: { surface: widgetSurface, instanceId: input.instance.id }, instance: input.instance } };
      }
      if (actionId === 'automation.conversation.target.verify') {
        const input = AutomationConversationActionInputSchemasV1[actionId].parse(rawInput);
        const trigger = savedRow?.triggers.find(item => item.id === input.scopedTrigger?.triggerId);
        if (!savedRow || !trigger) throw new Error('Expected a committed Automation trigger to verify');
        expect(context?.actionCaller).toMatchObject({ kind: 'plugin', pluginId: CHANNELS_MANIFEST.id });
        expect(input).toMatchObject({ automationId: savedRow.id, scopedTrigger: {
          sessionId: savedRow.scopeSessionId, triggerId: trigger.id, triggerRevision: trigger.revision,
          triggerKind: trigger.kind, pullRequest: { repository: 'acme/widgets', number: 42 },
        } });
        return { ok: true, result: { kind: 'verified' } };
      }
      if (actionId === 'workflow.trigger.list' && readWorkflowTriggers && context) {
        const result = await readWorkflowTriggers({ actionId, input: rawInput, context });
        return parseActionExecuteFailure(result) ?? { ok: true, result };
      }
      throw new Error(`Unexpected external host Action ${actionId}`);
    } };
    const http = createPluginHttpFixture({ request: async request => {
      expect(request.method === undefined || request.method === 'GET').toBe(true);
      const path = new URL(request.url).pathname;
      if (authority === 'comments permission denied' && path === '/repos/acme/widgets/issues/comments') {
        return { status: 403, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
        ) };
      }
      const body = path === '/repos/acme/widgets' ? { id: 77, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }
        : path === '/user' ? { id: 99, login: 'native-user' }
        : path === '/repos/acme/widgets/issues/comments' ? []
        : path === '/repos/acme/widgets/issues/42' ? { id: 300, number: 42, title: 'Existing PR', pull_request: {} }
        : path === '/search/users' ? { items: [{ id: 99, login: 'native-user', type: 'User' }] } : undefined;
      if (body === undefined) throw new Error(`Unexpected GitHub read ${path}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
    } });
    const declarations = [CHANNELS_MANIFEST, TRIAGE_PLUGIN.manifest, GITHUB_PLUGIN.manifest].map(manifest => ({
      manifest: normalizePluginManifestV2(manifest), occurrenceId: createPluginRuntimeOccurrenceId(manifest.id), sourceCustody: createManagedPluginSourceCustody(manifest.id),
    }));
    const targeted = createManifestTargetedContributionsService({
      readCurrentDeclarations: () => ({ declarations: providerRetired
        ? declarations.filter(row => row.manifest.id !== GITHUB_PLUGIN.manifest.id)
        : declarations }),
      subscribeToCatalogChanges: () => () => {},
    });
    const providerMaterialization = createPluginActionCallerMaterializationFixture(GITHUB_PLUGIN.manifest.id);
    const triageMaterialization = createPluginActionCallerMaterializationFixture(TRIAGE_PLUGIN.manifest.id);
    const provider = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: providerMaterialization.resolveCurrentPluginMaterializationRef,
    });
    const triage = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN });
    const actionsFor = (seed: PluginActionsServiceSeed) => createPluginInvocationActionsService({ seed: {
      ...seed, readCurrentTargetedDeclarations: async () => ({ declarations }),
    }, actionExecutor: hostBoundary,
    // Only cross-process delivery is substituted. Manifest admission, opaque handles,
    // input selection, registered handlers and target-owned parsers remain real.
    invokeContributedAction: async request => {
      await request.beforeHandlerInvocation?.();
      if (request.input === undefined) throw new Error('Expected admitted operation input');
      const materialization = request.action.pluginId === GITHUB_PLUGIN.manifest.id ? providerMaterialization : triageMaterialization;
      const result = await registry.invoke({ pluginId: request.action.pluginId, localId: request.action.localId, input: request.input,
        surface: request.surface, caller: request.caller, signal: request.signal, invocationAuthority: 'account_automation',
        initiatingActionCaller: request.initiatingActionCaller,
      });
      if (result.status === 'deferred') throw new Error('Contributed child unexpectedly requested approval');
      return result.status !== 'executed' ? result : { ...result, executionOrigin: { serverIdentityId: linkedSession.serverId,
        materializationRef: materialization.materialization } };
    } });
    const core = await createPluginTestkit({ manifest: CHANNELS_MANIFEST, module: CHANNELS_PLUGIN });
    const registry = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
      actions: declarations.flatMap(({ manifest, occurrenceId, sourceCustody }) => {
        const kit = manifest.id === CHANNELS_MANIFEST.id ? core : manifest.id === TRIAGE_PLUGIN.manifest.id ? triage : provider;
        return manifest.contributes.actions.flatMap(definition => {
          const handler = kit.registration('actions', definition.id);
          return handler ? [{ pluginId: manifest.id, pluginVersion: manifest.version, occurrenceId, sourceCustody,
            localId: definition.id, definition: { ...definition, inputSchema: definition.inputSchema ?? undefined },
            handler: async (input: JsonValue, context: PluginInvocationContext) => {
              try { return await handler(input, context); }
              catch (error) {
                const refusal = readPluginActionError(error);
                if (kit === provider && refusal && !providerRefusal) {
                  providerRefusal = { code: refusal.code, firstFrame: readUnexpectedActionErrorDiagnosticV1(error).stackFrames[0] };
                }
                throw error;
              }
            },
          }] : [];
        });
      }),
      readCurrentPluginOccurrenceId: pluginId => declarations.find(row => row.manifest.id === pluginId)?.occurrenceId ?? null,
      resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
        desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
      resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (occurrenceId, id) =>
        createPluginInvocationServiceBinding(occurrenceId, id) }),
      resolveCurrentPluginMaterializationRef: pluginId => createPluginActionCallerMaterializationFixture(pluginId).materialization,
      createServices: seed => {
        const services: PluginServices = { ...createUnavailablePluginServices(),
          actions: actionsFor(seed),
          logger: { ...createUnavailablePluginServices().logger, warn },
          targetedContributions: targeted.bind({ pluginId: seed.plugin.id, signal: seed.signal, isCurrent: seed.isOccurrenceCurrent }),
          http: { ...http, async openWebSocket() { throw new Error('No PR attach socket'); } },
          // The shared Collection and credential materializers are genuine external boundaries.
          storage: { account: { collection: (definition: { id: string }) => {
            if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error(`Unexpected Collection ${definition.id}`);
            return state;
          } } } as unknown as PluginServices['storage'],
          connectedAccounts: { getBinding: async () => ({ account: credentialRef }),
            materialize: async () => ({ kind: 'httpHeaders', headers: credentialConnected ? { authorization: 'Bearer fixture-token' } : {} }),
          } as unknown as PluginServices['connectedAccounts'],
          settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
            get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
            set: async () => { throw new Error('No Settings writes'); }, reset: async () => { throw new Error('No Settings writes'); } }) },
        };
        if ((authority === 'first poll settles' || pollWinsBindingCas) && seed.plugin.id === CHANNELS_MANIFEST.id
          && seed.contribution.id === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1) {
          // Place the background poll on the same Machine as the provider fixture.
          channelsContext = { ...seed, invokedAtMs: Date.now(), services: { ...services, actions: { ...services.actions,
            getCurrentExecutionRouting: async () => ({ serverIdentityId: linkedSession.serverId,
              machineId: providerMaterialization.materialization.machineId, pluginId: CHANNELS_MANIFEST.id }),
          } } };
        }
        return services;
      },
    });
    const invokeCore = async (localId: string, input: JsonValue) => {
      const exactDetach = localId === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1
        && input && typeof input === 'object' && 'kind' in input && input.kind === 'removeTrigger' && 'automationId' in input;
      const result = await registry.invoke({ pluginId: CHANNELS_MANIFEST.id, localId, input, surface: 'cli',
        invocationAuthority: 'present_user', signal: controller.signal, requestId: linkRequestId,
        requestCurrentIntent: async ({ fingerprint }) => {
          if (exactDetach) throw new Error('A committed trigger deletion must not ask again to detach its own binding');
          return { status: 'approved', fingerprint };
        } });
      if (result.status === 'deferred') throw new Error(`deferred:${result.artifactId}`);
      if (result.status !== 'executed') return projectContributedActionFailure({
        errorCode: result.code, error: result.message, data: result.data,
      });
      return result.value;
    };
    let nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    let attaches = 0;
    boundary.rpc.mockImplementation(async ({ machineId, method, request }: { machineId: string; method: string; request: unknown }) => {
      if (method === 'scm.pullRequest.openOrReuse') return nativeResponse;
      if (method !== 'action.invoke') throw new Error(`Unexpected Machine RPC ${method}`);
      if (workflowTrigger) throw new Error('Machine RPC unavailable in the Account executor fixture');
      expect(machineId).toBe('session-machine');
      const transport = TargetedActionRpcRequestV1Schema.parse(request);
      expect(transport.defaultSessionId).toBe(sessionId);
      const admitted = getActionSpec('action.invoke').inputSchema.parse(transport.input);
      if (!admitted || typeof admitted !== 'object' || !('input' in admitted)) throw new Error('Expected a contributed Action envelope');
      expect(admitted).toMatchObject({ action: { pluginId: CHANNELS_MANIFEST.id, localId: 'session-pull-request-binding-v1' } });
      const input = SessionPullRequestBindingInputV1Schema.parse(admitted.input);
      if (input.kind !== 'attach') throw new Error('Native open must perform an explicit attach');
      attaches++;
      return invokeCore('session-pull-request-binding-v1', input);
    });
    const hostParams = { token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    } satisfies Parameters<typeof createCliActionDeps>[0];
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const deps = workflowTrigger ? createCliActionExecutorHarness(hostParams, {
      invokeContributedAction: async function dispatchAfterCommittedSave({ action, input, context }) {
        expect(action).toEqual({ pluginId: CHANNELS_MANIFEST.id, localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 });
        const binding = SessionPullRequestBindingInputV1Schema.parse(input);
        if (reopenAfterTriggerDeletion && binding.kind === 'attach' && binding.target === undefined) {
          const result = await invokeCore(action.localId, binding);
          return parseActionExecuteFailure(result) ?? { ok: true as const, result };
        }
        expect(context).toMatchObject({ surface: 'cli', actionCaller: { kind: 'host' }, defaultSessionId: sessionId, actionRequestId: linkRequestId });
        if (binding.kind === 'list') return { ok: true, result: await invokeCore(action.localId, binding) };
        if (binding.kind === 'attach') {
          expect(binding).toMatchObject({ target: {
            automationId: savedRow?.id, triggerId: savedRow?.triggers[0]?.id, triggerRevision: 0, triggerKind: 'prComment',
          } });
          expect(savedRow).toBeDefined();
          expect(binding).not.toHaveProperty('credentialRef');
          if (unexpectedAttachmentFailure) throw new Error('Attachment transport failed with Bearer fixture-secret_123+/=');
          if (originless && 'target' in binding && binding.target) {
            const { origin: _origin, ...target } = binding.target;
            expect(await invokeCore(action.localId, { ...binding, target })).toMatchObject({ kind: 'attached' });
          }
          attaches++;
        }
        const result = await invokeCore(action.localId, binding);
        return parseActionExecuteFailure(result) ?? { ok: true as const, result };
      },
    }).deps : createCliActionDeps(hostParams);
    readWorkflowTriggers = deps.workflowAction!;
    const open = () => deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo', base: { kind: 'branch', name: 'main' } },
      context: { surface: 'cli', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    });
    try {
      if (workflowTrigger) {
        const qualified = { kind: 'attach', sessionId, pullRequest: { repository: 'acme/widgets', number: 42 },
          credentialRef, expectedRepositoryId: '77' } as const;
        if (!reopenAfterTriggerDeletion) {
          const explicitlyAttached = await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, qualified);
          expect(explicitlyAttached).toMatchObject({ kind: 'attached', bindingId: expect.any(String) });
        }

        const ordinaryPost = boundary.post.getMockImplementation()!;
        boundary.post.mockImplementation(async (url: string, input: unknown) => {
          if (url.endsWith('/v3/automations/query')) {
            expect(input).toMatchObject({ scopeSessionId: sessionId, details: true });
            return { status: 200, data: { automations: savedRow ? [structuredClone(savedRow)] : [], nextCursor: null } };
          }
          return ordinaryPost(url, input);
        });
        boundary.request.mockImplementation(async ({ url, method, data }: { url: string; method: string; data: unknown }) => {
          if (method === 'GET' && savedRow && url.endsWith(`/v3/automations/${savedRow.id}`)) {
            return { status: 200, data: structuredClone(savedRow) };
          }
          if (method === 'DELETE' && savedRow && url.endsWith(`/v3/automations/${savedRow.id}`)) {
            savedRow = undefined;
            return { status: 200, data: { ok: true, removedRevision: 1 } };
          }
          if (method === 'PUT' && savedRow && url.endsWith(`/v3/automations/${savedRow.id}`)) {
            const removal = AutomationDefinitionReconcileRequestSchema.parse(data);
            expect(removal.removedTriggers).toEqual([{ triggerId: savedRow.triggers[0]?.id, expectedRevision: 0 }]);
            expect(removal.triggers).toMatchObject(savedRow.triggers.slice(1).map(item => ({ triggerId: item.id })));
            savedRow = { ...savedRow, triggers: savedRow.triggers.filter(item =>
              !removal.removedTriggers.some(removed => removed.triggerId === item.id)), templateVersion: 2 };
            return { status: 200, data: structuredClone(savedRow) };
          }
          if (method !== 'POST' || !url.endsWith('/v3/automations') || savedRow) throw new Error('Unexpected Automation request');
          const input = AutomationDefinitionCreateRequestSchema.parse(data);
          savedRow = AutomationDefinitionDetailSchema.parse({
            id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
            targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
            workflowDefinitionId: null, scopeSessionId: sessionId, executionRecipe: input.executionRecipe,
            assignments: input.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
              priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [],
            triggers: input.triggers.map(({ triggerId, trigger }) => {
              if (trigger.kind !== 'prComment') throw new Error('Expected a PR comment trigger');
              // Home stores a scope-bound envelope even for plaintext PR selectors.
              const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: input.automationId, triggerId, triggerRevision: 0, triggerKind: trigger.kind },
                  definition: { kind: trigger.kind, pullRequest: trigger.pullRequest },
                });
              return { kind: trigger.kind, enabled: trigger.enabled, id: triggerId, revision: 0,
                createdAt: 1, updatedAt: 1, sourceSessionId: input.scopeSessionId, triggerDefinitionEnvelope: JSON.stringify(envelope) };
            }),
          });
          return { status: 200, data: structuredClone(savedRow) };
        });
        credentialConnected = authority !== 'unconnected workflow trigger';
        const receipt = await deps.workflowAction!({
          actionId: 'workflow.trigger.add',
          input: { lifetimeSession: { sessionId }, project: { machineId: 'session-machine', directory: '/repo' },
            target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'notify',
              actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Ready' } } }] } },
            trigger: { kind: 'prComment', enabled: true, pullRequest: qualified.pullRequest } },
          context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: linkRequestId },
        });
        expect(receipt).toMatchObject({ set: { revision: 1 }, triggerRevision: 0 });
        if (!savedRow) throw new Error('Expected a committed Automation');
        const saved = await getAutomationDefinition({ token, automationId: savedRow.id });
        expect(saved).toMatchObject({ templateVersion: 1, triggers: [{ kind: 'prComment', revision: 0 }] });
        expect(saved?.triggers).toHaveLength(1);
        expect(receipt).toMatchObject({ set: { automationId: savedRow.id, revision: 1 },
          triggerId: saved?.triggers[0]?.id, triggerRevision: 0 });
        const readBindings = () => [...state.rows.values()].flatMap(row => {
          const bindingId = row.value[CHANNEL_STATE_FIELD.bindingId];
          if (row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.binding || typeof bindingId !== 'string') return [];
          const { binding } = readConversationBindingUpdateRow({ row, bindingId });
          return [binding];
        });
        const scopedBindings = readBindings().flatMap(({ target }) => target.kind === 'automation' ? [target] : []);
        expect(scopedBindings).toEqual(credentialConnected && !unexpectedAttachmentFailure
          ? [expect.objectContaining({ automationId: savedRow.id, scopedTrigger: expect.objectContaining({
            sessionId, triggerId: saved?.triggers[0]?.id, triggerRevision: 0,
          }) })] : []);
        if (unexpectedAttachmentFailure) {
          expect(receipt).toMatchObject({ postWriteFailure: { ok: false, errorCode: 'action_failed', error: 'action_failed',
            failureCause: { phase: 'workflow.trigger.pr_binding', errorClass: 'Error', errorCode: null, httpStatus: null } } });
          expect(JSON.stringify(receipt)).not.toContain('Attachment transport failed');
          expect(diagnostic).toHaveBeenCalledWith('Workflow PR binding attachment exception', expect.objectContaining({
            requestId: linkRequestId, message: 'Attachment transport failed with Bearer [REDACTED]',
            topFrame: expect.stringContaining('dispatchAfterCommittedSave'),
          }));
          expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('fixture-secret');
        } else if (credentialConnected) {
          expect(receipt).not.toHaveProperty('postWriteFailure');
          expect(attaches).toBe(1);
          const automationId = savedRow.id;
          const triggerId = savedRow.triggers[0]!.id;
          const cleanup = { kind: 'removeTrigger', sessionId, automationId } as const;
          const siblingId = 'retained-sibling-trigger';
          if (removeSingleTrigger) {
            // A second saved PR trigger in the same set must survive removing the first.
            const sibling = { ...savedRow.triggers[0], id: siblingId,
              triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId, triggerId: siblingId, triggerRevision: 0, triggerKind: 'prComment' },
                definition: { kind: 'prComment', pullRequest: qualified.pullRequest },
              })) };
            savedRow = AutomationDefinitionDetailSchema.parse({ ...savedRow, triggers: [...savedRow.triggers, sibling] });
            expect(await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, { ...qualified, target: {
              automationId, triggerId: siblingId, triggerRevision: 0, triggerKind: 'prComment', origin: 'automatic',
            } })).toMatchObject({ kind: 'attached' });
          }
          const before = readBindings();
          expect(before).toContainEqual(expect.objectContaining({ enabled: true, deletionState: 'none',
            target: expect.objectContaining({ kind: 'automation', automationId: savedRow.id }) }));
          if (!removeSingleTrigger && !originless) {
            for (const input of [cleanup, { ...cleanup, triggerId }]) {
              expect(await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, input)).toEqual({ kind: 'removed' });
              expect(readBindings()).toEqual(before);
            }
          }
          const removal = await deps.workflowAction!({
            actionId: 'workflow.trigger.remove', input: { automationId, ...(removeSingleTrigger ? { triggerId } : {}) },
            context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: linkRequestId },
          });
          if (removeSingleTrigger) {
            expect(savedRow?.triggers.map(item => item.id)).toEqual([siblingId]);
            expect(removal).toMatchObject({ set: { automationId, revision: 2, triggers: [{ id: siblingId }] } });
            expect(removal).not.toHaveProperty('postWriteFailure');
            expect(await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, cleanup)).toEqual({ kind: 'removed' });
          } else {
            expect(savedRow).toBeUndefined();
            expect(removal).toEqual({ automationId, deleted: true, removedRevision: 1 });
          }
          const after = readBindings();
          expect(after.filter(binding => binding.target.kind === 'session'))
            .toEqual(before.filter(binding => binding.target.kind === 'session'));
          expect(after.filter(binding => binding.target.kind === 'automation')).toEqual([
            expect.objectContaining({ enabled: originless, deletionState: 'none',
              target: expect.objectContaining({ kind: 'automation', automationId, scopedTrigger: expect.objectContaining({ triggerId }) }) }),
            ...(removeSingleTrigger ? [expect.objectContaining({ enabled: true, deletionState: 'none',
              target: expect.objectContaining({ kind: 'automation', automationId, scopedTrigger: expect.objectContaining({ triggerId: siblingId }) }) })] : []),
          ]);
          if (reopenAfterTriggerDeletion) {
            nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result: 'reused', nextAction: { kind: 'none' } });
            expect(await open()).toBe(nativeResponse);
            expect(await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, { kind: 'list', sessionId })).toMatchObject({
              kind: 'links', pullRequestLinks: [expect.objectContaining({ number: 42 })],
            });
            expect(await invokeCore('session-pull-request-watch-v1', { kind: 'get', sessionId })).toMatchObject({
              kind: 'ready', bindings: expect.arrayContaining([expect.objectContaining({ link: expect.objectContaining({ number: 42 }) })]),
            });
            const reopened = readBindings();
            expect(reopened).toHaveLength(2);
            expect(reopened.filter(binding => binding.target.kind === 'automation')).toEqual(after);
            expect(reopened.filter(binding => binding.target.kind === 'session')).toHaveLength(1);
            expect(await open()).toBe(nativeResponse);
            expect(readBindings()).toEqual(reopened);
          }
        } else {
          expect(receipt).toMatchObject({ postWriteFailure: { ok: false, errorCode: 'github_credential_unavailable' } });
          expect(providerRefusal).toMatchObject({ code: 'github_credential_unavailable',
            firstFrame: { file: expect.stringMatching(/githubApiClient[.]ts$/u) } });
          expect(await invokeCore(SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, qualified))
            .toMatchObject({ ok: false, errorCode: 'github_credential_unavailable' });
        }
        return;
      }
      if (authority !== 'current' && authority !== 'first poll settles' && !pollWinsBindingCas) {
        const cause = authority === 'provider retired' ? 'channels_pr_link_provider_not_ready' : 'channels_pr_link_connection_not_ready';
        expect(await open()).toMatchObject({ success: true, pullRequest, result: 'created',
          outcome: { kind: 'effect_applied_with_warning',
            effect: { kind: 'pull_request', number: 42, url: pullRequest.url },
            message: authority === 'comments permission denied'
              ? expect.stringMatching(new RegExp(`access to read repository comments.*${cause}.*${linkRequestId}`))
              : expect.stringContaining(cause) } });
        if (authority === 'comments permission denied') {
          expect(warn.mock.calls.filter(([, details]) => details?.code === cause)).toEqual([
            [expect.any(String), expect.objectContaining({ code: cause, requestId: linkRequestId, reason: 'permissionMissing' })],
          ]);
          expect(state.rows.size).toBe(0);
        }
        expect(await invokeCore('session-pull-request-binding-v1', { kind: 'list', sessionId }))
          .toEqual({ kind: 'links', sessionId, pullRequestLinks: [] });
        expect(adds).toBe(0);
        return;
      }
      expect(await open()).toBe(nativeResponse);
      if (authority === 'first poll settles' || pollWinsBindingCas) expect(firstPollSettled).toBe(true);
      expect(adds).toBe(1); expect(attaches).toBe(1);
      expect(instances[0]?.bindings.session).toEqual({ kind: 'value', value: linkedSession });
      nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result: 'reused', nextAction: { kind: 'none' } });
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(1); expect(attaches).toBe(2);
      expect([...state.rows.values()].filter(row => !row.deleted
        && row.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.binding)).toHaveLength(1);
      instances = []; // The person removed the widget at the external placement owner.
      expect(await invokeCore('session-pull-request-binding-v1', { kind: 'list', sessionId })).toMatchObject({ kind: 'links' });
      expect(await invokeCore('session-pull-request-watch-v1', { kind: 'get', sessionId })).toMatchObject({ kind: 'ready' });
      expect(adds).toBe(1); expect(instances).toEqual([]);
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(2); expect(attaches).toBe(3);
      nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: false, errorCode: 'COMMAND_FAILED', error: 'Native open refused' });
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(2); expect(attaches).toBe(3);
    } finally { diagnostic.mockRestore(); controller.abort(); registry.dispose(); await core.dispose(); await triage.dispose(); await provider.dispose(); }
  });
});
