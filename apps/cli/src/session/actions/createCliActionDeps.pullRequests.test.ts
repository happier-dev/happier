import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliActionDeps } from './createCliActionDeps';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createManifestTargetedContributionsService } from '@happier-dev/cli-common/plugins/registration';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '@happier-dev/plugins-channels/manifest';
import { TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { GITHUB_PLUGIN } from '@happier-dev/plugins-scm-github/manifest';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { SessionPullRequestBindingInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginInvocationActionsService, type PluginActionsHostExecutor, type PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createPluginInvocationServiceBinding, createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_FIELD, CHANNEL_STATE_FIXED_ROW_ID, CHANNEL_STATE_RECORD_KIND } from '../../../../../packages/plugins/channels/src/collections';
import { MemoryCollection } from '../../../../../packages/plugins/channels/src/testkit/memoryCollection';

const boundary = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), rpc: vi.fn() }));
// Only authenticated HTTP and Machine RPC are replaced; Session routing and Actions stay real.
vi.mock('axios', async original => {
  const actual = await original<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get, post: boundary.post, isAxiosError: () => false } };
});
vi.mock('@/session/transport/rpc/machineRpc', async (original) => ({
  ...await original<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: boundary.rpc, callExactMachineRpc: boundary.rpc,
}));
const sessionId = 'c111111111111111111111111';
const pullRequest = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
  number: 42, title: 'Fix', url: 'https://github.com/acme/widgets/pull/42', baseBranch: 'main', headBranch: 'fix', state: 'open' };
describe('CLI session pull request binding', () => {
  beforeEach(() => {
    boundary.get.mockReset(); boundary.post.mockReset(); boundary.rpc.mockReset();
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
      })).toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { scmEffectCommitted: true,
        code: 'target_unavailable', diagnostic: { reason } } });
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
    })).resolves.toMatchObject({ ok: false, errorCode: 'denied', details: { scmEffectCommitted: true, pullRequest: { number: 42 } } });
  });

  it('composes native open and explicit rejoin through registered Channels and Triage without refresh placement', async () => {
    const controller = new AbortController();
    const linkedSession = { serverId: 'srv_plugin_testkit', sessionId };
    const widgetSurface = { serverId: linkedSession.serverId, accountId: 'original-account', owner: { kind: 'companion', sessionId } } as const;
    const definition = { kind: 'installed', surface: { pluginId: TRIAGE_PLUGIN.manifest.id, localId: 'session-pull-request' } } as const;
    const credentialRef = { service: { pluginId: GITHUB_PLUGIN.manifest.id, localId: 'github-account' }, accountId: '99' };
    const state = new MemoryCollection<Record<string, JsonValue>>();
    await state.put({ id: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey, v: 1,
      payload: { connectionIdentityKey: 'A'.repeat(43) } }, { expectedRevision: 'absent' });
    let instances: WidgetInstanceV1[] = [];
    let adds = 0;
    const hostBoundary: PluginActionsHostExecutor = { async execute(actionId, rawInput, context) {
      if (actionId === 'account.profile.get' || actionId === 'widgets.catalog.list'
        || actionId === 'widgets.item.list' || actionId === 'widgets.item.add') {
        expect(context?.actionCaller).toMatchObject({ kind: 'plugin', pluginId: TRIAGE_PLUGIN.manifest.id,
          sourceCustody: createManagedPluginSourceCustody(TRIAGE_PLUGIN.manifest.id) });
      }
      if (actionId === 'account.profile.get') return { ok: true, result: { id: widgetSurface.accountId, timestamp: 1,
        name: null, firstName: null, lastName: null, username: null, avatar: null } };
      if (actionId === 'session.transcript.get') return { ok: true, result: { ok: true, projection: 'externalShareableV1',
        sessionId, items: [], scannedThroughSeq: 0, hasMore: false } };
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
      throw new Error(`Unexpected external host Action ${actionId}`);
    } };
    const http = createPluginHttpFixture({ request: async request => {
      expect(request.method === undefined || request.method === 'GET').toBe(true);
      const path = new URL(request.url).pathname;
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
    const targeted = createManifestTargetedContributionsService({ readCurrentDeclarations: () => ({ declarations }), subscribeToCatalogChanges: () => () => {} });
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
            localId: definition.id, definition: { ...definition, inputSchema: definition.inputSchema ?? undefined }, handler }] : [];
        });
      }),
      readCurrentPluginOccurrenceId: pluginId => declarations.find(row => row.manifest.id === pluginId)?.occurrenceId ?? null,
      resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
        desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
      resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (occurrenceId, id) =>
        createPluginInvocationServiceBinding(occurrenceId, id) }),
      resolveCurrentPluginMaterializationRef: pluginId => createPluginActionCallerMaterializationFixture(pluginId).materialization,
      createServices: seed => ({ ...createUnavailablePluginServices(),
        actions: actionsFor(seed),
        targetedContributions: targeted.bind({ pluginId: seed.plugin.id, signal: seed.signal, isCurrent: seed.isOccurrenceCurrent }),
        http: { ...http, async openWebSocket() { throw new Error('No PR attach socket'); } },
        // The shared Collection and credential materializers are genuine external boundaries.
        storage: { account: { collection: (definition: { id: string }) => {
          if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error(`Unexpected Collection ${definition.id}`);
          return state;
        } } } as unknown as PluginServices['storage'],
        connectedAccounts: { getBinding: async () => ({ account: credentialRef }),
          materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } }) } as unknown as PluginServices['connectedAccounts'],
        settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
          get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
          set: async () => { throw new Error('No Settings writes'); }, reset: async () => { throw new Error('No Settings writes'); } }) },
      }),
    });
    const invokeCore = async (localId: string, input: JsonValue) => {
      const result = await registry.invoke({ pluginId: CHANNELS_MANIFEST.id, localId, input, surface: 'cli',
        invocationAuthority: 'present_user', signal: controller.signal,
        requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }) });
      if (result.status !== 'executed') throw new Error(result.status === 'deferred'
        ? `deferred:${result.artifactId}` : `${result.status}:${result.code}`);
      return result.value;
    };
    let nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    let attaches = 0;
    boundary.rpc.mockImplementation(async ({ machineId, method, request }: { machineId: string; method: string; request: unknown }) => {
      if (method === 'scm.pullRequest.openOrReuse') return nativeResponse;
      if (method !== 'action.invoke') throw new Error(`Unexpected Machine RPC ${method}`);
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
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }),
    });
    const open = () => deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo', base: { kind: 'branch', name: 'main' } },
      context: { surface: 'cli', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    });
    try {
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(1); expect(attaches).toBe(1);
      expect(instances[0]?.bindings.session).toEqual({ kind: 'value', value: linkedSession });
      nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, result: 'reused', nextAction: { kind: 'none' } });
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(1); expect(attaches).toBe(2);
      instances = []; // The person removed the widget at the external placement owner.
      expect(await invokeCore('session-pull-request-binding-v1', { kind: 'list', sessionId })).toMatchObject({ kind: 'links' });
      expect(await invokeCore('session-pull-request-watch-v1', { kind: 'get', sessionId })).toMatchObject({ kind: 'ready' });
      expect(adds).toBe(1); expect(instances).toEqual([]);
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(2); expect(attaches).toBe(3);
      nativeResponse = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: false, errorCode: 'COMMAND_FAILED', error: 'Native open refused' });
      expect(await open()).toBe(nativeResponse);
      expect(adds).toBe(2); expect(attaches).toBe(3);
    } finally { controller.abort(); registry.dispose(); await core.dispose(); await triage.dispose(); await provider.dispose(); }
  });
});
