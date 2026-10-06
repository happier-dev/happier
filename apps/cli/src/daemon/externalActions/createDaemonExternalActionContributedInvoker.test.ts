import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import tweetnacl from 'tweetnacl';

const externalActionTargetResolverMocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: externalActionTargetResolverMocks.fetchSessionById,
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: externalActionTargetResolverMocks.fetchAccountMachineReplacements,
}));

import {
  API_TOKEN_FULL_GRANT_V1,
  ApiTokenGrantV1Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  StrictJsonValueSchema,
  TargetActionApprovalRequestV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowRunStartRequestV1Schema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  type ApprovalExecutionOriginV1,
  type PluginMachineExecutionOriginV1,
  type TargetActionApprovalReplayPlacementV1,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';
import {
  createActionExecutor,
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
  type ActionExecutorDeps,
  createWorkflowAccountRunActionOwner,
  type WorkflowAccountRunActionDeps,
} from '@happier-dev/protocol/actions';
import type {
  JsonValue,
  PluginInvocationContext,
} from '@happier-dev/plugin-sdk';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import {
  createResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  buildPluginContributionRegistry,
} from '@/plugins/projection/registry/normalize/package';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import {
  createTargetActionHostBindingResolver,
  createTargetActionHostPolicyResolver,
} from '@/plugins/runtime/hostAccess/resolve';
import type { TargetActionCurrentIntentRequest } from '@/plugins/runtime/invocation/actionExecutor';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import {
  buildTargetActionInvocationRegistry,
} from '@/plugins/runtime/invocation/buildTargetActionRegistry';
import {
  createUnavailablePluginServicesFactory,
} from '@/plugins/runtime/invocation/services/factory';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import {
  createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { encodeBase64 } from '@/api/encryption';
import type { PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';

import {
  createDaemonExternalActionContributedApprovalReplay,
  createDaemonExternalActionContributedDefinitionLister,
  createDaemonExternalActionContributedInvoker,
} from './createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

const EXTERNAL_ACTION_ENCRYPTION_KEY = new Uint8Array(32).fill(7);

function createApiActionApprovalOrigin(defaultSessionId?: string): ApprovalExecutionOriginV1 {
  return {
    v: 1,
    authority: 'account_automation',
    surface: 'api',
    caller: { kind: 'host' },
    serverId: 'server-external',
    accountId: 'account-1',
    principalId: 'principal-1',
    credentialId: '11111111-1111-4111-8111-111111111111',
    machineId: 'machine-local',
    ...(defaultSessionId ? { sessionId: defaultSessionId } : {}),
    target: { kind: 'machine', machineId: 'machine-local' },
    actionId: 'action.invoke',
    requestId: 'request-1',
  };
}

function createExternalActionRuntime(
  scope: 'global' | 'session' = 'session',
  pluginId = 'acme.external',
  onActionInvocation?: (context: PluginInvocationContext) => void | Promise<void>,
  resolveCurrentPluginExecutionOrigin?: (
    pluginId: string,
  ) => PluginMachineExecutionOriginV1 | null,
  resolveCurrentPluginApprovalReplayPlacement?: (
    pluginId: string,
  ) => TargetActionApprovalReplayPlacementV1 | null,
  onServicesSeed?: (seed: PluginActionsServiceSeed) => void,
  serviceOwners?: Pick<ReturnType<typeof createProductionPluginInvocationServiceOwners>, 'createServices' | 'resolveHostBinding'>,
  dangerLevel: 'safe' | 'writesRemote' = 'safe',
  activationOnly?: () => void,
): ResolvedExecutablePluginRuntimeRegistry {
  const plugin = {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'External Action Fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      contributes: {
        actions: [{
          id: 'inspect',
          title: 'Inspect',
          scopes: [scope],
          // `api` deliberately is not an author-visible Action surface.
          surfaces: ['cli'],
          execution: { target: 'daemon' },
          dangerLevel,
          ...(dangerLevel === 'safe' ? {} : { confirmation: { title: 'Write', body: 'Write provider state?', confirmLabel: 'Write' } }),
        }],
      },
    }),
  } satisfies LoadedPlugin;
  const normalizedAction = buildPluginContributionRegistry({
    loadedPlugins: [plugin],
  }).actions[0];
  if (!normalizedAction) throw new Error('Expected normalized external Action contribution');
  const resolvedAction: ResolvedActionContribution = {
    provenance: 'external',
    source: { kind: normalizedAction.sourceSpec.kind },
    pluginId: normalizedAction.pluginId,
    pluginVersion: normalizedAction.pluginVersion,
    identity: normalizedAction.identity,
    pluginRootPath: normalizedAction.pluginRootPath,
    manifestPath: normalizedAction.manifestPath,
    daemonEntryPath: normalizedAction.daemonEntryPath,
    devDaemonEntryPath: normalizedAction.devDaemonEntryPath,
    sourceSpec: normalizedAction.sourceSpec,
    localizedPresentation: normalizedAction.localizedPresentation,
    definition: normalizedAction.definition,
  };
  const contributes = createResolvedContributionRegistry({
    actions: [resolvedAction],
    activationTargets: [{
      provenance: 'external',
      source: { kind: normalizedAction.sourceSpec.kind },
      pluginId,
      manifestPath: normalizedAction.manifestPath,
      daemonEntryPath: normalizedAction.daemonEntryPath,
      devDaemonEntryPath: normalizedAction.devDaemonEntryPath,
      sourceSpec: normalizedAction.sourceSpec,
      manifest: plugin.manifest,
    }],
  });
  const actionRegistryKey = buildQualifiedPluginContributionKey(
    createPluginContributionIdentity({ pluginId, localId: 'inspect' }),
  );
  expect(actionRegistryKey).toBe(`${pluginId}/inspect`);
  const actionsById = contributes.actionsById;
  if (!actionsById) throw new Error('Expected indexed external Action contributions');
  const registeredAction = actionsById.get(actionRegistryKey);
  if (!registeredAction) throw new Error('Expected parsed external Action contribution');
  const sourceCustody = pluginId === 'happier.channels'
    ? {
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli-root' },
    } as const
    : pluginId === 'acme.managed'
      ? { kind: 'managed', immutableGenerationId: 'fixture-immutable-generation', installSource: 'localPath' } as const
    : { kind: 'development', registeredRootId: `fixture-root:${pluginId}` } as const;
  const fixtureOccurrenceId = createPluginRuntimeOccurrenceId(pluginId);
  const targetActionInvocations = buildTargetActionInvocationRegistry({
    contributes,
    targetRegistrations: activationOnly ? [] : [{
      pluginId,
      occurrenceId: fixtureOccurrenceId,
      registration: {
        family: 'actions',
        localId: registeredAction.definition.id,
        value: async (_input: JsonValue, context: PluginInvocationContext) => {
          await onActionInvocation?.(context);
          return {
            surface: context.surface,
            caller: context.caller?.kind ?? null,
            sessionId: context.session?.id ?? null,
          };
        },
      },
    }],
    readCurrentPluginOccurrenceId: (currentPluginId) => (
      currentPluginId === pluginId ? fixtureOccurrenceId : null
    ),
    readCurrentPluginSourceCustody: (currentPluginId) => (
      currentPluginId === pluginId ? sourceCustody : null
    ),
    readTargetActivationFacts: () => activationOnly ? [] : [{
      pluginId,
      pluginVersion: '1.0.0',
      source: 'localPath',
      occurrenceId: fixtureOccurrenceId,
      host: 'daemon',
      platform: 'darwin',
      occurredAtMs: 1,
      status: 'active',
      required: [{ family: 'actions', localId: registeredAction.definition.id }],
      bound: [{ family: 'actions', localId: registeredAction.definition.id }],
      diagnostics: [],
    }],
    resolveAuthorizationFacts: (resolvedAction) => ({
      generation: {
        targetGeneration: resolvedAction.occurrenceId,
        desiredGeneration: resolvedAction.occurrenceId,
        appliedGeneration: resolvedAction.occurrenceId,
      },
      resourceSelections: [],
      scopedGrants: [],
      operatingSystemAuthorization: [],
    }),
    resolveHostBinding: serviceOwners?.resolveHostBinding ?? createTargetActionHostBindingResolver(),
    resolveHostPolicy: createTargetActionHostPolicyResolver(),
    createServices: (seed, binding) => {
      onServicesSeed?.(seed);
      return (serviceOwners?.createServices ?? createUnavailablePluginServicesFactory())(seed, binding);
    },
  });

  const runtime = {
    contributes,
    generation: 1,
    targetActionInvocations,
    resolveCurrentPluginExecutionOrigin: async (currentPluginId) => (
      resolveCurrentPluginExecutionOrigin
        ? resolveCurrentPluginExecutionOrigin(currentPluginId)
        : {
        serverIdentityId: 'server-external',
        materializationRef: {
          pluginId: currentPluginId,
          machineId: 'machine-local',
          materializationId: 'fixture-materialization',
        },
      }
    ),
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {},
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => { activationOnly?.(); return []; },
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    resolveCaptureSource: unexpectedCaptureSourceResolution,
    resolvePromptAssetBlocks: async () => [],
    retireConsumers: () => {},
    retainPluginActivationComponent: () => null,
    retainPreparedActivationRegistryComponents: () => [],
    dispose: async () => {},
  } satisfies ResolvedExecutablePluginRuntimeRegistry;
  return Object.assign(runtime, {
    resolveCurrentPluginApprovalReplayPlacement: async (currentPluginId: string) => (
      resolveCurrentPluginApprovalReplayPlacement
        ? resolveCurrentPluginApprovalReplayPlacement(currentPluginId)
        : {
          serverId: 'server-external',
          machineId: 'machine-local',
        }
    ),
  });
}

