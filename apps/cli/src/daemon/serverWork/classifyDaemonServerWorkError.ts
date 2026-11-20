import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DaemonServerWorkErrorClassification } from './types';

export function classifyDaemonServerWorkError(
  error: unknown,
  options: Readonly<{ featureAbsentStatusCodes?: readonly number[] }> = {},
): DaemonServerWorkErrorClassification {
  const classification = classifyServerEndpointError(error, options);
  const { errorCode } = projectActionFailureCauseV1(error, 'connected_account.usage.persistence', { allowUnknownErrorCode: true });
  return { ...classification, ...(errorCode ? { errorCode } : {}) };
}
