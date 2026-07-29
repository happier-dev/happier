import { HappyError } from '@/utils/errors/errors';

export type ConnectedServiceApiErrorPayload = Readonly<{
    code: string;
    status?: number;
    generation?: number;
    runtimeStateRevision?: number | null;
    resetAtMs?: number;
    canTryAgain?: boolean;
    credentialRevision?: string | null;
    reason?: 'revision_mismatch' | 'refresh_lease_lost';
}>;

export class ConnectedServiceApiError extends HappyError {
    readonly generation?: number;
    readonly runtimeStateRevision?: number | null;
    readonly resetAtMs?: number;
    readonly credentialRevision?: string | null;
    readonly reason?: 'revision_mismatch' | 'refresh_lease_lost';

    constructor(payload: ConnectedServiceApiErrorPayload) {
        super(payload.code, payload.canTryAgain === true, {
            code: payload.code,
            status: payload.status,
            kind: 'server',
        });
        this.name = 'ConnectedServiceApiError';
        this.generation = payload.generation;
        this.runtimeStateRevision = payload.runtimeStateRevision;
        this.resetAtMs = payload.resetAtMs;
        this.credentialRevision = payload.credentialRevision;
        this.reason = payload.reason;
        Object.setPrototypeOf(this, ConnectedServiceApiError.prototype);
    }
}

function readNumberField(
    json: Record<string, unknown>,
    field: 'generation' | 'resetAtMs' | 'runtimeStateRevision',
): number | undefined {
    const value = json[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const record = json as Record<string, unknown>;
    return typeof record.error === 'string' && record.error.trim().length > 0 ? record.error : null;
}

export function createConnectedServiceApiError(
    json: unknown,
    opts: Readonly<{ status?: number; fallbackCode: string }>,
): ConnectedServiceApiError {
    const record = json && typeof json === 'object' ? json as Record<string, unknown> : {};
    return new ConnectedServiceApiError({
        code: readErrorCode(json) ?? opts.fallbackCode,
        status: opts.status,
        generation: readNumberField(record, 'generation'),
        runtimeStateRevision: record.runtimeStateRevision === null
            ? null
            : readNumberField(record, 'runtimeStateRevision'),
        resetAtMs: readNumberField(record, 'resetAtMs'),
        canTryAgain: isRetryableConnectedServiceStatus(opts.status),
        credentialRevision: typeof record.credentialRevision === 'string' || record.credentialRevision === null
            ? record.credentialRevision
            : undefined,
        reason: record.reason === 'revision_mismatch' || record.reason === 'refresh_lease_lost'
            ? record.reason
            : undefined,
    });
}

export function isConnectedServiceApiErrorCode(error: unknown, code: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    return record.code === code || (error instanceof Error && error.message === code);
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
        runtimeStateRevision: record.runtimeStateRevision === null
            ? null
            : readNumberField(record, 'runtimeStateRevision'),
        resetAtMs: readNumberField(record, 'resetAtMs'),
        canTryAgain: isRetryableConnectedServiceStatus(response.status),
    });
}

export async function throwConnectedServiceApiError(response: Response): Promise<never> {
    throw await readConnectedServiceApiError(response);
}
