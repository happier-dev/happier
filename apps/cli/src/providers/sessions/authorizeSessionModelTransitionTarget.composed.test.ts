import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBackendTargetKeyV2,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  setProviderExperimentalConfirmationV1,
  type ProviderBoundModelRef,
  type ProviderModelDescriptorV1,
} from '@happier-dev/protocol';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { prepareProviderLaunch } from '@/providers/lifecycle/prepareLaunch';

import { resolveSessionModelTransitionAuthorizationRoute } from './authorizeSessionModelTransitionTarget';
import {
  resolveProviderAuthorizationApplyPolicyForActiveBinding,
  sameProviderAuthorizationRuntimeBindingDimensions,
} from './providerAuthorizationApplyPolicy';
import type {
  AuthorizedSessionModelTransitionTarget,
} from './sessionModelTransitionCoordinator';

const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
const connectionId =
  ProviderConnectionIdSchema.parse('pc_cliproxyapi_claude_transition');
const machineId = 'machine-g4-composed';
const dnsEvidenceByEndpointUrl = new Map([
  ['https://gateway.example/v1', ['1.1.1.1']],
  ['https://gateway.example/', ['1.1.1.1']],
]);
const haiku: ProviderModelDescriptorV1 = {
  id: 'claude-haiku-through-cliproxyapi',
  name: 'Claude Haiku through CLIProxyAPI',
  capabilities: {
    toolRoundTrips: 'supported',
    reasoningControls: 'supported',
  },
};
const sonnet: ProviderModelDescriptorV1 = {
  id: 'claude-sonnet-through-cliproxyapi',
  name: 'Claude Sonnet through CLIProxyAPI',
  capabilities: {
    toolRoundTrips: 'supported',
    reasoningControls: 'supported',
  },
};

