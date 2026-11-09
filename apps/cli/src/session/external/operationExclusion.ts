import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, watch, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    inspectProcessGeneration,
    parseProcessGenerationWitness as normalizeOwnerProcess,
    readProcessIdentityByPid,
    type ProcessGenerationLiveness,
    type ProcessGenerationWitness,
} from '@/daemon/processIdentity';
import { processGenerationMatches } from '@happier-dev/cli-common/processInstance';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

export type ExternalSessionOperationRequest =
    | Readonly<{
        kind: 'materialize';
        sessionId: string;
        requestId: string;
        sourceIdentity: string;
        sourceGeneration: string;
    }>
    | Readonly<{
        kind: 'takeover';
        sessionId: string;
        requestId: string;
        sourceIdentity: string;
        sourceGeneration: string;
        plan: 'external-linked' | 'persisted';
    }>
    | Readonly<{
        kind: 'handoff';
        sessionId: string;
        requestId: string;
        sourceMachineId: string;
        targetMachineId: string;
        semanticRequest: string;
    }>;

export type ExternalSessionOperationOwnerProcess = ProcessGenerationWitness;
export type ExternalSessionOperationOwnerProcessLiveness = ProcessGenerationLiveness;
export { inspectProcessGeneration as inspectExternalSessionOperationOwnerProcess } from '@/daemon/processIdentity';

type ExternalSessionOperationClaimRecord = Readonly<{
    schemaVersion: 2;
    claimId: string;
    ownerId: string;
    ownerProcess?: ExternalSessionOperationOwnerProcess;
    request: ExternalSessionOperationRequest;
    /** Authenticated Account subject bound at operation admission, when pinned. */
    accountSubject?: string;
    acquiredAtMs: number;
}>;

export type ExternalSessionOperationClaim = Readonly<{
    record: ExternalSessionOperationClaimRecord;
    release(): Promise<void>;
}>;

export type ExternalSessionOperationConvergenceWaitResult =
    | Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'aborted' }>
    | Readonly<{
        status: 'failed';
        reason:
            | 'watch_creation_failed'
            | 'watch_iteration_failed'
            | 'watch_closure_failed';
    }>;

export type ExternalSessionOperationAcquireResult =
    | Readonly<{ status: 'acquired'; claim: ExternalSessionOperationClaim }>
    | Readonly<{
        status: 'converged';
        active: ExternalSessionOperationClaimRecord;
        waitForRelease?(input?: Readonly<{
            signal?: AbortSignal;
            deadlineAtMs?: number;
        }>): Promise<ExternalSessionOperationConvergenceWaitResult>;
    }>
    | Readonly<{
        status: 'conflict';
        reason:
            | 'active_operation'
            | 'semantic_request_mismatch'
            | 'source_identity_mismatch'
            | 'source_generation_mismatch'
            | 'account_subject_mismatch'
            | 'claim_unreadable';
        active: ExternalSessionOperationClaimRecord | null;
    }>;

export type ExternalSessionOperationExclusion = Readonly<{
    acquire(
        request: ExternalSessionOperationRequest,
        input?: Readonly<{
            signal?: AbortSignal;
            /** Authenticated Account subject pinned at operation admission. */
            accountSubject?: string;
        }>,
    ): Promise<ExternalSessionOperationAcquireResult>;
}>;

export type ExternalSessionOperationExclusionOwner =
    ExternalSessionOperationExclusion & Readonly<{
        inspectPassiveRepairClaim(input: Readonly<{
            sessionId: string;
            operationClaimId: string;
        }>): Promise<'active' | 'inactive'>;
        withPassiveRepairClaimBarrier<TResult>(
            input: Readonly<{
                sessionId: string;
                operationClaimId: string;
            }>,
            effect: () => Promise<TResult>,
        ): Promise<
            | Readonly<{ status: 'active' }>
            | Readonly<{ status: 'executed'; value: TResult }>
        >;
        /**
         * Freeze claim admission for the whole Session, including the window
         * after a claim is acquired but before its first durable record exists.
         */
        withPassiveRepairSessionBarrier<TResult>(
            input: Readonly<{ sessionId: string }>,
            effect: () => Promise<TResult>,
        ): Promise<
            | Readonly<{ status: 'active' }>
            | Readonly<{ status: 'executed'; value: TResult }>
        >;
    }>;

function readRequiredString(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`External session operation ${field} is required`);
    return normalized;
}