function createExternalActionExecutor(
  invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>,
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'],
) {
  return createActionExecutor({
    invokeContributedAction,
    ...(listContributedActionDefinitions ? { listContributedActionDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions) } : {}),
    isActionApprovalRequired: () => false,
  } as unknown as ActionExecutorDeps);
}

function createCanonicalSessionTargetResolver(params: Readonly<{
  machineId?: string;
  host?: string;
  homeDir?: string;
}> = {}) {
  const machineId = params.machineId ?? 'machine-local';
  const host = params.host ?? 'host-local';
  const homeDir = params.homeDir ?? '/home/local';
  externalActionTargetResolverMocks.fetchSessionById.mockReset();
  externalActionTargetResolverMocks.fetchAccountMachineReplacements.mockReset();
  externalActionTargetResolverMocks.fetchAccountMachineReplacements.mockResolvedValue([]);
  externalActionTargetResolverMocks.fetchSessionById.mockResolvedValue({
    id: 'session-verified',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadataVersion: 1,
    dataEncryptionKey: null,
    machineId: 'stale-raw-machine-id',
    encryptionMode: 'e2ee',
    metadata: encryptSessionPayload({
      ctx: {
        encryptionKey: EXTERNAL_ACTION_ENCRYPTION_KEY,
        encryptionVariant: 'legacy',
      },
      payload: {
        machineId,
        host,
        homeDir,
      },
    }),
  });
  return createDaemonExternalActionTargetResolver({
    credentials: {
      token: 'daemon-token',
      encryption: { type: 'legacy', secret: EXTERNAL_ACTION_ENCRYPTION_KEY },
    },
    currentMachineHost: 'host-local',
    currentMachineHomeDir: '/home/local',
  });
}

