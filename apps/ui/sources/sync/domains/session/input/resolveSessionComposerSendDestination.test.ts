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

    it('still uses the transition when the send carries attachments', () => {
        // The attachments path is a separate call site with its own upload step,
        // and it composes the uploaded block into the outbound text before it
        // gets here. It is the path most likely to be forgotten, and it must
        // reach the same decision as a plain send.
        expect(resolveSessionComposerSendDestination({
            route: 'sessionAgent',
            armedContinuation: ARMED,
            ...REACHABLE,
        }).kind).toBe('armedAgentContinuation');
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

    it('identifies the TRANSITION, so an edited draft retries the same switch', () => {
        // Deliberate, and easy to "fix" into a defect. The submitted localId is
        // the operation's identity: the daemon derives the departure divider's
        // localId from it, and a repeated invocation is reconciled by matching
        // that divider. Deriving the identity from the draft text instead would
        // break the one case that actually needs the retry — an `outcome_unknown`
        // where the cutover committed but the input never landed — turning a
        // send that works today into "the Session is now X, send it again".
        //
        // Nothing is lost by reusing it: the canonical admission owner compares
        // content against both the pending row and the committed transcript row
        // and refuses a reused identity whose content differs. It never
        // overwrites what the reader already sent.
        const armed = { route: 'sessionAgent', armedContinuation: ARMED, ...REACHABLE } as const;
        expect(resolveSessionComposerSendDestination(armed))
            .toEqual(resolveSessionComposerSendDestination(armed));
        expect(
            resolveSessionComposerSendDestination(armed),
        ).toMatchObject({ localId: 'armed-local-1' });
    });
});
