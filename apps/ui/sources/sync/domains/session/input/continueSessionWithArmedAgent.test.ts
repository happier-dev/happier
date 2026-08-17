import type { SessionAgentTransitionResultV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    continueSessionWithArmedAgent,
    reconcileArmedAgentContinuationDisposition,
    resolveArmedAgentContinuationDisposition,
    type ArmedAgentContinuationCanonicalFacts,
    type ArmedAgentContinuationSubmission,
} from './continueSessionWithArmedAgent';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

// The socket transport is the only genuine boundary in this path. Everything
// below it — request sealing, result parsing, and the recovery decision — is
// the code under test.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScope(params),
}));

const LABELS = { sourceAgentLabel: 'Claude Code', targetAgentLabel: 'Codex' } as const;

function submission(
    overrides: Partial<ArmedAgentContinuationSubmission> = {},
): ArmedAgentContinuationSubmission {
    return {
        machineId: 'machine-1',
        serverId: 'server-1',
        sessionId: 'session-1',
        localId: 'local-1',
        intent: {
            v: 1,
            mode: 'same_session',
            sourceAgentId: 'claude',
            selection: { v: 1, agentId: 'codex', modelId: 'gpt-5' },
        },
        input: { text: 'ship it' },
        ...LABELS,
        ...overrides,
    };
}

function rpcError(rpcErrorCode: string): Error {
    return Object.assign(new Error(rpcErrorCode), { rpcErrorCode });
}

describe('continueSessionWithArmedAgent', () => {
    beforeEach(() => {
        machineRpcWithServerScope.mockReset();
    });

    it('dispatches the submitted message to the ARMED TARGET Agent, not the current one', async () => {
        machineRpcWithServerScope.mockResolvedValue({ type: 'accepted', localId: 'local-1' });

        const outcome = await continueSessionWithArmedAgent(submission());

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'session.agentTransition',
            payload: {
                v: 1,
                sessionId: 'session-1',
                // The Agent the client believes is running, so the daemon can
                // refuse a switch decided against a stale view.
                expectedCurrentAgentId: 'claude',
                selection: { v: 1, agentId: 'codex', modelId: 'gpt-5' },
                // The exact submitted input, carrying the stable localId that is
                // the dedupe identity, divider correlation key, and the only key
                // the composer may compare-clear against.
                input: { text: 'ship it', localId: 'local-1', meta: {} },
            },
        }));
        expect(outcome.result).toEqual({ type: 'accepted', localId: 'local-1' });
        expect(outcome.disposition).toEqual({
            draft: 'clear',
            arm: 'clear',
            notice: null,
            send: 'allow',
        });
    });

    it('reports an old daemon as a no-effect rejection rather than an unknown outcome', async () => {
        machineRpcWithServerScope.mockRejectedValue(rpcError('RPC_METHOD_NOT_AVAILABLE'));

        const outcome = await continueSessionWithArmedAgent(submission());

        expect(outcome.result).toEqual({
            type: 'rejected',
            code: 'unsupported_operation',
            sourceEffect: 'none',
        });
        expect(outcome.disposition.draft).toBe('preserve');
        expect(outcome.disposition.arm).toBe('keep');
    });

    it('never fabricates a rejection when the transport proves nothing', async () => {
        machineRpcWithServerScope.mockRejectedValue(new Error('socket closed'));

        const outcome = await continueSessionWithArmedAgent(submission());

        // A rejection would promise `sourceEffect: 'none'` and hand the reader
        // Keep editing in front of a Session that may already have switched.
        expect(outcome.result).toEqual({ type: 'outcome_unknown', localId: 'local-1' });
        expect(outcome.disposition.draft).toBe('preserve');
    });

    it('treats an unreadable answer as unknown, not as success', async () => {
        machineRpcWithServerScope.mockResolvedValue({ type: 'definitely_fine' });

        const outcome = await continueSessionWithArmedAgent(submission());

        expect(outcome.result).toEqual({ type: 'outcome_unknown', localId: 'local-1' });
        expect(outcome.disposition.draft).toBe('preserve');
    });

    it('carries the short display text the reader expects to read in the transcript', async () => {
        machineRpcWithServerScope.mockResolvedValue({ type: 'accepted', localId: 'local-1' });

        await continueSessionWithArmedAgent(submission({
            input: {
                text: 'review comment 1\nreview comment 2\n\nship it',
                displayText: 'ship it',
                meta: { source: 'ui' },
            },
        }));

        // `displayText` is a canonical `MessageMeta` field, and the frozen wire
        // already carries `input.meta` — so the expanded prompt still reaches the
        // Agent while the transcript reads back what the reader actually wrote.
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                input: {
                    text: 'review comment 1\nreview comment 2\n\nship it',
                    localId: 'local-1',
                    meta: { displayText: 'ship it', source: 'ui' },
                },
            }),
        }));
    });

    it('never lets a blank display text blank out the transcript row', async () => {
        machineRpcWithServerScope.mockResolvedValue({ type: 'accepted', localId: 'local-1' });

        await continueSessionWithArmedAgent(submission({
            input: { text: '[image.png](https://example.test/a.png)', displayText: '   ' },
        }));

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                input: expect.objectContaining({ meta: {} }),
            }),
        }));
    });
});

