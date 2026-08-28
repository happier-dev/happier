import { describe, expect, it, vi } from 'vitest';

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
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  StrictJsonValueSchema,
  TargetActionApprovalRequestV1Schema,
  type PluginMachineExecutionOriginV1,
  type TargetActionApprovalReplayPlacementV1,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';
import {
  createActionExecutor,
  type ActionExecutorDeps,
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
import {
  createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import {
  createDaemonExternalActionContributedApprovalReplay,
  createDaemonExternalActionContributedDefinitionLister,
  createDaemonExternalActionContributedInvoker,
} from './createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

const EXTERNAL_ACTION_ENCRYPTION_KEY = new Uint8Array(32).fill(7);

function createExternalActionRuntime(
  scope: 'global' | 'session' = 'session',
  pluginId = 'acme.external',
  onActionInvocation?: () => void | Promise<void>,
  resolveCurrentPluginExecutionOrigin?: (
    pluginId: string,
  ) => PluginMachineExecutionOriginV1 | null,
  resolveCurrentPluginApprovalReplayPlacement?: (
    pluginId: string,
  ) => TargetActionApprovalReplayPlacementV1 | null,
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
          dangerLevel: 'safe',
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
  const targetActionInvocations = buildTargetActionInvocationRegistry({
    contributes,
    targetRegistrations: [{
      pluginId,
      generation: 'fixture-generation',
      registration: {
        family: 'actions',
        localId: registeredAction.definition.id,
        value: async (_input: JsonValue, context: PluginInvocationContext) => {
          await onActionInvocation?.();
          return {
            surface: context.surface,
            caller: context.caller?.kind ?? null,
            sessionId: context.session?.id ?? null,
          };
        },
      },
    }],
    targetActivationFacts: [{
      pluginId,
      pluginVersion: '1.0.0',
      source: 'localPath',
      generation: 'fixture-generation',
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
        targetGeneration: resolvedAction.generation,
        desiredGeneration: resolvedAction.generation,
        appliedGeneration: resolvedAction.generation,
      },
      resourceSelections: [],
      scopedGrants: [],
      operatingSystemAuthorization: [],
    }),
    resolveHostBinding: createTargetActionHostBindingResolver(),
    resolveHostPolicy: createTargetActionHostPolicyResolver(),
    createServices: createUnavailablePluginServicesFactory(),
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
    activateContributionsOnDemand: async () => [],
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    resolvePromptAssetBlocks: async () => [],
    retireConsumers: () => {},
    retainActivationRegistryComponentsExcluding: () => [],
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
    ...(listContributedActionDefinitions ? { listContributedActionDefinitions } : {}),
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
  return createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
    acquireRuntimeRegistryLease: async () => lease,
  }));
}

