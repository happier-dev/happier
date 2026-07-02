import type { DeepSecReviewMode } from './command.js';

export type DeepSecCostWarningInput = Readonly<{
  mode: DeepSecReviewMode;
  changedFileCount?: number;
  diffBytes?: number;
  selectedFileCount?: number;
  selectedBytes?: number;
  largestSelectedFileBytes?: number;
  thresholds?: Partial<DeepSecCostWarningThresholds>;
}>;

export type DeepSecCostWarningThresholds = Readonly<{
  changedFileCount: number;
  diffBytes: number;
  selectedFileCount: number;
  selectedBytes: number;
  largestSelectedFileBytes: number;
}>;

export const DEFAULT_DEEPSEC_COST_WARNING_THRESHOLDS: DeepSecCostWarningThresholds = Object.freeze({
  changedFileCount: 50,
  diffBytes: 2 * 1024 * 1024,
  selectedFileCount: 100,
  selectedBytes: 10 * 1024 * 1024,
  largestSelectedFileBytes: 5 * 1024 * 1024,
});

export type DeepSecCostWarningReason =
  | 'repository_scan'
  | 'changed_file_count'
  | 'diff_bytes'
  | 'selected_file_count'
  | 'selected_bytes'
  | 'single_file_bytes';

export type DeepSecCostWarningResult =
  | Readonly<{ status: 'ok' }>
  | Readonly<{
      status: 'requires_confirmation';
      costClass: 'expensive';
      reason: DeepSecCostWarningReason;
      messageKey: string;
    }>;

function exceeds(value: number | undefined, threshold: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > threshold;
}

function warning(reason: DeepSecCostWarningReason): DeepSecCostWarningResult {
  return {
    status: 'requires_confirmation',
    costClass: 'expensive',
    reason,
    messageKey: 'plugins.deepsec.costWarning.expensive',
  };
}

export function buildDeepSecCostWarning(input: DeepSecCostWarningInput): DeepSecCostWarningResult {
  if (input.mode === 'repository_security_audit') return warning('repository_scan');
  const thresholds = { ...DEFAULT_DEEPSEC_COST_WARNING_THRESHOLDS, ...(input.thresholds ?? {}) };
  if (exceeds(input.changedFileCount, thresholds.changedFileCount)) return warning('changed_file_count');
  if (exceeds(input.diffBytes, thresholds.diffBytes)) return warning('diff_bytes');
  if (exceeds(input.selectedFileCount, thresholds.selectedFileCount)) return warning('selected_file_count');
  if (exceeds(input.selectedBytes, thresholds.selectedBytes)) return warning('selected_bytes');
  if (exceeds(input.largestSelectedFileBytes, thresholds.largestSelectedFileBytes)) return warning('single_file_bytes');
  return { status: 'ok' };
}