describe('resolveArmedAgentContinuationDisposition', () => {
    it('clears the draft ONLY on canonical admission of that exact input', () => {
        const notAccepted: readonly SessionAgentTransitionResultV1[] = [
            { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
            { type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' },
            { type: 'partially_applied', localId: 'local-1', applied: 'source_stopped', code: 'cutover_conflict' },
            { type: 'partially_applied', localId: 'local-1', applied: 'source_stopped', code: 'context_unavailable' },
            { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code: 'divider_missing' },
            { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code: 'target_start_failed' },
            { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code: 'input_rejected' },
            { type: 'outcome_unknown', localId: 'local-1' },
        ];

        for (const result of notAccepted) {
            const disposition = resolveArmedAgentContinuationDisposition(result, LABELS);
            expect(disposition.draft).toBe('preserve');
            // Silence is the defect this whole path exists to remove: every
            // outcome that is not a completed send says so out loud.
            expect(disposition.notice).not.toBeNull();
            expect(disposition.notice?.message).not.toBe('');
        }
    });

    it('says nothing at all when the switch completed and the message landed', () => {
        expect(resolveArmedAgentContinuationDisposition({ type: 'accepted', localId: 'local-1' }, LABELS)).toEqual({
            draft: 'clear',
            arm: 'clear',
            notice: null,
            send: 'allow',
        });
    });

    it('keeps the armed target while the Session is still the source Agent', () => {
        // `rejected` and `source_stopped` both leave the Session on the source
        // Agent, so the armed choice is still a truthful promise and the ordinary
        // send is the retry — which is why neither notice carries an action.
        expect(resolveArmedAgentContinuationDisposition(
            { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            send: 'allow',
            notice: {
                tone: 'warning',
                recovery: 'none',
                message: t('session.agentContinuation.transition.rejected.sourceNotIdle', {
                    agent: 'Claude Code',
                }),
            },
        });

        expect(resolveArmedAgentContinuationDisposition(
            { type: 'partially_applied', localId: 'local-1', applied: 'source_stopped', code: 'cutover_conflict' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            send: 'allow',
            notice: {
                tone: 'warning',
                recovery: 'none',
                message: t('session.agentContinuation.transition.sourceStopped', {
                    source: 'Claude Code',
                    agent: 'Codex',
                }),
            },
        });
    });

    it('clears the armed target once the Session IS the target, and still preserves the draft', () => {
        // The switch happened. Leaving the row armed would promise a switch that
        // has already been spent, and section 7.5 forbids retrying it. The
        // message did NOT go through, so the draft stays.
        expect(resolveArmedAgentContinuationDisposition(
            { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code: 'target_start_failed' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'clear',
            send: 'allow',
            notice: {
                tone: 'warning',
                // Resume is only offered once a canonical fact says the Session
                // has no live runtime. Without that fact, offering it would
                // contradict a target that is already running.
                recovery: 'none',
                message: t('session.agentContinuation.transition.switched', { agent: 'Codex' }),
            },
        });
    });

    it('treats a committed switch as a partial SUCCESS to act on, never as an error', () => {
        // The Session really did move to the target; only the message failed. The
        // shipped defect reported this as "Error" behind an OK button and threw the
        // fact away on dismiss. Every code reachable at this depth must therefore
        // produce a WARNING that names the target, a draft that survives, and an
        // armed row that does not — the switch is spent.
        for (const code of ['divider_missing', 'target_start_failed', 'input_rejected'] as const) {
            const disposition = resolveArmedAgentContinuationDisposition(
                { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code },
                LABELS,
            );
            expect(disposition.notice?.tone).toBe('warning');
            expect(disposition.notice?.message).toContain('Codex');
            expect(disposition.draft).toBe('preserve');
            expect(disposition.arm).toBe('clear');
        }
    });

    it('does not name a cause it cannot know for an indeterminate outcome', () => {
        expect(resolveArmedAgentContinuationDisposition(
            { type: 'outcome_unknown', localId: 'local-1' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            // Nothing is established yet, so nothing may be sent: a second
            // submission is the one way this path can duplicate the reader's
            // message. The notice is a notice, never a retry button.
            send: 'block',
            notice: {
                tone: 'neutral',
                recovery: 'none',
                message: t('session.agentContinuation.transition.unknown'),
            },
        });
    });
});

describe('reconcileArmedAgentContinuationDisposition', () => {
    const TARGET_AGENT_ID = 'codex';
    const UNKNOWN: SessionAgentTransitionResultV1 = { type: 'outcome_unknown', localId: 'local-1' };

    function reconcile(
        facts: ArmedAgentContinuationCanonicalFacts | null,
        result: SessionAgentTransitionResultV1 = UNKNOWN,
    ) {
        return reconcileArmedAgentContinuationDisposition({
            result,
            labels: LABELS,
            targetAgentId: TARGET_AGENT_ID,
            facts,
        });
    }

    it('resolves an unknown outcome to success once the exact input is canonically admitted', () => {
        // The reader's message is in the transcript. Anything else the banner
        // could say now contradicts an established effect.
        expect(reconcile({ currentAgentId: 'codex', sessionActive: true, inputAdmitted: true })).toEqual({
            draft: 'clear',
            arm: 'clear',
            notice: null,
            send: 'allow',
        });
    });

    it('resolves an unknown outcome to the committed depth once the Session canonically runs the target', () => {
        expect(reconcile({ currentAgentId: 'codex', sessionActive: false, inputAdmitted: false })).toEqual({
            draft: 'preserve',
            arm: 'clear',
            send: 'allow',
            notice: {
                tone: 'warning',
                // The Session is the target and has no live runtime: starting it
                // is the one factual recovery, and it belongs to the Session's
                // existing resume owner.
                recovery: 'resumeSession',
                message: t('session.agentContinuation.transition.switched', { agent: 'Codex' }),
            },
        });
    });

    it('never offers resume for a target that is already running', () => {
        expect(reconcile({ currentAgentId: 'codex', sessionActive: true, inputAdmitted: false }).notice)
            .toEqual({
                tone: 'warning',
                recovery: 'none',
                message: t('session.agentContinuation.transition.switched', { agent: 'Codex' }),
            });
    });

    it('offers resume for a committed-but-inactive target reported by the daemon itself', () => {
        expect(reconcile(
            { currentAgentId: 'codex', sessionActive: false, inputAdmitted: false },
            { type: 'partially_applied', localId: 'local-1', applied: 'current_view_committed', code: 'target_start_failed' },
        ).notice?.recovery).toBe('resumeSession');
    });

    it('keeps saying it does not know when the canonical facts establish nothing, but stops blocking', () => {
        // The reconciliation attempt IS the window. Once it has read canonical
        // state and still cannot tell, holding the composer hostage forever
        // would be a worse lie than the one this notice already tells honestly.
        expect(reconcile({ currentAgentId: 'claude', sessionActive: true, inputAdmitted: false })).toEqual({
            draft: 'preserve',
            arm: 'keep',
            send: 'allow',
            notice: {
                tone: 'neutral',
                recovery: 'none',
                message: t('session.agentContinuation.transition.unknown'),
            },
        });
    });

    it('blocks the composer until canonical facts have actually been read', () => {
        expect(reconcile(null).send).toBe('block');
    });

    it('never lets a client-side view weaken a definite daemon answer', () => {
        // `rejected` guarantees the source was never touched. A local view that
        // happens to show the target Agent must not promote that into a
        // committed cutover.
        expect(reconcile(
            { currentAgentId: 'codex', sessionActive: false, inputAdmitted: false },
            { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
        )).toEqual(resolveArmedAgentContinuationDisposition(
            { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
            LABELS,
        ));

        // And a stopped source stays a stopped source.
        const sourceStopped: SessionAgentTransitionResultV1 = {
            type: 'partially_applied', localId: 'local-1', applied: 'source_stopped', code: 'cutover_conflict',
        };
        expect(reconcile({ currentAgentId: 'codex', sessionActive: true, inputAdmitted: true }, sourceStopped).notice)
            .toEqual(resolveArmedAgentContinuationDisposition(sourceStopped, LABELS).notice);
    });
});
