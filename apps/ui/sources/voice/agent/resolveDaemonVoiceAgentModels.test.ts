import { describe, expect, it } from 'vitest';
import { resolveDaemonVoiceAgentModelIds } from './resolveDaemonVoiceAgentModels';

describe('resolveDaemonVoiceAgentModelIds', () => {
    it('uses custom chat model and commit=chat when configured', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'default' } as any,
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
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'chat',
                commitModelId: 'ignored',
            },
        });
        expect(result.chatModelId).toBe('session-model');
        expect(result.commitModelId).toBe('session-model');
    });

    it('uses commit source=session even when chat is custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'fast-model',
                commitModelSource: 'session',
                commitModelId: 'ignored',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model', commitModelId: 'session-model' });
    });

    it('uses commit custom model when commit source=custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'custom',
                commitModelId: 'commit-model',
            },
        });
        expect(result).toEqual({ chatModelId: 'session-model', commitModelId: 'commit-model' });
    });

    it('falls back to default model ids for unknown session flavor metadata', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: { id: 's1', metadata: { flavor: 'unknown-agent' }, modelMode: 'default' } as any,
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'chat',
            },
        });
        expect(result.chatModelId).toBe('default');
        expect(result.commitModelId).toBe('default');
    });
});