function createExternalActionIngressExecutor(scope: 'global' | 'session' = 'session') {
  const runtime = createExternalActionRuntime(scope);
  const lease: PluginRuntimeRegistryLease = {
    registry: runtime,
    source: 'ephemeral',
    durableRevision: runtime.durableRevision ?? -1,
    release: async () => {},
  };
  return createExternalActionExecutor(
    createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }),
    createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => lease,
    }),
  );
}

describe('createDaemonExternalActionContributedInvoker', () => {
  it('allows a source read but rejects writes under the same current read-only invocation lease', async () => {
    for (const dangerLevel of ['safe', 'writesRemote'] as const) {
      let invoked = false;
      const runtime = createExternalActionRuntime('global', 'acme.external', () => { invoked = true; },
        undefined, undefined, undefined, undefined, dangerLevel);
      const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
      const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }));
      const result = await executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
        surface: 'api', requiredContributedActionDangerLevel: 'safe',
      });
      expect(result).toMatchObject(dangerLevel === 'safe'
        ? { ok: true, result: { surface: 'api' } }
        : { ok: false, errorCode: 'plugin_action_read_only_required' });
      expect(invoked).toBe(dangerLevel === 'safe');
    }
  });

  it('keeps read-only source invocation subject to the exact contributed Action API grant', async () => {
    let invoked = false;
    const runtime = createExternalActionRuntime('global', 'acme.external', () => { invoked = true; });
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }));
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['action.invoke'] } },
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(invoked).toBe(false);
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['acme.external/actions/inspect'] } },
      },
    })).resolves.toMatchObject({ ok: true, result: { surface: 'api' } });
    expect(invoked).toBe(true);
  });
  it('rejects a write source before activating its unbound contributor', async () => {
    let activated = false;
    const runtime = createExternalActionRuntime('global', 'acme.external', undefined,
      undefined, undefined, undefined, undefined, 'writesRemote', () => { activated = true; });
    const lease = { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} } satisfies PluginRuntimeRegistryLease;
    const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    }));
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_read_only_required' });
    expect(activated).toBe(false);
  });
  it('invokes the committed contributor through authenticated exact-machine Action RPC without borrowing plugin identity', async () => {
    const executor = createExternalActionIngressExecutor();
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const controller = new AbortController();
    registerActionSpecRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => {
        handlers.set(method, (input) => handler(input, { signal: controller.signal, callerAuthority: 'present_user' }));
      } },
      actionExecutor: executor,
      actionIds: ['action.invoke'],
      targetMachineId: 'machine-local',
    });
    const { createUiAccountActionTransport } = await import('../../../../ui/sources/sync/ops/actions/accountActionTransport');
    const action = createUiAccountActionTransport({
      account: { serverId: 'server-external', accountId: 'account-1', assertCurrent: () => undefined },
      resolveFallbackMachineId: () => null,
      transport: async ({ method, payload }) => {
        const handler = handlers.get(method);
        if (!handler) return { ok: false, errorCode: 'method_not_found' };
        return handler(payload);
      },
    });
    const request = { actionId: 'action.invoke' as const, input: { action: { pluginId: 'acme.external', localId: 'inspect' }, input: {} },
      context: { serverId: 'server-external', runtimeAccountId: 'account-1', defaultSessionId: 'session-origin',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-local' } } };
    await expect(action(request)).resolves.toEqual({ surface: 'api', caller: null, sessionId: 'session-origin' });
    await expect(action({ ...request, context: { ...request.context,
      externalActionTarget: { kind: 'machine', machineId: 'wrong-machine' } } })).resolves.toMatchObject({ ok: false });
    controller.abort();
    await expect(action(request)).resolves.toMatchObject({ ok: false });
  });
  it('feeds current committed plugin definitions to API Action discovery without retaining the runtime lease', async () => {
    const runtime = createExternalActionRuntime('global');
    let runtimeAvailable = true;
    let retireAfterCatalogRead = false;
    const release = vi.fn(async () => {
      if (retireAfterCatalogRead) runtimeAvailable = false;
    });
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'active',
      durableRevision: runtime.durableRevision ?? -1,
      release,
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => runtimeAvailable ? lease : null,
    });
    const definitions = listContributedActionDefinitions();
    expect(definitions).toEqual([
      expect.objectContaining({ id: 'acme.external/actions/inspect' }),
    ]);
    const [definition] = definitions;
    expect(definition).toBeDefined();
    expect(definition).not.toHaveProperty('scopes');
    expect(definition).not.toHaveProperty('contributionSurfaces');
    expect(definition).not.toHaveProperty('placementBindings');
    expect(definition).not.toHaveProperty('availability');
    expect(definition).not.toHaveProperty('hostAccess');
    expect(definition).not.toHaveProperty('priority');
    expect(definition).not.toHaveProperty('dangerLevel');
    expect(StrictJsonValueSchema.safeParse(definition).success).toBe(true);
    const executor = createCliActionExecutor({
      token: 'discovery-token',
      sessionId: 'session-discovery',
      mode: 'plain',
      ctx: null,
      pluginActionExecutionOwner: 'current_process',
      invokeContributedAction: createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }),
      listContributedActionDefinitions,
    });
    const context = {
      surface: 'api' as const,
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: ApiTokenGrantV1Schema.parse({
          v: 1,
          actions: { families: [], ids: ['acme.external/actions/inspect'] },
          targets: null,
          approve: false,
          origins: [],
          models: null,
          permissionModes: null,
          create: null,
        }),
      },
    };
    const declaredAction = runtime.contributes.actions[0];
    if (!declaredAction) throw new Error('Expected current contributed Action declaration');

    // Exercise the real CLI composition before search: a host schema-export
    // failure must not obscure the missing on-demand contributed schema owner.
    const get = await executor.execute(
      'action.spec.get',
      { id: 'acme.external/actions/inspect' },
      context,
    );
    expect(get).toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({
          id: 'acme.external/actions/inspect',
          inputSchema: declaredAction.definition.inputSchema,
          ...(declaredAction.definition.outputSchema === undefined
            ? {}
            : { outputSchema: declaredAction.definition.outputSchema }),
        }),
      },
    });
    if (!get.ok) throw new Error('Expected contributed Action lookup to succeed');
    expect(StrictJsonValueSchema.safeParse(get.result).success).toBe(true);

    // Retiring the runtime after the summary read must prevent the subsequent
    // schema read from disclosing a declaration retained from that old lease.
    retireAfterCatalogRead = true;
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.external/actions/inspect' },
      context,
    )).resolves.toMatchObject({ ok: false, errorCode: 'unavailable' });
    retireAfterCatalogRead = false;
    runtimeAvailable = true;

    const search = await executor.execute(
      'action.spec.search',
      { query: 'inspect', limit: 5 },
      context,
    );
    expect(search, JSON.stringify(search)).toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: 'acme.external/actions/inspect' }),
        ]),
      },
    });
    if (!search.ok) throw new Error('Expected contributed Action search to succeed');
    expect(StrictJsonValueSchema.safeParse(search.result).success).toBe(true);

    expect(release).toHaveBeenCalled();
  });

  it('does not advertise a contributed Action rejected by the runtime catalog policy', () => {
    const runtime = createExternalActionRuntime('global');
    const targetActionInvocations = runtime.targetActionInvocations;
    if (!targetActionInvocations) throw new Error('Expected complete Action invocation fixture');
    const evaluateCatalogPolicy = vi.fn(() => ({
      outcome: 'denied',
      code: 'plugin_action_grant_revoked',
      requiresCurrentIntent: false,
    } as const));
    const deniedRuntime: ResolvedExecutablePluginRuntimeRegistry = {
      ...runtime,
      targetActionInvocations: {
        ...targetActionInvocations,
        evaluateCatalogPolicy,
      },
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => ({
        registry: deniedRuntime,
        source: 'active',
        durableRevision: deniedRuntime.durableRevision ?? -1,
        release: async () => {},
      }),
    });

    expect(listContributedActionDefinitions()).toEqual([]);
    expect(evaluateCatalogPolicy).toHaveBeenCalledWith('acme.external', 'inspect');
  });

  it('fails closed when a partial committed runtime has no Action invocation policy owner', () => {
    const runtime = createExternalActionRuntime('global');
    const partialRuntime: ResolvedExecutablePluginRuntimeRegistry = {
      ...runtime,
      targetActionInvocations: undefined,
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => ({
        registry: partialRuntime,
        source: 'active',
        durableRevision: partialRuntime.durableRevision ?? -1,
        release: async () => {},
      }),
    });

    expect(listContributedActionDefinitions()).toEqual([]);
  });

  it('keeps equal local ids from separate plugins distinct in external Action discovery', async () => {
    const alphaRuntime = createExternalActionRuntime('global', 'acme.alpha');
    const betaRuntime = createExternalActionRuntime('global', 'acme.beta');
    const alphaTargetActionInvocations = alphaRuntime.targetActionInvocations;
    const betaTargetActionInvocations = betaRuntime.targetActionInvocations;
    if (!alphaTargetActionInvocations || !betaTargetActionInvocations) {
      throw new Error('Expected complete Action invocation fixtures');
    }
    const runtime: ResolvedExecutablePluginRuntimeRegistry = {
      ...alphaRuntime,
      contributes: {
        ...alphaRuntime.contributes,
        actions: [...alphaRuntime.contributes.actions, ...betaRuntime.contributes.actions],
      },
      targetActionInvocations: {
        ...alphaTargetActionInvocations,
        evaluateCatalogPolicy: (pluginId, localId) => (
          pluginId === 'acme.beta'
            ? betaTargetActionInvocations.evaluateCatalogPolicy(pluginId, localId)
            : alphaTargetActionInvocations.evaluateCatalogPolicy(pluginId, localId)
        ),
      },
    };
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'active',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => lease,
    });
    expect(listContributedActionDefinitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
      expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
    ]));
    const executor = createExternalActionExecutor(
      createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }),
      listContributedActionDefinitions,
    );

    await expect(executor.execute(
      'action.spec.search',
      { query: 'inspect', limit: 5 },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
          expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
        ]),
      },
    });
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.alpha/actions/inspect' },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({ id: 'acme.alpha/actions/inspect' }),
      },
    });
    await expect(executor.execute(
      'action.spec.get',
      { id: 'acme.beta/actions/inspect' },
      { surface: 'api' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({ id: 'acme.beta/actions/inspect' }),
      },
    });
  });

  it('uses the verified envelope Session target to invoke a real session-scoped external Action', async () => {
    const executor = createExternalActionIngressExecutor('session');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          // This remains plugin payload, not a Session selector.
          input: { sessionId: 'session-forged-in-plugin-input' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver(),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: {
          ok: true,
          result: {
            surface: 'api',
            caller: null,
            sessionId: 'session-verified',
          },
        },
      },
    });

    expect(externalActionTargetResolverMocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'session-verified',
    });
  });

  it('does not let nested plugin input select a Session without a verified envelope target', async () => {
    const executor = createExternalActionIngressExecutor('session');
    const resolveTarget = createDaemonExternalActionTargetResolver({
      credentials: { token: 'daemon-token', encryption: null },
    });
    externalActionTargetResolverMocks.fetchSessionById.mockClear();

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: { sessionId: 'session-forged-in-plugin-input' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        actionId: 'action.invoke',
        execution: {
          ok: false,
          errorCode: 'plugin_action_session_required',
        },
      },
    });
    expect(externalActionTargetResolverMocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('keeps a non-session external Action on the same verified Session target path', async () => {
    const executor = createExternalActionIngressExecutor('global');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver(),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: true,
          result: { sessionId: 'session-verified' },
        },
      },
    });
  });

  it('keeps an unscoped external Action executable on the current machine', async () => {
    const executor = createExternalActionIngressExecutor('global');
    const resolveTarget = createDaemonExternalActionTargetResolver({
      credentials: { token: 'daemon-token', encryption: null },
    });
    externalActionTargetResolverMocks.fetchSessionById.mockClear();

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: true,
          result: { sessionId: null },
        },
      },
    });
    expect(externalActionTargetResolverMocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('rejects a Session target the canonical locality owner cannot prove local', async () => {
    const executor = createExternalActionIngressExecutor('session');

    await expect(executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-verified' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: {},
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-local',
      resolveTarget: createCanonicalSessionTargetResolver({
        machineId: 'machine-elsewhere',
        host: 'host-elsewhere',
        homeDir: '/home/elsewhere',
      }),
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'target_not_local',
        },
      },
    });
  });

  it('runs a parsed external manifest Action through settings-required approve and reject intent decisions', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      const runtime = createExternalActionRuntime();
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      const acquireRuntimeRegistryLease = async (): Promise<PluginRuntimeRegistryLease> => lease;
      const approve = vi.fn(async (request: TargetActionCurrentIntentRequest) => ({
        status: 'approved' as const,
        fingerprint: request.fingerprint,
      }));
      const approvedInvokerOptions = {
        acquireRuntimeRegistryLease,
        requestCurrentIntent: approve,
      };
      const approved = createDaemonExternalActionContributedInvoker(approvedInvokerOptions);
      const context = {
        surface: 'api' as const,
        authority: 'account_automation' as const,
        actionCaller: { kind: 'host' as const },
        defaultSessionId: 'session-1',
      };

      await expect(approved({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        context,
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: { surface: 'api', caller: null, sessionId: 'session-1' },
      });
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'api',
        invocationSurface: 'api',
      }));

      const reject = vi.fn(async () => ({
        status: 'rejected' as const,
        code: 'plugin_action_current_intent_rejected',
      }));
      const rejectedInvokerOptions = {
        acquireRuntimeRegistryLease,
        requestCurrentIntent: reject,
      };
      const rejected = createDaemonExternalActionContributedInvoker(rejectedInvokerOptions);

      await expect(rejected({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        context,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'plugin_action_current_intent_rejected',
        actionHandlerInvocation: 'notStarted',
      });
      expect(reject).toHaveBeenCalledOnce();
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('returns a deferred generic approval artifact for an API Ask-first contributed Action', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let executionOriginReads = 0;
      const runtime = createExternalActionRuntime(
        'global',
        'acme.external',
        undefined,
        (pluginId) => {
          executionOriginReads += 1;
          return {
            serverIdentityId: 'server-external',
            materializationRef: {
              pluginId,
              machineId: 'machine-local',
              materializationId: 'fixture-materialization',
            },
          };
        },
      );
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      const requestCurrentIntent = vi.fn(async () => ({
        status: 'deferred',
        artifactId: 'approval-api-required-1',
      } as never));
      const executor = createExternalActionExecutor(
        createDaemonExternalActionContributedInvoker({
          acquireRuntimeRegistryLease: async () => lease,
          requestCurrentIntent,
        }),
        createDaemonExternalActionContributedDefinitionLister({
          tryAcquireRuntimeRegistryLease: () => lease,
        }),
      );

      await expect(executeExternalAction({
        actionId: 'action.invoke',
        envelope: {
          v: 1,
          input: {
            action: { pluginId: 'acme.external', localId: 'inspect' },
            input: {},
          },
        },
        principal: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
          authority: 'account_automation',
        },
        currentMachineId: 'machine-local',
        resolveTarget: createDaemonExternalActionTargetResolver({
          credentials: { token: 'daemon-token', encryption: null },
        }),
        executor,
      })).resolves.toMatchObject({
        kind: 'response',
        response: {
          actionId: 'action.invoke',
          execution: {
            ok: true,
            result: {
              kind: 'approval_request_created',
              artifactId: 'approval-api-required-1',
              actionId: 'action.invoke',
            },
          },
        },
      });
      expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
        replayPlacement: {
          serverId: 'server-external',
          machineId: 'machine-local',
        },
      }));
      expect(executionOriginReads).toBe(0);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('does not post-veto a direct API contributed Action when its execution origin changes', async () => {
    let originRead = 0;
    let actionInvocations = 0;
    const runtime = createExternalActionRuntime(
      'global',
      'acme.external',
      () => { actionInvocations += 1; },
      (pluginId) => {
        originRead += 1;
        return {
          serverIdentityId: 'server-external',
          materializationRef: {
            pluginId,
            machineId: 'machine-local',
            materializationId: originRead === 1 ? 'before-effect' : 'after-effect',
          },
        };
      },
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const invoke = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    });

    await expect(invoke({
      action: { pluginId: 'acme.external', localId: 'inspect' },
      input: {},
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      result: { surface: 'api', caller: null, sessionId: null },
    });
    expect(actionInvocations).toBe(1);
    expect(originRead).toBe(0);
  });

  it('executes a materializationless bundled API Action without requiring an execution origin', async () => {
    let actionInvocations = 0;
    const runtime = createExternalActionRuntime(
      'global',
      'happier.channels',
      () => { actionInvocations += 1; },
      () => null,
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    const invoke = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
    });

    await expect(invoke({
      action: { pluginId: 'happier.channels', localId: 'inspect' },
      input: {},
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      result: { surface: 'api', caller: null, sessionId: null },
    });
    expect(actionInvocations).toBe(1);
  });

  it('defers and replays a materializationless bundled API Action with its admitting Workflow starter at its exact daemon placement', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    let serviceOwners: ReturnType<typeof createProductionPluginInvocationServiceOwners> | undefined;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'happier.channels/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const runId = '99999999-9999-4999-8999-999999999999';
      let acceptedEnvelope: string | undefined;
      const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
        ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-local', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      const workflowDeps: WorkflowAccountRunActionDeps = {
        resolveAccountId: async () => 'account-1',
        storage: { execute: async operation => {
          if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
          acceptedEnvelope = String(operation.acceptedEnvelope);
          return { kind: 'created', run };
        } },
        definitions: { get: async () => { throw new Error('inline_definition_only'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
        randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-local', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      };
      const owner = createWorkflowAccountRunActionOwner(workflowDeps);
      serviceOwners = createProductionPluginInvocationServiceOwners({
        invokeContributedAction: async () => { throw new Error('no_further_plugin_edge'); },
        actionExecutor: { execute: async (actionId, input, context) => {
          if (actionId !== 'workflow.run.start') throw new Error('unexpected_host_action');
          return { ok: true, result: await owner.execute({ actionId, input: WorkflowRunStartRequestV1Schema.parse(input),
            context: { ...context, callerPermissionMode: 'default',
              externalActionTarget: { kind: 'machine', machineId: 'machine-local', project: { machineId: 'machine-local', directory: '/repo' } } } }) };
        } },
      });
      const runtime = createExternalActionRuntime(
        'global',
        'happier.channels',
        async context => {
          actionInvocations += 1;
          await context.services.actions.execute('workflow.run.start', { runId, source: { kind: 'inline', definition: {
            version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Review', references: [], attachments: [] } }],
          } } });
        },
        () => null,
        () => ({
          serverId: 'server-bundled',
          machineId: 'machine-local',
        }),
        undefined,
        serviceOwners,
      );
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const invoke = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-bundled-1' };
          },
          read: async () => persisted,
        }),
      });

      await expect(invoke({
        action: { pluginId: 'happier.channels', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: {
          ...createApiActionApprovalOrigin(),
          serverId: 'server-bundled',
        },
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'approval_request_created',
          artifactId: 'approval-bundled-1',
          actionId: 'action.invoke',
        },
      });
      expect(persisted).toMatchObject({
        sourceCustody: {
          kind: 'bundled_first_party',
          packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli-root' },
        },
        replayPlacement: {
          serverId: 'server-bundled',
          machineId: 'machine-local',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });
      const replayed = await replay({
        artifactId: 'approval-bundled-1',
        decision: 'approve',
      });
      expect(replayed, JSON.stringify(replayed)).toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: { ok: true },
        },
      });
      expect(actionInvocations).toBe(1);
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope),
      })).toMatchObject({ kind: 'available', content: { startedBy: 'user',
        authorization: { principal: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'inspect' } } } });

      await expect(replay({
        artifactId: 'approval-bundled-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      expect(actionInvocations).toBe(1);
    } finally {
      await serviceOwners?.dispose();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('replays a managed API target-action artifact exactly once at its stamped daemon', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.managed/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const runtime = createExternalActionRuntime('global', 'acme.managed', () => {
        actionInvocations += 1;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async (args: Readonly<{ artifactId: string }>) => (
          args.artifactId === 'approval-api-exact-1' ? persisted : null
        ),
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          if (args.artifactId !== 'approval-api-exact-1') {
            return { ok: false as const, errorCode: 'not_found', error: 'artifact_not_found' };
          }
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
        now: () => 1,
        create: async (request) => {
          persisted = request;
          return { artifactId: 'approval-api-exact-1' };
        },
        read: async () => persisted,
      });
      const deferred = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent,
      });

      await expect(deferred({
        action: { pluginId: 'acme.managed', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin('session-1'),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
          defaultSessionId: 'session-1',
        },
        signal: new AbortController().signal,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'approval_request_created',
          artifactId: 'approval-api-exact-1',
          actionId: 'action.invoke',
        },
      });
      expect(actionInvocations).toBe(0);
      expect(persisted).toMatchObject({
        status: 'open',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'fixture-immutable-generation',
          installSource: 'localPath',
        },
        replayPlacement: {
          serverId: 'server-external',
          machineId: 'machine-local',
          defaultSessionId: 'session-1',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      await expect(replay({
        artifactId: 'approval-api-exact-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: {
            ok: true,
            result: { surface: 'api', caller: null, sessionId: 'session-1' },
          },
        },
      });
      expect(actionInvocations).toBe(1);
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
        execution: {
          ok: true,
          result: { surface: 'api', caller: null, sessionId: 'session-1' },
        },
      });

      await expect(replay({
        artifactId: 'approval-api-exact-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      expect(actionInvocations).toBe(1);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('reconstructs an immutable PAT context and installation-key signer for contributed-Action replay', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
    const installationKeyPair = tweetnacl.sign.keyPair();
    const outerInput = {
      action: { pluginId: 'acme.external', localId: 'inspect' },
      input: {},
    } as const;
    const target = { kind: 'machine' as const, machineId: 'machine-local' };
    const approvedGrant = {
      ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['acme.external/actions/inspect'] },
    };
    const authorization = {
      v: 1 as const,
      token: 'home-signed-external-invocation',
      binding: {
        serverIdentityId: 'server-external',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        machineId: 'machine-local',
        actionId: 'action.invoke',
        requestId: 'request-1',
        requestEnvelopeDigest: 'A'.repeat(43),
        grant: approvedGrant,
        target,
      },
    };
    const approvalExecutionOrigin: ApprovalExecutionOriginV1 = {
      ...createApiActionApprovalOrigin(),
      serverIdentityId: authorization.binding.serverIdentityId,
      externalActionExecutionAuthorization: authorization,
      externalActionInputSignature: signExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: 'action.invoke',
        target,
        input: outerInput,
        privateKey: installationKeyPair.secretKey,
      }),
    };
    let replaySeed: PluginActionsServiceSeed | null = null;
    const runtime = createExternalActionRuntime(
      'global',
      'acme.external',
      undefined,
      undefined,
      undefined,
      (seed) => { replaySeed = seed; },
    );
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    };
    let persisted: TargetActionApprovalRequestV1 | null = null;
    const targetActionApprovals = {
      targetActionApprovalsGet: async () => persisted,
      targetActionApprovalsUpdate: async (args: Readonly<{
        artifactId: string;
        request: TargetActionApprovalRequestV1;
      }>) => {
        persisted = args.request;
        return { ok: true as const };
      },
    };
    const deferred = createDaemonExternalActionContributedInvoker({
      acquireRuntimeRegistryLease: async () => lease,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        now: () => 1,
        create: async (request) => {
          persisted = request;
          return { artifactId: 'approval-external-pat-replay' };
        },
        read: async () => persisted,
      }),
    });

    await expect(deferred({
      action: outerInput.action,
      input: outerInput.input,
      approvalExecutionOrigin,
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        serverId: 'server-external',
        serverIdentityId: 'server-external',
        actionRequestId: 'request-1',
        externalActionCredential: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: '11111111-1111-4111-8111-111111111111',
          grant: approvedGrant,
        },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-external-pat-replay' },
    });

    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: null } as never,
      isApprovalExecutionOriginCurrent: async () => true,
      acquireRuntimeRegistryLease: async () => lease,
      targetActionApprovals,
      readInstallationIdentity: () => ({
        version: 1,
        installationId: 'machine-installation-1',
        createdAt: 1,
        publicKey: encodeBase64(installationKeyPair.publicKey, 'base64url'),
        privateKey: encodeBase64(installationKeyPair.secretKey, 'base64url'),
      }),
      now: () => 2,
    });
    await expect(replay({
      artifactId: 'approval-external-pat-replay',
      decision: 'approve',
    })).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

    expect(replaySeed).not.toBeNull();
    const context = replaySeed!.externalActionContext!;
    expect(context.externalActionCredential.grant).toEqual(authorization.binding.grant);
    expect(context.externalActionCredential.grant.approve).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.externalActionCredential)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization.binding)).toBe(true);
    expect(Object.isFrozen(context.externalActionExecutionAuthorization.binding.target)).toBe(true);
    expect(Object.isFrozen(context.externalActionTarget)).toBe(true);
    const effectInput = { v: 1, teamId: 'team-1' };
    const signature = context.signExternalActionApprovalInput!({
      actionId: 'teams.archive',
      input: effectInput,
      target,
      authorization,
    });
    expect(verifyExternalActionApprovalInputV1({
      authorizationToken: authorization.token,
      actionId: 'teams.archive',
      target,
      input: effectInput,
      publicKey: installationKeyPair.publicKey,
      signature,
    })).toBe(true);
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('admits one target effect across independent concurrent executors', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    let releaseActionInvocation: () => void = () => {};
    try {
      let actionInvocations = 0;
      let firstActionInvocationStarted!: () => void;
      const firstActionInvocation = new Promise<void>((resolve) => {
        firstActionInvocationStarted = resolve;
      });
      const actionInvocationRelease = new Promise<void>((resolve) => {
        releaseActionInvocation = resolve;
      });
      const runtime = createExternalActionRuntime('global', 'acme.external', async () => {
        actionInvocations += 1;
        if (actionInvocations === 1) firstActionInvocationStarted();
        await actionInvocationRelease;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      let failTerminalWrite = false;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          const prior = persisted;
          if (failTerminalWrite
            && (args.request.status === 'executed' || args.request.status === 'failed')) {
            return { ok: false as const, errorCode: 'conflict', error: 'synthetic_terminal_write_failure' };
          }
          // Mirror the Artifact store contract: terminal equality is
          // idempotent, while an equal executing row loses the claim.
          if (prior !== null && isDeepStrictEqual(prior, args.request)) {
            return args.request.status === 'executing'
              ? { ok: false as const, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' }
              : { ok: true as const };
          }
          const allowed = prior !== null && (
            (prior.status === 'open' && args.request.status === 'approved')
            || (prior.status === 'approved' && args.request.status === 'executing')
            || (prior.status === 'executing'
              && (args.request.status === 'executed' || args.request.status === 'failed'))
          );
          if (!allowed) {
            return {
              ok: false as const,
              errorCode: 'invalid_transition',
              error: 'target_action_approval_invalid_transition',
            };
          }
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-api-concurrent-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const createReplay = () => createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });
      const first = createReplay()({
        artifactId: 'approval-api-concurrent-1',
        decision: 'approve',
      });
      await firstActionInvocation;
      const second = createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' });

      expect(actionInvocations).toBe(1);
      releaseActionInvocation();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ ok: true, result: { ok: true, status: 'executed', execution: expect.any(Object) } }),
        { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' },
      ]);
      expect(actionInvocations).toBe(1);
      await vi.waitFor(() => expect(persisted).toMatchObject({ status: 'executed' }));
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
        execution: { ok: true },
      });
      persisted = { ...persisted!, status: 'approved', updatedAtMs: 3, execution: undefined };
      failTerminalWrite = true;
      await expect(createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' }))
        .resolves.toEqual({ ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' });
      expect(actionInvocations).toBe(2);
      expect(persisted).toMatchObject({ status: 'executing' });
      await expect(createReplay()({ artifactId: 'approval-api-concurrent-1', decision: 'approve' }))
        .resolves.toEqual({ ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' });
      expect(actionInvocations).toBe(2);
    } finally {
      releaseActionInvocation();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('evaluates a conflicting concurrent rejection after the in-flight approval settles', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    let releaseActionInvocation: () => void = () => {};
    try {
      let actionInvocations = 0;
      let actionInvocationStarted!: () => void;
      const actionStarted = new Promise<void>((resolve) => {
        actionInvocationStarted = resolve;
      });
      const actionRelease = new Promise<void>((resolve) => {
        releaseActionInvocation = resolve;
      });
      const runtime = createExternalActionRuntime('global', 'acme.external', async () => {
        actionInvocations += 1;
        actionInvocationStarted();
        await actionRelease;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-api-conflict-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      const approve = replay({ artifactId: 'approval-api-conflict-1', decision: 'approve' });
      await actionStarted;
      const reject = replay({ artifactId: 'approval-api-conflict-1', decision: 'reject' });
      releaseActionInvocation();

      await expect(approve).resolves.toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed' },
      });
      await expect(reject).resolves.toEqual({
        ok: false,
        errorCode: 'approval_not_open',
        error: 'approval_not_open',
      });
      expect(actionInvocations).toBe(1);
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
      });
    } finally {
      releaseActionInvocation();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('fails a replay when the current Action policy no longer matches its durable approval', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.external/actions/inspect': {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    try {
      let actionInvocations = 0;
      const runtime = createExternalActionRuntime('global', 'acme.external', () => {
        actionInvocations += 1;
      });
      const lease: PluginRuntimeRegistryLease = {
        registry: runtime,
        source: 'ephemeral',
        durableRevision: runtime.durableRevision ?? -1,
        release: async () => {},
      };
      let persisted: TargetActionApprovalRequestV1 | null = null;
      const targetActionApprovals = {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate: async (args: Readonly<{
          artifactId: string;
          request: TargetActionApprovalRequestV1;
        }>) => {
          persisted = args.request;
          return { ok: true as const };
        },
      };
      const defer = createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent: createTargetActionCurrentIntentAdapter({
          now: () => 1,
          create: async (request) => {
            persisted = request;
            return { artifactId: 'approval-api-stale-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        approvalExecutionOrigin: createApiActionApprovalOrigin(),
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      expect(persisted).toMatchObject({
        sourceCustody: {
          kind: 'development',
          registeredRootId: 'fixture-root:acme.external',
        },
      });

      // The persisted Ask-first subject must not become silently executable
      // when the current policy flips to Allowed before the user decides.
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        isApprovalExecutionOriginCurrent: async () => true,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      await expect(replay({
        artifactId: 'approval-api-stale-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'plugin_action_current_intent_mismatch',
      });
      expect(actionInvocations).toBe(0);
      expect(persisted).toMatchObject({
        status: 'failed',
        decision: { kind: 'approve' },
        execution: {
          ok: false,
          errorCode: 'plugin_action_current_intent_mismatch',
        },
      });
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('rejects a stamped API target-action artifact without acquiring its executor', async () => {
    // Simulates the pre-origin development artifact shape. Current writers
    // cannot construct it, but replay must still fail closed before a lease.
    let persisted = {
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      requestedSurface: 'api',
      qualifiedActionId: 'acme.external/actions/inspect',
      input: {},
      sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
      policyFingerprint: 'a'.repeat(64),
      subjectFingerprint: 'b'.repeat(64),
      replayPlacement: {
        serverId: 'server-external',
        machineId: 'machine-local',
      },
      summary: 'Inspect',
    } as TargetActionApprovalRequestV1;
    const acquireRuntimeRegistryLease = vi.fn(async () => {
      throw new Error('rejection_must_not_acquire_a_runtime_lease');
    });
    const targetActionApprovalsUpdate = vi.fn(async (args: Readonly<{
      artifactId: string;
      request: TargetActionApprovalRequestV1;
    }>) => {
      persisted = args.request;
      return { ok: true as const };
    });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'daemon-token', encryption: null } as never,
      acquireRuntimeRegistryLease,
      targetActionApprovals: {
        targetActionApprovalsGet: async () => persisted,
        targetActionApprovalsUpdate,
      },
      now: () => 2,
    });

    await expect(replay({
      artifactId: 'approval-api-reject-1',
      decision: 'reject',
      callerGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true, targets: { sessions: ['other-session'], machines: [] } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(targetActionApprovalsUpdate).not.toHaveBeenCalled();
    expect(acquireRuntimeRegistryLease).not.toHaveBeenCalled();

    await expect(replay({
      artifactId: 'approval-api-reject-1',
      decision: 'reject',
    })).resolves.toEqual({
      ok: true,
      result: { ok: true, status: 'rejected' },
    });
    expect(acquireRuntimeRegistryLease).not.toHaveBeenCalled();
    expect(targetActionApprovalsUpdate).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({
      status: 'rejected',
      decision: { kind: 'reject', decidedAtMs: 2 },
    });
  });
});
