import { describe, expect, it, vi } from 'vitest';
import {
    type AccountEncryptionCurrentnessResponse,
    createPlainSessionOwnerMetadataEnvelopeV1,
    resolveExternalSessionsSourceKey,
    SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import {
    resolveExternalSessionTagLookupCandidates,
} from '@/api/session/external/linking/externalSessionTagLookupCandidates';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { annotateExternalSessionCandidates } from './candidateAnnotations';
import { resolveExternalSessionCandidateIdentityKey } from './candidateQuery';

const fetchSessionsPageMock = vi.hoisted(() => vi.fn());
const lookupSessionsByTagsMock = vi.hoisted(() => vi.fn());

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionsPage: fetchSessionsPageMock,
    lookupSessionsByTags: lookupSessionsByTagsMock,
}));

const indexedTagRouteUnavailable = async () => ({ state: 'unavailable' } as const);

/**
 * The tag a candidate would own once linked, derived through the same canonical
 * owner `link.ensure` uses. A lookup built from any other identity input returns
 * nothing from the fixtures below, so these tests fail on a wrong derivation.
 */
function canonicalCandidateLookupTag(params: Readonly<{
    machineId: string;
    agentId: Parameters<typeof resolveExternalSessionTagLookupCandidates>[0]['agentId'];
    remoteSessionId: string;
    source: Parameters<typeof resolveExternalSessionTagLookupCandidates>[0]['source'];
    sourceKey: string;
}>): string {
    return resolveExternalSessionTagLookupCandidates({
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        releasedPersistedSource: params.source,
        sourceKey: params.sourceKey,
        releasedSourceKeys: [params.sourceKey],
    })[0].tag;
}

const plainAccountEncryptionCurrentness = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

const getPlainAccountEncryptionCurrentness = async () => plainAccountEncryptionCurrentness;

