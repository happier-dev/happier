import {
    SCM_OPERATION_ERROR_CODES,
    ScmRepositoryProvisioningFailureResponseSchema,
    type ScmOperationErrorCode,
    type ScmRepositoryCloneOutput,
} from '@happier-dev/plugin-sdk/scm';

import type { PrStatusCacheErrorKind } from './prStatusCache.js';
type ProvisioningFailure = Extract<ScmRepositoryCloneOutput, { success: false }>;

/** Project provider failures through the canonical SCM vocabulary and metadata schema. */
export function classifyHostingProviderError(error: unknown): Readonly<{
    message: string;
    code: ScmOperationErrorCode;
    cacheKind: PrStatusCacheErrorKind;
    details: Pick<ProvisioningFailure, 'retryNotBeforeMs' | 'remediation'>;
}> {
    const message = error instanceof Error ? error.message : 'Hosting provider operation failed';
    const record = typeof error === 'object' && error !== null ? error : {};
    const maybeCode = 'errorCode' in record ? record.errorCode : undefined;
    const code = typeof maybeCode === 'string' && Object.values(SCM_OPERATION_ERROR_CODES).includes(maybeCode as ScmOperationErrorCode)
        ? maybeCode as ScmOperationErrorCode : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
    const parsed = ScmRepositoryProvisioningFailureResponseSchema.safeParse({ ...record, success: false, error: message, errorCode: code });
    return {
        message, code,
        cacheKind: code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED ? 'auth'
            : code === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND ? 'notFound' : 'network',
        details: code === SCM_OPERATION_ERROR_CODES.REMOTE_RATE_LIMITED && parsed.success
            ? { ...(parsed.data.retryNotBeforeMs !== undefined ? { retryNotBeforeMs: parsed.data.retryNotBeforeMs } : {}),
                ...(parsed.data.remediation ? { remediation: parsed.data.remediation } : {}) }
            : {},
    };
}
