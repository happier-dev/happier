import {
  SESSION_PERMISSION_MODES,
  parseSessionPermissionModeAlias,
  type SessionPermissionMode,
} from '../sessions/metadata/sessionPermissionModes.js';
import {
  AgentPermissionIntentV1Schema,
  type AgentPermissionIntentV1,
} from '../runtime/permissionIntentV1.js';

export type PermissionPrivilegeOrdinal = 0 | 1 | 2 | 3;

export type EffectivePermissionModeFailureReason =
  | 'admitted_permission_ceiling_missing'
  | 'admitted_permission_ceiling_invalid'
  | 'current_permission_mode_invalid';

export type PermissionEscalationDecision =
  | Readonly<{
      ok: true;
      requestedMode: string;
      normalizedMode: SessionPermissionMode;
      requestedOrdinal: PermissionPrivilegeOrdinal;
      callerMode: string;
      callerOrdinal: PermissionPrivilegeOrdinal;
    }>
  | Readonly<{
      ok: false;
      reason: 'permission_escalation_denied';
      requestedMode: string;
      normalizedMode: SessionPermissionMode;
      requestedOrdinal: PermissionPrivilegeOrdinal;
      callerMode: string;
      callerOrdinal: PermissionPrivilegeOrdinal;
    }>
  | Readonly<{
      ok: false;
      reason: 'invalid_parameters';
      requestedMode: string;
      requestedOrdinal: null;
      callerMode: string;
      callerOrdinal: PermissionPrivilegeOrdinal;
    }>;

/**
 * The effective permission mode for one causally admitted turn. The admitted
 * ceiling is intentionally parsed through the strict runtime schema: it is an
 * authority fact, not display/session metadata that may fall back to default.
 */
export type EffectivePermissionModeResolution =
  | Readonly<{
      ok: true;
      currentMode: SessionPermissionMode;
      admittedPermissionCeiling: AgentPermissionIntentV1;
      effectiveMode: SessionPermissionMode;
      currentOrdinal: PermissionPrivilegeOrdinal;
      admittedCeilingOrdinal: PermissionPrivilegeOrdinal;
      effectiveOrdinal: PermissionPrivilegeOrdinal;
    }>
  | Readonly<{
      ok: false;
      reason: EffectivePermissionModeFailureReason;
    }>;

function parsePermissionModeForPrivilege(raw: unknown): SessionPermissionMode | null {
  if (typeof raw !== 'string') return null;
  return parseSessionPermissionModeAlias(raw);
}

function ordinalForSessionPermissionMode(mode: SessionPermissionMode): PermissionPrivilegeOrdinal {
  switch (mode) {
    case 'plan':
    case 'read-only':
      return 0;
    case 'default':
      return 1;
    case 'acceptEdits':
    case 'safe-yolo':
      return 2;
    case 'bypassPermissions':
    case 'yolo':
      return 3;
  }
}

function normalizeSupportedModes(
  supportedModes: readonly string[] | undefined,
): ReadonlyArray<Readonly<{
  requestedMode: string;
  normalizedMode: SessionPermissionMode;
  ordinal: PermissionPrivilegeOrdinal;
}>> {
  if (!supportedModes || supportedModes.length === 0) return [];
  const out: Array<Readonly<{
    requestedMode: string;
    normalizedMode: SessionPermissionMode;
    ordinal: PermissionPrivilegeOrdinal;
  }>> = [];
  const seen = new Set<string>();
  for (const mode of supportedModes) {
    if (typeof mode !== 'string') continue;
    const trimmed = mode.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    const normalizedMode = parsePermissionModeForPrivilege(trimmed);
    if (!normalizedMode) continue;
    seen.add(trimmed);
    out.push({
      requestedMode: trimmed,
      normalizedMode,
      ordinal: ordinalForSessionPermissionMode(normalizedMode),
    });
  }
  return out;
}

function parseCallerPermission(rawMode: unknown): Readonly<{
  mode: string;
  normalizedMode: SessionPermissionMode;
  ordinal: PermissionPrivilegeOrdinal;
}> {
  const normalizedMode = parsePermissionModeForPrivilege(rawMode) ?? 'default';
  return {
    mode: normalizedMode,
    normalizedMode,
    ordinal: ordinalForSessionPermissionMode(normalizedMode),
  };
}

export function resolvePermissionPrivilegeOrdinal(rawMode: unknown): PermissionPrivilegeOrdinal | null {
  const normalizedMode = parsePermissionModeForPrivilege(rawMode);
  return normalizedMode ? ordinalForSessionPermissionMode(normalizedMode) : null;
}

/**
 * Intersects the mutable current Session mode with immutable authority that
 * was admitted for this causal turn. All permission handlers use this before
 * selecting an immediate decision or creating/reconsidering a pending request.
 */
