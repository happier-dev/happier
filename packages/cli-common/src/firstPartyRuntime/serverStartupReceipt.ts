import { readFile } from 'node:fs/promises';

/**
 * The startup attestation exchanged between a launcher and the server it starts. The launcher arms
 * it with a private path and per-spawn nonce; the server writes the receipt once startup finished.
 *
 * A receipt with only `{ nonce, pid }` proves the process finished starting. It does not prove an
 * API is listening: worker roles write it too. `api` is present only after a successful API listen
 * and carries a server-generated identity that the same process returns from its API `/ready`, so
 * a launcher can bind the receipt to the process that actually answers on the probed endpoint.
 */
export const SERVER_STARTUP_RECEIPT_PATH_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_PATH';
export const SERVER_STARTUP_RECEIPT_NONCE_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE';

const RECEIPT_POLL_MS = 100;

export type ServerApiStartupIdentity = Readonly<{ instanceId: string; address: string; port: number }>;

export type ServerStartupReceipt = Readonly<{
    nonce: string;
    pid: number;
    api?: ServerApiStartupIdentity;
}>;

export type ServerStartupReceiptFailure = 'timeout' | 'cancelled' | 'missing_api';

export class ServerStartupReceiptError extends Error {
    readonly code: ServerStartupReceiptFailure;

    constructor(code: ServerStartupReceiptFailure) {
        super(`server startup receipt unavailable: ${code}`);
        this.name = 'ServerStartupReceiptError';
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseApiIdentity(value: unknown): ServerApiStartupIdentity | null {
    if (!isRecord(value)) return null;
    const { instanceId, address, port } = value;
    if (!isNonBlankString(instanceId) || !isNonBlankString(address)) return null;
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0) return null;
    return { instanceId, address, port };
}

export function parseServerStartupReceipt(value: unknown): ServerStartupReceipt | null {
    if (!isRecord(value)) return null;
    const { nonce, pid, api } = value;
    if (!isNonBlankString(nonce)) return null;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (api === undefined) return { nonce, pid };
    const parsedApi = parseApiIdentity(api);
    return parsedApi ? { nonce, pid, api: parsedApi } : null;
}

export function readApiStartupIdentityFromReadyPayload(payload: unknown): Readonly<{ instanceId: string }> | null {
    if (!isRecord(payload) || !isRecord(payload.apiStartupIdentity)) return null;
    const { instanceId } = payload.apiStartupIdentity;
    return isNonBlankString(instanceId) ? { instanceId } : null;
}

/** Whether an API bound to `api.address` can be the one answering on the probed endpoint. */
export function listenAddressCoversEndpoint(
    api: ServerApiStartupIdentity,
    endpoint: Readonly<{ host: string; port: number }>,
): boolean {
    if (api.port !== endpoint.port) return false;
    if (api.address === '0.0.0.0' || api.address === '::') return true;
    if (api.address === endpoint.host) return true;
    return endpoint.host === 'localhost' && (api.address === '127.0.0.1' || api.address === '::1');
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'EPERM');
    }
}

export function parseServerStartupReceiptText(text: string): ServerStartupReceipt | null {
    try {
        return parseServerStartupReceipt(JSON.parse(text));
    } catch {
        return null;
    }
}

function waitForNextPoll(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

/**
 * Waits for the exact attempt's receipt from a live process. The caller owns the budget: a
 * non-positive `timeoutMs` fails without reading. With `requireApi`, a generic receipt fails at once
 * because that attempt already finished starting without an API listener.
 */
export async function waitForServerStartupReceipt(params: Readonly<{
    path: string;
    nonce: string;
    requireApi: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<ServerStartupReceipt> {
    if (!(Number.isFinite(params.timeoutMs) && params.timeoutMs > 0)) {
        throw new ServerStartupReceiptError('timeout');
    }
    const deadline = Date.now() + params.timeoutMs;
    while (true) {
        if (params.signal?.aborted) throw new ServerStartupReceiptError('cancelled');
        const receipt = await readFile(params.path, 'utf8').then(parseServerStartupReceiptText).catch(() => null);
        if (receipt && receipt.nonce === params.nonce && isProcessAlive(receipt.pid)) {
            if (params.requireApi && !receipt.api) throw new ServerStartupReceiptError('missing_api');
            return receipt;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new ServerStartupReceiptError('timeout');
        await waitForNextPoll(Math.min(RECEIPT_POLL_MS, remainingMs), params.signal);
    }
}
