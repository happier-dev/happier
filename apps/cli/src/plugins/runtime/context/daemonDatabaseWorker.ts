import type { ChildProcess } from 'node:child_process';

import type { DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';

import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { PluginContextServiceError } from './errors';

type WireDatabaseValue =
    | null
    | string
    | number
    | Readonly<{ type: 'bigint'; value: string }>
    | Readonly<{ type: 'bytes'; base64: string }>;

type WireDatabaseRow = Readonly<Record<string, WireDatabaseValue>>;

export type DaemonDatabaseWorkerResultLimits = Readonly<{
    maximumResultBytes: number;
    maximumResultRows: number;
}>;

type WorkerRequest =
    | Readonly<{ id: string; kind: 'open'; filePath: string }>
    | Readonly<{ id: string; kind: 'exec'; sql: string }>
    | Readonly<{ id: string; kind: 'get'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{
        id: string;
        kind: 'all';
        sql: string;
        values: readonly WireDatabaseValue[];
        resultLimits: DaemonDatabaseWorkerResultLimits;
    }>
    | Readonly<{ id: string; kind: 'run'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{ id: string; kind: 'close' }>;

type WorkerResult =
    | Readonly<{ kind: 'void' }>
    | Readonly<{ kind: 'row'; row: WireDatabaseRow | null }>
    | Readonly<{ kind: 'rows'; rows: readonly WireDatabaseRow[] }>
    | Readonly<{
        kind: 'run';
        changes: WireDatabaseValue | null;
        lastInsertRowId: WireDatabaseValue | null;
    }>;

type WorkerResponse =
    | Readonly<{ id: string; ok: true; result: WorkerResult }>
    | Readonly<{ id: string; ok: false; error: Readonly<{ message: string; code: string | null }> }>;

type PendingRequest = Readonly<{
    resolve: (result: WorkerResult) => void;
    reject: (error: unknown) => void;
    cleanupAbort: () => void;
}>;

type WorkerSession = {
    readonly id: number;
    readonly child: ChildProcess;
    readonly pendingById: Map<string, PendingRequest>;
    termination: Promise<void>;
    retired: boolean;
};

type WorkerRequestWithoutId =
    | Readonly<{ kind: 'open'; filePath: string }>
    | Readonly<{ kind: 'exec'; sql: string }>
    | Readonly<{ kind: 'get'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{
        kind: 'all';
        sql: string;
        values: readonly WireDatabaseValue[];
        resultLimits: DaemonDatabaseWorkerResultLimits;
    }>
    | Readonly<{ kind: 'run'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{ kind: 'close' }>;

export type DaemonDatabaseWorkerRequestOptions = Readonly<{
    signal?: AbortSignal;
    /** The caller owns whether this was a timeout or an explicit cancellation. */
    createAbortError?: () => Error;
}>;

export type DaemonDatabaseWorkerAllRequestOptions = DaemonDatabaseWorkerRequestOptions & Readonly<{
    resultLimits: DaemonDatabaseWorkerResultLimits;
}>;

export type DaemonDatabaseWorkerLease = Readonly<{
    /** Stable for one child connection and changes after worker retirement. */
    sessionId: number;
    exec(sql: string, options?: DaemonDatabaseWorkerRequestOptions): Promise<void>;
    get(sql: string, values?: readonly DaemonDatabaseValue[], options?: DaemonDatabaseWorkerRequestOptions): Promise<unknown>;
    all(
        sql: string,
        values: readonly DaemonDatabaseValue[],
        options: DaemonDatabaseWorkerAllRequestOptions,
    ): Promise<readonly unknown[]>;
    run(sql: string, values?: readonly DaemonDatabaseValue[], options?: DaemonDatabaseWorkerRequestOptions): Promise<unknown>;
    isRetired(): boolean;
}>;

export type DaemonDatabaseWorkerClient = Readonly<{
    acquire(): Promise<DaemonDatabaseWorkerLease>;
    close(): Promise<void>;
}>;

const WORKER_SUBCOMMAND = ['daemon', 'database-worker'] as const;
let requestSequence = 0;
let workerSessionSequence = 0;

function nextRequestId(): string {
    requestSequence += 1;
    return `daemon-database-${requestSequence}`;
}

function nextWorkerSessionId(): number {
    workerSessionSequence += 1;
    return workerSessionSequence;
}

function workerUnavailableError(): PluginContextServiceError {
    return new PluginContextServiceError(
        'daemon_database_worker_terminated',
        'SQLite database worker terminated before the operation completed',
    );
}

function workerProtocolError(): PluginContextServiceError {
    return new PluginContextServiceError(
        'daemon_database_worker_protocol_invalid',
        'SQLite database worker returned an invalid response',
    );
}

function encodeDatabaseValue(value: DaemonDatabaseValue): WireDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
    return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
}

function decodeDatabaseValue(value: unknown): DaemonDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (!isRecord(value) || typeof value.type !== 'string') throw workerProtocolError();
    if (value.type === 'bigint' && typeof value.value === 'string') {
        try {
            return BigInt(value.value);
        } catch {
            throw workerProtocolError();
        }
    }
    if (value.type === 'bytes' && typeof value.base64 === 'string') {
        return new Uint8Array(Buffer.from(value.base64, 'base64'));
    }
    throw workerProtocolError();
}

function encodeDatabaseRow(value: unknown): WireDatabaseRow {
    if (!isRecord(value)) {
        throw new PluginContextServiceError('daemon_database_result_invalid', 'SQLite query returned an invalid row');
    }
    const row: Record<string, WireDatabaseValue> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
        row[key] = encodeDatabaseValue(assertDatabaseValue(field));
    }
    return row;
}

function decodeDatabaseRow(value: unknown): Record<string, DaemonDatabaseValue> {
    if (!isRecord(value)) throw workerProtocolError();
    const row: Record<string, DaemonDatabaseValue> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
        row[key] = decodeDatabaseValue(field);
    }
    return row;
}

function assertDatabaseValue(value: unknown): DaemonDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value;
    }
    if (value instanceof Uint8Array) return value;
    throw new PluginContextServiceError('daemon_database_result_invalid', 'SQLite query returned an unsupported value');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serializeError(error: unknown): Readonly<{ message: string; code: string | null }> {
    const message = error instanceof Error ? error.message : String(error ?? 'SQLite database worker failed');
    const candidateCode = error instanceof Error ? (error as Error & { code?: unknown }).code : null;
    return {
        message: message.trim().length > 0 ? message : 'SQLite database worker failed',
        code: typeof candidateCode === 'string' && candidateCode.trim().length > 0 ? candidateCode : null,
    };
}

