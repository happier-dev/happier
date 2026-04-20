import { describe, expect, it } from 'vitest';

import { resolveNewSessionCompatAgentType } from './resolveNewSessionCompatAgentType';

describe('resolveNewSessionCompatAgentType', () => {
    it('returns the persisted canonical built-in agent id for configured ACP backends instead of the legacy customAcp sentinel', () => {
        expect(resolveNewSessionCompatAgentType({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            persistedAgentId: 'codex',
            selectedBuiltInAgentId: 'customAcp',
        })).toBe('codex');
    });

    it('falls back to the canonical default built-in agent when configured ACP backends only have legacy customAcp carriers', () => {
        expect(resolveNewSessionCompatAgentType({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            persistedAgentId: 'customAcp',
            selectedBuiltInAgentId: 'customAcp',
        })).toBe('claude');
    });
});
