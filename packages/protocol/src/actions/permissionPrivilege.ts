import {
  SESSION_PERMISSION_MODES,
  type SessionPermissionMode,
} from '../sessions/metadata/sessionPermissionModes.js';

export type PermissionPrivilegeOrdinal = 0 | 1 | 2 | 3;

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

const SESSION_PERMISSION_MODE_SET = new Set<string>(SESSION_PERMISSION_MODES);

function normalizePermissionToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}
function parsePermissionModeForPrivilege(raw: unknown): SessionPermissionMode | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SESSION_PERMISSION_MODE_SET.has(trimmed)) return trimmed as SessionPermissionMode;

  switch (normalizePermissionToken(trimmed)) {
    case 'plan':
      return 'plan';

    case 'read':
    case 'read-only':
    case 'readonly':
    case 'no-tools':
    case 'notools':
    case 'ro':
      return 'read-only';

    case 'default':
    case 'ask':
    case 'prompt':
    case 'normal':
      return 'default';

    case 'acceptedits':
    case 'accept-edits':
      return 'acceptEdits';

    case 'safe':
    case 'safe-yolo':
    case 'safeyolo':
    case 'workspace':
    case 'workspace-write':
    case 'workspacewrite':
    case 'auto':
    case 'auto-edit':
      return 'safe-yolo';

    case 'bypasspermissions':
    case 'bypass-permissions':
      return 'bypassPermissions';

    case 'yolo':
    case 'full':
    case 'full-access':
    case 'bypass':
    case 'dontask':
    case 'dont-ask':
    case 'danger':
    case 'danger-full-access':
      return 'yolo';

    default:
      return null;
  }
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
