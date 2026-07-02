import { describe, expect, it, vi } from 'vitest';

async function loadRestoreModule(): Promise<Record<string, any> | null> {
    try {
        const modulePath = './restore';
        return await import(modulePath);
    } catch {
        return null;
    }
}

const providerCandidate = {
    id: 'provider:checkpoint-1',
    source: 'provider',
    scopes: ['workspace'],
    candidate: {
        source: 'provider',
        backendId: 'claude',
        target: {
            kind: 'provider_checkpoint',
            checkpointId: 'checkpoint-1',
        },
    },
} as const;

const scmCandidate = {
    id: 'scm:turn-1',
    source: 'happier_scm',
    scopes: ['workspace'],
    candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        turnId: 'turn-1',
    },
} as const;

describe('restoreSessionCheckpoint', () => {
    it('requires explicit source selection when provider and SCM can restore the same scope', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['workspace'],
                anchor: { kind: 'before_user_message', messageId: 'message-1' },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [providerCandidate, scmCandidate],
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

    it('sanitizes provider restore tokens from restore receipts', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const providerRestore = vi.fn(async () => ({
            ok: true,
            outcome: 'completed',
            restoredScopes: ['conversation'],
        }));
        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation'],
                candidate: {
                    source: 'provider',
                    backendId: 'claude',
                    target: {
                        kind: 'provider_restore_token',
                        token: 'raw-token',
                    },
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreProvider: providerRestore,
            },
        });

        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain('raw-token');
        expect(providerRestore).toHaveBeenCalledWith(expect.objectContaining({
            target: {
                kind: 'provider_restore_token',
                token: 'raw-token',
            },
        }));
    });

    it('requires trusted turn-start evidence for provider anchor candidates when configured', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation'],
                candidate: {
                    source: 'provider',
                    backendId: 'codex',
                    anchor: {
                        kind: 'before_user_message',
                        messageId: 'message-2',
                        evidence: { messageSeq: 12 },
                    },
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                providerAnchorRequiresTurnEvidence: () => true,
                resolveTurnEvidenceForAnchor: async () => null,
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'trusted_turn_evidence_required',
        });
    });

    it('records sanitized failure receipts when provider restore fails', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation'],
                candidate: {
                    source: 'provider',
                    backendId: 'claude',
                    target: {
                        kind: 'provider_restore_token',
                        token: 'raw-failed-token',
                    },
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreProvider: async () => ({
                    ok: false,
                    code: 'restore_failed',
                }),
                createLifecycleId: () => 'restore-failed-1',
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'provider_restore_failed',
            receipts: [{
                lifecycleId: 'restore-failed-1',
                candidate: {
                    target: {
                        kind: 'provider_restore_token',
                        redacted: true,
                    },
                },
            }],
        });
        expect(JSON.stringify(result)).not.toContain('raw-failed-token');
    });

    it('uses exact per-part scope selections for composed restore candidates', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const restoreProvider = vi.fn(async () => ({
            ok: true,
            outcome: 'completed',
            restoredScopes: ['conversation'],
        }));
        const restoreScm = vi.fn(async () => ({
            ok: true,
            restoredScopes: ['workspace'],
        }));

        const result = await module.restoreSessionCheckpoint({
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
                                target: {
                                    kind: 'provider_checkpoint',
                                    checkpointId: 'provider-conversation-1',
                                },
                            },
                        },
                        {
                            scopes: ['workspace'],
                            candidate: {
                                source: 'happier_scm',
                                checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
                            },
                        },
                    ],
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreProvider,
                restoreScm,
            },
        });

        expect(result).toMatchObject({
            ok: true,
            source: 'composed',
            restoredScopes: ['conversation', 'workspace'],
        });
        expect(restoreProvider).toHaveBeenCalledWith(expect.objectContaining({
            scopes: ['conversation'],
        }));
        expect(restoreScm).toHaveBeenCalledWith(expect.objectContaining({
            scopes: ['workspace'],
        }));
    });

    it('preserves an already-succeeded composed part receipt when a later part fails', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const restoreProvider = vi.fn(async () => ({
            ok: true,
            outcome: 'completed',
            restoredScopes: ['conversation'],
        }));
        const restoreScm = vi.fn(async () => ({
            ok: false,
            code: 'conflict',
        }));

        const result = await module.restoreSessionCheckpoint({
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
                                target: {
                                    kind: 'provider_checkpoint',
                                    checkpointId: 'provider-conversation-1',
                                },
                            },
                        },
                        {
                            scopes: ['workspace'],
                            candidate: {
                                source: 'happier_scm',
                                checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
                            },
                        },
                    ],
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreProvider,
                restoreScm,
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'scm_restore_failed',
        });
        // The provider conversation restore already ran and mutated; its receipt must survive so the
        // transcript can see scope-by-scope progress rather than an ambiguous bare failure.
        expect(result.receipts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'provider',
                phase: 'succeeded',
                restoredScopes: ['conversation'],
            }),
        ]));
    });

    it('does not split auto-selected atomic provider candidates into narrower scope calls', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const restoreProvider = vi.fn(async () => ({
            ok: true,
            outcome: 'completed',
            restoredScopes: ['workspace'],
        }));

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['workspace'],
                anchor: { kind: 'before_user_message', messageId: 'message-1' },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [{
                    id: 'provider:atomic-conversation-workspace',
                    source: 'provider',
                    scopes: ['conversation', 'workspace'],
                    atomic: true,
                    candidate: {
                        source: 'provider',
                        backendId: 'claude',
                        target: {
                            kind: 'provider_checkpoint',
                            checkpointId: 'atomic-1',
                        },
                    },
                }],
                restoreProvider,
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'restore_target_missing',
        });
        expect(restoreProvider).not.toHaveBeenCalled();
    });

    it('fails closed when provider restored scopes do not match the selected scopes', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['conversation'],
                candidate: {
                    source: 'provider',
                    backendId: 'claude',
                    target: {
                        kind: 'provider_checkpoint',
                        checkpointId: 'provider-conversation-1',
                    },
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreProvider: async () => ({
                    ok: true,
                    outcome: 'completed',
                    restoredScopes: ['workspace'],
                }),
                createLifecycleId: () => 'invalid-provider-result-1',
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'provider_restore_failed',
            error: 'invalid_provider_restore_scopes',
            receipts: [{
                lifecycleId: 'invalid-provider-result-1',
                failedScopes: [{
                    scope: 'conversation',
                    code: 'invalid_provider_restore_scopes',
                }],
            }],
        });
    });

    it('fails closed when SCM restore scope results are outside the selected scopes', async () => {
        const module = await loadRestoreModule();
        expect(module).not.toBeNull();
        if (!module) return;

        const result = await module.restoreSessionCheckpoint({
            request: {
                v: 1,
                sessionId: 'session-1',
                scopes: ['workspace'],
                candidate: {
                    source: 'happier_scm',
                    checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
                },
                confirmation: { sourceChoiceConfirmed: true },
            },
            ports: {
                isSessionIdle: async () => true,
                collectCandidates: async () => [],
                restoreScm: async () => ({
                    ok: true,
                    restoredScopes: ['workspace'],
                    failedScopes: [{
                        scope: 'conversation',
                        code: 'unexpected_scope',
                    }],
                }),
            },
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'scm_restore_failed',
            error: 'invalid_scm_restore_scopes',
        });
    });
});
