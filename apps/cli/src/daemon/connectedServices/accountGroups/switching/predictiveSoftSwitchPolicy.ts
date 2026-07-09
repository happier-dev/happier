import { resolve } from 'node:path';

import type {
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type {
  CatalogAgentId,
  ConnectedServicePredictiveSoftSwitchLiveSessionRequirement,
  ConnectedServiceRuntimeAuthApplyCapability,
} from '@/agent/catalog/types';
import { readConnectedServiceChildSelectionsFromEnv } from '../../connectedServiceChildEnvironment';
import { resolveConnectedServiceGroupHomeDir } from '../../homes/resolveConnectedServiceHomeDir';

type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'same_provider_account_exhausted'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';
type PredictiveSoftSwitchSessionApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type PredictiveSoftSwitchTurnState = Readonly<{
  inFlight: boolean;
}>;

export type PredictiveSoftSwitchPolicyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'defer';
      reason: 'predictive_soft_switch_defer_until_turn_boundary';
    }>
  | Readonly<{
      status: 'suppress';
      reason:
        | 'predictive_soft_switch_restart_required'
        | 'predictive_soft_switch_turn_in_flight'
        | 'predictive_soft_switch_shared_group_auth_surface_required';
    }>;

export type PredictiveSoftSwitchSessionApplyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason: 'predictive_soft_switch_hot_apply_required';
    }>;

function pathEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  return leftTrimmed.length > 0 && rightTrimmed.length > 0 && resolve(leftTrimmed) === resolve(rightTrimmed);
}

function supportsInTurnDirectLiveHotAuth(
  capability: ConnectedServiceRuntimeAuthApplyCapability | null | undefined,
): boolean {
  const directLiveHotAuth = capability?.directLiveHotAuth;
  if (typeof directLiveHotAuth !== 'object') return false;
  if (directLiveHotAuth.supportsInTurnApply !== true) return false;
  if (directLiveHotAuth.requiresExactRuntimeIdentity !== true) return false;

  const { authMode } = directLiveHotAuth;
  if (authMode === null || typeof authMode !== 'object') return false;
  if (authMode.kind === 'external_token_injection') {
    return directLiveHotAuth.refreshSelectionResync === 'required'
      && typeof authMode.surface === 'string'
      && authMode.surface.trim().length > 0;
  }
  if (authMode.kind === 'provider_owned') {
    return directLiveHotAuth.refreshSelectionResync === 'not_applicable'
      && typeof authMode.name === 'string'
      && authMode.name.trim().length > 0;
  }
  if (authMode.kind === 'managed_provider_session' || authMode.kind === 'api_key') {
    return directLiveHotAuth.refreshSelectionResync === 'not_applicable';
  }
  return false;
}

export function evaluatePredictiveSoftSwitchLiveSessionRequirement(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  requirement?: ConnectedServicePredictiveSoftSwitchLiveSessionRequirement | null;
  activeServerDir: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  env?: Pick<NodeJS.ProcessEnv, string> | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  const requirement = input.requirement ?? { kind: 'none' as const };
  if (requirement.kind === 'none') return { status: 'allow' };

  if (requirement.kind === 'shared_group_auth_surface') {
    if (!requirement.serviceIds.includes(input.serviceId)) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }
    const selection = readConnectedServiceChildSelectionsFromEnv(input.env ?? {})?.get(input.serviceId) ?? null;
    if (
      selection?.kind !== 'group'
      || selection.groupId !== input.groupId
      || selection.activeProfileId !== input.activeProfileId
    ) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }

    const expectedBase = resolveConnectedServiceGroupHomeDir({
      activeServerDir: input.activeServerDir,
      serviceId: input.serviceId,
      groupId: input.groupId,
      agentId: input.agentId,
    });
    const expectedAuthSurface = requirement.authEnvSubpath && requirement.authEnvSubpath.length > 0
      ? resolve(expectedBase, ...requirement.authEnvSubpath)
      : expectedBase;
    const actualAuthSurface = typeof requirement.authEnvKey === 'string'
      ? input.env?.[requirement.authEnvKey]
      : null;
    if (!pathEquals(actualAuthSurface, expectedAuthSurface)) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }
  }

  return { status: 'allow' };
}

export function evaluatePredictiveSoftSwitchPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  predictiveSoftSwitchMode: PredictiveSoftSwitchCapability;
  turnState?: PredictiveSoftSwitchTurnState | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') {
    return { status: 'allow' };
  }
  if (input.predictiveSoftSwitchMode !== 'supported') {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    };
  }
  if (input.turnState?.inFlight === true) {
    if (supportsInTurnDirectLiveHotAuth(input.runtimeAuthApply)) {
      return { status: 'allow' };
    }
    if (input.reason === 'same_provider_account_exhausted') {
      return {
        status: 'defer',
        reason: 'predictive_soft_switch_defer_until_turn_boundary',
      };
    }
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    };
  }
  return { status: 'allow' };
}

export function evaluatePredictiveSoftSwitchSessionApplyPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  sessionId?: string | null;
  applyMode?: PredictiveSoftSwitchSessionApplyMode | null;
}>): PredictiveSoftSwitchSessionApplyDecision {
  if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') return { status: 'allow' };
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return { status: 'allow' };
  if (input.applyMode === undefined || input.applyMode === null || input.applyMode === 'hot_apply') {
    return { status: 'allow' };
  }
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_hot_apply_required',
  };
}