describe('annotateExternalSessionCandidates', () => {
    it('reads layout-v1 owner metadata when annotating linked and imported candidates', async () => {
        const secret = new Uint8Array(32).fill(7);
        const createOwnerMetadataEnvelope = (
            ownerMetadata: Parameters<typeof SessionOwnerMetadataV1Schema.parse>[0],
        ) => createPlainSessionOwnerMetadataEnvelopeV1(
            SessionOwnerMetadataV1Schema.parse(ownerMetadata),
        );
        fetchSessionsPageMock.mockReset();
        lookupSessionsByTagsMock.mockReset();
        const sourceKey = resolveExternalSessionsSourceKey({
            kind: 'codexHome',
            home: 'user',
        })!;
        const tagFor = (remoteSessionId: string) => canonicalCandidateLookupTag({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId,
            source: { kind: 'codexHome', home: 'user' },
            sourceKey,
        });
        const rowsByTag = new Map<string, unknown>([
            [tagFor('remote-linked'), {
                    id: 'linked-session',
                    encryptionMode: 'plain',
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: createOwnerMetadataEnvelope({
                        v: 1,
                        workspace: { machineId: 'machine-1' },
                        nativeSession: {
                            externalSessionV1: {
                                v: 1,
                                agentId: 'codex',
                                machineId: 'machine-1',
                                remoteSessionId: 'remote-linked',
                                source: { kind: 'codexHome', home: 'user' },
                            },
                        },
                    }),
                    materializedThroughSourceAt: 100,
            }],
            [tagFor('remote-imported'), {
                    id: 'imported-session',
                    encryptionMode: 'plain',
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: createOwnerMetadataEnvelope({
                        v: 1,
                        workspace: { machineId: 'machine-1' },
                        history: {
                            externalHistoryImportV1: {
                                v: 1,
                                agentId: 'codex',
                                remoteSessionId: 'remote-imported',
                                importedAtMs: 90,
                                source: { kind: 'codexHome', home: 'user' },
                            },
                        },
                    }),
                    materializedThroughSourceAt: 80,
            }],
        ]);
        lookupSessionsByTagsMock.mockImplementation(async ({ tags }: { tags: readonly string[] }) => ({
            state: 'available' as const,
            tags,
            sessions: tags.flatMap((tag) => (rowsByTag.has(tag) ? [rowsByTag.get(tag)] : [])),
        }));

        const result = await annotateExternalSessionCandidates({
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret },
            },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: [
                { remoteSessionId: 'remote-linked', updatedAtMs: 2 },
                { remoteSessionId: 'remote-imported', updatedAtMs: 1 },
            ],
            sourceKeyOwner: {
                sourceKey: resolveExternalSessionsSourceKey({
                    kind: 'codexHome',
                    home: 'user',
                })!,
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
        }, {
            fetchPage: fetchSessionsPageMock,
            decryptMetadata: tryDecryptSessionOwnerMetadataView,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: lookupSessionsByTagsMock,
        });

        expect(fetchSessionsPageMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            annotationsIncomplete: false,
            candidates: [
                expect.objectContaining({
                    remoteSessionId: 'remote-linked',
                    linkedSessionId: 'linked-session',
                    materializedThrough: 100,
                }),
                expect.objectContaining({
                    remoteSessionId: 'remote-imported',
                    linkedSessionId: 'imported-session',
                    imported: true,
                    materializedThrough: 80,
                }),
            ],
        });
    });

    it('splits the served page into indexed tag lookups inside the wire limit and never scans Session pages', async () => {
        fetchSessionsPageMock.mockReset();
        lookupSessionsByTagsMock.mockReset();
        lookupSessionsByTagsMock.mockImplementation(async ({ tags }: { tags: readonly string[] }) => ({
            state: 'available' as const,
            tags,
            sessions: [],
        }));

        const result = await annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: Array.from({ length: 5 }, (_unused, index) => ({
                remoteSessionId: `remote-${index}`,
                updatedAtMs: index,
            })),
            sourceKeyOwner: {
                sourceKey: 'codexHome:user:::',
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
        }, {
            fetchPage: fetchSessionsPageMock,
            decryptMetadata: () => null,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: lookupSessionsByTagsMock,
        });

        const requestedTags = lookupSessionsByTagsMock.mock.calls
            .map((call) => (call[0] as { tags: readonly string[] }).tags);
        expect(requestedTags.map((tags) => tags.length)).toEqual([4, 1]);
        expect(requestedTags.flat()).toEqual(Array.from({ length: 5 }, (_unused, index) => (
            canonicalCandidateLookupTag({
                machineId: 'machine-1',
                agentId: 'codex',
                remoteSessionId: `remote-${index}`,
                source: { kind: 'codexHome', home: 'user' },
                sourceKey: 'codexHome:user:::',
            })
        )));
        expect(fetchSessionsPageMock).not.toHaveBeenCalled();
        expect(result.annotationsIncomplete).toBe(false);
    });

    it('stops the indexed lookup and rejects when the caller cancels mid-page', async () => {
        fetchSessionsPageMock.mockReset();
        lookupSessionsByTagsMock.mockReset();
        const abortController = new AbortController();
        lookupSessionsByTagsMock.mockImplementation(async ({ tags }: { tags: readonly string[] }) => {
            abortController.abort();
            return { state: 'available' as const, tags, sessions: [] };
        });

        await expect(annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: Array.from({ length: 8 }, (_unused, index) => ({
                remoteSessionId: `remote-${index}`,
                updatedAtMs: index,
            })),
            sourceKeyOwner: {
                sourceKey: 'codexHome:user:::',
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
            signal: abortController.signal,
        }, {
            fetchPage: fetchSessionsPageMock,
            decryptMetadata: () => null,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: lookupSessionsByTagsMock,
        })).rejects.toMatchObject({ name: 'AbortError' });

        expect(lookupSessionsByTagsMock).toHaveBeenCalledTimes(1);
    });

    it('stops the bounded compatibility scan and rejects when the caller cancels mid-scan', async () => {
        fetchSessionsPageMock.mockReset();
        lookupSessionsByTagsMock.mockReset();
        lookupSessionsByTagsMock.mockImplementation(indexedTagRouteUnavailable);
        const abortController = new AbortController();
        fetchSessionsPageMock.mockImplementation(async ({ cursor }: { cursor?: string }) => {
            abortController.abort();
            return { sessions: [], hasNext: true, nextCursor: cursor ? `${cursor}-next` : 'next' };
        });

        await expect(annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
            maxPages: 10,
            sourceKeyOwner: {
                sourceKey: 'codexHome:user:::',
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
            signal: abortController.signal,
        }, {
            fetchPage: fetchSessionsPageMock,
            decryptMetadata: () => null,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: lookupSessionsByTagsMock,
        })).rejects.toMatchObject({ name: 'AbortError' });

        expect(fetchSessionsPageMock).toHaveBeenCalledTimes(1);
    });

    it('projects live links, released conversion tombstones, and publication time from canonical session owners', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({
                sessions: [{
                    id: 'linked-session',
                    metadata: {
                        machineId: 'machine-1',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                            machineId: 'machine-1',
                            remoteSessionId: 'remote-linked',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                    materializedThroughSourceAt: 100,
                }, {
                    id: 'imported-session',
                    metadata: {
                        machineId: 'machine-1',
                        externalHistoryImportV1: {
                            v: 1,
                            providerId: 'codex',
                            remoteSessionId: 'remote-imported',
                            importedAtMs: 90,
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                    materializedThroughSourceAt: 80,
                }],
                hasNext: false,
                nextCursor: null,
            })
            .mockResolvedValueOnce({ sessions: [], hasNext: false, nextCursor: null });

        const result = await annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: [
                { remoteSessionId: 'remote-linked', updatedAtMs: 2 },
                { remoteSessionId: 'remote-imported', updatedAtMs: 1 },
            ],
            sourceKeyOwner: {
                sourceKey: 'codexHome:user:::',
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
        }, {
            fetchPage,
            decryptMetadata: ({ rawSession }) => rawSession.metadata as Record<string, unknown>,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: indexedTagRouteUnavailable,
        });

        expect(result).toEqual({
            annotationsIncomplete: false,
            candidates: [
                expect.objectContaining({
                    remoteSessionId: 'remote-linked',
                    linkedSessionId: 'linked-session',
                    materializedThrough: 100,
                }),
                expect.objectContaining({
                    remoteSessionId: 'remote-imported',
                    linkedSessionId: 'imported-session',
                    imported: true,
                    materializedThrough: 80,
                }),
            ],
        });
    });

    it('marks candidate annotations incomplete when the bounded active or archived scan stops early', async () => {
        const fetchPage = vi.fn(async ({ cursor }: { cursor?: string }) => ({
            sessions: [],
            hasNext: true,
            nextCursor: cursor ? `${cursor}-next` : 'next',
        }));

        const result = await annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidates: [
                { remoteSessionId: 'remote-1', updatedAtMs: 1 },
                { remoteSessionId: 'remote-2', updatedAtMs: 2 },
            ],
            maxPages: 2,
            sourceKeyOwner: {
                sourceKey: 'codexHome:user:::',
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
        }, {
            fetchPage,
            decryptMetadata: () => null,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: indexedTagRouteUnavailable,
        });

        expect(fetchPage).toHaveBeenCalledTimes(4);
        expect(result).toMatchObject({
            annotationsIncomplete: true,
            candidates: [
                { remoteSessionId: 'remote-1' },
                { remoteSessionId: 'remote-2' },
            ],
        });
    });

    it('annotates only the project-qualified candidate when native ids collide', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({
                sessions: [{
                    id: 'linked-project-b',
                    metadata: {
                        machineId: 'machine-1',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'claude',
                            machineId: 'machine-1',
                            remoteSessionId: 'duplicate-native-id',
                            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                            linkData: { projectId: 'project-b' },
                        },
                    },
                }],
                hasNext: false,
                nextCursor: null,
            })
            .mockResolvedValueOnce({ sessions: [], hasNext: false, nextCursor: null });

        const result = await annotateExternalSessionCandidates({
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            machineId: 'machine-1',
            agentId: 'claude',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            candidates: [
                {
                    remoteSessionId: 'duplicate-native-id',
                    candidateKey: resolveExternalSessionCandidateIdentityKey({
                        remoteSessionId: 'duplicate-native-id',
                        linkData: { projectId: 'project-a' },
                    }),
                    updatedAtMs: 2,
                    linkData: { projectId: 'project-a' },
                },
                {
                    remoteSessionId: 'duplicate-native-id',
                    candidateKey: resolveExternalSessionCandidateIdentityKey({
                        remoteSessionId: 'duplicate-native-id',
                        linkData: { projectId: 'project-b' },
                    }),
                    updatedAtMs: 1,
                    linkData: { projectId: 'project-b' },
                },
            ],
            sourceKeyOwner: {
                sourceKey: resolveExternalSessionsSourceKey({
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude',
                })!,
                resolveSourceKey: resolveExternalSessionsSourceKey,
            },
        }, {
            fetchPage,
            decryptMetadata: ({ rawSession }) => rawSession.metadata as Record<string, unknown>,
            getAccountEncryptionCurrentness: getPlainAccountEncryptionCurrentness,
            lookupByTags: indexedTagRouteUnavailable,
        });

        expect(result).toEqual({
            annotationsIncomplete: false,
            candidates: [
                expect.not.objectContaining({ linkedSessionId: expect.anything() }),
                expect.objectContaining({
                    candidateKey: resolveExternalSessionCandidateIdentityKey({
                        remoteSessionId: 'duplicate-native-id',
                        linkData: { projectId: 'project-b' },
                    }),
                    linkedSessionId: 'linked-project-b',
                }),
            ],
        });
    });
});
