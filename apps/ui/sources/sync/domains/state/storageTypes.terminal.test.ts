import { describe, it, expect } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('canonicalizes legacy runtime descriptors onto runtimeDescriptorV1 at storage ingress', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'thread-1',
                },
            },
        } as any);

        expect((parsed as any).runtimeDescriptorV1).toEqual({
            v: 1,
            providerId: 'codex',
            provider: {
                backendMode: 'appServer',
                providerSessionId: 'thread-1',
            },
        });
        expect(parsed).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('rejects malformed canonical runtimeDescriptorV1 metadata', () => {
        expect(() => MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
            },
        } as any)).toThrow();
    });

    it('falls back to a valid legacy runtime descriptor when the canonical carrier is malformed', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
            },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'thread-legacy',
                },
            },
        } as any);

        expect((parsed as any).runtimeDescriptorV1).toEqual({
            v: 1,
            providerId: 'codex',
            provider: {
                backendMode: 'appServer',
                providerSessionId: 'thread-legacy',
            },
        });
        expect(parsed).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('should preserve terminal metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            terminal: {
                mode: 'tmux',
                requested: 'tmux',
                tmux: {
                    target: 'happy:win-1',
                    tmpDir: '/tmp/happy-tmux',
                },
            },
        } as any);

        expect((parsed as any).terminal).toEqual({
            mode: 'tmux',
            requested: 'tmux',
            tmux: {
                target: 'happy:win-1',
                tmpDir: '/tmp/happy-tmux',
            },
        });
    });

    it('should preserve Auggie vendor session metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            auggieSessionId: 'auggie-session-1',
            auggieAllowIndexing: true,
        } as any);

        expect((parsed as any).auggieSessionId).toBe('auggie-session-1');
        expect((parsed as any).auggieAllowIndexing).toBe(true);
    });

    it('should preserve Qwen vendor session metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            qwenSessionId: 'qwen-session-1',
        } as any);

        expect((parsed as any).qwenSessionId).toBe('qwen-session-1');
    });

    it('should preserve Kimi vendor session metadata when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            kimiSessionId: 'kimi-session-1',
        } as any);

        expect((parsed as any).kimiSessionId).toBe('kimi-session-1');
    });

    it('should preserve sessionLogPath when present', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp',
            host: 'host',
            sessionLogPath: '/Users/test/.happier/logs/session.log',
        } as any);

        expect((parsed as any).sessionLogPath).toBe('/Users/test/.happier/logs/session.log');
    });
});
