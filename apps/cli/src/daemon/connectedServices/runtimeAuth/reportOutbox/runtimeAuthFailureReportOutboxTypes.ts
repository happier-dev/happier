import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeFailureClassification } from '../types';

export type RuntimeAuthFailureReportOutboxClassification = ConnectedServiceRuntimeFailureClassification;

export type RuntimeAuthFailureReportOutboxReport = Readonly<{
  reportId?: string;
  /** Accepted from older runners but ignored; launcher daemon identity is not authority. */
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
  | Readonly<{
    status: 'enqueued';
    enqueue: 'accepted' | 'coalesced';
    item: RuntimeAuthFailureReportOutboxItem;
  }>
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
