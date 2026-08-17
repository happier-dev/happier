import type { SessionAgentTransitionResultV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    continueSessionWithArmedAgent,
    resolveArmedAgentContinuationDisposition,
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
            failureMessage: null,
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
            expect(disposition.failureMessage).not.toBeNull();
        }
    });

    it('keeps the armed target while the Session is still the source Agent', () => {
        // `rejected` and `source_stopped` both leave the Session on the source
        // Agent, so the armed choice is still a truthful promise and a retry is
        // the safe action.
        expect(resolveArmedAgentContinuationDisposition(
            { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            failureMessage: t('session.agentContinuation.transition.rejected.sourceNotIdle', {
                agent: 'Claude Code',
            }),
        });

        expect(resolveArmedAgentContinuationDisposition(
            { type: 'partially_applied', localId: 'local-1', applied: 'source_stopped', code: 'cutover_conflict' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            failureMessage: t('session.agentContinuation.transition.sourceStopped', {
                source: 'Claude Code',
                agent: 'Codex',
            }),
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
            failureMessage: t('session.agentContinuation.transition.switched', { agent: 'Codex' }),
        });
    });

    it('does not name a cause it cannot know for an indeterminate outcome', () => {
        expect(resolveArmedAgentContinuationDisposition(
            { type: 'outcome_unknown', localId: 'local-1' },
            LABELS,
        )).toEqual({
            draft: 'preserve',
            arm: 'keep',
            failureMessage: t('session.agentContinuation.transition.unknown'),
        });
    });
});
