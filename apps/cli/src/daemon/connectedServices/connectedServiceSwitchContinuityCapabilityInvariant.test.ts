// F4 invariant (connected-services reliability hardening): every provider
// continuity resolver must stay consistent with its state-sharing descriptor and
// shared manifest/catalog entry. "Needs restart/rematerialization" and "requires
// shared vendor state" are separate concepts — a provider whose descriptor does
// not support shared state must never resolve a shared-state-required continuity
// mode, and a resolver-supported switch transition must be advertised by the
// shared manifest.
import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import type { AgentCore, AgentSessionAuthSwitchTransition } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId, ConnectedServiceSwitchContinuityParams } from '@/agent/catalog/types';
import {
  getConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceSwitchContinuity,
} from './catalogHooks';

const CONTINUITY_PROVIDERS = ['codex', 'claude', 'gemini', 'opencode', 'pi'] as const;
const RESOLVED_TRANSITION_FIXTURES: ReadonlyArray<{
  name: string;
  transition: AgentSessionAuthSwitchTransition;
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

function resolveManifestAgentCore(agentId: CatalogAgentId): AgentCore {
  return AGENTS_CORE[agentId];
}

function resolvePrimaryServiceId(agentId: CatalogAgentId): ConnectedServiceId {
  const serviceId = resolveManifestAgentCore(agentId).connectedServices?.supportedServiceIds[0];
  if (!serviceId) {
    throw new Error(`missing connected-service fixture service id for ${agentId}`);
  }
  return serviceId;
}

function manifestSupportsSharedState(agentId: CatalogAgentId): boolean {
  return resolveManifestAgentCore(agentId).connectedServices?.providerStateSharing?.state.supported === true;
}

function manifestAdvertisesSwitchTransition(input: Readonly<{
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  transition: AgentSessionAuthSwitchTransition;
}>): boolean {
  const switchCapability = resolveManifestAgentCore(input.agentId).connectedServices?.sessionAuthSwitch;
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
  it.each(CONTINUITY_PROVIDERS)(
    'keeps %s state-sharing manifest capability aligned with its descriptor',
    async (agentId) => {
      const descriptor = await getConnectedServiceStateSharingDescriptor(agentId);
      const descriptorSupportsSharedState = descriptor?.state.supported === true;

      expect(manifestSupportsSharedState(agentId)).toBe(descriptorSupportsSharedState);
    },
  );

  it.each(CONTINUITY_PROVIDERS)(
    'does not let %s require shared-state continuity without descriptor support',
    async (agentId) => {
      const descriptor = await getConnectedServiceStateSharingDescriptor(agentId);
      const serviceId = resolvePrimaryServiceId(agentId);
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
    'advertises every %s resolver-supported transition in the shared manifest',
    async (agentId) => {
      const serviceId = resolvePrimaryServiceId(agentId);

      for (const fixture of RESOLVED_TRANSITION_FIXTURES) {
        const result = await resolveConnectedServiceSwitchContinuity(
          agentId,
          fixture.createParams(agentId, serviceId),
        );

        if (result.mode === 'unsupported') {
          continue;
        }
        expect(
          manifestAdvertisesSwitchTransition({
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
