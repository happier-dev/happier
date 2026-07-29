import { describe, expect, it } from 'vitest';
import { resolveDaemonVoiceAgentModelIds } from './resolveDaemonVoiceAgentModels';
import { getAgentCore } from '@/agents/catalog/catalog';

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

    it('uses the target session flavor defaults for default sentinel values', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: { id: 's1', metadata: { flavor: 'codex' }, modelMode: 'default' } as any,
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'default',
                commitModelSource: 'chat',
                commitModelId: 'default',
            },
        });

        expect(result).toEqual({
            chatModelId: getAgentCore('codex').model.defaultMode,
            commitModelId: getAgentCore('codex').model.defaultMode,
        });
    });

    it('uses raw session flavor even when other metadata is missing', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: {
                id: 's1',
                modelMode: 'default',
                metadata: {
                    flavor: 'codex',
                },
            } as any,
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({
            chatModelId: getAgentCore('codex').model.defaultMode,
            commitModelId: getAgentCore('codex').model.defaultMode,
        });
    });

    it('uses layout-v1 owner metadata for Agent and model facts', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            session: {
                id: 's1',
                modelMode: '',
                metadataLayoutVersion: 1,
                metadata: {
                    v: 1,
                    flavor: 'codex',
                },
                ownerMetadataView: {
                    flavor: 'gemini',
                },
            } as any,
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({
            chatModelId: getAgentCore('gemini').model.defaultMode,
            commitModelId: getAgentCore('gemini').model.defaultMode,
        });
    });

});
