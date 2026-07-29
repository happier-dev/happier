import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import type { DaemonUsageLimitRecoveryFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryFieldIntoMetadata';
import { deterministicStringify } from '@/utils/deterministicJson';

export function applyDaemonUsageLimitRecoveryMutation(
  metadata: Record<string, unknown>,
  mutation: DaemonUsageLimitRecoveryFieldMutation,
): Record<string, unknown> {
  if (
    mutation.fieldId !== 'runtime.usageLimitRecovery'
    || mutation.source !== 'daemon'
    || mutation.deliveryClass !== 'durable_required'
  ) {
    throw new Error('invalid_daemon_usage_limit_recovery_mutation');
  }

  if (mutation.op.kind === 'clear') {
    if (
      typeof mutation.op.previousFingerprint !== 'string'
      || deterministicStringify(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY])
        !== mutation.op.previousFingerprint
    ) {
      return metadata;
    }
    return mergeUsageLimitRecoveryFieldIntoMetadata({
      latestMetadata: metadata,
      baseMetadata: metadata,
      candidateMetadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: null },
    });
  }

  return mergeUsageLimitRecoveryFieldIntoMetadata({
    latestMetadata: metadata,
    baseMetadata: metadata,
    candidateMetadata: {
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: mutation.op.value,
    },
  });
}
