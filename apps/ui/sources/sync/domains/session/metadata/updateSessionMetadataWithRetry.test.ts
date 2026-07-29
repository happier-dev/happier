import { describe, expect, it, vi } from 'vitest';
import {
    updateSessionMetadataWithRetry,
} from './updateSessionMetadataWithRetry';

type Metadata = {
    v?: 1;
    summary?: { text: string; updatedAt: number };
    path: string;
    host: string;
    readStateV1?: { v: 1; sessionSeq: number; pendingActivityAt: number; updatedAt: number };
    tools?: string[];
};

describe('updateSessionMetadataWithRetry', () => {
    it('keeps an ordinary layout-0 metadata mutation on the legacy writer', async () => {
        const initial = {
            mode: 'legacy_owner' as const,
            metadataLayoutVersion: 0 as const,
            metadataVersion: 3,
            metadataCiphertext: 'metadata-source',
            ownerMetadata: null,
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: {
                    path: '/workspace',
                    host: 'owner-host',
                    summary: { text: 'Before', updatedAt: 10 },
                },
                agentState: null,
            },
        };
        const encryptMetadata = vi.fn(async (value: Metadata) =>
            `legacy:${JSON.stringify(value)}`);
        const emitUpdateMetadata = vi.fn(async () => ({
            result: 'success' as const,
            version: 4,
            metadata: 'metadata-committed',
        }));
        const decryptMetadata = vi.fn(async () => ({
            path: '/workspace',
            host: 'owner-host',
            summary: { text: 'After', updatedAt: 20 },
        }));
        const applySessionMetadata = vi.fn();
        const encryptPayload = vi.fn(async () => 'tuple-must-not-run');
        const sealOwnerMetadata = vi.fn(() => 'tuple-must-not-run');
        const applyTupleSnapshot = vi.fn();

        await updateSessionMetadataWithRetry<Metadata>({
            sessionId: 's_ordinary',
            getSession: () => ({
                metadataLayoutVersion: 0,
                metadataVersion: 3,
                metadata: initial.value.metadata,
            }),
            refreshSessions: async () => undefined,
            encryptMetadata,
            decryptMetadata,
            applySessionMetadata,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload,
                sealOwnerMetadata,
            },
            emitUpdateMetadata,
            applyTupleSnapshot,
            updater: (base) => ({
                ...base,
                summary: { text: 'After', updatedAt: 20 },
            }),
        });

        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            sid: 's_ordinary',
            expectedVersion: 3,
            metadata: expect.stringContaining('"After"'),
        });
        expect(encryptMetadata).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledWith(
            4,
            'metadata-committed',
        );
        expect(applySessionMetadata).toHaveBeenCalledWith({
            metadataVersion: 4,
            metadata: expect.objectContaining({
                summary: { text: 'After', updatedAt: 20 },
            }),
        });
        expect(encryptPayload).not.toHaveBeenCalled();
        expect(sealOwnerMetadata).not.toHaveBeenCalled();
        expect(applyTupleSnapshot).not.toHaveBeenCalled();
    });

    it('returns an exact ordinary layout-0 no-op without encryption, commit, refetch, or apply', async () => {
        const initial = {
            mode: 'legacy_owner' as const,
            metadataLayoutVersion: 0 as const,
            metadataVersion: 3,
            metadataCiphertext: 'metadata-source',
            ownerMetadata: null,
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: {
                    path: '/workspace',
                    host: 'owner-host',
                },
                agentState: null,
            },
        };
        const refreshSessions = vi.fn(async () => undefined);
        const encryptMetadata = vi.fn(async () => 'must-not-run');
        const decryptMetadata = vi.fn(async () => null);
        const emitUpdateMetadata = vi.fn(async () => ({
            result: 'error' as const,
        }));
        const applySessionMetadata = vi.fn();
        const encryptPayload = vi.fn(async () => 'must-not-run');
        const sealOwnerMetadata = vi.fn(() => 'must-not-run');
        const applyTupleSnapshot = vi.fn();

        await expect(updateSessionMetadataWithRetry<Metadata>({
            sessionId: 's_ordinary',
            getSession: () => ({
                metadataLayoutVersion: 0,
                metadataVersion: 3,
                metadata: initial.value.metadata,
            }),
            refreshSessions,
            encryptMetadata,
            decryptMetadata,
            applySessionMetadata,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload,
                sealOwnerMetadata,
            },
            emitUpdateMetadata,
            applyTupleSnapshot,
            updater: (base) => ({ ...base }),
        })).resolves.toBeUndefined();

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(encryptMetadata).not.toHaveBeenCalled();
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(emitUpdateMetadata).not.toHaveBeenCalled();
        expect(applySessionMetadata).not.toHaveBeenCalled();
        expect(encryptPayload).not.toHaveBeenCalled();
        expect(sealOwnerMetadata).not.toHaveBeenCalled();
        expect(applyTupleSnapshot).not.toHaveBeenCalled();
    });

    it('uses the exact owner tuple and applies both committed versions without the legacy serializer', async () => {
        const emitCalls: unknown[] = [];
        const initial = {
            mode: 'owner' as const,
            metadataLayoutVersion: 1 as const,
            metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current',
            ownerMetadataCiphertext: 'owner-current',
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: {
                    path: '/private',
                    host: 'owner-host',
                    summary: { text: 'Before', updatedAt: 10 },
                },
                sharedMetadata: {
                    v: 1 as const,
                    summary: { text: 'Before', updatedAt: 10 },
                },
                ownerMetadata: {
                    v: 1 as const,
                    workspace: {
                        path: '/private',
                        host: 'owner-host',
                    },
                },
                agentState: null,
            },
        };
        let applied: unknown;
        const sealOwnerMetadata = vi.fn(() => 'owner-resealed');

        await updateSessionMetadataWithRetry<
            Metadata,
            Record<string, unknown>
        >({
            sessionId: 's_layout1',
            getSession: () => ({
                metadataLayoutVersion: 1,
                metadataVersion: 3,
                metadata: initial.value.metadata,
            }),
            refreshSessions: async () => undefined,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload: async () => 'shared-next',
                sealOwnerMetadata,
            },
            emitUpdateMetadata: async (payload) => {
                emitCalls.push(payload);
                return {
                    result: 'success',
                    metadataLayoutVersion: 1,
                    version: 4,
                    agentStateVersion: 6,
                };
            },
            applyTupleSnapshot: (next) => {
                applied = next;
            },
            updater: (base) => ({
                ...base,
                summary: { text: 'After', updatedAt: 20 },
            }),
        });

        expect(emitCalls).toEqual([{
            mode: 'owner',
            metadataLayoutVersion: 1,
            expectedOwnerMetadataCiphertext: 'owner-current',
            sharedMetadata: {
                ciphertext: 'shared-next',
                expectedVersion: 3,
            },
            ownerMetadata: { ciphertext: 'owner-current' },
            agentState: {
                ciphertext: null,
                expectedVersion: 5,
            },
        }]);
        expect(applied).toMatchObject({
            mode: 'owner',
            metadataVersion: 4,
            agentStateVersion: 6,
            ownerMetadataCiphertext: 'owner-current',
            value: {
                metadata: {
                    summary: { text: 'After', updatedAt: 20 },
                },
            },
        });
        expect(sealOwnerMetadata).not.toHaveBeenCalled();
    });

    it('uses the conditioned legacy branch once and refreshes before surfacing an active conflict', async () => {
        const initial = {
            mode: 'legacy_owner' as const,
            metadataLayoutVersion: 0 as const,
            metadataVersion: 3,
            metadataCiphertext: 'metadata-source',
            ownerMetadata: null,
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: {
                    path: '/workspace',
                    host: 'owner-host',
                },
                agentState: null,
            },
        };
        const refreshSessions = vi.fn(async () => undefined);
        const emitUpdateMetadata = vi.fn(async () => ({
            result: 'session-active' as const,
        }));

        await expect(updateSessionMetadataWithRetry<Metadata>({
            sessionId: 's_layout0_conditioned',
            getSession: () => ({
                metadataLayoutVersion: 0,
                metadataVersion: 3,
                metadata: initial.value.metadata,
            }),
            refreshSessions,
            encryptMetadata: async () => 'metadata-next',
            decryptMetadata: async () => null,
            applySessionMetadata: () => undefined,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload: async () => 'must-not-run',
                sealOwnerMetadata: () => 'must-not-run',
            },
            emitUpdateMetadata,
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                path: '/workspace/next',
            }),
            sessionExpectation: { kind: 'inactive_model_intent' },
            maxAttempts: 3,
        })).rejects.toMatchObject({
            code: 'session_active',
            retryable: false,
        });

        expect(emitUpdateMetadata).toHaveBeenCalledTimes(1);
        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            sid: 's_layout0_conditioned',
            expectedVersion: 3,
            metadata: 'metadata-next',
            sessionExpectation: { kind: 'inactive_model_intent' },
        });
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('uses the dedicated conditioned owner tuple once and refreshes before surfacing an active conflict', async () => {
        const initial = {
            mode: 'owner' as const,
            metadataLayoutVersion: 1 as const,
            metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current',
            ownerMetadataCiphertext: 'owner-current',
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: {
                    path: '/private',
                    host: 'owner-host',
                },
                sharedMetadata: {
                    v: 1 as const,
                },
                ownerMetadata: {
                    v: 1 as const,
                    workspace: {
                        path: '/private',
                        host: 'owner-host',
                    },
                },
                agentState: null,
            },
        };
        const refreshSessions = vi.fn(async () => undefined);
        const emitUpdateMetadata = vi.fn(async () => ({
            result: 'session-active' as const,
        }));

        await expect(updateSessionMetadataWithRetry<
            Metadata,
            Record<string, unknown>
        >({
            sessionId: 's_layout1_conditioned',
            getSession: () => ({
                metadataLayoutVersion: 1,
                metadataVersion: 3,
                metadata: initial.value.metadata,
            }),
            refreshSessions,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload: async () => 'shared-next',
                sealOwnerMetadata: () => 'owner-next',
            },
            emitUpdateMetadata,
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                path: '/private/next',
            }),
            sessionExpectation: { kind: 'inactive_model_intent' },
            maxAttempts: 3,
        })).rejects.toMatchObject({
            code: 'session_active',
            retryable: false,
        });

        expect(emitUpdateMetadata).toHaveBeenCalledTimes(1);
        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            mode: 'owner_inactive_model_intent',
            metadataLayoutVersion: 1,
            sessionExpectation: { kind: 'inactive_model_intent' },
            expectedOwnerMetadataCiphertext: 'owner-current',
            sharedMetadata: {
                ciphertext: 'shared-next',
                expectedVersion: 3,
            },
            ownerMetadata: { ciphertext: 'owner-next' },
            agentState: {
                ciphertext: null,
                expectedVersion: 5,
            },
        });
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('reacquires and reapplies policy after an explicit layout-1 conflict', async () => {
        const snapshots = [
            {
                mode: 'shared_editor' as const,
                metadataLayoutVersion: 1 as const,
                metadataVersion: 1,
                sharedMetadataCiphertext: 'shared-initial',
                value: {
                    metadata: {
                        v: 1 as const,
                        summary: { text: 'Initial', updatedAt: 10 },
                    } as unknown as Metadata,
                    sharedMetadata: {
                        v: 1 as const,
                        summary: { text: 'Initial', updatedAt: 10 },
                    },
                    ownerMetadata: null,
                    agentState: null,
                },
            },
            {
                mode: 'shared_editor' as const,
                metadataLayoutVersion: 1 as const,
                metadataVersion: 2,
                sharedMetadataCiphertext: 'shared-concurrent',
                value: {
                    metadata: {
                        v: 1 as const,
                        summary: { text: 'Concurrent', updatedAt: 15 },
                        agentPresentation: { agentId: 'codex' },
                    } as unknown as Metadata,
                    sharedMetadata: {
                        v: 1 as const,
                        summary: { text: 'Concurrent', updatedAt: 15 },
                        agentPresentation: { agentId: 'codex' },
                    },
                    ownerMetadata: null,
                    agentState: null,
                },
            },
        ];
        const acquireTupleSnapshot = async () => snapshots.shift()!;
        const updaterBases: Metadata[] = [];
        const attempts: unknown[] = [];

        await updateSessionMetadataWithRetry({
            sessionId: 's_layout1',
            getSession: () => ({
                metadataLayoutVersion: 1,
                metadataVersion: 1,
                metadata: snapshots[0]!.value.metadata,
            }),
            refreshSessions: async () => undefined,
            acquireTupleSnapshot,
            tupleCrypto: {
                encryptPayload: async (payload) => JSON.stringify(payload),
                sealOwnerMetadata: () => {
                    throw new Error(
                        'shared editor must not seal owner metadata',
                    );
                },
            },
            emitUpdateMetadata: async (payload) => {
                attempts.push(payload);
                return attempts.length === 1
                    ? {
                        result: 'version-mismatch',
                        metadataLayoutVersion: 1,
                        version: 2,
                    }
                    : {
                        result: 'success',
                        metadataLayoutVersion: 1,
                        version: 3,
                    };
            },
            applyTupleSnapshot: () => undefined,
            updater: (base) => {
                updaterBases.push(base);
                return {
                    ...base,
                    summary: { text: 'Mine', updatedAt: 20 },
                };
            },
            maxAttempts: 2,
        });

        expect(updaterBases).toEqual([
            expect.objectContaining({
                summary: { text: 'Initial', updatedAt: 10 },
            }),
            expect.objectContaining({
                summary: { text: 'Concurrent', updatedAt: 15 },
                agentPresentation: { agentId: 'codex' },
            }),
        ]);
        expect(attempts).toEqual([
            expect.objectContaining({
                sharedMetadata: expect.objectContaining({
                    expectedVersion: 1,
                }),
            }),
            expect.objectContaining({
                sharedMetadata: expect.objectContaining({
                    expectedVersion: 2,
                }),
            }),
        ]);
    });

    it('replays through the shared tuple owner after the UI write timeout leaves the exact source unchanged', async () => {
        const acquireTupleSnapshot = async () => ({
            mode: 'shared_editor' as const,
            metadataLayoutVersion: 1 as const,
            metadataVersion: 1,
            sharedMetadataCiphertext: 'shared-source',
            value: {
                metadata: {
                    v: 1 as const,
                    summary: { text: 'Before', updatedAt: 10 },
                } as unknown as Metadata,
                sharedMetadata: {
                    v: 1 as const,
                    summary: { text: 'Before', updatedAt: 10 },
                },
                ownerMetadata: null,
                agentState: null,
            },
        });
        const acquire = vi.fn(acquireTupleSnapshot);
        const ambiguous = new Error('timeout after write');
        ambiguous.name = 'ServerFetchWriteTimeoutError';
        const emit = vi.fn()
            .mockRejectedValueOnce(ambiguous)
            .mockResolvedValueOnce({
                result: 'success',
                metadataLayoutVersion: 1,
                version: 2,
            });

        await expect(updateSessionMetadataWithRetry({
            sessionId: 's_layout1',
            getSession: () => ({
                metadataLayoutVersion: 1,
                metadataVersion: 1,
                metadata: {
                    v: 1,
                    summary: { text: 'Before', updatedAt: 10 },
                } as unknown as Metadata,
            }),
            refreshSessions: async () => undefined,
            acquireTupleSnapshot: acquire,
            tupleCrypto: {
                encryptPayload: async () => 'shared-next',
                sealOwnerMetadata: () => {
                    throw new Error(
                        'shared editor must not seal owner metadata',
                    );
                },
            },
            emitUpdateMetadata: emit,
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                summary: { text: 'After', updatedAt: 20 },
            }),
            maxAttempts: 3,
        })).resolves.toBeUndefined();

        expect(acquire).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledTimes(2);
    });

});
