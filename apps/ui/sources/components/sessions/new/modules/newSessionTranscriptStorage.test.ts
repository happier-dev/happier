import { afterEach, describe, expect, it } from 'vitest';

import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

import {
    coerceNewSessionTranscriptStorage,
    supportsDirectTranscriptStorageForNewSession,
} from './newSessionTranscriptStorage';

function publishInstalledAgentBehavior(behavior: Readonly<Record<string, unknown>>): void {
    publishProjectedAgentUiBehaviorDescriptors({
        machineId: 'machine-a',
        descriptorsByAgentId: {
            'acme.agent': {
                kind: 'plugin.ui.v1',
                pluginId: 'acme',
                agentId: 'acme.agent',
                version: 1,
                behavior,
            },
        },
    });
}

afterEach(() => {
    clearProjectedAgentUiBehaviorDescriptors();
});

describe('supportsDirectTranscriptStorageForNewSession', () => {
    it('honors an installed Agent that projected direct transcript storage', () => {
        publishInstalledAgentBehavior({
            newSession: { transcriptStorageModes: ['persisted', 'direct'] },
        });

        expect(supportsDirectTranscriptStorageForNewSession({
            agentId: 'acme.agent',
            settings: {},
        })).toBe(true);
    });

    it('keeps an installed Agent that projected only persisted storage on persisted', () => {
        publishInstalledAgentBehavior({
            newSession: { transcriptStorageModes: ['persisted'] },
        });

        expect(supportsDirectTranscriptStorageForNewSession({
            agentId: 'acme.agent',
            settings: {},
        })).toBe(false);
        expect(coerceNewSessionTranscriptStorage({
            requested: 'direct',
            agentId: 'acme.agent',
            settings: {},
            externalSessionsEnabled: true,
        })).toBe('persisted');
    });

    it('fails closed when an external Agent has no bundled transcript-storage policy', () => {
        expect(supportsDirectTranscriptStorageForNewSession({
            agentId: 'acme.agent',
            settings: {},
        })).toBe(false);
    });

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
            externalSessionsEnabled: true,
        })).toBe('persisted');
    });
});
