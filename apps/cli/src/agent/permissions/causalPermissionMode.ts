import type { PermissionMode } from '@/api/types';
import { resolveEffectivePermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import type { EffectivePermissionModeFailureReason, SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';

export type CausalPermissionModeResolution =
  | Readonly<{
      ok: true;
      authority: 'legacy' | 'admittedSessionInputV1' | 'unattributedNativeApproval';
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
  if (context?.requireExplicitApproval) {
    const resolved = resolveEffectivePermissionMode({
      currentMode: params.currentPermissionMode,
      admittedPermissionCeiling: 'default',
      supportedModes: params.supportedModes,
    });
    return resolved.ok
      ? { ok: true, authority: 'unattributedNativeApproval', effectiveMode: resolved.effectiveMode }
      : { ok: false, reason: resolved.reason };
  }
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
  const currentCaller = context && Object.hasOwn(context, 'callerPermissionMode')
    ? resolveEffectivePermissionMode({
        currentMode: context.callerPermissionMode,
        admittedPermissionCeiling: parseAgentPermissionIntentV1Alias(resolved.effectiveMode),
        supportedModes: params.supportedModes,
      })
    : resolved;
  if (!currentCaller.ok) return { ok: false, reason: currentCaller.reason };

  return {
    ok: true,
    authority: 'admittedSessionInputV1',
    effectiveMode: currentCaller.effectiveMode,
    ...(authority.sourceAuthority ? { sourceAuthority: authority.sourceAuthority } : {}),
  };
}
