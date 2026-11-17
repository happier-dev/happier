import { resolveEffectivePermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import type { SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { PermissionMode } from '@/api/types';

import { normalizePermissionModeToIntent } from './modeCanonical';

export function resolvePermissionModeForQueueingUserMessage(opts: {
  currentPermissionMode: PermissionMode | undefined;
  messagePermissionModeRaw: unknown;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
}): { ok: true; currentPermissionMode: PermissionMode | undefined; queuePermissionMode: PermissionMode; didChange: boolean }
  | { ok: false; reason: 'permission_mode_not_granted' } {
  const baseline = normalizePermissionModeToIntent(opts.currentPermissionMode) ?? opts.currentPermissionMode;
  // Send carries turn intent. Only the immediate mode Action changes the
  // Session baseline; steering still compares canonical effective modes.
  const requestedMode = normalizePermissionModeToIntent(opts.messagePermissionModeRaw) ?? baseline ?? 'default';
  // Resolve once at queue admission, before choosing new-turn or steer delivery.
  // Runtime configuration and replacement consume this admitted effective mode.
  const authority = opts.causalPermissionAuthority;
  const effective = authority ? resolveEffectivePermissionMode({
    currentMode: requestedMode, admittedPermissionCeiling: authority.admittedPermissionCeiling,
  }) : null;
  if (effective && !effective.ok) return { ok: false, reason: 'permission_mode_not_granted' };
  const queuePermissionMode = effective?.ok ? effective.effectiveMode : requestedMode;
  return {
    ok: true,
    currentPermissionMode: baseline,
    queuePermissionMode,
    didChange: queuePermissionMode !== (baseline ?? 'default'),
  };
}
