import {
    SCM_OPERATION_ERROR_CODES,
    ScmRepositoryProvisioningFailureResponseSchema,
    type ScmOperationErrorCode,
    type ScmRepositoryCloneOutput,
} from '@happier-dev/plugin-sdk/scm';
import {
    ActionFailureCauseV1Schema,
    isPluginError,
    readUnexpectedActionErrorDiagnosticV1,
} from '@happier-dev/plugin-sdk/errors';

import type { PrStatusCacheErrorKind } from './prStatusCache.js';
type ProvisioningFailure = Extract<ScmRepositoryCloneOutput, { success: false }>;

/** Project provider failures through the canonical SCM vocabulary and metadata schema. */
export function classifyHostingProviderError(error: unknown): Readonly<{
    message: string;
    code: ScmOperationErrorCode;
    cacheKind: PrStatusCacheErrorKind;
    details: Pick<ProvisioningFailure, 'retryNotBeforeMs' | 'remediation' | 'failureCause'>;
}> {
    const message = error instanceof Error ? error.message : 'Hosting provider operation failed';
    const record = typeof error === 'object' && error !== null ? error : {};
    const pluginError = isPluginError(error) ? error : null;
    const nativeAuthRefused = pluginError?.code === 'plugin_connected_account_native_unavailable';
    const maybeCode = 'errorCode' in record ? record.errorCode : undefined;
    const code = nativeAuthRefused ? SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED
        : typeof maybeCode === 'string' && Object.values(SCM_OPERATION_ERROR_CODES).includes(maybeCode as ScmOperationErrorCode)
        ? maybeCode as ScmOperationErrorCode : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
    const { errorClass, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
    // Cause metadata retains the plugin's typed code or first cause, excluding its message and opaque details.
    const pluginCause = pluginError ? ActionFailureCauseV1Schema.safeParse(pluginError.data.failureCause ?? {
        phase: 'scm.hosting_provider', errorClass, errorCode: pluginError.code, httpStatus,
    }) : null;
    const parsed = ScmRepositoryProvisioningFailureResponseSchema.safeParse({ ...record, success: false, error: message, errorCode: code,
        ...(nativeAuthRefused ? { remediation: { kind: 'auth_required',
            ...(pluginError?.remediation?.kind === 'openUrl' ? { url: pluginError.remediation.url } : {}) } } : {}),
    });
    return {
        message, code,
        cacheKind: code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED ? 'auth'
            : code === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND ? 'notFound' : 'network',
        details: { ...(parsed.success
            ? { ...(code === SCM_OPERATION_ERROR_CODES.REMOTE_RATE_LIMITED && parsed.data.retryNotBeforeMs !== undefined ? { retryNotBeforeMs: parsed.data.retryNotBeforeMs } : {}),
                ...(parsed.data.failureCause ? { failureCause: parsed.data.failureCause } : {}),
                ...(parsed.data.remediation ? { remediation: parsed.data.remediation } : {}) }
            : {}), ...(pluginCause?.success ? { failureCause: pluginCause.data } : {}) },
    };
}
