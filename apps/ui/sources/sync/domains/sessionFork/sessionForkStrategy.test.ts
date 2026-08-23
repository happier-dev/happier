import { describe, expect, it } from 'vitest';

import {
    classifySessionForkRpcOutcome,
    findForkChildForRequest,
    type SessionForkChildCandidate,
} from './sessionForkStrategy';

function candidate(
    id: string,
    forkV1: Record<string, unknown> | null,
): SessionForkChildCandidate {
    return { sessionId: id, metadata: forkV1 ? { forkV1 } : {} };
}

describe('classifySessionForkRpcOutcome', () => {
    it('reports a created child when the daemon returned one', () => {
        expect(classifySessionForkRpcOutcome({ ok: true, childSessionId: 'child_1' } as any))
            .toEqual({ type: 'created', childSessionId: 'child_1' });
    });

    it('treats an unavailable daemon method as a definite update requirement, not an unknown outcome', () => {
        expect(classifySessionForkRpcOutcome({
            ok: false,
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: 'Daemon RPC is not available',
        } as any)).toEqual({
            type: 'failed',
            kind: 'update_required',
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            message: 'Daemon RPC is not available',
        });
    });

    it('treats a webhook timeout as outcome-unknown so the caller never blind-retries', () => {
        expect(classifySessionForkRpcOutcome({
            ok: false,
            errorCode: 'SESSION_WEBHOOK_TIMEOUT',
            errorMessage: 'timed out',
        } as any)).toEqual({ type: 'unknown', errorCode: 'SESSION_WEBHOOK_TIMEOUT' });
    });

    it('treats an unexpected transport failure as outcome-unknown because the request may have been emitted', () => {
        expect(classifySessionForkRpcOutcome({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: 'socket closed',
        } as any)).toEqual({ type: 'unknown', errorCode: 'UNEXPECTED' });
    });

    it('treats a daemon domain rejection as a definite failure', () => {
        expect(classifySessionForkRpcOutcome({
            ok: false,
            errorCode: 'fork_strategy_unsupported',
            errorMessage: 'Native fork is not supported for this session',
        } as any)).toEqual({
            type: 'failed',
            kind: 'error',
            errorCode: 'fork_strategy_unsupported',
            message: 'Native fork is not supported for this session',
        });
    });

    it('treats a client-side missing machine target as a definite failure', () => {
        expect(classifySessionForkRpcOutcome({
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable machine target found for session fork',
        } as any)).toMatchObject({ type: 'failed', kind: 'error' });
    });
});

describe('findForkChildForRequest', () => {
    const base = {
        parentSessionId: 'parent_1',
        forkPoint: { type: 'seq', upToSeqInclusive: 12 },
        knownChildSessionIds: new Set<string>(),
    } as const;

    it('finds the child the daemon actually created for a replay request', () => {
        const result = findForkChildForRequest({
            ...base,
            route: 'replay',
            candidates: [
                candidate('child_1', {
                    v: 1,
                    parentSessionId: 'parent_1',
                    parentCutoffSeqInclusive: 12,
                    strategy: 'replay',
                }),
            ],
        });
        expect(result).toEqual({ type: 'found', childSessionId: 'child_1' });
    });

    it('accepts either resolved native strategy for a generic native request', () => {
        for (const strategy of ['provider_native', 'acp_fork_latest', 'native']) {
            expect(findForkChildForRequest({
                ...base,
                route: 'native',
                candidates: [
                    candidate('child_n', {
                        v: 1,
                        parentSessionId: 'parent_1',
                        parentCutoffSeqInclusive: 12,
                        strategy,
                    }),
                ],
            })).toEqual({ type: 'found', childSessionId: 'child_n' });
        }
    });

    it('never adopts a replay child for a native request', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'native',
            candidates: [
                candidate('child_replay', {
                    v: 1,
                    parentSessionId: 'parent_1',
                    parentCutoffSeqInclusive: 12,
                    strategy: 'replay',
                }),
            ],
        })).toEqual({ type: 'none' });
    });

    it('ignores a child that already existed before the request was submitted', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'replay',
            knownChildSessionIds: new Set(['child_old']),
            candidates: [
                candidate('child_old', {
                    v: 1,
                    parentSessionId: 'parent_1',
                    parentCutoffSeqInclusive: 12,
                    strategy: 'replay',
                }),
            ],
        })).toEqual({ type: 'none' });
    });

    it('ignores children of another parent or another cutoff', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'replay',
            candidates: [
                candidate('other_parent', {
                    v: 1, parentSessionId: 'parent_2', parentCutoffSeqInclusive: 12, strategy: 'replay',
                }),
                candidate('other_cutoff', {
                    v: 1, parentSessionId: 'parent_1', parentCutoffSeqInclusive: 9, strategy: 'replay',
                }),
                candidate('not_a_fork', null),
            ],
        })).toEqual({ type: 'none' });
    });

    it('matches a latest-cutoff request on parent and strategy without guessing the resolved seq', () => {
        expect(findForkChildForRequest({
            parentSessionId: 'parent_1',
            forkPoint: { type: 'latest' },
            route: 'replay',
            knownChildSessionIds: new Set(),
            candidates: [
                candidate('child_latest', {
                    v: 1, parentSessionId: 'parent_1', parentCutoffSeqInclusive: 41, strategy: 'replay',
                }),
            ],
        })).toEqual({ type: 'found', childSessionId: 'child_latest' });
    });

    it('finds a branch-and-edit child by its durable request identity rather than an adjacent cutoff guess', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'replay',
            requestId: 'fork-request-ours',
            candidates: [
                candidate('child_branch_and_edit', {
                    v: 1,
                    parentSessionId: 'parent_1',
                    // The daemon's canonical resolver excluded the clicked
                    // user message at seq 12 from the persisted child.
                    parentCutoffSeqInclusive: 11,
                    strategy: 'replay',
                    requestId: 'fork-request-ours',
                }),
            ],
        })).toEqual({ type: 'found', childSessionId: 'child_branch_and_edit' });
    });

    it('never adopts a concurrent identical fork from another client', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'replay',
            requestId: 'fork-request-ours',
            candidates: [
                candidate('child-other-client', {
                    v: 1,
                    parentSessionId: 'parent_1',
                    // This client clicked an agent row at the same exact
                    // cutoff, so cutoff/strategy alone would misadopt it.
                    parentCutoffSeqInclusive: 12,
                    strategy: 'replay',
                    requestId: 'fork-request-other-client',
                }),
            ],
        })).toEqual({ type: 'none' });
    });

    it('refuses to guess when several new children match', () => {
        expect(findForkChildForRequest({
            ...base,
            route: 'replay',
            candidates: [
                candidate('child_a', {
                    v: 1, parentSessionId: 'parent_1', parentCutoffSeqInclusive: 12, strategy: 'replay',
                }),
                candidate('child_b', {
                    v: 1, parentSessionId: 'parent_1', parentCutoffSeqInclusive: 12, strategy: 'replay',
                }),
            ],
        })).toEqual({ type: 'ambiguous' });
    });
});
