export const MACHINE_RPC_TIMEOUT_ERROR_CODE = 'MACHINE_RPC_TIMEOUT';

export function isMachineRpcTimeoutError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === MACHINE_RPC_TIMEOUT_ERROR_CODE,
    );
}
