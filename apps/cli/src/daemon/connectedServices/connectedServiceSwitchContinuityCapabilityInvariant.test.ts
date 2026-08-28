// F4 invariant (connected-services reliability hardening): every provider
// continuity resolver must stay consistent with its state-sharing descriptor and
// public Agent declaration/catalog entry. "Needs restart/rematerialization" and "requires
// shared vendor state" are separate concepts — a provider whose descriptor does
// not support shared state must never resolve a shared-state-required continuity
// mode, and a resolver-supported switch transition must be advertised by the
// public declaration.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentConnectedAccountSwitchTransitionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId, ConnectedServiceSwitchContinuityParams } from '@/agent/catalog/types';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const acquireAuthoritativePluginRuntimeRegistryLease = vi.hoisted(() => vi.fn());
vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease,
}));

import {
  getConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceSwitchContinuity,
} from './catalogHooks';

const CONTINUITY_PROVIDERS = ['codex', 'claude', 'gemini', 'opencode', 'pi'] as const;
const RESOLVED_TRANSITION_FIXTURES: ReadonlyArray<{
  name: string;
  transition: AgentConnectedAccountSwitchTransitionV1;
  createParams: (
    agentId: CatalogAgentId,
    serviceId: ConnectedServiceId,
  ) => ConnectedServiceSwitchContinuityParams;
}> = [
  {
    name: 'connected-to-connected',
    transition: 'connected_to_connected',
    createParams: createChangedConnectedProfileParams,
  },
  {
    name: 'native-to-connected',
    transition: 'native_to_connected',
    createParams: createNativeToConnectedProfileParams,
  },
];

async function resolvePrimaryServiceId(
  runtime: ResolvedExecutablePluginRuntimeRegistry,
  agentId: CatalogAgentId,
): Promise<ConnectedServiceId> {
  const entry = await runtime.acquireAgentCatalogEntry?.(agentId);
  const serviceId = entry?.connectedAccountServiceIds?.[0];
  if (!serviceId) {
    throw new Error(`missing public connected-account service declaration for ${agentId}`);
  }
  return serviceId;
}

async function declarationAdvertisesSwitchTransition(
  runtime: ResolvedExecutablePluginRuntimeRegistry,
  input: Readonly<{
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    transition: AgentConnectedAccountSwitchTransitionV1;
  }>,
): Promise<boolean> {
  const entry = await runtime.acquireAgentCatalogEntry?.(input.agentId);
  const switchCapability = entry?.connectedAccountSwitchContinuity;
  if (!switchCapability?.continuityMode) {
    return false;
  }
  const supportedTransitions = switchCapability.supportedTransitions;
  if (!supportedTransitions || supportedTransitions.includes(input.transition)) {
    return true;
  }
  const stateSharingRequired = switchCapability.providerStateSharingRequired;
  if (!stateSharingRequired?.supportedTransitions.includes(input.transition)) {
    return false;
  }
  const serviceIds = stateSharingRequired.serviceIds;
  if (serviceIds && !serviceIds.includes(input.serviceId)) {
    return false;
  }
  return true;
}

function createChangedConnectedProfileParams(
  agentId: CatalogAgentId,
  serviceId: ConnectedServiceId,
): ConnectedServiceSwitchContinuityParams {
  return {
    sessionId: 'session-1',
    agentId,
    serviceId,
    previousBinding: {
      source: 'connected',
      selection: 'profile',
      serviceId,
      profileId: 'old',
      groupId: null,
    },
    nextBinding: {
      source: 'connected',
      selection: 'profile',
      serviceId,
      profileId: 'new',
      groupId: null,
    },
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        [serviceId]: { source: 'connected', selection: 'profile', profileId: 'old' },
      },
    },
    toBindings: {
      v: 1,
      bindingsByServiceId: {
        [serviceId]: { source: 'connected', selection: 'profile', profileId: 'new' },
      },
    },
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'materialization-1',
      createdAt: 1,
    },
    vendorResumeId: 'vendor-session-1',
  };
}

function createNativeToConnectedProfileParams(
  agentId: CatalogAgentId,
  serviceId: ConnectedServiceId,
): ConnectedServiceSwitchContinuityParams {
  return {
    ...createChangedConnectedProfileParams(agentId, serviceId),
    previousBinding: {
      source: 'native',
      selection: 'native',
      serviceId,
      profileId: null,
      groupId: null,
    },
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        [serviceId]: { source: 'native' },
      },
    },
  };
}

describe('connected-service switch continuity capability invariants', () => {
  let runtime!: ResolvedExecutablePluginRuntimeRegistry;

  beforeAll(async () => {
    runtime = await resolveExecutablePluginRuntimeRegistry();
    acquireAuthoritativePluginRuntimeRegistryLease.mockImplementation(async () => ({
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    }));
  });

  afterAll(async () => {
    await runtime.dispose();
  });

  it.each(CONTINUITY_PROVIDERS)(
    'keeps %s public switch declaration aligned with its state-sharing descriptor',
    async (agentId) => {
      const entry = await runtime.acquireAgentCatalogEntry?.(agentId);
      const descriptor = await getConnectedServiceStateSharingDescriptor(agentId);
      const descriptorSupportsSharedState = descriptor?.state.supported === true;
      const requiresSharedState = entry?.connectedAccountSwitchContinuity
        ?.providerStateSharingRequired !== undefined;

      if (requiresSharedState) {
        expect(descriptorSupportsSharedState).toBe(true);
      }
    },
  );

  it.each(CONTINUITY_PROVIDERS)(
    'does not let %s require shared-state continuity without descriptor support',
    async (agentId) => {
      const descriptor = await getConnectedServiceStateSharingDescriptor(agentId);
      const serviceId = await resolvePrimaryServiceId(runtime, agentId);
      const paramsByTransition = [
        createChangedConnectedProfileParams(agentId, serviceId),
        createNativeToConnectedProfileParams(agentId, serviceId),
      ];

      for (const params of paramsByTransition) {
        const result = await resolveConnectedServiceSwitchContinuity(agentId, params);

        if (descriptor?.state.supported === true) {
          continue;
        }
        expect(result.mode).not.toBe('restart_shared_state_required');
      }
    },
  );

  it.each(CONTINUITY_PROVIDERS)(
    'advertises every %s resolver-supported transition in its public Agent declaration',
    async (agentId) => {
      const serviceId = await resolvePrimaryServiceId(runtime, agentId);

      for (const fixture of RESOLVED_TRANSITION_FIXTURES) {
        const result = await resolveConnectedServiceSwitchContinuity(
          agentId,
          fixture.createParams(agentId, serviceId),
        );

        if (result.mode === 'unsupported') {
          continue;
        }
        expect(
          await declarationAdvertisesSwitchTransition(runtime, {
            agentId,
            serviceId,
            transition: fixture.transition,
          }),
          `${agentId} resolver supports ${fixture.name} with ${result.mode}, but the manifest does not advertise ${fixture.transition}`,
        ).toBe(true);
      }
    },
  );
});
