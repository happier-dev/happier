import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { ForgeCiMutationResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeReleaseMutationResultV1 } from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

type UnknownMutation = Extract<ForgeCiMutationResultV1 | ForgeReleaseMutationResultV1, { kind: 'outcome_unknown' }>;
type UnknownDownload = Extract<FileDownloadResultV1, { success: false }> & Readonly<{ status: 'unknown' }>;
type FailedDownload = Extract<FileDownloadResultV1, { success: false }> & Readonly<{ status: 'failed' }>;

export type ForgeOperationStateV1 =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'credentials-expired'; account: ConnectedAccountRef; failure: TriageSourceFailureV1; stale: boolean; recovery: 'repairAccount' }>
  | Readonly<{ kind: 'uncertain-write-outcome'; targetUrl: string | null; outcome: UnknownMutation | UnknownDownload; stale: boolean; recovery: 'readStatus' }>
  | Readonly<{ kind: 'failure'; failure: TriageSourceFailureV1; download?: FailedDownload; stale: boolean; recovery: 'none' }>;

/** Presentation facts only: account repair, effects and safe readback stay with their owners. */
export function readForgeOperationStateV1(input: Readonly<{
  failure?: TriageSourceFailureV1 | null;
  mutation?: ForgeCiMutationResultV1 | ForgeReleaseMutationResultV1 | null;
  download?: FileDownloadResultV1 | null;
  targetUrl?: string | null;
  account?: ConnectedAccountRef | null;
  hasRetainedValue: boolean;
}>): ForgeOperationStateV1 {
  if (input.mutation?.kind === 'outcome_unknown' || input.download?.status === 'unknown') return {
    kind: 'uncertain-write-outcome', targetUrl: input.mutation?.kind === 'outcome_unknown' ? input.mutation.webUrl ?? input.targetUrl ?? null : input.targetUrl ?? null,
    outcome: input.mutation?.kind === 'outcome_unknown' ? input.mutation : input.download as UnknownDownload,
    stale: input.hasRetainedValue, recovery: 'readStatus',
  };
  if (input.download?.status === 'failed') return {
    kind: 'failure', failure: { class: 'transient', code: 'file_download_failed' },
    // Do not squeeze canonical receiver error/errorCode through the bounded provider-failure codec.
    download: input.download as FailedDownload, stale: input.hasRetainedValue, recovery: 'none',
  };
  const failure = input.failure ?? (input.mutation?.kind === 'rejected' ? input.mutation.failure : null);
  if (!failure) return { kind: 'ready' };
  if (failure.class === 'authentication' && input.account) return {
    kind: 'credentials-expired', account: input.account, failure, stale: input.hasRetainedValue, recovery: 'repairAccount',
  };
  return { kind: 'failure', failure, stale: input.hasRetainedValue, recovery: 'none' };
}