function normalizeRequest(request: ExternalSessionOperationRequest): ExternalSessionOperationRequest {
    const sessionId = readRequiredString(request.sessionId, 'sessionId');
    const requestId = readRequiredString(request.requestId, 'requestId');
    if (request.kind === 'handoff') {
        return Object.freeze({
            kind: request.kind,
            sessionId,
            requestId,
            sourceMachineId: readRequiredString(request.sourceMachineId, 'sourceMachineId'),
            targetMachineId: readRequiredString(request.targetMachineId, 'targetMachineId'),
            semanticRequest: readRequiredString(request.semanticRequest, 'semanticRequest'),
        });
    }
    const sourceIdentity = readRequiredString(request.sourceIdentity, 'sourceIdentity');
    const sourceGeneration = readRequiredString(request.sourceGeneration, 'sourceGeneration');
    if (request.kind === 'takeover') {
        return Object.freeze({
            kind: request.kind,
            sessionId,
            requestId,
            sourceIdentity,
            sourceGeneration,
            plan: request.plan,
        });
    }
    return Object.freeze({
        kind: request.kind,
        sessionId,
        requestId,
        sourceIdentity,
        sourceGeneration,
    });
}

function serializeSemanticRequest(request: ExternalSessionOperationRequest): string {
    return JSON.stringify(normalizeRequest(request));
}

function parseClaimRecord(value: unknown): ExternalSessionOperationClaimRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        record.schemaVersion !== 2
        || typeof record.claimId !== 'string'
        || !record.claimId.trim()
        || typeof record.ownerId !== 'string'
        || !record.ownerId.trim()
        || typeof record.acquiredAtMs !== 'number'
        || !Number.isFinite(record.acquiredAtMs)
    ) {
        return null;
    }
    const ownerProcess = record.ownerProcess === undefined
        ? undefined
        : normalizeOwnerProcess(record.ownerProcess);
    if (record.ownerProcess !== undefined && !ownerProcess) return null;
    const accountSubject = record.accountSubject === undefined
        ? undefined
        : typeof record.accountSubject === 'string' && record.accountSubject.trim()
          ? record.accountSubject.trim()
          : null;
    if (record.accountSubject !== undefined && !accountSubject) return null;
    try {
        const request = normalizeRequest(record.request as ExternalSessionOperationRequest);
        return Object.freeze({
            schemaVersion: 2,
            claimId: record.claimId,
            ownerId: record.ownerId,
            ...(ownerProcess ? { ownerProcess } : {}),
            request,
            ...(accountSubject ? { accountSubject } : {}),
            acquiredAtMs: record.acquiredAtMs,
        });
    } catch {
        return null;
    }
}

function resolveClaimPaths(activeServerDir: string, sessionId: string) {
    const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const rootDirectory = join(activeServerDir, 'external-session-operations');
    const claimDirectory = join(rootDirectory, sessionKey);
    const claimFilePath = join(claimDirectory, 'claim.json');
    const mutationLockPath = join(rootDirectory, `${sessionKey}.mutation.lock`);
    return { rootDirectory, claimDirectory, claimFilePath, mutationLockPath } as const;
}

async function withClaimMutationLock<TResult>(
    mutationLockPath: string,
    effect: () => Promise<TResult>,
    signal?: AbortSignal,
): Promise<TResult> {
    // Cross-process mutation has no push channel. The file-lock owner handles
    // contention and exact-owner recovery; caller cancellation ends admission.
    return await withJsonOwnerFileLock({
        lockPath: mutationLockPath,
        timeoutMs: Infinity,
        signal,
        errorCode: 'external_session_operation_claim_lock_unavailable',
    }, effect);
}

