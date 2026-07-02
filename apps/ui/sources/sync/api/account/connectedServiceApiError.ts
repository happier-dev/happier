import { HappyError } from '@/utils/errors/errors';

export type ConnectedServiceApiErrorPayload = Readonly<{
    code: string;
    status?: number;
    generation?: number;
    resetAtMs?: number;
    canTryAgain?: boolean;
}>;

export class ConnectedServiceApiError extends HappyError {
    readonly generation?: number;
    readonly resetAtMs?: number;

    constructor(payload: ConnectedServiceApiErrorPayload) {
        super(payload.code, payload.canTryAgain === true, {
            code: payload.code,
            status: payload.status,
            kind: 'server',
        });
        this.name = 'ConnectedServiceApiError';
        this.generation = payload.generation;
        this.resetAtMs = payload.resetAtMs;
        Object.setPrototypeOf(this, ConnectedServiceApiError.prototype);
    }
}

function readNumberField(json: Record<string, unknown>, field: 'generation' | 'resetAtMs'): number | undefined {
    const value = json[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const record = json as Record<string, unknown>;
    return typeof record.error === 'string' && record.error.trim().length > 0 ? record.error : null;
}

function isRetryableConnectedServiceStatus(status: number | undefined): boolean {
    return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

export async function readConnectedServiceApiError(
    response: Response,
    fallbackCode = 'connected_service_request_failed',
): Promise<ConnectedServiceApiError> {
    const json = await response.json().catch(() => null);
    const record = json && typeof json === 'object' ? json as Record<string, unknown> : {};
    const code = readErrorCode(json) ?? fallbackCode;
    return new ConnectedServiceApiError({
        code,
        status: response.status,
        generation: readNumberField(record, 'generation'),
        resetAtMs: readNumberField(record, 'resetAtMs'),
        canTryAgain: isRetryableConnectedServiceStatus(response.status),
    });
}

export async function throwConnectedServiceApiError(response: Response): Promise<never> {
    throw await readConnectedServiceApiError(response);
}
