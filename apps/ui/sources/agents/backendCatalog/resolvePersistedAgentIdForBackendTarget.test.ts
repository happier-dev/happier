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

    it('does not persist the legacy customAcp sentinel when the selected backend target is still the legacy built-in carrier', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
            persistedAgentId: 'codex',
            selectedBuiltInAgentId: 'claude',
        })).toBe('codex');
    });

    it('reuses a canonical built-in persisted agent instead of returning the legacy customAcp sentinel for configured ACP backends', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            persistedAgentId: 'codex',
            selectedBuiltInAgentId: 'claude',
        })).toBe('codex');
    });

    it('falls back to the selected built-in agent when the persisted value is still the legacy customAcp sentinel', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            persistedAgentId: 'customAcp',
            selectedBuiltInAgentId: 'codex',
        })).toBe('codex');
    });

    it('falls back to the selected built-in agent when a configured ACP backend has no canonical persisted built-in identity', () => {
        expect(resolvePersistedAgentIdForBackendTarget({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            persistedAgentId: 'customAcp',
            selectedBuiltInAgentId: 'claude',
        })).toBe('claude');
    });
});
