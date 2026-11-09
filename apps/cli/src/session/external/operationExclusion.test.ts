import { createHash } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';

import {
    createExternalSessionOperationExclusion,
    inspectExternalSessionOperationOwnerProcess,
    type ExternalSessionOperationRequest,
} from './operationExclusion';

const createdDirectories: string[] = [];

async function createOwner(ownerId: string, nowMs: () => number) {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
    createdDirectories.push(activeServerDir);
    return {
        activeServerDir,
        owner: createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId,
            nowMs,

        }),
    };
}

function materializeRequest(overrides: Partial<Extract<ExternalSessionOperationRequest, { kind: 'materialize' }>> = {}) {
    return {
        kind: 'materialize',
        sessionId: 'session-1',
        requestId: 'request-materialize-1',
        sourceIdentity: 'codex:thread-1',
        sourceGeneration: 'generation-1',
        ...overrides,
    } as const;
}

function takeoverRequest(overrides: Partial<Extract<ExternalSessionOperationRequest, { kind: 'takeover' }>> = {}) {
    return {
        kind: 'takeover',
        sessionId: 'session-1',
        requestId: 'request-takeover-1',
        sourceIdentity: 'codex:thread-1',
        sourceGeneration: 'generation-1',
        plan: 'persisted',
        ...overrides,
    } as const;
}