describe('createDaemonExternalActionContributedInvoker', () => {
  it('feeds current committed plugin definitions to API Action discovery without retaining the runtime lease', async () => {
    const runtime = createExternalActionRuntime('global');
    const release = vi.fn(async () => {});
    const lease: PluginRuntimeRegistryLease = {
      registry: runtime,
      source: 'active',
      durableRevision: runtime.durableRevision ?? -1,
      release,
    };
    const listContributedActionDefinitions = createDaemonExternalActionContributedDefinitionLister({
      tryAcquireRuntimeRegistryLease: () => lease,
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
    const executor = createExternalActionExecutor(
      createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
      }),
      listContributedActionDefinitions,
    );

    const search = await executor.execute(
      'action.spec.search',
      { query: 'inspect', limit: 5 },
      { surface: 'api' },
    );
    expect(search).toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: 'acme.external/actions/inspect' }),
        ]),
      },
    });
    if (!search.ok) throw new Error('Expected contributed Action search to succeed');
    expect(StrictJsonValueSchema.safeParse(search.result).success).toBe(true);

    const get = await executor.execute(
      'action.spec.get',
      { id: 'acme.external/actions/inspect' },
      { surface: 'api' },
    );
    expect(get).toMatchObject({
      ok: true,
      result: {
        actionSpec: expect.objectContaining({ id: 'acme.external/actions/inspect' }),
      },
    });
    if (!get.ok) throw new Error('Expected contributed Action lookup to succeed');
    expect(StrictJsonValueSchema.safeParse(get.result).success).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('keeps equal local ids from separate plugins distinct in external Action discovery', async () => {
    const alphaRuntime = createExternalActionRuntime('global', 'acme.alpha');
    const betaRuntime = createExternalActionRuntime('global', 'acme.beta');
    const runtime: ResolvedExecutablePluginRuntimeRegistry = {
      ...alphaRuntime,
      contributes: {
        ...alphaRuntime.contributes,
        actions: [...alphaRuntime.contributes.actions, ...betaRuntime.contributes.actions],
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
      const executor = createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
        acquireRuntimeRegistryLease: async () => lease,
        requestCurrentIntent,
      }));

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

  it('defers and replays a materializationless bundled API Action at its exact daemon placement', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
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
      const runtime = createExternalActionRuntime(
        'global',
        'happier.channels',
        () => { actionInvocations += 1; },
        () => null,
        () => ({
          serverId: 'server-bundled',
          machineId: 'machine-local',
        }),
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
        replayPlacement: {
          serverId: 'server-bundled',
          machineId: 'machine-local',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });
      await expect(replay({
        artifactId: 'approval-bundled-1',
        decision: 'approve',
      })).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: { ok: true },
        },
      });
      expect(actionInvocations).toBe(1);

      await expect(replay({
        artifactId: 'approval-bundled-1',
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

  it('replays an approved API target-action artifact exactly once at its stamped daemon', async () => {
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
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
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
        replayPlacement: {
          serverId: 'server-external',
          machineId: 'machine-local',
          defaultSessionId: 'session-1',
        },
      });

      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
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

  it('serializes concurrent approve replays for one API target-action artifact', async () => {
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
            return { artifactId: 'approval-api-concurrent-1' };
          },
          read: async () => persisted,
        }),
      });
      await defer({
        action: { pluginId: 'acme.external', localId: 'inspect' },
        input: {},
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
        acquireRuntimeRegistryLease: async () => lease,
        targetActionApprovals,
        now: () => 2,
      });

      const firstController = new AbortController();
      const first = replay({
        artifactId: 'approval-api-concurrent-1',
        decision: 'approve',
        signal: firstController.signal,
      });
      await firstActionInvocation;
      const second = replay({ artifactId: 'approval-api-concurrent-1', decision: 'approve' });
      const cancelledReason = new DOMException('Stopped waiting', 'AbortError');
      firstController.abort(cancelledReason);
      await expect(first).rejects.toBe(cancelledReason);
      await new Promise<void>((resolve) => { setImmediate(resolve); });

      expect(actionInvocations).toBe(1);

      releaseActionInvocation();
      const secondResult = await second;
      expect(secondResult).toMatchObject({
        ok: true,
        result: {
          ok: true,
          status: 'executed',
          execution: { ok: true },
        },
      });
      expect(actionInvocations).toBe(1);
      expect(persisted).toMatchObject({
        status: 'executed',
        decision: { kind: 'approve' },
        execution: { ok: true },
      });
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
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
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
        context: {
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        },
        signal: new AbortController().signal,
      });

      // The persisted Ask-first subject must not become silently executable
      // when the current policy flips to Allowed before the user decides.
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
      const replay = createDaemonExternalActionContributedApprovalReplay({
        credentials: { token: 'daemon-token', encryption: null } as never,
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
    let persisted = TargetActionApprovalRequestV1Schema.parse({
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      requestedSurface: 'api',
      qualifiedActionId: 'acme.external/actions/inspect',
      input: {},
      generation: 'fixture-generation',
      policyFingerprint: 'a'.repeat(64),
      subjectFingerprint: 'b'.repeat(64),
      replayPlacement: {
        serverId: 'server-external',
        machineId: 'machine-local',
      },
      summary: 'Inspect',
    });
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
