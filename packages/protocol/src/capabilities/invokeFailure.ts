import { readRecord } from '../inputs/inputRecords.js';
import { isPluginError } from '../plugins/errors.js';
import { createProviderErrorV1, ProviderErrorCodeV1Schema } from '../providers/errors.js';
import { readRpcErrorCode } from '../rpc/errors.js';

/** Content-free failure evidence; retryability is the producer's, never a reader heuristic. */
export type CapabilityInvokeFailure = Readonly<{ errorCode: string; retryable?: boolean }>;

export function readCapabilityInvokeFailure(error: unknown): CapabilityInvokeFailure | null {
  const record = readRecord(error);
  const providerCode = ProviderErrorCodeV1Schema.safeParse(record.code ?? record.errorCode ?? readRpcErrorCode(error));
  const code = readRpcErrorCode(error) ?? (typeof record.errorCode === 'string' ? record.errorCode : undefined)
    ?? (isPluginError(error) ? error.code : providerCode.success ? providerCode.data : undefined);
  if (!code?.trim()) return null;
  const details = readRecord(record.details);
  const retryable = typeof record.retryable === 'boolean' ? record.retryable
    : typeof details.retryable === 'boolean' ? details.retryable
    : providerCode.success ? createProviderErrorV1(providerCode.data).retryable : undefined;
  return { errorCode: code.trim(), ...(retryable === undefined ? {} : { retryable }) };
}
