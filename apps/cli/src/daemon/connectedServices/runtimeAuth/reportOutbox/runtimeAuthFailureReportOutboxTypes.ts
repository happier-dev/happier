import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import type {
  ConnectedServiceRuntimeFailureClassification,
  ConnectedServiceRuntimeAuthFailureKind,
  ConnectedServiceRuntimeLimitCategory,
  ConnectedServiceRuntimeQuotaScope,
} from '../types';

export type RuntimeAuthFailureReportOutboxAction = Readonly<{
  kind: 'open_url';
  url: string;
}>;

export type RuntimeAuthFailureReportOutboxRecoveryAction =
  | Readonly<{ kind: 'provider_state_sharing_required' }>
  | Readonly<{ kind: 'quota_recovery_required' }>;

export type RuntimeAuthFailureReportOutboxClassification = Readonly<{
  kind: ConnectedServiceRuntimeAuthFailureKind;
  limitCategory?: ConnectedServiceRuntimeLimitCategory;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  quotaScope?: ConnectedServiceRuntimeQuotaScope;
  providerLimitId?: string | null;
  action?: RuntimeAuthFailureReportOutboxAction | null;
  planType: string | null;
  rateLimits: null;
  source: ConnectedServiceRuntimeFailureClassification['source'];
  recoveryAction?: RuntimeAuthFailureReportOutboxRecoveryAction | null;
}>;

export type RuntimeAuthFailureReportOutboxReport = Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: unknown;
  classification: unknown;
}>;

export type RuntimeAuthFailureReportOutboxItem = Readonly<{
  schemaVersion: 1;
  fileId: string;
  reportKey: string;
  sessionId: string;
  switchesThisTurn: number;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  classification: RuntimeAuthFailureReportOutboxClassification;
  attemptCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type EnqueueRuntimeAuthFailureReportOutboxItemResult =
  | Readonly<{ status: 'enqueued'; item: RuntimeAuthFailureReportOutboxItem }>
  | Readonly<{ status: 'rejected'; reason: 'unclassified_report' }>;

export type DrainRuntimeAuthFailureReportOutboxItemResult =
  | Readonly<{ status: 'delivered' }>
  | Readonly<{ status: 'retry' }>
  | Readonly<{ status: 'drop' }>;

export type DrainRuntimeAuthFailureReportOutboxItemsResult = Readonly<{
  delivered: number;
  dropped: number;
  retried: number;
}>;
