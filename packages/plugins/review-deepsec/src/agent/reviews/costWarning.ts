import type { DeepSecReviewMode } from './command.js';

export type DeepSecCostWarningInput = Readonly<{
  mode: DeepSecReviewMode;
  confirmedCostWarning: boolean;
}>;

export type DeepSecCostWarningReason =
  | 'repository_scan'
  | 'paid_review';

export type DeepSecCostWarningResult =
  | Readonly<{ status: 'ok' }>
  | Readonly<{
      status: 'requires_confirmation';
      costClass: 'expensive';
      reason: DeepSecCostWarningReason;
      messageKey: string;
    }>;

export function buildDeepSecCostWarning(input: DeepSecCostWarningInput): DeepSecCostWarningResult {
  if (input.confirmedCostWarning) return { status: 'ok' };
  return {
    status: 'requires_confirmation',
    costClass: 'expensive',
    reason: input.mode === 'repository_security_audit' ? 'repository_scan' : 'paid_review',
    messageKey: 'plugins.deepsec.costWarning.expensive',
  };
}