function handoffRequest(overrides: Partial<Extract<ExternalSessionOperationRequest, { kind: 'handoff' }>> = {}) {
    return {
        kind: 'handoff',
        sessionId: 'session-1',
        requestId: 'handoff-1',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        semanticRequest: '{"sessionStorageMode":"persisted"}',
        ...overrides,
    } as const;
}

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(createdDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe('external session operation exclusion', () => {
    it('records the canonical process witness for a new claim', async () => {
        const { owner } = await createOwner('daemon:canonical', Date.now);
        const acquired = await owner.acquire(materializeRequest());
        expect(acquired.status).toBe('acquired');
        if (acquired.status !== 'acquired') return;
        expect(acquired.claim.record).toMatchObject({
            schemaVersion: 2,
            ownerProcess: {
                pid: process.pid,
                processStartTimeMs: (await readProcessIdentityByPid(process.pid))?.processStartTimeMs,
            },
        });
        await acquired.claim.release();
    });

    it('compares a live Linux claim in numeric witness units and detects PID reuse', async () => {
        const ownerProcess = { pid: 4_242, processStartTimeMs: 190 } as const;
        const inspect = (observedStart: number) => inspectExternalSessionOperationOwnerProcess(
            ownerProcess,
            {
                readProcessRunState: async () => 'servable',
                readProcessIdentityByPid: async () => ({
                    pid: ownerProcess.pid,
                    processStartTimeMs: observedStart,
                    command: 'happier daemon',
                }),
            },
        );
        await expect(inspect(190)).resolves.toBe('verified_running');
        await expect(inspect(200)).resolves.toBe('verified_stopped');
    });
    it.each(['dead', 'zombie'] as const)(
        'verifies a recorded owner process is stopped when its run state is %s',
        async (runState) => {
            const readProcessIdentityByPid = vi.fn();
            await expect(inspectExternalSessionOperationOwnerProcess({
                pid: 4_242,
                processStartTimeMs: 1_717_171_717_000,
            }, {
                readProcessRunState: async () => runState,
                readProcessIdentityByPid,
            })).resolves.toBe('verified_stopped');
            expect(readProcessIdentityByPid).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['stopped run state', async () => ({
            readProcessRunState: async () => 'stopped' as const,
            readProcessIdentityByPid: async () => null,
        })],
        ['missing process identity', async () => ({
            readProcessRunState: async () => 'servable' as const,
            readProcessIdentityByPid: async () => null,
        })],
    ] as const)('fails closed when owner process liveness has %s', async (_case, buildDependencies) => {
        await expect(inspectExternalSessionOperationOwnerProcess({
            pid: 4_242,
            processStartTimeMs: 1_717_171_717_000,
        }, await buildDependencies())).resolves.toBe('unknown');
    });

    it('atomically excludes materialize, takeover, and handoff in every first-owner ordering', async () => {
        let nowMs = 1_000;
        const { owner } = await createOwner('daemon:one', () => nowMs);

        const materialize = await owner.acquire(materializeRequest());
        expect(materialize.status).toBe('acquired');
        await expect(owner.acquire(takeoverRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { kind: 'materialize' } },
        });
        await expect(owner.acquire(handoffRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { kind: 'materialize' } },
        });
        if (materialize.status !== 'acquired') throw new Error('expected materialize acquisition');
        await materialize.claim.release();

        const takeover = await owner.acquire(takeoverRequest());
        expect(takeover.status).toBe('acquired');
        await expect(owner.acquire(handoffRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { kind: 'takeover' } },
        });
        if (takeover.status !== 'acquired') throw new Error('expected takeover acquisition');
        await takeover.claim.release();

        const handoff = await owner.acquire(handoffRequest());
        expect(handoff.status).toBe('acquired');
        await expect(owner.acquire(materializeRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { kind: 'handoff' } },
        });
        if (handoff.status !== 'acquired') throw new Error('expected handoff acquisition');
        await handoff.claim.release();

        nowMs += 1;
        await expect(owner.acquire(materializeRequest())).resolves.toMatchObject({ status: 'acquired' });
    });

    it('converges an identical semantic request but rejects request-id reuse, relink, and generation drift', async () => {
        const { activeServerDir, owner } = await createOwner('daemon:one', () => 2_000);
        const acquired = await owner.acquire(takeoverRequest());
        expect(acquired.status).toBe('acquired');

        const restartedOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:two',
            nowMs: () => 2_100,

        });
        await expect(restartedOwner.acquire(takeoverRequest())).resolves.toMatchObject({
            status: 'converged',
            active: { request: takeoverRequest() },
        });
        await expect(restartedOwner.acquire(takeoverRequest({ plan: 'external-linked' }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'semantic_request_mismatch',
        });
        const handoffOwner = await createOwner('daemon:handoff', () => 2_000);
        await expect(handoffOwner.owner.acquire(handoffRequest())).resolves.toMatchObject({ status: 'acquired' });
        await expect(handoffOwner.owner.acquire(handoffRequest({
            semanticRequest: '{"sessionStorageMode":"direct"}',
        }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'semantic_request_mismatch',
        });
        await expect(restartedOwner.acquire(takeoverRequest({
            sourceIdentity: 'codex:thread-2',
        }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'semantic_request_mismatch',
        });
        await expect(restartedOwner.acquire(takeoverRequest({
            sourceGeneration: 'generation-2',
        }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'semantic_request_mismatch',
        });
        await expect(restartedOwner.acquire(takeoverRequest({
            requestId: 'request-takeover-relinked',
            sourceIdentity: 'codex:thread-2',
        }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'source_identity_mismatch',
        });
        await expect(restartedOwner.acquire(takeoverRequest({
            requestId: 'request-takeover-next-generation',
            sourceGeneration: 'generation-2',
        }))).resolves.toMatchObject({
            status: 'conflict',
            reason: 'source_generation_mismatch',
        });
    });

    it('binds the pinned Account subject into the claim and conflicts on A→B rotation', async () => {
        const { activeServerDir, owner } = await createOwner('daemon:one', () => 2_000);
        const first = await owner.acquire(takeoverRequest(), { accountSubject: 'account-a' });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') throw new Error('expected acquisition');
        expect(first.claim.record.accountSubject).toBe('account-a');

        // The same pinned subject converges to the same claim.
        await expect(owner.acquire(takeoverRequest(), { accountSubject: 'account-a' }))
            .resolves.toMatchObject({ status: 'converged' });

        // A rotated subject may neither acquire nor converge the claim.
        const rotated = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:two',
            nowMs: () => 2_000,

        });
        await expect(rotated.acquire(takeoverRequest(), { accountSubject: 'account-b' }))
            .resolves.toMatchObject({
                status: 'conflict',
                reason: 'account_subject_mismatch',
            });
        await expect(rotated.acquire(takeoverRequest()))
            .resolves.toMatchObject({ status: 'converged' });

        await first.claim.release();
        await expect(rotated.acquire(takeoverRequest(), { accountSubject: 'account-b' }))
            .resolves.toMatchObject({ status: 'acquired' });
    });

    it.each([
        ['creation', () => {
            throw new Error('watch creation failed');
        }],
        ['iteration', () => ({
            next: vi.fn(async () => {
                throw new Error('watch iteration failed');
            }),
            return: vi.fn(async () => ({ done: true as const, value: undefined })),
            [Symbol.asyncIterator]() {
                return this;
            },
        })],
        ['closure', () => ({
            next: vi.fn(async () => ({
                done: false as const,
                value: { eventType: 'rename' as const, filename: 'claim.json' },
            })),
            return: vi.fn(async () => {
                throw new Error('watch closure failed');
            }),
            [Symbol.asyncIterator]() {
                return this;
            },
        })],
    ] as const)('settles watcher %s failure as a typed convergence result', async (
        expectedFailure,
        createWatcher,
    ) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
        createdDirectories.push(activeServerDir);
        const firstOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:first',

        });
        const first = await firstOwner.acquire(takeoverRequest());
        if (first.status !== 'acquired') throw new Error('expected first acquisition');
        const watchClaimChanges = vi.fn(createWatcher) as unknown as
            typeof import('node:fs/promises').watch;
        const secondOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:second',

            watchClaimChanges,
        });
        const converged = await secondOwner.acquire(takeoverRequest());
        if (converged.status !== 'converged') {
            throw new Error('expected semantic convergence');
        }
        const fallbackRelease = setTimeout(() => {
            void first.claim.release();
        }, 50);
        try {
            await expect(converged.waitForRelease?.()).resolves.toEqual({
                status: 'failed',
                reason: `watch_${expectedFailure}_failed`,
            });
        } finally {
            clearTimeout(fallbackRelease);
            await first.claim.release();
        }
    });

    it('cleans its abort listener and watcher when cancelled', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
        createdDirectories.push(activeServerDir);
        const firstOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:first',

        });
        const first = await firstOwner.acquire(takeoverRequest());
        if (first.status !== 'acquired') throw new Error('expected first acquisition');
        const watcher = {
            next: vi.fn(async () => await new Promise<never>(() => undefined)),
            return: vi.fn(async () => ({ done: true as const, value: undefined })),
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        const secondOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:second',

            watchClaimChanges: vi.fn(() => watcher) as unknown as
                typeof import('node:fs/promises').watch,
        });
        const converged = await secondOwner.acquire(takeoverRequest());
        if (converged.status !== 'converged') {
            throw new Error('expected semantic convergence');
        }
        const waitForRelease = converged.waitForRelease as unknown as (
            input: Readonly<{ signal: AbortSignal }>,
        ) => Promise<unknown>;
        const controller = new AbortController();

        const result = waitForRelease({ signal: controller.signal });
        await vi.waitFor(() => {
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
        });
        controller.abort();
        await expect(result).resolves.toEqual({ status: 'aborted' });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(watcher.return).toHaveBeenCalledOnce();
        await first.claim.release();
    });

    it('pre-arms a lazy watcher before rereading so release in the arm gap is not lost', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
        createdDirectories.push(activeServerDir);
        const firstOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:first',

        });
        const first = await firstOwner.acquire(takeoverRequest());
        if (first.status !== 'acquired') throw new Error('expected first acquisition');
        const claimDirectory = join(
            activeServerDir,
            'external-session-operations',
            createHash('sha256').update('session-1', 'utf8').digest('hex'),
        );
        const releasedDirectory = `${claimDirectory}.released-by-lazy-watch-probe`;
        let nextRead = false;
        const watcher = {
            get next() {
                if (!nextRead) {
                    nextRead = true;
                    renameSync(claimDirectory, releasedDirectory);
                    rmSync(releasedDirectory, { recursive: true, force: true });
                }
                return async () => await new Promise<never>(() => undefined);
            },
            return: vi.fn(async () => ({ done: true as const, value: undefined })),
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        const secondOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:second',

            watchClaimChanges: vi.fn(() => watcher) as unknown as
                typeof import('node:fs/promises').watch,
        });
        const converged = await secondOwner.acquire(takeoverRequest());
        if (converged.status !== 'converged') {
            throw new Error('expected semantic convergence');
        }

        await expect(converged.waitForRelease?.({
            deadlineAtMs: Date.now() + 100,
        })).resolves.toEqual({ status: 'ready' });
        expect(nextRead).toBe(true);
        expect(watcher.return).toHaveBeenCalledOnce();
    });

    it('settles at the caller deadline and closes the watcher before claim expiry', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
        createdDirectories.push(activeServerDir);
        const firstOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:first',

        });
        const first = await firstOwner.acquire(takeoverRequest());
        if (first.status !== 'acquired') throw new Error('expected first acquisition');
        const watcher = {
            next: vi.fn(async () => await new Promise<never>(() => undefined)),
            return: vi.fn(async () => ({ done: true as const, value: undefined })),
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        const secondOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:second',

            watchClaimChanges: vi.fn(() => watcher) as unknown as
                typeof import('node:fs/promises').watch,
        });
        const converged = await secondOwner.acquire(takeoverRequest());
        if (converged.status !== 'converged') {
            throw new Error('expected semantic convergence');
        }

        await expect(converged.waitForRelease?.({
            deadlineAtMs: Date.now() + 20,
        })).resolves.toEqual({ status: 'aborted' });
        expect(watcher.return).toHaveBeenCalledOnce();
        await first.claim.release();
    });

    it('reclaims an unexpired claim from a verified-stopped predecessor without letting the stale owner release its successor', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
        createdDirectories.push(activeServerDir);
        const predecessorProcess = {
            pid: 4_242,
            processStartTimeMs: 1_717_171_717_000,
        } as const;
        const predecessor = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:predecessor',
            ownerProcess: predecessorProcess,
            inspectOwnerProcess: async () => 'unknown',
            nowMs: () => 4_000,

        });
        const first = await predecessor.acquire(materializeRequest());
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') throw new Error('expected predecessor acquisition');

        const inspectOwnerProcess = vi.fn(async () => 'verified_stopped' as const);
        const replacement = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:replacement',
            ownerProcess: {
                pid: 4_243,
                processStartTimeMs: 1_717_171_718_000,
            },
            inspectOwnerProcess,
            nowMs: () => 4_100,

        });
        const resumed = await replacement.acquire(materializeRequest());

        expect(resumed.status).toBe('acquired');
        expect(inspectOwnerProcess).toHaveBeenCalledWith(predecessorProcess);
        if (resumed.status !== 'acquired') throw new Error('expected replacement acquisition');
        expect(resumed.claim.record.ownerId).toBe('daemon:replacement');

        await first.claim.release();
        await expect(predecessor.acquire(takeoverRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: {
                claimId: resumed.claim.record.claimId,
                ownerId: 'daemon:replacement',
            },
        });
    });

    it.each(['verified_running', 'unknown'] as const)(
        'preserves an unexpired claim when predecessor process liveness is %s',
        async (liveness) => {
            const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-exclusion-'));
            createdDirectories.push(activeServerDir);
            const predecessorProcess = {
                pid: 5_242,
                processStartTimeMs: 1_717_171_717_000,
            } as const;
            const predecessor = createExternalSessionOperationExclusion({
                activeServerDir,
                ownerId: 'daemon:predecessor',
                ownerProcess: predecessorProcess,
                nowMs: () => 4_000,

            });
            await expect(predecessor.acquire(materializeRequest())).resolves.toMatchObject({
                status: 'acquired',
            });

            const inspectOwnerProcess = vi.fn(async () => liveness);
            const replacement = createExternalSessionOperationExclusion({
                activeServerDir,
                ownerId: 'daemon:replacement',
                ownerProcess: {
                    pid: 5_243,
                    processStartTimeMs: 1_717_171_718_000,
                },
                inspectOwnerProcess,
                nowMs: () => 4_100,

            });

            await expect(replacement.acquire(materializeRequest())).resolves.toMatchObject({
                status: 'converged',
                active: { ownerId: 'daemon:predecessor' },
            });
            expect(inspectOwnerProcess).toHaveBeenCalledWith(predecessorProcess);
        },
    );

    it('inspects the exact live repair claim and fails closed for a different or malformed claim', async () => {
        let nowMs = 5_000;
        const { activeServerDir, owner } = await createOwner(
            'daemon:repair-inspection',
            () => nowMs,
        );
        const acquired = await owner.acquire(materializeRequest());
        if (acquired.status !== 'acquired') throw new Error('expected acquisition');
        const repairEffect = vi.fn(async () => 'repaired' as const);

        await expect(owner.inspectPassiveRepairClaim({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        })).resolves.toBe('active');
        await expect(owner.withPassiveRepairClaimBarrier({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        }, repairEffect)).resolves.toEqual({ status: 'active' });
        await expect(owner.withPassiveRepairSessionBarrier({
            sessionId: acquired.claim.record.request.sessionId,
        }, repairEffect)).resolves.toEqual({ status: 'active' });
        expect(repairEffect).not.toHaveBeenCalled();
        await expect(owner.inspectPassiveRepairClaim({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: 'different-live-claim',
        })).rejects.toThrow(
            'external_session_operation_repair_claim_conflict',
        );

        nowMs += 60_001;
        await acquired.claim.release();
        await expect(owner.inspectPassiveRepairClaim({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        })).resolves.toBe('inactive');
        await expect(owner.withPassiveRepairClaimBarrier({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        }, repairEffect)).resolves.toEqual({
            status: 'executed',
            value: 'repaired',
        });
        await expect(owner.withPassiveRepairSessionBarrier({
            sessionId: acquired.claim.record.request.sessionId,
        }, repairEffect)).resolves.toEqual({
            status: 'executed',
            value: 'repaired',
        });
        expect(repairEffect).toHaveBeenCalledTimes(2);
        await acquired.claim.release();

        const sessionKey = createHash('sha256')
            .update(acquired.claim.record.request.sessionId, 'utf8')
            .digest('hex');
        const claimDirectory = join(
            activeServerDir,
            'external-session-operations',
            sessionKey,
        );
        await mkdir(claimDirectory, { recursive: true });
        await writeFile(join(claimDirectory, 'claim.json'), '{malformed', 'utf8');
        await expect(owner.inspectPassiveRepairClaim({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        })).rejects.toThrow(
            'external_session_operation_repair_claim_unreadable',
        );
        const malformedEffect = vi.fn(async () => undefined);
        await expect(owner.withPassiveRepairClaimBarrier({
            sessionId: acquired.claim.record.request.sessionId,
            operationClaimId: acquired.claim.record.claimId,
        }, malformedEffect)).rejects.toThrow(
            'external_session_operation_repair_claim_unreadable',
        );
        await expect(owner.withPassiveRepairSessionBarrier({
            sessionId: acquired.claim.record.request.sessionId,
        }, malformedEffect)).rejects.toThrow(
            'external_session_operation_repair_claim_unreadable',
        );
        expect(malformedEffect).not.toHaveBeenCalled();

        // 0.2 never wrote these claims. An undeployed v1 wall-clock claim
        // cannot be reinterpreted as a current numeric-witness record.
        await writeFile(join(claimDirectory, 'claim.json'), JSON.stringify({
            ...acquired.claim.record,
            schemaVersion: 1,
        }), 'utf8');
        await expect(owner.withPassiveRepairSessionBarrier({
            sessionId: acquired.claim.record.request.sessionId,
        }, malformedEffect)).rejects.toThrow(
            'external_session_operation_repair_claim_unreadable',
        );
    });

    it('waits for the owning passive repair without a local acquisition cutoff', async () => {
        const activeServerDir = await mkdtemp(join(
            tmpdir(),
            'happier-operation-repair-barrier-deadline-',
        ));
        createdDirectories.push(activeServerDir);
        const owner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:repair-barrier-deadline',

        });
        let signalRepairStarted!: () => void;
        const repairStarted = new Promise<void>((resolve) => {
            signalRepairStarted = resolve;
        });
        let releaseRepair!: () => void;
        const repairRelease = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        const repair = owner.withPassiveRepairClaimBarrier({
            sessionId: materializeRequest().sessionId,
            operationClaimId: 'claim-repair-barrier-deadline',
        }, async () => {
            signalRepairStarted();
            await repairRelease;
        });
        await repairStarted;

        let acquisitionSettled = false;
        const acquisition = owner.acquire(materializeRequest()).then(
            (result) => {
                acquisitionSettled = true;
                return { status: 'resolved' as const, result };
            },
            (error: unknown) => {
                acquisitionSettled = true;
                return { status: 'rejected' as const, error };
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const settledBeforeRepairRelease = acquisitionSettled;
        releaseRepair();
        await repair;
        const acquisitionOutcome = await acquisition;
        if (
            acquisitionOutcome.status === 'resolved'
            && acquisitionOutcome.result.status === 'acquired'
        ) {
            await acquisitionOutcome.result.claim.release();
        }

        expect(settledBeforeRepairRelease).toBe(false);
        expect(acquisitionOutcome).toMatchObject({ status: 'resolved', result: { status: 'acquired' } });
    });

    it('does not retry a barrier effect that throws the contention error code', async () => {
        const { owner } = await createOwner(
            'daemon:repair-effect-error',
            Date.now,
        );
        const effect = vi.fn(async () => {
            throw new Error(
                'external_session_operation_claim_lock_timeout',
            );
        });

        await expect(owner.withPassiveRepairClaimBarrier({
            sessionId: materializeRequest().sessionId,
            operationClaimId: 'claim-repair-effect-error',
        }, effect)).rejects.toThrow(
            'external_session_operation_claim_lock_timeout',
        );
        expect(effect).toHaveBeenCalledOnce();
    });

    it('cancels a pending claim acquisition without releasing the live repair barrier', async () => {
        const activeServerDir = await mkdtemp(join(
            tmpdir(),
            'happier-operation-repair-barrier-cancellation-',
        ));
        createdDirectories.push(activeServerDir);
        const owner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:repair-barrier-cancellation',

        });
        let signalRepairStarted!: () => void;
        const repairStarted = new Promise<void>((resolve) => {
            signalRepairStarted = resolve;
        });
        let releaseRepair!: () => void;
        const repairRelease = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        const repair = owner.withPassiveRepairClaimBarrier({
            sessionId: materializeRequest().sessionId,
            operationClaimId: 'claim-repair-barrier-cancellation',
        }, async () => {
            signalRepairStarted();
            await repairRelease;
        });
        await repairStarted;

        const controller = new AbortController();
        let acquisitionSettled = false;
        const acquisition = owner.acquire(materializeRequest(), {
            signal: controller.signal,
        }).then(
            (result) => {
                acquisitionSettled = true;
                return { status: 'resolved' as const, result };
            },
            (error: unknown) => {
                acquisitionSettled = true;
                return { status: 'rejected' as const, error };
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        const remainedPendingThroughContention = !acquisitionSettled;
        controller.abort();
        const acquisitionOutcome = await acquisition;
        const abortErrorSettledBeforeRepairRelease =
            acquisitionOutcome.status === 'rejected'
            && acquisitionOutcome.error instanceof Error
            && acquisitionOutcome.error.name === 'AbortError';
        releaseRepair();
        await repair;
        if (
            acquisitionOutcome.status === 'resolved'
            && acquisitionOutcome.result.status === 'acquired'
        ) {
            await acquisitionOutcome.result.claim.release();
        }

        expect(remainedPendingThroughContention).toBe(true);
        expect(abortErrorSettledBeforeRepairRelease).toBe(true);
        expect(acquisitionOutcome).toMatchObject({
            status: 'rejected',
            error: { name: 'AbortError' },
        });

        const probe = await owner.acquire(materializeRequest());
        expect(probe.status).toBe('acquired');
        if (probe.status !== 'acquired') throw new Error('expected probe acquisition');
        await expect(owner.inspectPassiveRepairClaim({
            sessionId: probe.claim.record.request.sessionId,
            operationClaimId: probe.claim.record.claimId,
        })).resolves.toBe('active');
        await probe.claim.release();
        await expect(owner.inspectPassiveRepairClaim({
            sessionId: probe.claim.record.request.sessionId,
            operationClaimId: probe.claim.record.claimId,
        })).resolves.toBe('inactive');
    });

    it('keeps a live owner beyond the former expiry and reclaims only its stopped process', async () => {
        let nowMs = 5_000;
        let ownerStopped = false;
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-process-'));
        createdDirectories.push(activeServerDir);
        const owner = createExternalSessionOperationExclusion({
            activeServerDir, ownerId: 'daemon:one', nowMs: () => nowMs,
            ownerProcess: { pid: 4_242, processStartTimeMs: 190 },
            inspectOwnerProcess: async () => 'verified_running',
        });
        const first = await owner.acquire(handoffRequest());
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') throw new Error('expected handoff acquisition');
        // The prior local writer persisted wall-clock lease fields. They remain
        // readable, but no longer override the process witness.
        const claimDirectory = join(activeServerDir, 'external-session-operations', createHash('sha256').update('session-1', 'utf8').digest('hex'));
        await writeFile(join(claimDirectory, 'claim.json'), JSON.stringify({ ...first.claim.record, renewedAtMs: 5_000, expiresAtMs: 65_000 }));

        const restartedOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:two',
            nowMs: () => nowMs,
            ownerProcess: { pid: 4_243, processStartTimeMs: 200 },
            inspectOwnerProcess: async () => ownerStopped ? 'verified_stopped' : 'verified_running',
        });
        await expect(restartedOwner.acquire(handoffRequest())).resolves.toMatchObject({ status: 'converged' });

        nowMs = 65_001;
        await expect(restartedOwner.acquire(takeoverRequest())).resolves.toMatchObject({ status: 'conflict' });
        await expect(restartedOwner.inspectPassiveRepairClaim({ sessionId: 'session-1', operationClaimId: first.claim.record.claimId })).resolves.toBe('active');
        ownerStopped = true;
        const replacement = await restartedOwner.acquire(takeoverRequest());
        expect(replacement.status).toBe('acquired');
        await first.claim.release();

        await expect(owner.acquire(materializeRequest())).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { kind: 'takeover' } },
        });
        if (replacement.status !== 'acquired') throw new Error('expected replacement acquisition');
        await replacement.claim.release();
        await expect(owner.acquire(materializeRequest())).resolves.toMatchObject({ status: 'acquired' });
    });

});
