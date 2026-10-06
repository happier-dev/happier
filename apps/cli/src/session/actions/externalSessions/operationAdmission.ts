import type {
  ExternalSessionOperationActionResponseV1,
  ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { projectExternalSessionOperationProgressV1 } from '@happier-dev/protocol/sessions/external/operationV1';

import { logExternalSessionsInternalError } from './responseErrors';

/** Acknowledge the published admission while the same executor keeps driving the operation. */
export async function acknowledgeExternalSessionOperationAdmission(
  execute: (
    onAdmitted: (record: ExternalSessionOperationRecordV1) => void,
  ) => Promise<ExternalSessionOperationActionResponseV1>,
  logContext: string,
): Promise<ExternalSessionOperationActionResponseV1> {
  let admit!: (record: ExternalSessionOperationRecordV1) => void;
  const admitted = new Promise<ExternalSessionOperationRecordV1>((resolve) => {
    admit = resolve;
  });
  const operation = execute(admit).catch((error: unknown) => {
    // After admission there is no pending RPC to observe an irrecoverable
    // storage/projection failure. Keep it in the daemon's default file log.
    logExternalSessionsInternalError(logContext, error);
    throw error;
  });
  return await Promise.race([
    admitted.then((record) => ({
      ok: true as const,
      progress: projectExternalSessionOperationProgressV1(record),
    })),
    operation,
  ]);
}
