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
  createDaemonExternalActionContributedInvoker,
} from './createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

const EXTERNAL_ACTION_ENCRYPTION_KEY = new Uint8Array(32).fill(7);

function createExternalActionRuntime(
  scope: 'global' | 'session' = 'session',
): ResolvedExecutablePluginRuntimeRegistry {
  const pluginId = 'acme.external';
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
        value: async (_input: JsonValue, context: PluginInvocationContext) => ({
          surface: context.surface,
          caller: context.caller?.kind ?? null,
          sessionId: context.session?.id ?? null,
        }),
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
      packageTrust: {
        packageIdentity: resolvedAction.qualifiedId,
        reviewedPackageIdentity: resolvedAction.qualifiedId,
      },
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

  return {
    contributes,
    generation: 1,
    targetActionInvocations,
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
}

function createExternalActionExecutor(
  invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>,
) {
  return createActionExecutor({
    invokeContributedAction,
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
    release: async () => {},
  };
  return createExternalActionExecutor(createDaemonExternalActionContributedInvoker({
    acquireRuntimeRegistryLease: async () => lease,
  }));
}

describe('createDaemonExternalActionContributedInvoker', () => {
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
    })).resolves.toEqual({
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
});
