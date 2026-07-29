import { describe, expect, it, vi } from 'vitest';
import {
    resolveExternalSessionsSourceKey,
    sealSessionOwnerMetadataV1,
    SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { annotateExternalSessionCandidates } from './candidateAnnotations';
import { resolveExternalSessionCandidateIdentityKey } from './candidateQuery';

const fetchSessionsPageMock = vi.hoisted(() => vi.fn());

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionsPage: fetchSessionsPageMock,
}));

describe('annotateExternalSessionCandidates', () => {
    it('reads layout-v1 owner metadata when annotating linked and imported candidates', async () => {
        const secret = new Uint8Array(32).fill(7);
        const sealOwnerMetadata = (
            ownerMetadata: Parameters<typeof SessionOwnerMetadataV1Schema.parse>[0],
        ) => sealSessionOwnerMetadataV1({
            material: { type: 'legacy', secret },
            ownerMetadata: SessionOwnerMetadataV1Schema.parse(ownerMetadata),
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        fetchSessionsPageMock.mockReset();
        fetchSessionsPageMock
            .mockResolvedValueOnce({
                sessions: [{
                    id: 'linked-session',
                    encryptionMode: 'plain',
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: sealOwnerMetadata({
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
                }, {
                    id: 'imported-session',
                    encryptionMode: 'plain',
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: sealOwnerMetadata({
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
                hasNext: false,
                nextCursor: null,
            })
            .mockResolvedValueOnce({
                sessions: [],
                hasNext: false,
                nextCursor: null,
            });

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
        });

        expect(result).toEqual([
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
        ]);
    });

    it('projects live links, conversion tombstones, and publication time from canonical session owners', async () => {
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
                            agentId: 'codex',
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
        });

        expect(result).toEqual([
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
        ]);
    });

    it('caps active and archived scans without starting a second lookup per candidate', async () => {
        const fetchPage = vi.fn(async ({ cursor }: { cursor?: string }) => ({
            sessions: [],
            hasNext: true,
            nextCursor: cursor ? `${cursor}-next` : 'next',
        }));

        await annotateExternalSessionCandidates({
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
        });

        expect(fetchPage).toHaveBeenCalledTimes(4);
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
        });

        expect(result).toEqual([
            expect.not.objectContaining({ linkedSessionId: expect.anything() }),
            expect.objectContaining({
                candidateKey: resolveExternalSessionCandidateIdentityKey({
                    remoteSessionId: 'duplicate-native-id',
                    linkData: { projectId: 'project-b' },
                }),
                linkedSessionId: 'linked-project-b',
            }),
        ]);
    });
});
