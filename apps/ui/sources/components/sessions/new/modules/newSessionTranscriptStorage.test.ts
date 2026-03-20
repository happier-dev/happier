import { describe, expect, it } from 'vitest';

import {
    coerceNewSessionTranscriptStorage,
    supportsDirectTranscriptStorageForNewSession,
} from './newSessionTranscriptStorage';

describe('supportsDirectTranscriptStorageForNewSession', () => {
    it('uses shared agent session-storage support when no UI override is required', () => {
        expect(supportsDirectTranscriptStorageForNewSession({
            agentId: 'kiro',
            settings: {},
        })).toBe(true);
    });

    it('still applies provider-specific runtime constraints', () => {
        expect(supportsDirectTranscriptStorageForNewSession({
            agentId: 'opencode',
            settings: {
                opencodeBackendMode: 'acp',
            } as never,
        })).toBe(false);
    });
});

describe('coerceNewSessionTranscriptStorage', () => {
    it('falls back to synced when direct storage is unsupported by the agent/runtime', () => {
        expect(coerceNewSessionTranscriptStorage({
            requested: 'direct',
            agentId: 'opencode',
            settings: {
                opencodeBackendMode: 'acp',
            } as never,
            directSessionsEnabled: true,
        })).toBe('persisted');
    });
});
