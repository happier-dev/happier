import { describe, expect, it } from 'vitest';
import { resolveDaemonVoiceAgentModelIds } from './resolveDaemonVoiceAgentModels';
import { getAgentCore } from '@/agents/catalog/catalog';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const baseMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('The canonical Session fixture requires readable metadata');
    return metadata;
})();

describe('resolveDaemonVoiceAgentModelIds', () => {
    it('leaves attached session choices for host admission instead of copying pending model intent', () => {
        expect(resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: { chatModelSource: 'session', commitModelSource: 'session' },
        })).toEqual({});
        expect(resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: { chatModelSource: 'custom', chatModelId: 'custom-model', commitModelSource: 'session' },
        })).toEqual({ chatModelId: 'custom-model' });
    });

    it('uses custom chat model and commit=chat when configured', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'fast-model',
                commitModelSource: 'chat',
                commitModelId: 'heavy-model',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model', commitModelId: 'fast-model' });
    });

    it('uses session model when chat source=session', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'chat',
                commitModelId: 'ignored',
            },
        });
        expect(result).toEqual({});
    });

    it('uses commit source=session even when chat is custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'fast-model',
                commitModelSource: 'session',
                commitModelId: 'ignored',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model' });
    });

    it('uses commit custom model when commit source=custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'custom',
                commitModelId: 'commit-model',
            },
        });
        expect(result).toEqual({ commitModelId: 'commit-model' });
    });

    it('reports the typed unavailable when the session Agent identity is unreadable', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'unknown-agent' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'chat',
            },
        });

        expect(result).toBeNull();
    });

    it('resolves models for an externally installed Agent declared by the session runtime', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata,
                runtimeDescriptorV1: { v: 1, agentId: 'acme-external-agent', agent: {} },
            },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'acme-fast',
                commitModelSource: 'chat',
            },
        });

        expect(result).toEqual({ chatModelId: 'acme-fast', commitModelId: 'acme-fast' });
    });

    it('uses the target session flavor defaults for default sentinel values', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'codex' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'default',
                commitModelSource: 'chat',
                commitModelId: 'default',
            },
        });

        expect(result).toEqual({
            chatModelId: getAgentCore('codex').model?.defaultMode,
            commitModelId: getAgentCore('codex').model?.defaultMode,
        });
    });

    it('uses the resolved Agent flavor for session-default models', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'codex' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({});
    });

    it('uses the already-resolved owner Agent identity for default session models', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'gemini' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({});
    });

});
