type PermissionLike = Readonly<{
    status?: string | null;
    reason?: string | null;
    decision?: string | null;
}> | null | undefined;

type ToolResultLike = Readonly<{
    error?: unknown;
}> | null | undefined;

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

    return permission.reason === 'Request interrupted' || readResultError(params.result) === 'Request interrupted';
}
