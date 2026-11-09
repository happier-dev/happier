import { describe, expect, it, vi } from 'vitest';
import { createUiSessionStateMetadataUpdatePort } from '@/sync/state/metadataUpdatePort';
import {
    updateSessionMetadataWithRetry,
    type SessionMetadataUpdatePayload,
} from './updateSessionMetadataWithRetry';

type Metadata = {
    v?: 1;
    summary?: { text: string; updatedAt: number };
    path: string;
    host: string;
    readStateV1?: { v: 1; sessionSeq: number; pendingActivityAt: number; updatedAt: number };
    sessionModelsV1?: {
        v: 1;
        agentId: string;
        updatedAt: number;
        currentModelId: string;
        availableModels: Array<{
            id: string;
            name: string;
            contextWindowTokens?: number;
        }>;
    };
    tools?: string[];
};

const ownerCurrentEnvelope = {
    t: 'plain' as const,
    v: {
        v: 1 as const,
        workspace: {
            path: '/private',
            host: 'owner-host',
        },
    },
};

describe('updateSessionMetadataWithRetry', () => {
    it('preserves the canonical reviewed-revision refusal at the UI result sink', async () => {
        const snapshot = {
            mode: 'shared_editor' as const, metadataLayoutVersion: 1 as const,
            metadataVersion: 2, sharedMetadataCiphertext: 'shared-before',
            value: { metadata: { v: 1 as const }, sharedMetadata: { v: 1 as const }, ownerMetadata: null, agentState: null },
        };
        const emit = vi.fn();
        const write = () => updateSessionMetadataWithRetry({
            sessionId: 'reviewed-session',
            getSession: () => ({ metadataLayoutVersion: 1, metadataVersion: 2, metadata: snapshot.value.metadata }),
            refreshSessions: async () => undefined,
            initialSnapshot: snapshot, acquireTupleSnapshot: async () => snapshot,
            tupleCrypto: { encryptPayload: async payload => JSON.stringify(payload),
                encodeOwnerMetadata: () => { throw new Error('A shared editor cannot seal owner metadata'); } },
            emitUpdateMetadata: emit, applyTupleSnapshot: () => undefined,
            updater: metadata => metadata, expectedMetadataRevision: 1,
        });
        await expect(write()).rejects.toMatchObject({ code: 'metadata_tuple_conflict', retryable: false });
        const port = createUiSessionStateMetadataUpdatePort({ updateSessionMetadataWithRetry: write });
        expect(await port.update('reviewed-session', metadata => metadata, { reason: 'reviewed-edit' }))
            .toEqual({ ok: false, reason: 'conflict' });
        expect(emit).not.toHaveBeenCalled();
    });

    it('rejects a present-null layout before any metadata effect', async () => {
        const acquireTupleSnapshot = vi.fn();
        const emitUpdateMetadata = vi.fn();
        await expect(updateSessionMetadataWithRetry<Metadata>({
            sessionId: 's_invalid_null_layout',
            getSession: () => ({
                metadataLayoutVersion: null as never,
                metadataVersion: 3,
                metadata: { path: '/workspace', host: 'owner-host' },
            }),
            refreshSessions: async () => undefined,
            acquireTupleSnapshot,
            tupleCrypto: {
                encryptPayload: vi.fn(),
                encodeOwnerMetadata: vi.fn(),
            },
            emitUpdateMetadata,
            applyTupleSnapshot: vi.fn(),
            updater: (base) => base,
        })).rejects.toThrow(/Unsupported Session metadata layout/iu);

        expect(acquireTupleSnapshot).not.toHaveBeenCalled();
        expect(emitUpdateMetadata).not.toHaveBeenCalled();
    });

    it('rebases a released legacy write through the shared retry owner without dropping the winner', async () => {
        const source = { path: '/workspace', host: 'before', forkV1: {
            v: 1 as const, parentSessionId: 'private-parent', parentCutoffSeqInclusive: 7,
            strategy: 'private-strategy', requestId: 'private-request', createdAtMs: 123,
        } };
        const initial = { mode: 'legacy_owner' as const, metadataLayoutVersion: 0 as const,
            metadataVersion: 3, metadataCiphertext: JSON.stringify(source), ownerMetadata: null,
            agentStateVersion: 0, agentStateCiphertext: null, value: { metadata: source, agentState: null } };
        let committed = source;
        const payloads: SessionMetadataUpdatePayload[] = [];
        await updateSessionMetadataWithRetry({
            sessionId: 'legacy-rebase', getSession: () => ({ metadataVersion: 3, metadata: source }),
            initialSnapshot: initial, acquireTupleSnapshot: async () => initial,
            refreshSessions: async () => undefined,
            encryptMetadata: async metadata => JSON.stringify(metadata),
            decryptMetadata: async (_version, ciphertext) => JSON.parse(ciphertext) as typeof source,
            applySessionMetadata: next => { committed = next.metadata; },
            tupleCrypto: { encryptPayload: async () => { throw new Error('Legacy transport seals the flat value'); },
                encodeOwnerMetadata: () => ownerCurrentEnvelope },
            emitUpdateMetadata: async payload => {
                payloads.push(payload);
                if ('mode' in payload) throw new Error('Released legacy mutation must remain on its wire seam');
                return payloads.length === 1
                    ? { result: 'version-mismatch', version: 4, metadata: JSON.stringify({ ...source, host: 'winner',
                        forkV1: { ...source.forkV1, createdAtMs: 234 } }) }
                    : { result: 'success', version: 5, metadata: payload.metadata };
            },
            applyTupleSnapshot: () => { throw new Error('Legacy result must retain its shape'); },
            updater: metadata => ({ ...metadata, path: '/requested' }),
        });
        expect(committed).toEqual({ ...source, path: '/requested', host: 'winner', forkV1: { ...source.forkV1, createdAtMs: 234 } });
        expect(payloads).toEqual([
            { sid: 'legacy-rebase', expectedVersion: 3, metadata: JSON.stringify({ ...source, path: '/requested' }),
                usageTimingV1: { v: 1, metadata: { v: 1, minMs: 123, maxMs: 123 }, agentState: null } },
            { sid: 'legacy-rebase', expectedVersion: 4, metadata: JSON.stringify({ ...source, path: '/requested', host: 'winner',
                forkV1: { ...source.forkV1, createdAtMs: 234 } }),
                usageTimingV1: { v: 1, metadata: { v: 1, minMs: 234, maxMs: 234 }, agentState: null } },
        ]);
    });

    it('migrates an ordinary layout-0 metadata mutation through the owner tuple', async () => {
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
        const emitUpdateMetadata = vi.fn(async (patch: SessionMetadataUpdatePayload) => ({
            result: 'success' as const,
            metadataLayoutVersion: 1,
            version: 'mode' in patch && patch.mode === 'owner_migration' ? 4 : 5,
            agentStateVersion: 6,
        }));
        const decryptMetadata = vi.fn(async () => ({
            path: '/workspace',
            host: 'owner-host',
            summary: { text: 'After', updatedAt: 20 },
        }));
        const applySessionMetadata = vi.fn();
        const encryptPayload = vi.fn(async (value: unknown) =>
            `tuple:${JSON.stringify(value)}`);
        const encodeOwnerMetadata = vi.fn(() => ownerCurrentEnvelope);
        const applyTupleSnapshot = vi.fn();
        let acknowledgedRevision: number | undefined;

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
                encodeOwnerMetadata,
            },
            getOwnerMigrationCurrentness: () => ({
                expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
            }),
            emitUpdateMetadata,
            applyTupleSnapshot,
            onMetadataCommitted: (revision) => { acknowledgedRevision = revision; },
            updater: (base) => ({
                ...base,
                summary: { text: 'After', updatedAt: 20 },
            }),
        });

        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            mode: 'owner_migration',
            expectedAccountEncryptionMode: 'plain',
            expectedAccountContentPublicKeyFingerprint: null,
            usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: null },
            source: {
                metadataLayoutVersion: 0,
                metadata: {
                    version: 3,
                    ciphertext: 'metadata-source',
                },
                ownerMetadata: null,
                agentState: {
                    version: 5,
                    ciphertext: null,
                },
            },
            target: expect.objectContaining({
                metadataLayoutVersion: 1,
                ownerMetadata: expect.objectContaining({ t: 'plain' }),
                sharedMetadata: {
                    ciphertext: expect.stringContaining('"Before"'),
                },
            }),
        });
        expect(emitUpdateMetadata).toHaveBeenLastCalledWith(expect.objectContaining({
            mode: 'owner', sharedMetadata: { expectedVersion: 4, ciphertext: expect.stringContaining('"After"') },
        }));
        expect(encryptMetadata).not.toHaveBeenCalled();
        expect(acknowledgedRevision).toBe(5);
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessionMetadata).not.toHaveBeenCalled();
        expect(encryptPayload).toHaveBeenCalled();
        expect(encodeOwnerMetadata).toHaveBeenCalled();
        expect(applyTupleSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'owner',
                metadataLayoutVersion: 1,
                metadataVersion: 5,
                agentStateVersion: 6,
            }),
        );
    });

    it('projects predecessor aliases only at the layout-0 encryption boundary', async () => {
        const canonicalMetadata: Metadata = {
            path: '/workspace',
            host: 'owner-host',
            sessionModelsV1: {
                v: 1,
                agentId: 'codex',
                updatedAt: 10,
                currentModelId: 'codex-1',
                availableModels: [{
                    id: 'codex-1',
                    name: 'Codex 1',
                    contextWindowTokens: 0,
                }],
            },
        };
        const initial = {
            mode: 'legacy_owner' as const,
            metadataLayoutVersion: 0 as const,
            metadataVersion: 3,
            metadataCiphertext: 'metadata-source',
            ownerMetadata: null,
            agentStateVersion: 5,
            agentStateCiphertext: null,
            value: {
                metadata: canonicalMetadata,
                agentState: null,
            },
        };
        const encryptedInputs: Metadata[] = [];

        await updateSessionMetadataWithRetry<Metadata>({
            sessionId: 's_predecessor_compat',
            getSession: () => ({
                metadataLayoutVersion: 0,
                metadataVersion: 3,
                metadata: canonicalMetadata,
            }),
            refreshSessions: async () => undefined,
            encryptMetadata: async (value) => {
                encryptedInputs.push(value);
                return 'metadata-compatible';
            },
            decryptMetadata: async () => canonicalMetadata,
            applySessionMetadata: () => undefined,
            acquireTupleSnapshot: async () => initial,
            tupleCrypto: {
                encryptPayload: async () => 'tuple-must-not-run',
                encodeOwnerMetadata: () => ownerCurrentEnvelope,
            },
            emitUpdateMetadata: async () => ({
                result: 'success',
                version: 4,
                metadata: 'metadata-compatible',
            }),
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                summary: { text: 'Unrelated update', updatedAt: 20 },
            }),
        });

        expect(encryptedInputs).toHaveLength(1);
        expect(encryptedInputs[0]?.sessionModelsV1).toMatchObject({
            agentId: 'codex',
            provider: 'codex',
        });
        expect(encryptedInputs[0]?.sessionModelsV1?.availableModels[0])
            .not.toHaveProperty('contextWindowTokens');
        expect(canonicalMetadata.sessionModelsV1).not.toHaveProperty('provider');
        expect(canonicalMetadata.sessionModelsV1?.availableModels[0])
            .toHaveProperty('contextWindowTokens', 0);
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
        const encodeOwnerMetadata = vi.fn(() => ownerCurrentEnvelope);
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
                encodeOwnerMetadata,
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
        expect(encodeOwnerMetadata).not.toHaveBeenCalled();
        expect(applyTupleSnapshot).not.toHaveBeenCalled();
    });

    it('uses the exact owner tuple and applies both committed versions without the legacy serializer', async () => {
        const emitCalls: unknown[] = [];
        const initial = {
            mode: 'owner' as const,
            metadataLayoutVersion: 1 as const,
            metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current',
            ownerMetadataEnvelope: ownerCurrentEnvelope,
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
        const encodeOwnerMetadata = vi.fn(() => ownerCurrentEnvelope);

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
                encodeOwnerMetadata,
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
            usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: null },
            displayProjectionV1: null,
            expectedOwnerMetadata: ownerCurrentEnvelope,
            sharedMetadata: {
                ciphertext: 'shared-next',
                expectedVersion: 3,
            },
            ownerMetadata: ownerCurrentEnvelope,
            agentState: {
                ciphertext: null,
                expectedVersion: 5,
            },
        }]);
        expect(applied).toMatchObject({
            mode: 'owner',
            metadataVersion: 4,
            agentStateVersion: 6,
            ownerMetadataEnvelope: ownerCurrentEnvelope,
            value: {
                metadata: {
                    summary: { text: 'After', updatedAt: 20 },
                },
            },
        });
        expect(encodeOwnerMetadata).not.toHaveBeenCalled();
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
                encodeOwnerMetadata: () => ownerCurrentEnvelope,
            },
            emitUpdateMetadata,
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                path: '/workspace/next',
            }),
            sessionExpectation: { kind: 'inactive_model_intent' },
        })).rejects.toMatchObject({
            code: 'session_active',
            retryable: false,
        });

        expect(emitUpdateMetadata).toHaveBeenCalledTimes(1);
        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            sid: 's_layout0_conditioned',
            expectedVersion: 3,
            metadata: 'metadata-next',
            usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: null },
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
            ownerMetadataEnvelope: ownerCurrentEnvelope,
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
                encodeOwnerMetadata: (ownerMetadata) => ({
                    t: 'plain' as const,
                    v: ownerMetadata,
                }),
            },
            emitUpdateMetadata,
            applyTupleSnapshot: () => undefined,
            updater: (base) => ({
                ...base,
                path: '/private/next',
            }),
            sessionExpectation: { kind: 'inactive_model_intent' },
        })).rejects.toMatchObject({
            code: 'session_active',
            retryable: false,
        });

        expect(emitUpdateMetadata).toHaveBeenCalledTimes(1);
        expect(emitUpdateMetadata).toHaveBeenCalledWith({
            mode: 'owner_inactive_model_intent',
            metadataLayoutVersion: 1,
            usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: null },
            displayProjectionV1: null,
            sessionExpectation: { kind: 'inactive_model_intent' },
            expectedOwnerMetadata: ownerCurrentEnvelope,
            sharedMetadata: {
                ciphertext: 'shared-next',
                expectedVersion: 3,
            },
            ownerMetadata: {
                t: 'plain',
                v: expect.objectContaining({
                    workspace: expect.objectContaining({
                        path: '/private/next',
                    }),
                }),
            },
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
                encodeOwnerMetadata: () => {
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
                encodeOwnerMetadata: () => {
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
        })).resolves.toBeUndefined();

        expect(acquire).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledTimes(2);
    });

});
