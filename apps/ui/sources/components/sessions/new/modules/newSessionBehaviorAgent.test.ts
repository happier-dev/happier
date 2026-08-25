import { describe, expect, it } from 'vitest';

import { resolveNewSessionBehaviorAgentId } from './newSessionBehaviorAgent';

describe('resolveNewSessionBehaviorAgentId', () => {
    it('prefers the Agent that will actually run the Session over the bundled presentation id', () => {
        expect(resolveNewSessionBehaviorAgentId({
            runtimeCarrierAgentId: 'acme.agent',
            staticAgentId: 'claude',
            agentType: 'claude',
        })).toBe('acme.agent');
    });

    it('answers an installed Agent that has no bundled presentation id at all', () => {
        // This is the whole point: gating on `staticAgentId` answers null here,
        // which is how an installed Agent's declared options were dropped.
        expect(resolveNewSessionBehaviorAgentId({
            runtimeCarrierAgentId: 'acme.agent',
            staticAgentId: null,
        })).toBe('acme.agent');
    });

    it('falls back to the bundled identity when no carrier is selected', () => {
        expect(resolveNewSessionBehaviorAgentId({
            runtimeCarrierAgentId: null,
            staticAgentId: 'codex',
        })).toBe('codex');
        expect(resolveNewSessionBehaviorAgentId({
            runtimeCarrierAgentId: '   ',
            agentType: 'codex',
        })).toBe('codex');
    });

    it('refuses an unbacked non-bundled fallback rather than inventing an identity', () => {
        expect(resolveNewSessionBehaviorAgentId({
            runtimeCarrierAgentId: null,
            staticAgentId: null,
            agentType: 'acme.agent',
        })).toBeNull();
        expect(resolveNewSessionBehaviorAgentId({})).toBeNull();
    });
});