export function resolveEffectivePermissionMode(params: Readonly<{
  currentMode: unknown;
  admittedPermissionCeiling: unknown;
  supportedModes?: readonly string[];
}>): EffectivePermissionModeResolution {
  if (params.admittedPermissionCeiling === undefined || params.admittedPermissionCeiling === null) {
    return { ok: false, reason: 'admitted_permission_ceiling_missing' };
  }

  const parsedCeiling = AgentPermissionIntentV1Schema.safeParse(params.admittedPermissionCeiling);
  if (!parsedCeiling.success) {
    return { ok: false, reason: 'admitted_permission_ceiling_invalid' };
  }

  const currentMode = parsePermissionModeForPrivilege(params.currentMode);
  if (!currentMode) {
    return { ok: false, reason: 'current_permission_mode_invalid' };
  }

  const currentOrdinal = ordinalForSessionPermissionMode(currentMode);
  const admittedCeilingOrdinal = ordinalForSessionPermissionMode(parsedCeiling.data);
  // Equal ordinal is not equal permission authority. A causal admission has
  // an exact, immutable ceiling; selecting a sibling mode merely because it
  // shares a privilege bucket would let mutable Session state reinterpret the
  // admitted request. A strictly narrower current mode remains safe.
  if (currentOrdinal < admittedCeilingOrdinal || currentMode === parsedCeiling.data) {
    return {
      ok: true,
      currentMode,
      admittedPermissionCeiling: parsedCeiling.data,
      effectiveMode: currentMode,
      currentOrdinal,
      admittedCeilingOrdinal,
      effectiveOrdinal: currentOrdinal,
    };
  }

  const supportedModes = normalizeSupportedModes(params.supportedModes ?? SESSION_PERMISSION_MODES);
  const exactCeiling = supportedModes.find((mode) => mode.normalizedMode === parsedCeiling.data);
  const strictlyNarrower = supportedModes
    .filter((mode) => mode.ordinal < admittedCeilingOrdinal)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  const selected = exactCeiling ?? strictlyNarrower;
  // Do not substitute a same-ordinal sibling for an exact causal ceiling. If
  // the target cannot enact the admitted mode, it may only choose a strictly
  // narrower capability or reject the causal authority.
  if (!selected) {
    return { ok: false, reason: 'admitted_permission_ceiling_invalid' };
  }

  return {
    ok: true,
    currentMode,
    admittedPermissionCeiling: parsedCeiling.data,
    effectiveMode: selected.normalizedMode,
    currentOrdinal,
    admittedCeilingOrdinal,
    effectiveOrdinal: selected.ordinal,
  };
}

export function assertNonEscalatingPermissionMode(params: Readonly<{
  requestedMode: unknown;
  callerMode: unknown;
  supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
  const caller = parseCallerPermission(params.callerMode);
  const requestedRaw = typeof params.requestedMode === 'string' ? params.requestedMode.trim() : '';
  const requestedMode = parsePermissionModeForPrivilege(params.requestedMode);
  if (!requestedRaw || !requestedMode) {
    return {
      ok: false,
      reason: 'invalid_parameters',
      requestedMode: requestedRaw,
      requestedOrdinal: null,
      callerMode: caller.mode,
      callerOrdinal: caller.ordinal,
    };
  }

  const requestedOrdinal = ordinalForSessionPermissionMode(requestedMode);
  const requestedSupported = normalizeSupportedModes(params.supportedModes).find(
    (mode) => mode.normalizedMode === requestedMode || mode.requestedMode === requestedRaw,
  );
  const requestedOutputMode = requestedSupported?.requestedMode ?? requestedMode;

  if (requestedOrdinal > caller.ordinal) {
    return {
      ok: false,
      reason: 'permission_escalation_denied',
      requestedMode: requestedOutputMode,
      normalizedMode: requestedMode,
      requestedOrdinal,
      callerMode: caller.mode,
      callerOrdinal: caller.ordinal,
    };
  }

  return {
    ok: true,
    requestedMode: requestedOutputMode,
    normalizedMode: requestedMode,
    requestedOrdinal,
    callerMode: caller.mode,
    callerOrdinal: caller.ordinal,
  };
}

export function resolveNearestPermissionModeAtOrBelow(params: Readonly<{
  requestedMode: unknown;
  callerMode: unknown;
  supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
  if (typeof params.requestedMode === 'string' && params.requestedMode.trim().length > 0) {
    return assertNonEscalatingPermissionMode(params);
  }

  const caller = parseCallerPermission(params.callerMode);
  const selected = normalizeSupportedModes(params.supportedModes)
    .filter((mode) => mode.ordinal <= caller.ordinal)
    .sort((a, b) => b.ordinal - a.ordinal)[0];

  if (selected) {
    return {
      ok: true,
      requestedMode: selected.requestedMode,
      normalizedMode: selected.normalizedMode,
      requestedOrdinal: selected.ordinal,
      callerMode: caller.mode,
      callerOrdinal: caller.ordinal,
    };
  }

  return {
    ok: true,
    requestedMode: caller.mode,
    normalizedMode: caller.normalizedMode,
    requestedOrdinal: caller.ordinal,
    callerMode: caller.mode,
    callerOrdinal: caller.ordinal,
  };
}
