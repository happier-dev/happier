import type { ApprovalAutomaticChecksV1 } from '@happier-dev/protocol/approvals/approvalAutomaticChecks';

type ApprovalAutomaticChecksDecision =
  | Readonly<{ kind: 'consent'; automationId: string; triggerId: ApprovalAutomaticChecksV1['consents'][number]['triggerId'] }>
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'override' }>
  | null;

/** The decision offered while the approval owner's recorded before checks hold an Action. */
export function readApprovalAutomaticChecksDecision(
  checks: ApprovalAutomaticChecksV1 | null | undefined,
): ApprovalAutomaticChecksDecision {
  if (checks?.phase === 'consent') {
    const pending = checks.consents.find(consent => consent.decision === 'pending');
    return pending ? { kind: 'consent', automationId: pending.automationId, triggerId: pending.triggerId } : null;
  }
  if (checks?.phase === 'checking') return { kind: 'checking' };
  if (checks?.phase === 'override') return { kind: 'override' };
  return null;
}
