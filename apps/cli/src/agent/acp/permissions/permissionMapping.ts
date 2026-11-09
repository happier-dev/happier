import type { PermissionOption } from '@agentclientprotocol/sdk';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

/** ACP 1.2.1's "always" kinds are provider-owned lasting decisions, not host tool grants. */
export function createAcpNativePermissionChoices(
  requirementId: string,
  options: readonly PermissionOption[],
): NativePermissionChoicesV1 {
  return {
    requirementId,
    source: 'acp',
    choices: options.map((option) => {
      const approved = option.kind === 'allow_once' || option.kind === 'allow_always';
      const decision = approved ? 'approved' as const : 'denied' as const;
      return {
        id: option.optionId,
        label: option.name,
        scope: option.kind === 'allow_always' || option.kind === 'reject_always' ? 'localPersistent' : 'once',
        decision,
        response: { approved, decision },
      };
    }),
  };
}

export type PermissionOptionKind = PermissionOption['kind'] | string;

export type PermissionDecision = NativePermissionChoicesV1['choices'][number]['decision'];

export type PermissionOptionLike = {
  optionId?: string;
  name?: string;
  kind?: unknown;
};

export function normalizePermissionOptionKind(kind: unknown): PermissionOptionKind {
  if (typeof kind !== 'string') return '';
  return kind.trim().toLowerCase();
}

export function normalizePermissionDecision(decision: string): PermissionDecision | string {
  return decision.trim().toLowerCase();
}

export type PermissionOutcomeSelected = { outcome: 'selected'; optionId: string };
export type PermissionOutcomeCancelled = { outcome: 'cancelled' };
export type PermissionOutcome = PermissionOutcomeSelected | PermissionOutcomeCancelled;

function findByKind(options: ReadonlyArray<PermissionOptionLike>, kinds: string[]): PermissionOptionLike | undefined {
  return options.find(
    (opt) => kinds.includes(normalizePermissionOptionKind(opt.kind)) && typeof opt.optionId === 'string' && opt.optionId.length > 0,
  );
}

function findByOptionIdIncludes(options: ReadonlyArray<PermissionOptionLike>, needle: string): PermissionOptionLike | undefined {
  return options.find(
    (opt) => typeof opt.optionId === 'string' && opt.optionId.toLowerCase().includes(needle),
  );
}

export function pickPermissionOptionId(options: ReadonlyArray<PermissionOptionLike>, decision: PermissionDecision | string): string | null {
  const decisionLower = normalizePermissionDecision(String(decision));

  const allowAlways =
    findByKind(options, ['allow_always', 'allowalways'])
    ?? findByOptionIdIncludes(options, 'allow-always')
    ?? findByOptionIdIncludes(options, 'always');
  const allowOnce =
    findByKind(options, ['allow_once', 'allowonce'])
    ?? findByOptionIdIncludes(options, 'allow-once')
    ?? findByOptionIdIncludes(options, 'once');
  const rejectAlways =
    findByKind(options, ['reject_always', 'rejectalways'])
    ?? findByOptionIdIncludes(options, 'reject-always');
  const rejectOnce =
    findByKind(options, ['reject_once', 'rejectonce'])
    ?? findByOptionIdIncludes(options, 'reject-once')
    ?? findByOptionIdIncludes(options, 'reject')
    ?? findByOptionIdIncludes(options, 'deny');

  if (decisionLower === 'approved_for_session') {
    return (
      allowAlways?.optionId
      ?? allowOnce?.optionId
      ?? (typeof options[0]?.optionId === 'string' ? options[0]?.optionId : null)
    );
  }

  if (decisionLower === 'approved' || decisionLower === 'approved_execpolicy_amendment') {
    return (
      allowOnce?.optionId
      ?? allowAlways?.optionId
      ?? (typeof options[0]?.optionId === 'string' ? options[0]?.optionId : null)
    );
  }

  if (decisionLower === 'denied') {
    return (
      rejectOnce?.optionId
      ?? rejectAlways?.optionId
      ?? (typeof options[0]?.optionId === 'string' ? options[0]?.optionId : null)
    );
  }

  // abort (or unknown): prefer rejecting once if possible; callers may choose to return cancelled instead.
  return (
    rejectOnce?.optionId
    ?? rejectAlways?.optionId
    ?? findByOptionIdIncludes(options, 'cancel')?.optionId
    ?? (typeof options[0]?.optionId === 'string' ? options[0]?.optionId : null)
  );
}

export function pickPermissionOutcome(options: ReadonlyArray<PermissionOptionLike>, decision: PermissionDecision | string): PermissionOutcome {
  const decisionLower = normalizePermissionDecision(String(decision));

  // Spec: clients can return cancelled outcome for aborted permission prompts.
  if (decisionLower === 'abort') {
    return { outcome: 'cancelled' };
  }

  const optionId = pickPermissionOptionId(options, decision);
  if (!optionId) {
    // Fail closed: we can't select a meaningful option without an id.
    return { outcome: 'cancelled' };
  }

  return { outcome: 'selected', optionId };
}
