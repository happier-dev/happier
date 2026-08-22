import type { PermissionMode } from '@/api/types';
import {
  resolveEffectivePermissionMode,
  type EffectivePermissionModeFailureReason,
  SessionInputCausalPermissionAuthorityV1Schema,
  type SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';

export type CausalPermissionModeResolution =
  | Readonly<{
      ok: true;
      authority: 'legacy' | 'admittedSessionInputV1';
      effectiveMode: PermissionMode;
      sourceAuthority?: NonNullable<SessionInputCausalPermissionAuthorityV1['sourceAuthority']>;
    }>
  | Readonly<{
      ok: false;
      reason: EffectivePermissionModeFailureReason | 'causal_permission_authority_invalid';
    }>;

/**
 * The ACP boundary owns only the distinction between a legacy host operation
 * and a causally admitted turn. Privilege ordering remains exclusively in the
 * Protocol resolver.
 */
export function resolveCausalPermissionMode(params: Readonly<{
  currentPermissionMode: PermissionMode;
  context?: AcpPermissionCallContext;
  supportedModes?: readonly string[];
}>): CausalPermissionModeResolution {
  const context = params.context;
  // An agent action is causally bound only when the host stamps this own
  // field. Its value may be null/undefined at a broken or first-turn seam;
  // that is non-authorizing rather than a legacy operation.
  if (!context || !Object.prototype.hasOwnProperty.call(context, 'causalPermissionAuthority')) {
    return {
      ok: true,
      authority: 'legacy',
      effectiveMode: params.currentPermissionMode,
    };
  }

  const parsedCausal = SessionInputCausalPermissionAuthorityV1Schema.safeParse(
    context.causalPermissionAuthority,
  );
  if (!parsedCausal.success) {
    return { ok: false, reason: 'causal_permission_authority_invalid' };
  }

  const authority = parsedCausal.data;

  const resolved = resolveEffectivePermissionMode({
    currentMode: params.currentPermissionMode,
    admittedPermissionCeiling: authority.admittedPermissionCeiling,
    supportedModes: params.supportedModes,
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  return {
    ok: true,
    authority: 'admittedSessionInputV1',
    effectiveMode: resolved.effectiveMode,
    ...(authority.sourceAuthority ? { sourceAuthority: authority.sourceAuthority } : {}),
  };
}
