type PermissionLike = Readonly<{
    status?: string | null;
    reason?: string | null;
}> | null | undefined;

type ToolResultLike = Readonly<{
    error?: unknown;
}> | null | undefined;

export const REQUEST_INTERRUPTED_REASON = 'Request interrupted';

function readResultError(result: ToolResultLike): string | null {
    if (!result || typeof result !== 'object') return null;
    return typeof result.error === 'string' ? result.error : null;
}

export function isRequestInterruptedPlaceholder(params: Readonly<{
    permission?: PermissionLike;
    result?: ToolResultLike;
}>): boolean {
    const permission = params.permission;
    if (permission?.status !== 'canceled') {
        return false;
    }

    return permission.reason === REQUEST_INTERRUPTED_REASON || readResultError(params.result) === REQUEST_INTERRUPTED_REASON;
}
