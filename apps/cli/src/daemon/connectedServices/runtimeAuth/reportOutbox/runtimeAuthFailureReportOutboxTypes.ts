import type {
  ConnectedServiceRuntimeFailureClassification,
} from '../types';
import type {
  SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

export type RuntimeAuthFailureReportOutboxAction = Readonly<{
  kind: 'open_url';
  url: string;
}>;

export type RuntimeAuthFailureReportOutboxRecoveryAction =
  | Readonly<{ kind: 'provider_state_sharing_required' }>
  | Readonly<{ kind: 'quota_recovery_required' }>;

export type RuntimeAuthFailureReportOutboxClassification = Readonly<
  Omit<ConnectedServiceRuntimeFailureClassification, 'rateLimits'> & { rateLimits: null }
>;

export type RuntimeAuthFailureReportOutboxReport = Readonly<{
  reportId?: string;
  /** Accepted only when reading a legacy caller shape; ignored by the current writer. */
  originDaemonExecutionGenerationV1?: string;
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: unknown;
  classification: unknown;
}>;

export type RuntimeAuthFailureReportOutboxItem = Readonly<{
  schemaVersion: 1;
  fileId: string;
  reportKey: string;
  reportId: string;
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
