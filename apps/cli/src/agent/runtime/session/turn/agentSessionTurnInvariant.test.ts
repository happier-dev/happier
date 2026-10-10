import { describe, expect, it } from 'vitest';

import { createAgentSessionTurnInvariant } from './agentSessionTurnInvariant';

describe('createAgentSessionTurnInvariant', () => {
    it.each([
        { kind: 'tool-call', toolCallId: 'root-call', toolName: 'SubAgent', input: {} },
        { kind: 'tool-progress', toolCallId: 'root-call', progress: {} },
        { kind: 'tool-result', toolCallId: 'root-call', output: {} },
        { kind: 'message-delta', channel: 'assistant', text: 'child output' },
        { kind: 'file-edit', editId: 'edit-1', path: 'child.ts' },
        { kind: 'transcript-message-committed', messageId: 'message-1', role: 'assistant', text: 'child output' },
    ])('admits session-scoped $kind without changing foreground turn authority', (output) => {
        for (const scope of [{}, { sidechainId: 'child-1' }, { sidechainId: 'child-1', turnId: 'turn-1' }]) {
            const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
            let sequence = 0;
            const observe = (event: Record<string, unknown>) => invariant.observe({
                sessionId: 'session-1', emittedAtMs: 1, sequence: ++sequence, ...event,
            });
            expect(observe({ kind: 'turn-start', turnId: 'turn-1', startedBy: 'provider' }).status).toBe('accepted');
            expect(observe({ kind: 'turn-complete', turnId: 'turn-1' }).status).toBe('accepted');
            expect(observe({ ...output, ...scope }).status).toBe('accepted');
            expect(invariant.read()).toMatchObject({ activeTurnId: null, knownTurnCount: 0 });
            expect(observe({ kind: 'turn-start', turnId: 'turn-2', startedBy: 'provider', agentTurnId: 'native-2' }).status).toBe('accepted');
            expect(observe({ ...output, ...scope }).status).toBe('accepted');
            expect(invariant.read()).toMatchObject({ activeTurnId: 'turn-2', knownTurnCount: 1 });
            expect(observe({ ...output, turnId: 'turn-1' })).toMatchObject({
                status: 'rejected', diagnostic: { code: 'agent_runtime_turn_not_active' },
            });
            expect(observe({ ...output, ...scope, sessionId: 'other' })).toMatchObject({
                status: 'rejected', diagnostic: { code: 'agent_runtime_event_session_mismatch' },
            });
            expect(observe({ kind: 'turn-complete', turnId: 'turn-2', agentTurnId: 'native-2' }).status).toBe('accepted');
            expect(observe({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false }).status).toBe('accepted');
            expect(observe({ ...output, ...scope })).toMatchObject({
                status: 'rejected', diagnostic: { code: 'agent_runtime_event_after_runtime_end' },
            });
        }
    });

    it('rejects malformed, cross-session, and stale events without mutating accepted state', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
            unknown: true,
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_event_invalid' } });
        expect(invariant.observe({
            sequence: 1,
            sessionId: 'other-session',
            emittedAtMs: 1,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_event_session_mismatch' } });
        expect(invariant.read()).toMatchObject({
            providerSessionId: null,
            lastAcceptedSequence: null,
        });

        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'runtime-ended',
            cause: 'providerEnded',
            retryable: false,
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_event_sequence_stale' } });
        expect(invariant.read()).toMatchObject({
            providerSessionId: 'provider-1',
            runtimeEnded: false,
            lastAcceptedSequence: 2,
        });
    });

    it('binds provider identity once and treats an identical replay as idempotent', () => {
        const invariant = createAgentSessionTurnInvariant({
            sessionId: 'session-1',
            expectedProviderSessionId: 'provider-1',
        });

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'provider-session-id',
            providerSessionId: 'other-provider',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_provider_session_conflict' } });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
        })).toMatchObject({ status: 'ignored' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'provider-session-id',
            providerSessionId: 'provider-2',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_provider_session_conflict' } });
        expect(invariant.read().providerSessionId).toBe('provider-1');
    });

    it('dedupes the provider session id on the matched PAIR, so a later log-path republish is not swallowed', () => {
        // A runtime publishes its provider id as soon as it knows it, and the
        // path of that session's log only once the conversation materializes —
        // Claude's SDK path can only ever deliver the path as a SAME-ID
        // republish. An id-keyed dedupe here suppresses the event before the
        // pair-aware metadata subscriber downstream ever sees it, so the path
        // never reaches Session metadata and a successor Agent is offered no
        // log to read.
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
        const nativeSessionLogPath = '/Users/dev/.claude/projects/x.jsonl';

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
        })).toMatchObject({ status: 'accepted' });

        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
            nativeSessionLogPath,
        })).toMatchObject({ status: 'accepted' });

        // Control: the pair really is the key — republishing the SAME pair is
        // still redundant and must stay suppressed.
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'provider-session-id',
            providerSessionId: 'provider-1',
            nativeSessionLogPath,
        })).toMatchObject({ status: 'ignored' });
    });

    it('requires accepted host delivery before start and enforces exact terminal finality', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'turn-start',
            turnId: 'turn-1',
            startedBy: 'host',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_turn_start_without_acceptance' } });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'input-accepted',
            inputIds: ['input-1'],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'turn-start',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            startedBy: 'host',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'turn-complete',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 5,
            sessionId: 'session-1',
            emittedAtMs: 5,
            kind: 'turn-failed',
            turnId: 'turn-1',
            diagnostic: { code: 'duplicate', severity: 'error' },
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_duplicate_terminal' } });
        expect(invariant.observe({
            sequence: 6,
            sessionId: 'session-1',
            emittedAtMs: 6,
            kind: 'message-delta',
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'late',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_turn_not_active' } });
        expect(invariant.read()).toMatchObject({ activeTurnId: null, knownTurnCount: 0 });
    });

    it('accepts one exact rollback boundary for the most recently completed turn', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'input-accepted',
            inputIds: ['input-1'],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-start',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            startedBy: 'host',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'turn-complete',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'turn-rollback-boundary',
            turnId: 'turn-1',
            agentTurnId: 'other-agent-turn',
            providerCheckpoint: 'other-agent-turn',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_agent_turn_conflict' } });
        expect(invariant.observe({
            sequence: 5,
            sessionId: 'session-1',
            emittedAtMs: 5,
            kind: 'turn-rollback-boundary',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            providerCheckpoint: 'agent-turn-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 6,
            sessionId: 'session-1',
            emittedAtMs: 6,
            kind: 'turn-rollback-boundary',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            providerCheckpoint: 'agent-turn-1',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_turn_reused' } });
        expect(invariant.observe({
            sequence: 7,
            sessionId: 'session-1',
            emittedAtMs: 7,
            kind: 'message-delta',
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'still late',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_turn_not_active' } });
    });

    it('rejects a rollback boundary observed after a failed turn', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });

        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'input-accepted',
            inputIds: ['input-1'],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-start',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            startedBy: 'host',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'turn-failed',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            diagnostic: { code: 'provider_failed', severity: 'error' },
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'turn-rollback-boundary',
            turnId: 'turn-1',
            agentTurnId: 'agent-turn-1',
            providerCheckpoint: 'agent-turn-1',
        })).toMatchObject({
            status: 'rejected',
            diagnostic: { code: 'agent_runtime_rollback_boundary_terminal_conflict' },
        });
    });

    it('orders a provider successor after its predecessor terminal', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'turn-start',
            turnId: 'turn-1',
            startedBy: 'provider',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-start',
            turnId: 'turn-2',
            startedBy: 'provider',
            causedByTurnId: 'turn-1',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_turn_already_active' } });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'turn-complete',
            turnId: 'turn-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'turn-start',
            turnId: 'turn-2',
            startedBy: 'provider',
            causedByTurnId: 'turn-1',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.read().activeTurnId).toBe('turn-2');
    });

    it('requires active and accepted-delivery resolution before runtime-ended and rejects every post-end event', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
        expect(invariant.observe({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'input-accepted',
            inputIds: ['input-1'],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'runtime-ended',
            cause: 'connectionLost',
            retryable: true,
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_ended_with_pending_delivery' } });
        expect(invariant.observe({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'input-delivery-failed',
            inputIds: ['input-1'],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
            issue: { code: 'delivery_failed', severity: 'error' },
            duplicateRisk: 'unknown',
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'runtime-ended',
            cause: 'connectionLost',
            retryable: true,
        })).toMatchObject({ status: 'accepted' });
        expect(invariant.observe({
            sequence: 5,
            sessionId: 'session-1',
            emittedAtMs: 5,
            kind: 'provider-session-id',
            providerSessionId: 'late-provider',
        })).toMatchObject({ status: 'rejected', diagnostic: { code: 'agent_runtime_event_after_runtime_end' } });
        expect(invariant.read()).toMatchObject({ runtimeEnded: true, providerSessionId: null });

        const failedBeforeCustody = createAgentSessionTurnInvariant({ sessionId: 'session-2' });
        expect(failedBeforeCustody.observe({
            sequence: 1,
            sessionId: 'session-2',
            emittedAtMs: 1,
            kind: 'input-delivery-failed',
            inputIds: ['input-2'],
            delivery: { kind: 'newTurn', turnId: 'turn-2' },
            issue: { code: 'delivery_failed', severity: 'error' },
            duplicateRisk: 'unknown',
        })).toMatchObject({ status: 'accepted' });
        expect(failedBeforeCustody.observe({
            sequence: 2,
            sessionId: 'session-2',
            emittedAtMs: 2,
            kind: 'runtime-ended',
            cause: 'providerEnded',
            retryable: false,
        })).toMatchObject({ status: 'accepted' });
    });

    it('does not turn replay capacity into a lifetime turn limit', () => {
        const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
        let sequence = 0;
        for (let index = 0; index < 1_100; index += 1) {
            const turnId = `turn-${index}`;
            sequence += 1;
            expect(invariant.observe({
                sequence,
                sessionId: 'session-1',
                emittedAtMs: sequence,
                kind: 'turn-start',
                turnId,
                startedBy: 'provider',
                ...(index === 0 ? {} : { causedByTurnId: `turn-${index - 1}` }),
            })).toMatchObject({ status: 'accepted' });
            sequence += 1;
            expect(invariant.observe({
                sequence,
                sessionId: 'session-1',
                emittedAtMs: sequence,
                kind: 'turn-complete',
                turnId,
            })).toMatchObject({ status: 'accepted' });
            expect(invariant.read()).toMatchObject({ knownTurnCount: 0, activeTurnId: null });
        }
    });
});
