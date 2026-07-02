import { describe, expect, it, vi } from 'vitest';

async function loadCreateModule(): Promise<Record<string, any> | null> {
    try {
        const modulePath = './create';
        return await import(modulePath);
    } catch {
        return null;
    }
}

const providerCandidate = {
    id: 'provider:create',
    source: 'provider',
    scopes: ['workspace'],
    candidate: {
        source: 'provider',
        backendId: 'claude',
    },
} as const;

const scmCandidate = {
    id: 'scm:create',
    source: 'happier_scm',
    scopes: ['workspace'],
    candidate: {
        source: 'happier_scm',
    },
} as const;

describe('createSessionCheckpoint', () => {
    it('requires explicit source selection when provider and SCM can create the same scope', async () => {
        const module = await loadCreateModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.createSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['workspace'],
            },
            ports: {
                isSessionIdle: async () => true,
                collectCreateCandidates: async () => [providerCandidate, scmCandidate],
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'source_choice_required',
        });
        expect(result.candidates.map((candidate: { source: string }) => candidate.source)).toEqual([
            'provider',
            'happier_scm',
        ]);
    });

    it('sanitizes provider checkpoint tokens from creation receipts', async () => {
        const module = await loadCreateModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const checkpointProvider = vi.fn(async () => ({
            id: 'provider-create-1',
            target: {
                kind: 'provider_restore_token',
                token: 'raw-create-token',
            },
            timing: 'idle',
            checkpointScopes: ['conversation'],
            restoreScopes: ['conversation'],
        }));
        const result = await module.createSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation'],
                candidate: {
                    source: 'provider',
                    backendId: 'claude',
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCreateCandidates: async () => [],
                checkpointProvider,
            },
        });

        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain('raw-create-token');
        expect(checkpointProvider).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            scopes: ['conversation'],
            timing: 'idle',
        }));
    });

    it('executes an atomic provider checkpoint candidate with the exact selected scope set', async () => {
        const module = await loadCreateModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const checkpointProvider = vi.fn(async () => ({
            id: 'provider-create-atomic',
            target: {
                kind: 'provider_checkpoint',
                checkpointId: 'provider-create-atomic',
            },
            timing: 'idle',
            checkpointScopes: ['conversation', 'workspace'],
            restoreScopes: ['conversation', 'workspace'],
        }));

        const result = await module.createSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation', 'workspace'],
                candidate: {
                    source: 'provider',
                    backendId: 'claude',
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCreateCandidates: async () => [],
                checkpointProvider,
            },
        });

        expect(result).toMatchObject({
            ok: true,
            source: 'provider',
            checkpointRef: 'provider-create-atomic',
        });
        expect(checkpointProvider).toHaveBeenCalledWith(expect.objectContaining({
            backendId: 'claude',
            scopes: ['conversation', 'workspace'],
        }));
    });

    it('executes composed checkpoint creation with exact per-part scope selections', async () => {
        const module = await loadCreateModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const checkpointProvider = vi.fn(async () => ({
            id: 'provider-conversation-create',
            target: {
                kind: 'provider_checkpoint',
                checkpointId: 'provider-conversation-create',
            },
            timing: 'idle',
            checkpointScopes: ['conversation'],
            restoreScopes: ['conversation'],
        }));
        const checkpointScm = vi.fn(async () => ({
            ok: true,
            checkpointRef: 'refs/happier/checkpoints/scope/manual/workspace-1',
        }));

        const result = await module.createSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation', 'workspace'],
                candidate: {
                    source: 'composed',
                    parts: [
                        {
                            scopes: ['conversation'],
                            candidate: {
                                source: 'provider',
                                backendId: 'claude',
                            },
                        },
                        {
                            scopes: ['workspace'],
                            candidate: {
                                source: 'happier_scm',
                            },
                        },
                    ],
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCreateCandidates: async () => [],
                checkpointProvider,
                checkpointScm,
            },
        });

        expect(result).toMatchObject({
            ok: true,
            source: 'composed',
        });
        expect(checkpointProvider).toHaveBeenCalledWith(expect.objectContaining({
            scopes: ['conversation'],
        }));
        expect(checkpointScm).toHaveBeenCalledWith(expect.objectContaining({
            scopes: ['workspace'],
        }));
    });

    it('does not split auto-selected atomic provider creation candidates into narrower scope calls', async () => {
        const module = await loadCreateModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const checkpointProvider = vi.fn(async () => ({
            id: 'provider-create-workspace',
            target: {
                kind: 'provider_checkpoint',
                checkpointId: 'provider-create-workspace',
            },
            timing: 'idle',
            checkpointScopes: ['workspace'],
            restoreScopes: ['workspace'],
        }));

        const result = await module.createSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['workspace'],
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCreateCandidates: async () => [{
                    id: 'provider:atomic-conversation-workspace',
                    source: 'provider',
                    scopes: ['conversation', 'workspace'],
                    atomic: true,
                    candidate: {
                        source: 'provider',
                        backendId: 'claude',
                    },
                }],
                checkpointProvider,
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'checkpoint_source_unavailable',
        });
        expect(checkpointProvider).not.toHaveBeenCalled();
    });
});
