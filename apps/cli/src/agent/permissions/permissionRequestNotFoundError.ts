/**
 * Typed failure raised when a permission/user-action response targets an explicit request id that
 * the host coordinator does not recognize (never seen / already gone).
 *
 * The host must surface this typed failure instead of fabricating a success (gap 28/29): a stale or
 * unknown id must never read back as an approval.
 */
export const PERMISSION_REQUEST_NOT_FOUND_ERROR_CODE = 'permission_request_not_found' as const;

export class PermissionRequestNotFoundError extends Error {
    readonly errorCode = PERMISSION_REQUEST_NOT_FOUND_ERROR_CODE;
    readonly requestId: string;

    constructor(requestId: string) {
        super(PERMISSION_REQUEST_NOT_FOUND_ERROR_CODE);
        this.name = 'PermissionRequestNotFoundError';
        this.requestId = requestId;
    }
}

export function isPermissionRequestNotFoundError(value: unknown): value is PermissionRequestNotFoundError {
    return value instanceof PermissionRequestNotFoundError;
}
