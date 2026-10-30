import type { ComposerAgentContinuationIntentV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveSessionComposerSendDestination } from './resolveSessionComposerSendDestination';

const ARMED: ComposerAgentContinuationIntentV1 = {
    v: 1,
    mode: 'same_session',
    sourceAgentId: 'claude',
    selection: { v: 1, agentId: 'codex', modelId: 'gpt-5' },
};

const REACHABLE = {
    armedContinuationLocalId: 'armed-local-1',
    machineId: 'machine-1',
    pendingTransitionOutcome: 'settled',
} as const;

describe('resolveSessionComposerSendDestination', () => {
    it('sends an unarmed composer to the Session Agent, exactly as before', () => {
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: null,
            armedContinuationLocalId: null,
            machineId: 'machine-1',
            pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'sessionAgent' });
    });

    it('sends an armed composer through the transition instead of the current Agent', () => {
        // This is the link that was broken for the whole program: the picker armed
        // a switch and the send reached the Agent the reader was leaving.
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: ARMED,
            ...REACHABLE,
        })).toEqual({
            kind: 'armedAgentContinuation',
            machineId: 'machine-1',
            intent: ARMED,
            localId: 'armed-local-1',
        });
    });

    it('refuses an armed send that would reach a voice adapter', () => {
        // A voice adapter is not this Session's Agent. Sending here would leave
        // the armed promise unkept and silent, which is the defect this
        // destination decision exists to remove.
        expect(resolveSessionComposerSendDestination({
            route: 'voiceAdapter',
            armedContinuation: ARMED,
            ...REACHABLE,
        })).toEqual({ kind: 'refused', reason: 'conflictingDestination' });
    });

    it('refuses an armed send that would reach an execution run', () => {
        expect(resolveSessionComposerSendDestination({
            route: 'executionRun',
            armedContinuation: ARMED,
            ...REACHABLE,
        })).toEqual({ kind: 'refused', reason: 'conflictingDestination' });
    });

    it('leaves the voice and execution-run routes alone when nothing is armed', () => {
        expect(resolveSessionComposerSendDestination({
            route: 'voiceAdapter',
            armedContinuation: null,
            armedContinuationLocalId: null,
            machineId: 'machine-1',
            pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'voiceAdapter' });
        expect(resolveSessionComposerSendDestination({
            route: 'executionRun',
            armedContinuation: null,
            armedContinuationLocalId: null,
            machineId: 'machine-1',
            pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'executionRun' });
    });

    it('refuses rather than silently falling back when the armed switch has nowhere to run', () => {
        // The transition only runs on the machine hosting the Session. Without it
        // there is no destination at all — and quietly using the ordinary one
        // would send to the Agent the reader is leaving.
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: ARMED,
            armedContinuationLocalId: 'armed-local-1',
            machineId: null,
            pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'refused', reason: 'armedTargetUnreachable' });
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: ARMED,
            armedContinuationLocalId: null,
            machineId: 'machine-1',
            pendingTransitionOutcome: 'settled',
        })).toEqual({ kind: 'refused', reason: 'armedTargetUnreachable' });
    });

    it('refuses every send while a transition outcome is still unreconciled', () => {
        // An `outcome_unknown` may already have admitted the reader's message.
        // Until canonical facts say so, a second submission is the one way this
        // path can duplicate it — and a send that quietly mints a fresh identity
        // (the arm cleared, a voice route, an execution run) is exactly the one
        // the dedupe identity cannot protect.
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: ARMED,
            armedContinuationLocalId: 'armed-local-1',
            machineId: 'machine-1',
            pendingTransitionOutcome: 'unreconciled',
        })).toEqual({ kind: 'refused', reason: 'unreconciledTransitionOutcome' });

        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: null,
            armedContinuationLocalId: null,
            machineId: 'machine-1',
            pendingTransitionOutcome: 'unreconciled',
        })).toEqual({ kind: 'refused', reason: 'unreconciledTransitionOutcome' });
    });

    describe('an armed route or model change for the same Agent (D15)', () => {
        const ROUTE_IDLE = { turnActive: false } as const;

        it('applies the armed route on the next send, then sends to the same Agent', () => {
            // Same Agent, so no transition and nothing carried over as text: the
            // Session resumes on the new route and this message is its first input.
            expect(resolveSessionComposerSendDestination({
                route: 'sessionAgent',
                armedContinuation: null,
                armedContinuationLocalId: null,
                armedRoute: ROUTE_IDLE,
                machineId: 'machine-1',
                pendingTransitionOutcome: 'settled',
            })).toEqual({ kind: 'armedRouteContinuation', machineId: 'machine-1' });
        });

        it('lets an armed Agent switch win, because it carries its own model selection', () => {
            expect(resolveSessionComposerSendDestination({
                route: 'sessionAgent',
                armedContinuation: ARMED,
                armedRoute: ROUTE_IDLE,
                ...REACHABLE,
            }).kind).toBe('armedAgentContinuation');
        });

        it('refuses while the Agent is mid-turn, since applying the route restarts it', () => {
            expect(resolveSessionComposerSendDestination({
                route: 'sessionAgent',
                armedContinuation: null,
                armedContinuationLocalId: null,
                armedRoute: { turnActive: true },
                machineId: 'machine-1',
                pendingTransitionOutcome: 'settled',
            })).toEqual({ kind: 'refused', reason: 'sourceNotIdle' });
        });

        it('refuses a send addressed elsewhere or with no machine to restart on', () => {
            const base = {
                armedContinuation: null,
                armedContinuationLocalId: null,
                armedRoute: ROUTE_IDLE,
                pendingTransitionOutcome: 'settled',
            } as const;
            expect(resolveSessionComposerSendDestination({ ...base, route: 'voiceAdapter', machineId: 'machine-1' }))
                .toEqual({ kind: 'refused', reason: 'conflictingDestination' });
            expect(resolveSessionComposerSendDestination({ ...base, route: 'executionRun', machineId: 'machine-1' }))
                .toEqual({ kind: 'refused', reason: 'conflictingDestination' });
            expect(resolveSessionComposerSendDestination({ ...base, route: 'sessionAgent', machineId: null }))
                .toEqual({ kind: 'refused', reason: 'armedTargetUnreachable' });
        });
    });
});