async function readClaim(filePath: string): Promise<ExternalSessionOperationClaimRecord | null> {
    try {
        return parseClaimRecord(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
        return null;
    }
}

async function waitForClaimRelease(input: Readonly<{
    watchDirectory: string;
    claimFilePath: string;
    active: ExternalSessionOperationClaimRecord;
    nowMs: () => number;
    watchClaimChanges: typeof watch;
    signal?: AbortSignal;
    deadlineAtMs?: number;
}>): Promise<ExternalSessionOperationConvergenceWaitResult> {
    if (input.signal?.aborted) return { status: 'aborted' };

    const watcherController = new AbortController();
    let watcher: ReturnType<typeof watch>;
    try {
        watcher = input.watchClaimChanges(input.watchDirectory, {
            persistent: false,
            signal: watcherController.signal,
        });
    } catch {
        const current = await readClaim(input.claimFilePath);
        if (
            !current
            || current.claimId !== input.active.claimId
            || current.ownerId !== input.active.ownerId
            || serializeSemanticRequest(current.request)
                !== serializeSemanticRequest(input.active.request)
        ) {
            return { status: 'ready' };
        }
        return { status: 'failed', reason: 'watch_creation_failed' };
    }

    let boundaryTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    const closeWatcher = async (
        result: ExternalSessionOperationConvergenceWaitResult,
    ): Promise<ExternalSessionOperationConvergenceWaitResult> => {
        if (boundaryTimer) {
            clearTimeout(boundaryTimer);
            boundaryTimer = null;
        }
        if (abortListener && input.signal) {
            input.signal.removeEventListener('abort', abortListener);
            abortListener = null;
        }
        watcherController.abort();
        try {
            await watcher.return?.();
        } catch {
            return { status: 'failed', reason: 'watch_closure_failed' };
        }
        return result;
    };
    const changed = (async (): Promise<ExternalSessionOperationConvergenceWaitResult> => {
        try {
            const event = await watcher.next();
            return event.done
                ? { status: 'failed', reason: 'watch_iteration_failed' }
                : { status: 'ready' };
        } catch {
            return { status: 'failed', reason: 'watch_iteration_failed' };
        }
    })();

    const current = await readClaim(input.claimFilePath);
    if (
        !current
        || current.claimId !== input.active.claimId
        || current.ownerId !== input.active.ownerId
        || serializeSemanticRequest(current.request)
            !== serializeSemanticRequest(input.active.request)
    ) {
        return await closeWatcher({ status: 'ready' });
    }
    if (input.signal?.aborted) {
        return await closeWatcher({ status: 'aborted' });
    }

    const deadlineAtMs = input.deadlineAtMs;
    const boundary = new Promise<ExternalSessionOperationConvergenceWaitResult>((resolve) => {
        if (deadlineAtMs === undefined) return;
        boundaryTimer = setTimeout(
            () => resolve({ status: 'aborted' }),
            Math.max(0, deadlineAtMs - input.nowMs()),
        );
        boundaryTimer.unref?.();
    });
    const aborted = input.signal
        ? new Promise<ExternalSessionOperationConvergenceWaitResult>((resolve) => {
            abortListener = () => resolve({ status: 'aborted' });
            input.signal!.addEventListener('abort', abortListener, { once: true });
            if (input.signal!.aborted) abortListener();
        })
        : new Promise<ExternalSessionOperationConvergenceWaitResult>(() => undefined);

    try {
        return await closeWatcher(await Promise.race([
            changed,
            boundary,
            aborted,
        ]));
    } catch {
        if (boundaryTimer) clearTimeout(boundaryTimer);
        if (abortListener && input.signal) {
            input.signal.removeEventListener('abort', abortListener);
        }
        watcherController.abort();
        try {
            await watcher.return?.();
        } catch {
            return { status: 'failed', reason: 'watch_closure_failed' };
        }
        return { status: 'failed', reason: 'watch_iteration_failed' };
    }
}

function isAtomicClaimConflict(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

function conflictReason(
    active: ExternalSessionOperationClaimRecord,
    request: ExternalSessionOperationRequest,
    accountSubject?: string,
): Extract<ExternalSessionOperationAcquireResult, { status: 'conflict' }>['reason'] {
    if (
        accountSubject
        && active.accountSubject
        && active.accountSubject !== accountSubject
    ) {
        return 'account_subject_mismatch';
    }
    if (active.request.requestId === request.requestId) return 'semantic_request_mismatch';
    if (active.request.kind !== 'handoff' && request.kind !== 'handoff') {
        if (active.request.sourceIdentity !== request.sourceIdentity) return 'source_identity_mismatch';
        if (active.request.sourceGeneration !== request.sourceGeneration) return 'source_generation_mismatch';
    }
    return 'active_operation';
}

function sameOwnerProcess(
    left: ExternalSessionOperationOwnerProcess,
    right: ExternalSessionOperationOwnerProcess,
): boolean {
    return left.pid === right.pid
        && processGenerationMatches(left.processStartTimeMs, right.processStartTimeMs);
}

export function createExternalSessionOperationExclusion(input: Readonly<{
    activeServerDir: string;
    ownerId: string;
    ownerProcess?: ExternalSessionOperationOwnerProcess;
    inspectOwnerProcess?: (
        ownerProcess: ExternalSessionOperationOwnerProcess,
    ) => Promise<ExternalSessionOperationOwnerProcessLiveness>;
    nowMs?: () => number;
    watchClaimChanges?: typeof watch;
}>): ExternalSessionOperationExclusionOwner {
    const activeServerDir = readRequiredString(input.activeServerDir, 'activeServerDir');
    const ownerId = readRequiredString(input.ownerId, 'ownerId');
    const providedOwnerProcess = input.ownerProcess === undefined
        ? undefined
        : normalizeOwnerProcess(input.ownerProcess);
    if (input.ownerProcess !== undefined && !providedOwnerProcess) {
        throw new Error('External session operation ownerProcess is invalid');
    }
    const readOwnerProcess = async (): Promise<ExternalSessionOperationOwnerProcess> => {
        if (providedOwnerProcess) return providedOwnerProcess;
        const identity = await readProcessIdentityByPid(process.pid);
        const ownerProcess = normalizeOwnerProcess(identity);
        if (!ownerProcess) throw new Error('Current external operation process generation is unavailable');
        return ownerProcess;
    };
    const inspectOwnerProcess =
        input.inspectOwnerProcess ?? inspectProcessGeneration;
    const nowMs = input.nowMs ?? Date.now;
    const watchClaimChanges = input.watchClaimChanges ?? watch;

    const inspectClaimOwnerLiveness = async (
        claim: ExternalSessionOperationClaimRecord,
    ): Promise<ExternalSessionOperationOwnerProcessLiveness> => {
        if (!claim.ownerProcess) return 'unknown';
        return sameOwnerProcess(claim.ownerProcess, await readOwnerProcess())
            ? 'verified_running'
            : await inspectOwnerProcess(claim.ownerProcess);
    };

    const readPassiveRepairActiveClaimUnderLock = async (
        sessionId: string,
    ): Promise<ExternalSessionOperationClaimRecord | null> => {
        const paths = resolveClaimPaths(activeServerDir, sessionId);
        const active = await readClaim(paths.claimFilePath);
        if (!active) {
            try {
                await readFile(paths.claimFilePath, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                    return null;
                }
            }
            throw new Error(
                'external_session_operation_repair_claim_unreadable',
            );
        }
        const ownerLiveness = await inspectClaimOwnerLiveness(active);
        return ownerLiveness === 'verified_stopped' ? null : active;
    };

    const inspectPassiveRepairClaimUnderLock = async (rawInput: Readonly<{
        sessionId: string;
        operationClaimId: string;
    }>): Promise<'active' | 'inactive'> => {
        const sessionId = readRequiredString(rawInput.sessionId, 'sessionId');
        const operationClaimId = readRequiredString(
            rawInput.operationClaimId,
            'operationClaimId',
        );
        const active = await readPassiveRepairActiveClaimUnderLock(sessionId);
        if (!active) return 'inactive';
        if (active.claimId !== operationClaimId) {
            throw new Error(
                'external_session_operation_repair_claim_conflict',
            );
        }
        return 'active';
    };

    const buildClaim = (
        record: ExternalSessionOperationClaimRecord,
    ): ExternalSessionOperationClaim => Object.freeze({
        record,
        async release() {
            const paths = resolveClaimPaths(activeServerDir, record.request.sessionId);
            await withClaimMutationLock(paths.mutationLockPath, async () => {
                const current = await readClaim(paths.claimFilePath);
                if (!current || current.claimId !== record.claimId || current.ownerId !== ownerId) return;
                const releasedDirectory = `${paths.claimDirectory}.released-${record.claimId}`;
                try {
                    await rename(paths.claimDirectory, releasedDirectory);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
                    throw error;
                }
                await rm(releasedDirectory, { recursive: true, force: true });
            });
        },
    });

    return Object.freeze({
        async inspectPassiveRepairClaim(rawInput) {
            const sessionId = readRequiredString(rawInput.sessionId, 'sessionId');
            const paths = resolveClaimPaths(activeServerDir, sessionId);
            await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
            return await withClaimMutationLock(
                paths.mutationLockPath,
                async () => await inspectPassiveRepairClaimUnderLock(rawInput),
            );
        },
        async withPassiveRepairClaimBarrier(rawInput, effect) {
            const sessionId = readRequiredString(rawInput.sessionId, 'sessionId');
            const paths = resolveClaimPaths(activeServerDir, sessionId);
            await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
            return await withClaimMutationLock(paths.mutationLockPath, async () => {
                if (
                    await inspectPassiveRepairClaimUnderLock(rawInput)
                    === 'active'
                ) {
                    return Object.freeze({ status: 'active' as const });
                }
                return Object.freeze({
                    status: 'executed' as const,
                    value: await effect(),
                });
            });
        },
        async withPassiveRepairSessionBarrier(rawInput, effect) {
            const sessionId = readRequiredString(rawInput.sessionId, 'sessionId');
            const paths = resolveClaimPaths(activeServerDir, sessionId);
            await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
            return await withClaimMutationLock(
                paths.mutationLockPath,
                async () => {
                    if (await readPassiveRepairActiveClaimUnderLock(sessionId)) {
                        return Object.freeze({ status: 'active' as const });
                    }
                    return Object.freeze({
                        status: 'executed' as const,
                        value: await effect(),
                    });
                },
            );
        },
        async acquire(rawRequest, acquireInput = {}) {
            const request = normalizeRequest(rawRequest);
            const accountSubject =
                typeof acquireInput.accountSubject === 'string'
                  && acquireInput.accountSubject.trim()
                    ? acquireInput.accountSubject.trim()
                    : undefined;
            const paths = resolveClaimPaths(activeServerDir, request.sessionId);
            await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
            return await withClaimMutationLock(paths.mutationLockPath, async () => {
                for (;;) {
                    acquireInput.signal?.throwIfAborted();
                    const active = await readClaim(paths.claimFilePath);
                    if (active) {
                        const ownerLiveness = await inspectClaimOwnerLiveness(active);
                        if (ownerLiveness !== 'verified_stopped') {
                            const reason = conflictReason(active, request, accountSubject);
                            if (reason !== 'account_subject_mismatch'
                                && serializeSemanticRequest(active.request) === serializeSemanticRequest(request)) {
                                return Object.freeze({
                                    status: 'converged',
                                    active,
                                    waitForRelease: async (waitInput = {}) => {
                                        return await waitForClaimRelease({
                                            watchDirectory: paths.rootDirectory,
                                            claimFilePath: paths.claimFilePath,
                                            active,
                                            nowMs,
                                            watchClaimChanges,
                                            ...waitInput,
                                        });
                                    },
                                });
                            }
                            return Object.freeze({
                                status: 'conflict',
                                reason,
                                active,
                            });
                        }
                    }

                    if (active) {
                        const staleDirectory = `${paths.claimDirectory}.stale-${randomUUID()}`;
                        try {
                            await rename(paths.claimDirectory, staleDirectory);
                            await rm(staleDirectory, { recursive: true, force: true });
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
                        }
                    } else {
                        try {
                            await readFile(paths.claimFilePath, 'utf8');
                            return Object.freeze({ status: 'conflict', reason: 'claim_unreadable', active: null });
                        } catch (error) {
                            const code = (error as NodeJS.ErrnoException)?.code;
                            if (code !== 'ENOENT') {
                                return Object.freeze({ status: 'conflict', reason: 'claim_unreadable', active: null });
                            }
                        }
                    }

                    const ownerProcess = await readOwnerProcess();
                    const acquiredAtMs = nowMs();
                    const record: ExternalSessionOperationClaimRecord = Object.freeze({
                        schemaVersion: 2,
                        claimId: randomUUID(),
                        ownerId,
                        ownerProcess,
                        request,
                        ...(accountSubject ? { accountSubject } : {}),
                        acquiredAtMs,
                    });
                    const temporaryDirectory = `${paths.claimDirectory}.tmp-${record.claimId}`;
                    await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
                    await writeFile(join(temporaryDirectory, 'claim.json'), `${JSON.stringify(record)}\n`, {
                        encoding: 'utf8',
                        mode: 0o600,
                    });
                    try {
                        await rename(temporaryDirectory, paths.claimDirectory);
                        return Object.freeze({ status: 'acquired', claim: buildClaim(record) });
                    } catch (error) {
                        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
                        if (!isAtomicClaimConflict(error)) throw error;
                    }
                }

            }, acquireInput.signal);
        },
    });
}
