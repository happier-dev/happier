import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionStateUsageLimitRecoveryValueSchema,
} from '@happier-dev/protocol';
import type {
  DaemonUsageLimitRecoveryFieldMutation,
  RegisteredSessionStateFieldMutationV1,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { splitDurableRegisteredSessionStateMetadata } from '@/agent/runtime/registry/pluginMetadataDurability';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from './mergeUsageLimitRecoveryFieldIntoMetadata';
export { mergeUsageLimitRecoveryFieldIntoMetadata } from './mergeUsageLimitRecoveryFieldIntoMetadata';

export type StageUsageLimitRecoveryMutation = (
  mutation: DaemonUsageLimitRecoveryFieldMutation,
) => Promise<void>;

export function cancelLatestUsageLimitRecoveryInMetadataAfterExplicitStop(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = SessionStateUsageLimitRecoveryValueSchema.safeParse(
    metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (
    !parsed.success
    || parsed.data.status === 'cancelled'
    || parsed.data.status === 'exhausted'
    || parsed.data.status === 'paused'
  ) return metadata;

  return {
    ...metadata,
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
      ...parsed.data,
      status: 'cancelled',
      nextCheckAtMs: null,
    },
  };
}

function isExactDaemonUsageLimitRecoveryMutation(
  mutation: RegisteredSessionStateFieldMutationV1 | undefined,
): mutation is DaemonUsageLimitRecoveryFieldMutation {
  return mutation?.fieldId === 'runtime.usageLimitRecovery'
    && mutation.source === 'daemon'
    && mutation.deliveryClass === 'durable_required';
}

export async function persistUsageLimitRecoveryFieldDurably(params: Readonly<{
  sessionId: string;
  currentMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
  mode?: 'converge' | 'rearm' | 'explicit_rearm' | 'cancel';
  stageUsageLimitRecoveryMutation: StageUsageLimitRecoveryMutation;
}>): Promise<Record<string, unknown>> {
  const durableCandidate = mergeUsageLimitRecoveryFieldIntoMetadata({
    latestMetadata: params.currentMetadata,
    baseMetadata: params.currentMetadata,
    candidateMetadata: params.nextMetadata,
    ...(params.mode ? { mode: params.mode } : {}),
  });
  const candidateForSplit = (
    Object.prototype.hasOwnProperty.call(params.currentMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
    && !Object.prototype.hasOwnProperty.call(durableCandidate, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
  )
    ? {
        ...durableCandidate,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: null,
      }
    : durableCandidate;
  const split = splitDurableRegisteredSessionStateMetadata({
    sessionId: params.sessionId,
    current: params.currentMetadata,
    candidate: candidateForSplit,
    source: 'daemon',
  });
  const mutation = split.mutations[0];
  const candidateChangedUsageLimitField = (
    Object.prototype.hasOwnProperty.call(params.nextMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
    || Object.prototype.hasOwnProperty.call(params.currentMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
  );
  if (split.mutations.length === 0 && candidateChangedUsageLimitField) {
    const nextValue = params.nextMetadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
    const currentValue = params.currentMetadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
    const validNoop = (
      nextValue === null
        ? currentValue === undefined
        : SessionStateUsageLimitRecoveryValueSchema.safeParse(nextValue).success
          && JSON.stringify(nextValue) === JSON.stringify(currentValue)
    );
    if (validNoop) return durableCandidate;
  }
  if (
    split.mutations.length !== 1
    || !isExactDaemonUsageLimitRecoveryMutation(mutation)
    || !candidateChangedUsageLimitField
  ) {
    throw new Error('invalid_daemon_usage_limit_recovery_mutation');
  }

  await params.stageUsageLimitRecoveryMutation(mutation);
  return durableCandidate;
}
