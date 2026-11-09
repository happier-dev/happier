import axios from 'axios';
import { readAxiosResponseErrorCode } from '@/api/client/readAxiosResponseErrorCode';

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/u;

export type ApprovalPassFailure = Readonly<{ errorClass: string; errorCode?: string; status?: number }>;

/** Why an approval owner pass step failed, as log-safe facts: error class, typed code and HTTP status, never a message. */
export function readApprovalPassFailure(error: unknown): ApprovalPassFailure {
  const own = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
  const errorCode = readAxiosResponseErrorCode(error) ?? own;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return { errorClass: error instanceof Error ? error.name : typeof error,
    ...(errorCode && SAFE_CODE.test(errorCode) ? { errorCode } : {}),
    ...(typeof status === 'number' ? { status } : {}) };
}
