import { resolve } from 'node:path';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import {
  readConnectedServiceChildSelectionsFromEnv,
} from '../../connectedServiceChildEnvironment';
import { resolveConnectedServiceGroupHomeDir } from '../../homes/resolveConnectedServiceHomeDir';
import type {
  ConnectedServiceRuntimeAuthApplyCapability,
  ConnectedServicePredictiveSoftSwitchLiveSessionRequirement,
} from '../../credentials/lifecycleTypes';
import type { CatalogAgentId } from '@/backends/types';

type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'same_provider_account_exhausted'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';

type PredictiveSoftSwitchTurnState = Readonly<{
  inFlight: boolean;
  safeToApply?: boolean;
}>;

type PredictiveSoftSwitchSessionApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type ConnectedServiceSwitchApplyMode =
  | 'direct_live_hot_auth'
  | PredictiveSoftSwitchSessionApplyMode
  | 'transport_recycle';

type ConnectedServiceSwitchApplyContext =
  | 'pre_spawn'
  | 'healthy_live_session'
  | 'healthy_sibling'
  | 'original_failed_session'
  | 'manual';

export type ConnectedServiceSwitchApplyPolicyDecision =
  | Readonly<{
      status: 'allow';
      allowDirectLiveHotApply: boolean;
      allowTransportRecycle: boolean;
      allowRestartResume: boolean;
    }>
  | Readonly<{
      status: 'defer';
      reason: 'turn_boundary_required';
      policy: 'defer_until_turn_boundary';
      allowDirectLiveHotApply: boolean;
      allowTransportRecycle: boolean;
      allowRestartResume: boolean;
    }>
  | Readonly<{
      status: 'suppress';
      reason: 'direct_live_hot_apply_required';
      allowDirectLiveHotApply: boolean;
      allowTransportRecycle: boolean;
      allowRestartResume: boolean;
    }>;

export type PredictiveSoftSwitchPolicyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason:
        | 'predictive_soft_switch_restart_required'
        | 'predictive_soft_switch_turn_in_flight'
        | 'predictive_soft_switch_shared_group_auth_surface_required'
        | 'predictive_soft_switch_session_not_tracked';
    }>;

export type PredictiveSoftSwitchSessionApplyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason: 'predictive_soft_switch_hot_apply_required';
    }>;

type PredictiveSoftSwitchContext = 'pre_spawn' | 'live_session';

function normalizeDirectApplyMode(mode: ConnectedServiceSwitchApplyMode | null | undefined): 'direct_live_hot_auth' | Exclude<ConnectedServiceSwitchApplyMode, 'direct_live_hot_auth' | 'hot_apply'> | null {
  if (mode === undefined || mode === null) return null;
  return mode === 'hot_apply' ? 'direct_live_hot_auth' : mode;
}

function supportsInTurnDirectLiveHotAuth(
  capability: ConnectedServiceRuntimeAuthApplyCapability | null | undefined,
): boolean {
  const directLiveHotAuth = capability?.directLiveHotAuth;
  if (typeof directLiveHotAuth !== 'object') return false;
  if (directLiveHotAuth.supportsInTurnApply !== true) return false;
  if (directLiveHotAuth.requiresExactRuntimeIdentity !== true) return false;

  const { authMode } = directLiveHotAuth;
  if (authMode.kind === 'external_token_injection') {
    return directLiveHotAuth.refreshSelectionResync === 'required'
      && authMode.surface.trim().length > 0;
  }

  if (authMode.kind === 'provider_owned') {
    return directLiveHotAuth.refreshSelectionResync === 'not_applicable'
      && authMode.name.trim().length > 0;
  }

  return directLiveHotAuth.refreshSelectionResync === 'not_applicable';
}

function supportsDirectLiveHotAuth(
  capability: ConnectedServiceRuntimeAuthApplyCapability | null | undefined,
): boolean {
  const directLiveHotAuth = capability?.directLiveHotAuth;
  if (typeof directLiveHotAuth !== 'object') return false;

  const { authMode } = directLiveHotAuth;
  if (authMode.kind === 'external_token_injection') {
    return directLiveHotAuth.refreshSelectionResync === 'required'
      && authMode.surface.trim().length > 0;
  }

  if (authMode.kind === 'provider_owned') {
    return directLiveHotAuth.refreshSelectionResync === 'not_applicable'
      && authMode.name.trim().length > 0;
  }

  return directLiveHotAuth.refreshSelectionResync === 'not_applicable';
}

/**
 * Does this provider's runtime require a LIVE session-runtime identity probe to prove which account a
 * live session is on, for same-account fanout reconciliation?
 *
 * - `true`  — the account binding lives INSIDE the runtime process and can drift without the daemon
 *   knowing (codex: `requiresExactRuntimeIdentity: true`, external token injection). The fanout MUST
 *   re-probe the live runtime before switching a candidate.
 * - `false` — the account binding is DAEMON-authoritative via broker/shared-group indirection
 *   (opencode/pi/claude: `requiresExactRuntimeIdentity: false`, `provider_owned` broker selection).
 *   The daemon already owns the effective selection, so the daemon's own indexed identity is
 *   authoritative and a live session-runtime probe is neither needed NOR answerable — demanding one
 *   only strands the candidate on an unsupported RPC.
 *
 * Unknown / `unsupported` apply capability fails toward `true` (keep the conservative live-probe path).
 */
