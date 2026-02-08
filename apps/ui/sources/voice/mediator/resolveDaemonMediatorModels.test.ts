import { describe, expect, it } from 'vitest';
import { resolveDaemonVoiceMediatorModelIds } from './resolveDaemonMediatorModels';

describe('resolveDaemonVoiceMediatorModelIds', () => {
    it('uses custom chat model and commit=chat when configured', () => {
        const result = resolveDaemonVoiceMediatorModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'default' } as any,
            settings: {
                voiceMediatorChatModelSource: 'custom',
                voiceMediatorChatModelId: 'fast-model',
                voiceMediatorCommitModelSource: 'chat',
                voiceMediatorCommitModelId: 'heavy-model',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model', commitModelId: 'fast-model' });
    });

    it('uses session model when chat source=session', () => {
        const result = resolveDaemonVoiceMediatorModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            settings: {
                voiceMediatorChatModelSource: 'session',
                voiceMediatorChatModelId: 'ignored',
                voiceMediatorCommitModelSource: 'chat',
                voiceMediatorCommitModelId: 'ignored',
            },
        });
        expect(result.chatModelId).toBe('session-model');
        expect(result.commitModelId).toBe('session-model');
    });

    it('uses commit source=session even when chat is custom', () => {
        const result = resolveDaemonVoiceMediatorModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            settings: {
                voiceMediatorChatModelSource: 'custom',
                voiceMediatorChatModelId: 'fast-model',
                voiceMediatorCommitModelSource: 'session',
                voiceMediatorCommitModelId: 'ignored',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model', commitModelId: 'session-model' });
    });

    it('uses commit custom model when commit source=custom', () => {
        const result = resolveDaemonVoiceMediatorModelIds({
            session: { id: 's1', metadata: { flavor: 'claude' }, modelMode: 'session-model' } as any,
            settings: {
                voiceMediatorChatModelSource: 'session',
                voiceMediatorChatModelId: 'ignored',
                voiceMediatorCommitModelSource: 'custom',
                voiceMediatorCommitModelId: 'commit-model',
            },
        });
        expect(result).toEqual({ chatModelId: 'session-model', commitModelId: 'commit-model' });
    });

    it('falls back to default model ids for unknown session flavor metadata', () => {
        const result = resolveDaemonVoiceMediatorModelIds({
            session: { id: 's1', metadata: { flavor: 'unknown-agent' }, modelMode: 'default' } as any,
            settings: {
                voiceMediatorChatModelSource: 'session',
                voiceMediatorCommitModelSource: 'chat',
            },
        });
        expect(result.chatModelId).toBe('default');
        expect(result.commitModelId).toBe('default');
    });
});