function decodeResponse(value: unknown): WorkerResponse {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') throw workerProtocolError();
    if (value.ok) {
        if (!isRecord(value.result) || typeof value.result.kind !== 'string') throw workerProtocolError();
        return value as unknown as WorkerResponse;
    }
    if (!isRecord(value.error) || typeof value.error.message !== 'string') throw workerProtocolError();
    if (value.error.code !== null && typeof value.error.code !== 'string') throw workerProtocolError();
    return value as unknown as WorkerResponse;
}

function decodeLineFrames(onFrame: (value: unknown) => void): (chunk: Buffer) => void {
    let buffered = '';
    return (chunk: Buffer) => {
        buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
        while (true) {
            const newline = buffered.indexOf('\n');
            if (newline < 0) return;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line.trim()) continue;
            try {
                onFrame(JSON.parse(line) as unknown);
            } catch {
                onFrame(null);
            }
        }
    };
}

function encodeLine(value: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function requestFailureFromResponse(response: Extract<WorkerResponse, { ok: false }>): Error {
    const error = new Error(response.error.message);
    if (response.error.code) {
        Object.assign(error, { code: response.error.code });
    }
    return error;
}

export function createDaemonDatabaseWorkerClient(filePath: string): DaemonDatabaseWorkerClient {
    let closed = false;
    let active: WorkerSession | null = null;
    let starting: Promise<WorkerSession> | null = null;
    let retiring: Promise<void> | null = null;

    const failPending = (session: WorkerSession, error: unknown): void => {
        const pending = [...session.pendingById.values()];
        session.pendingById.clear();
        for (const request of pending) {
            request.cleanupAbort();
            request.reject(error);
        }
    };

    const retire = (session: WorkerSession, force: boolean): Promise<void> => {
        if (!session.retired) {
            session.retired = true;
            if (active === session) active = null;
            if (force) {
                try {
                    session.child.kill('SIGKILL');
                } catch {
                    // The managed termination promise remains the canonical completion signal.
                }
            }
        }
        const termination = session.termination;
        retiring = termination;
        void termination.finally(() => {
            if (retiring === termination) retiring = null;
        });
        return termination;
    };

    const createSession = async (): Promise<WorkerSession> => {
        const child = spawnHappyCLI([...WORKER_SUBCOMMAND], {
            stdio: ['pipe', 'pipe', 'inherit'],
            windowsHide: true,
        });
        if (!child.stdin || !child.stdout) {
            try {
                child.kill('SIGKILL');
            } catch {
                // best-effort cleanup for an unusable child boundary
            }
            throw workerUnavailableError();
        }
        child.stdin.on('error', () => {
            // A child can exit between an admission check and pipe write. Its managed
            // termination event rejects the matching request; never surface EPIPE globally.
        });

        const managed = createManagedChildProcess(child);
        const session: WorkerSession = {
            id: nextWorkerSessionId(),
            child,
            pendingById: new Map(),
            termination: Promise.resolve(),
            retired: false,
        };
        const termination = managed.waitForTermination().then(() => {
            session.retired = true;
            if (active === session) active = null;
            failPending(session, workerUnavailableError());
        });
        session.termination = termination;
        child.stdout.on('data', decodeLineFrames((value) => {
            if (session.retired) return;
            let response: WorkerResponse;
            try {
                response = decodeResponse(value);
            } catch (error) {
                failPending(session, error);
                void retire(session, true);
                return;
            }
            const pending = session.pendingById.get(response.id);
            if (!pending) return;
            session.pendingById.delete(response.id);
            pending.cleanupAbort();
            if (response.ok) {
                pending.resolve(response.result);
            } else {
                pending.reject(requestFailureFromResponse(response));
            }
        }));
        active = session;
        return session;
    };

    const request = async (
        session: WorkerSession,
        requestFrame: WorkerRequestWithoutId,
        options?: DaemonDatabaseWorkerRequestOptions,
    ): Promise<WorkerResult> => {
        if (session.retired || active !== session) throw workerUnavailableError();
        if (options?.signal?.aborted) {
            throw options.createAbortError?.() ?? new PluginContextServiceError(
                'daemon_database_cancelled',
                'Plugin daemon database operation was cancelled',
                true,
            );
        }
        const id = nextRequestId();
        const frame = Object.freeze({ ...requestFrame, id }) as WorkerRequest;
        return await new Promise<WorkerResult>((resolve, reject) => {
            let settled = false;
            const cleanupAbort = (): void => {
                options?.signal?.removeEventListener('abort', onAbort);
            };
            const settle = (next: () => void): void => {
                if (settled) return;
                settled = true;
                session.pendingById.delete(id);
                cleanupAbort();
                next();
            };
            const onAbort = (): void => {
                settle(() => {
                    void retire(session, true);
                    reject(options?.createAbortError?.() ?? new PluginContextServiceError(
                        'daemon_database_cancelled',
                        'Plugin daemon database operation was cancelled',
                        true,
                    ));
                });
            };
            session.pendingById.set(id, {
                resolve: (result) => settle(() => resolve(result)),
                reject: (error) => settle(() => reject(error)),
                cleanupAbort,
            });
            if (options?.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
            try {
                session.child.stdin?.write(encodeLine(frame));
            } catch (error) {
                settle(() => {
                    void retire(session, true);
                    reject(error);
                });
            }
        });
    };

    const acquireSession = async (): Promise<WorkerSession> => {
        if (closed) {
            throw new PluginContextServiceError('daemon_database_closed', 'Plugin daemon database handle is closed');
        }
        if (active && !active.retired) return active;
        if (starting) return await starting;
        starting = (async () => {
            if (retiring) await retiring;
            if (closed) {
                throw new PluginContextServiceError('daemon_database_closed', 'Plugin daemon database handle is closed');
            }
            const session = await createSession();
            try {
                const opened = await request(session, { kind: 'open', filePath });
                if (opened.kind !== 'void') throw workerProtocolError();
                return session;
            } catch (error) {
                void retire(session, true);
                throw error;
            }
        })();
        try {
            return await starting;
        } finally {
            starting = null;
        }
    };

    const leaseFor = (session: WorkerSession): DaemonDatabaseWorkerLease => Object.freeze({
        sessionId: session.id,
        exec: async (sql, options) => {
            const result = await request(session, { kind: 'exec', sql }, options);
            if (result.kind !== 'void') throw workerProtocolError();
        },
        get: async (sql, values = [], options) => {
            const result = await request(session, {
                kind: 'get',
                sql,
                values: values.map(encodeDatabaseValue),
            }, options);
            if (result.kind !== 'row') throw workerProtocolError();
            return result.row === null ? undefined : decodeDatabaseRow(result.row);
        },
        all: async (sql, values, options) => {
            const result = await request(session, {
                kind: 'all',
                sql,
                values: values.map(encodeDatabaseValue),
                resultLimits: options.resultLimits,
            }, options);
            if (result.kind !== 'rows') throw workerProtocolError();
            return Object.freeze(result.rows.map((row) => decodeDatabaseRow(row)));
        },
        run: async (sql, values = [], options) => {
            const result = await request(session, {
                kind: 'run',
                sql,
                values: values.map(encodeDatabaseValue),
            }, options);
            if (result.kind !== 'run') throw workerProtocolError();
            return Object.freeze({
                changes: result.changes === null ? undefined : decodeDatabaseValue(result.changes),
                lastInsertRowId: result.lastInsertRowId === null ? undefined : decodeDatabaseValue(result.lastInsertRowId),
            });
        },
        isRetired: () => session.retired || active !== session,
    });

    return Object.freeze({
        acquire: async () => leaseFor(await acquireSession()),
        close: async () => {
            if (closed) {
                if (retiring) await retiring;
                return;
            }
            closed = true;
            const pendingStart = starting;
            if (pendingStart) await pendingStart.catch(() => undefined);
            const session = active;
            if (!session || session.retired) {
                if (retiring) await retiring;
                return;
            }
            try {
                const result = await request(session, { kind: 'close' });
                if (result.kind !== 'void') throw workerProtocolError();
                session.child.stdin?.end();
            } catch {
                void retire(session, true);
            }
            await retire(session, false);
        },
    });
}

export type DaemonDatabaseWorkerRequest = WorkerRequest;
export type DaemonDatabaseWorkerResponse = WorkerResponse;

export function decodeDaemonDatabaseWorkerLineFrames(
    onFrame: (value: unknown) => void,
): (chunk: Buffer) => void {
    return decodeLineFrames(onFrame);
}

export function encodeDaemonDatabaseWorkerLine(value: unknown): Buffer {
    return encodeLine(value);
}

export function decodeDaemonDatabaseWorkerValue(value: unknown): DaemonDatabaseValue {
    return decodeDatabaseValue(value);
}

export function encodeDaemonDatabaseWorkerValue(value: DaemonDatabaseValue): WireDatabaseValue {
    return encodeDatabaseValue(value);
}

export function encodeDaemonDatabaseWorkerRow(value: unknown): WireDatabaseRow {
    return encodeDatabaseRow(value);
}