export function runtimeAuthApplyRequiresLiveIdentityProbe(
  capability: ConnectedServiceRuntimeAuthApplyCapability | null | undefined,
): boolean {
  const directLiveHotAuth = capability?.directLiveHotAuth;
  if (typeof directLiveHotAuth !== 'object') return true;
  return directLiveHotAuth.requiresExactRuntimeIdentity === true;
}

export function evaluateConnectedServiceSwitchApplyPolicy(input: Readonly<{
  context: ConnectedServiceSwitchApplyContext;
  reason: PredictiveSoftSwitchReason | 'manual' | 'diagnostic' | string;
  applyMode?: ConnectedServiceSwitchApplyMode | null;
  turnState?: PredictiveSoftSwitchTurnState | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): ConnectedServiceSwitchApplyPolicyDecision {
  const directLiveOnly =
    (
      input.context !== 'pre_spawn'
      && supportsDirectLiveHotAuth(input.runtimeAuthApply)
    )
    || input.context === 'healthy_sibling'
    || input.context === 'healthy_live_session'
    || input.reason === 'same_provider_account_exhausted'
    || input.reason === 'soft_threshold';
  if (directLiveOnly) {
    if (
      input.context === 'healthy_sibling'
      && input.turnState?.inFlight === true
      && input.turnState.safeToApply === false
      && !supportsInTurnDirectLiveHotAuth(input.runtimeAuthApply)
    ) {
      return {
        status: 'defer',
        reason: 'turn_boundary_required',
        policy: 'defer_until_turn_boundary',
        allowDirectLiveHotApply: true,
        allowTransportRecycle: false,
        allowRestartResume: false,
      };
    }
    const applyMode = normalizeDirectApplyMode(input.applyMode);
    if (applyMode === null || applyMode === 'direct_live_hot_auth') {
      return {
        status: 'allow',
        allowDirectLiveHotApply: true,
        allowTransportRecycle: false,
        allowRestartResume: false,
      };
    }
    return {
      status: 'suppress',
      reason: 'direct_live_hot_apply_required',
      allowDirectLiveHotApply: true,
      allowTransportRecycle: false,
      allowRestartResume: false,
    };
  }

  if (input.context === 'pre_spawn') {
    return {
      status: 'allow',
      allowDirectLiveHotApply: false,
      allowTransportRecycle: false,
      allowRestartResume: false,
    };
  }

  return {
    status: 'allow',
    allowDirectLiveHotApply: true,
    allowTransportRecycle: true,
    allowRestartResume: true,
  };
}

function pathEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  return leftTrimmed.length > 0 && rightTrimmed.length > 0 && resolve(leftTrimmed) === resolve(rightTrimmed);
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
    const selection = readConnectedServiceChildSelectionsFromEnv(input.env ?? {})
      .find((candidate) => candidate.serviceId === input.serviceId);
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
  context: PredictiveSoftSwitchContext;
  reason: PredictiveSoftSwitchReason;
  predictiveSoftSwitchMode: PredictiveSoftSwitchCapability;
  turnState?: PredictiveSoftSwitchTurnState | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  // RD-QUO-10: the restart-required suppression only applies to LIVE sessions —
  // applying a predictive switch there would force a hot apply or a restart. At
  // pre-spawn time there is no live runtime: the new process materializes the
  // freshly selected member, so restart-only providers may still rotate below
  // the soft threshold (plan-6 pre-turn contract).
  if (input.context === 'live_session' && input.predictiveSoftSwitchMode !== 'supported') {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    };
  }
  if (
    input.turnState?.inFlight === true
    && !supportsInTurnDirectLiveHotAuth(input.runtimeAuthApply)
  ) {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    };
  }
  return { status: 'allow' };
}

export function evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  hasTrackedRuntime: boolean;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  if (input.hasTrackedRuntime) return { status: 'allow' };
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_session_not_tracked',
  };
}

export function evaluatePredictiveSoftSwitchSessionApplyPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  sessionId?: string | null;
  applyMode?: PredictiveSoftSwitchSessionApplyMode | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): PredictiveSoftSwitchSessionApplyDecision {
  const decision = evaluateConnectedServiceSwitchApplyPolicy({
    context: input.reason === 'same_provider_account_exhausted'
      ? 'healthy_sibling'
      : input.reason === 'soft_threshold'
        ? 'healthy_live_session'
        : input.reason === 'usage_limit'
          ? 'original_failed_session'
          : 'manual',
    reason: input.reason,
    applyMode: input.applyMode,
    runtimeAuthApply: input.runtimeAuthApply,
  });
  if (decision.status === 'allow') return { status: 'allow' };
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return { status: 'allow' };
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_hot_apply_required',
  };
}