describe('real Claude registry Provider transition authorization composition', () => {
  const registries: Array<
    Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>
  > = [];

  afterEach(async () => {
    await Promise.all(registries.splice(0).map(async (registry) => {
      await registry.dispose();
    }));
  });

  it('classifies current-source CLIProxyAPI Haiku to Sonnet as live through the exact real Claude binding', async () => {
    const registry = await resolveExecutablePluginRuntimeRegistry({
      pluginIds: [
        'happier.agent.claude',
        'happier.provider.cliproxyapi',
      ],
    });
    registries.push(registry);
    const claude = registry.contributes.agentDefinitionsById.get('claude');
    expect(claude?.identity).toEqual({
      pluginId: 'happier.agent.claude',
      localId: 'claude',
    });
    const lease: PluginRuntimeRegistryLease = {
      registry,
      source: 'ephemeral',
      release: async () => undefined,
    };
    const providerRegistry = {
      providersByContributionKey:
        registry.contributes.providersByContributionKey ?? new Map(),
    };
    expect(providerRegistry.providersByContributionKey.get(contributionKey))
      .toMatchObject({
        provenance: 'first_party',
        identity: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
      });

    const initialSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: connectionId,
        source: { kind: 'contribution', contributionKey },
        role: 'default',
        displayName: 'External CLIProxyAPI',
        displayNameMode: 'custom',
        endpointOverrides: [
          {
            endpointTemplateId: 'cliproxyapi-openai-responses',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-openai-chat',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-anthropic',
            baseUrl: 'https://gateway.example',
          },
        ],
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const connection = resolveProviderConnectionForMachine({
      connectionId,
      machineId,
      accountSettings: { providerSettingsV1: initialSettings },
      registry: providerRegistry,
      dnsEvidenceByEndpointUrl,
    });
    if (connection.status !== 'resolved') {
      throw new Error(`Expected resolved CLIProxyAPI connection, received ${connection.status}`);
    }
    let settings = ProviderSettingsV1Schema.parse({
      ...initialSettings,
      accountGrants: [{
        v: 1,
        connectionId,
        connectionSecurityFingerprint:
          connection.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
    });
    const adapter = readLeasedAgentProviderBindingAdapter({
      lease,
      agentId: 'claude',
    });
    if (!adapter) throw new Error('Expected the real Claude Provider adapter');
    const agentTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
    const confirm = (
      agentTargetKey: string,
      model: ProviderModelDescriptorV1,
    ): void => {
      const compatibility = resolveProviderModelCompatibility({
        record: connection.record,
        providerSettings: settings,
        agentTargetKey,
        support: adapter.support,
        adapterVersion: adapter.adapter.adapterVersion,
        model,
      });
      if (compatibility.result.status === 'experimental') {
        settings = setProviderExperimentalConfirmationV1(settings, {
          connectionId,
          agentTargetKey,
          modelId: compatibility.result.confirmationScope.kind === 'model'
            ? model.id
            : null,
          compatibilityFingerprint: compatibility.compatibilityFingerprint,
          confirmedAt: 3,
        });
      }
    };
    const createAuthorizationAttempt = async (
      selection: Readonly<{
        v: 1;
        updatedAt: number;
        ref: ProviderBoundModelRef;
      }>,
      model: ProviderModelDescriptorV1,
      targetKey: string,
    ) => {
      return await createRuntimeProviderSpawnAuthorizationAttempt({
        selection,
        runtimeModelDescriptor: model,
        machineId,
        agentTargetKey: targetKey,
        agentId: 'claude',
        lease,
        getAccountSettingsSnapshot: () => ({
          source: 'network',
          settings: { providerSettingsV1: settings } as never,
          settingsVersion: 1,
          loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          scopeKey: 'account-g4-composed',
        }),
        resolveAddresses: async () => ['1.1.1.1'],
        materializationBaseDir: '/unused',
        sessionId: `session-${model.id}`,
      });
    };
    const authorize = async (
      targetKey: string,
      model: ProviderModelDescriptorV1,
    ) => {
      const selection: ProviderBoundModelRef = {
        agentTargetKey: targetKey,
        providerConnectionId: connectionId,
        modelId: model.id,
      };
      const result = await createAuthorizationAttempt(
        { v: 1, updatedAt: 2, ref: selection },
        model,
        targetKey,
      );
      if (!result.ok) {
        throw new Error(result.error.code);
      }
      try {
        return {
          selection,
          authorization: result.attempt.authorization,
        };
      } finally {
        result.attempt.cleanupOnFailure();
      }
    };

    confirm(agentTargetKey, haiku);
    const authorizedSelections: ProviderBoundModelRef[] = [];
    const preparedActiveHaiku = await prepareProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 2,
        ref: {
          agentTargetKey: 'agent:claude',
          providerConnectionId: connectionId,
          modelId: haiku.id,
        },
      },
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      machineId,
      agentId: 'claude',
      sessionId: 'session-active-haiku',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: true,
      resolvePrerequisites: async () => ({ ok: true }),
      createAuthorizationAttempt: async (context) => {
        authorizedSelections.push(context.selection.ref);
        return await createAuthorizationAttempt(
          context.selection,
          haiku,
          context.agentTargetKey,
        );
      },
    });
    if (!preparedActiveHaiku.ok || preparedActiveHaiku.kind !== 'provider') {
      throw new Error(
        preparedActiveHaiku.ok
          ? `Expected Provider launch, received ${preparedActiveHaiku.kind}`
          : preparedActiveHaiku.error.code,
      );
    }
    const authorizedPredecessorSelection = authorizedSelections[0];
    if (!authorizedPredecessorSelection) {
      preparedActiveHaiku.attempt.cleanupOnFailure();
      throw new Error('Expected the predecessor selection to reach authorization');
    }
    try {
      const activeHaiku = {
        selection: authorizedPredecessorSelection,
        authorization: preparedActiveHaiku.attempt.authorization,
      };
    expect(registry.activatedPluginIds.has('happier.agent.claude')).toBe(true);
    expect(registry.pluginDiagnosticsByPluginId['happier.agent.claude'] ?? [])
      .toEqual([]);
    confirm(agentTargetKey, sonnet);
    const nextSonnet = await authorize(agentTargetKey, sonnet);
    const activeTarget: AuthorizedSessionModelTransitionTarget = {
      selection: activeHaiku.selection,
      policy: 'live',
      providerBinding: null,
      sessionBindingMetadata:
        activeHaiku.authorization.sessionBindingMetadata,
      runtimeBindingBasis:
        projectProviderRuntimeBindingBasis(activeHaiku.authorization),
      revalidateBeforeEffect: async () => true,
    };

    expect({
      activeAgentTargetKey: activeHaiku.selection.agentTargetKey,
      activeRuntimeBindingBasisAgentTargetKey:
        activeHaiku.authorization.sessionBindingMetadata
          .runtimeBindingBasis?.agentTargetKey,
      nextAgentTargetKey:
        nextSonnet.authorization.binding.agentTargetKey,
      activeConnectionId:
        activeHaiku.authorization.binding.selection.connectionId,
      nextConnectionId:
        nextSonnet.authorization.binding.selection.connectionId,
      nextApplyPolicy: nextSonnet.authorization.support.applyPolicy,
      authorizationRoute: resolveSessionModelTransitionAuthorizationRoute(
        activeTarget,
        nextSonnet.selection,
      ).kind,
      runtimeBindingBasisEqual:
        sameProviderAuthorizationRuntimeBindingDimensions(
          activeHaiku.authorization,
          nextSonnet.authorization,
        ),
      resultingPolicy: resolveProviderAuthorizationApplyPolicyForActiveBinding({
        activeSelection: activeHaiku.selection,
        activeSessionBindingMetadata:
          activeHaiku.authorization.sessionBindingMetadata,
        next: nextSonnet.authorization,
      }),
    }).toMatchObject({
      activeAgentTargetKey: agentTargetKey,
      activeRuntimeBindingBasisAgentTargetKey: agentTargetKey,
      nextAgentTargetKey: agentTargetKey,
      activeConnectionId: connectionId,
      nextConnectionId: connectionId,
      nextApplyPolicy: 'live',
      authorizationRoute: 'authorize_same_binding',
      runtimeBindingBasisEqual: true,
      resultingPolicy: 'live',
    });
    } finally {
      preparedActiveHaiku.attempt.cleanupOnFailure();
    }
  });
});
