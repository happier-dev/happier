import { describe, expect, it } from 'vitest';

import { resolvePersistedAgentIdForBackendTarget } from './resolvePersistedAgentIdForBackendTarget';

describe('resolvePersistedAgentIdForBackendTarget', () => {
    it('returns the built-in agent id for built-in targets', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            persistedAgentId: 'codex',
            selectedBuiltInAgentId: 'codex',
        })).toBe('claude');
    });

    it('preserves an existing real built-in fallback for configured ACP backends', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            persistedAgentId: 'codex',
            selectedBuiltInAgentId: 'customAcp',
        })).toBe('codex');
    });

    it('falls back to the selected built-in agent when the persisted value is still the legacy customAcp sentinel', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            persistedAgentId: 'customAcp',
            selectedBuiltInAgentId: 'codex',
        })).toBe('codex');
    });
});
