import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalSessionLinkEnsureResponseSchema } from '@happier-dev/protocol';

import type { BoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';

const {
    readCredentialsMock,
    readStoredCredentialsMock,
    ensureExternalSessionLinkMock,
    resolveExternalSessionSourceSurfaceMock,
    resolveExternalSessionSurfaceOpsMock,
    resolveExternalSessionSourceKeyOwnerMock,
    resolveCurrentExternalSessionAgentIdentityMock,
    fetchSessionsPageMock,
    fetchAccountEncryptionCurrentnessMock,
} = vi.hoisted(() => ({
    readCredentialsMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
    ensureExternalSessionLinkMock: vi.fn(),
    resolveExternalSessionSourceSurfaceMock: vi.fn(),
    resolveExternalSessionSurfaceOpsMock: vi.fn(),
    resolveExternalSessionSourceKeyOwnerMock: vi.fn(),
    resolveCurrentExternalSessionAgentIdentityMock: vi.fn(),
    fetchSessionsPageMock: vi.fn(),
    fetchAccountEncryptionCurrentnessMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
    return {
        ...actual,
        fetchSessionsPage: (...args: Parameters<typeof actual.fetchSessionsPage>) =>
            fetchSessionsPageMock(...args),
    };
});

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/api/client/connectedServiceCredentialApi')
    >();
    return {
        ...actual,
        fetchAccountEncryptionCurrentness: (
            ...args: Parameters<typeof actual.fetchAccountEncryptionCurrentness>
        ) => fetchAccountEncryptionCurrentnessMock(...args),
    };
});

vi.mock('@/persistence', () => ({
    readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
    readStoredCredentials: (...args: unknown[]) => readStoredCredentialsMock(...args),
}));

vi.mock('@/api/session/external/linking/ensureExternalSessionLink', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/api/session/external/linking/ensureExternalSessionLink')
    >();
    ensureExternalSessionLinkMock.mockImplementation(actual.ensureExternalSessionLink);
    return {
        ...actual,
        ensureExternalSessionLink: (...args: Parameters<typeof actual.ensureExternalSessionLink>) =>
            ensureExternalSessionLinkMock(...args),
    };
});

vi.mock('./providerOpsResolution', () => ({
    resolveExternalSessionSourceSurface: (...args: unknown[]) => resolveExternalSessionSourceSurfaceMock(...args),
    resolveExternalSessionSurfaceOps: (...args: unknown[]) => resolveExternalSessionSurfaceOpsMock(...args),
    resolveExternalSessionSourceKeyOwner: (...args: unknown[]) => resolveExternalSessionSourceKeyOwnerMock(...args),
}));

vi.mock('@/api/session/external/linking/qualifiedLinkIdentityRegistry', () => ({
    resolveCurrentExternalSessionAgentIdentity: (...args: unknown[]) =>
        resolveCurrentExternalSessionAgentIdentityMock(...args),
}));

import {
    executeExternalSessionCandidatesListAction,
    executeExternalSessionLinkEnsureAction,
} from './discoveryLinkActions';

/**
 * The Agent declaration `resolveExternalSessionSourceSurface` really returns.
 * The host admission boundary materializes an Agent's authorized sources from
 * it, so a double that omits it would exercise a surface the daemon never sees.
 */
function externalSessionSourceDeclarationDouble(sourceKind: string) {
    return {
        sourceKind,
        schema: { fields: [{ kind: 'literal', name: 'kind', value: sourceKind }] },
        key: { segments: [{ kind: 'literal', value: sourceKind }] },
        instances: [{ kind: 'default', constants: {} }],
    };
}

describe('executeExternalSessionLinkEnsureAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readCredentialsMock.mockResolvedValue({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array([1]) },
        });
        readStoredCredentialsMock.mockResolvedValue({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array([1]) },
        });
        resolveExternalSessionSourceSurfaceMock.mockImplementation(async (_agentId, source) => ({
            ok: true,
            source,
            declaration: externalSessionSourceDeclarationDouble(source.kind),
            providerOps: {
                validateSource: ({ source }: Readonly<{ source: unknown }>) => ({ ok: true, source }),
            },
            currentAgent: {
                identity: { pluginId: 'acme.current-agent', localId: 'opencode' },
                sourceKinds: [source.kind],
            },
            sourceKeyOwner: {
                sourceKey: source.kind,
                resolveSourceKey: (candidate: Readonly<{ kind?: unknown }>) =>
                    candidate.kind === source.kind ? source.kind : null,
                resolvePersistedSourceKeys: (candidate: Readonly<{ kind?: unknown }>) =>
                    candidate.kind === source.kind ? [source.kind] : null,
            },
        }));
        resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
            validateSource: ({ source }: Readonly<{ source: unknown }>) => ({ ok: true, source }),
        });
        resolveExternalSessionSourceKeyOwnerMock.mockResolvedValue(null);
        resolveCurrentExternalSessionAgentIdentityMock.mockResolvedValue(null);
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({ mode: 'plain' });
        fetchSessionsPageMock.mockResolvedValue({ sessions: [], nextCursor: null, hasNext: false });
    });

    it('annotates a complete candidate generation but never a partial preparation page', async () => {
        const corpus = [
            { remoteSessionId: 'oldest', updatedAtMs: 10, linkData: { projectId: 'project-a' } },
            { remoteSessionId: 'middle', updatedAtMs: 20, linkData: { projectId: 'project-a' } },
            { remoteSessionId: 'newest', updatedAtMs: 30, linkData: { projectId: 'project-a' } },
        ] as const;
        const source = { kind: 'claudeConfig', configDir: '/private/annotation-deferral' } as const;
        const listCandidates = vi.fn(async (request: Readonly<{
            cursor?: string;
            searchTerm?: string;
        }>) => {
            if (request.searchTerm) {
                const match = corpus.find(
                    (candidate) => candidate.remoteSessionId === request.searchTerm,
                );
                return {
                    candidates: match
                        ? [{ ...match, title: `Title ${match.remoteSessionId}` }]
                        : [],
                    nextCursor: null,
                };
            }
            return request.cursor
                ? {
                    candidates: [corpus[2]],
                    nextCursor: null,
                    preparation: { kind: 'building_candidate_index' as const, scanned: 3, total: 3 },
                }
                : {
                    candidates: [corpus[0], corpus[1]],
                    nextCursor: 'qualified-scan-cursor',
                    preparation: { kind: 'building_candidate_index' as const, scanned: 2, total: 3 },
                };
        });
        resolveExternalSessionSourceSurfaceMock.mockResolvedValue({
            ok: true,
            source,
            declaration: externalSessionSourceDeclarationDouble(source.kind),
            providerOps: {
                validateSource: ({ source: candidateSource }: Readonly<{ source: unknown }>) => ({
                    ok: true,
                    source: candidateSource,
                }),
                listCandidates,
                resolveLinkIdentity: async (request: Readonly<{ remoteSessionId: string }>) => ({
                    remoteSessionId: request.remoteSessionId,
                    source,
                }),
            },
            currentAgent: {
                identity: { pluginId: 'happier.claude', localId: 'claude' },
                sourceKinds: ['claudeConfig'],
            },
            sourceKeyOwner: {
                sourceKey: 'claudeConfig:annotation-deferral',
                resolveSourceKey: () => 'claudeConfig:annotation-deferral',
                resolvePersistedSourceKeys: () => ['claudeConfig:annotation-deferral'] as const,
            },
        });
        const request = {
            machineId: 'machine-1',
            agentId: 'claude',
            source,
            limit: 2,
        } as const;

        await expect(executeExternalSessionCandidatesListAction(request)).resolves.toMatchObject({
            ok: true,
            candidates: [],
            preparation: { kind: 'building_candidate_index' },
        });

        const partial = await executeExternalSessionCandidatesListAction(request);
        expect(partial).toMatchObject({
            ok: true,
            candidates: [
                { remoteSessionId: 'newest' },
                { remoteSessionId: 'middle' },
            ],
            preparation: { kind: 'building_candidate_index' },
            annotationsIncomplete: true,
        });
        expect(fetchAccountEncryptionCurrentnessMock).not.toHaveBeenCalled();
        expect(fetchSessionsPageMock).not.toHaveBeenCalled();

        const complete = await executeExternalSessionCandidatesListAction(request);
        expect(complete).not.toHaveProperty('preparation');
        expect(complete).toMatchObject({
            ok: true,
            candidates: [
                { remoteSessionId: 'newest', title: 'Title newest' },
                { remoteSessionId: 'middle', title: 'Title middle' },
            ],
        });
        expect(fetchAccountEncryptionCurrentnessMock).toHaveBeenCalledTimes(1);
        expect(fetchSessionsPageMock).toHaveBeenCalled();
    });

    it('lists from one coherent current-global source snapshot during a G to H cutover', async () => {
        const generationGIdentity = {
            pluginId: 'acme.generation-g',
            localId: 'opencode',
        } as const;
        const generationGSourceKeyOwner = {
            sourceKey: 'opencodeServer:g',
            resolveSourceKey: vi.fn(() => 'opencodeServer:g'),
            resolvePersistedSourceKeys: vi.fn(() => ['opencodeServer:g'] as const),
        };
        const generationGProviderOps = {
            validateSource: vi.fn(async ({ source }: Readonly<{ source: unknown }>) => ({
                ok: true as const,
                source,
            })),
            listCandidates: vi.fn(async () => ({
                candidates: [],
                nextCursor: null,
            })),
        };
        resolveExternalSessionSourceSurfaceMock.mockResolvedValueOnce({
            ok: true,
            source: { kind: 'opencodeServer' },
            declaration: externalSessionSourceDeclarationDouble('opencodeServer'),
            providerOps: generationGProviderOps,
            currentAgent: {
                identity: generationGIdentity,
                sourceKinds: ['opencodeServer'],
            },
            sourceKeyOwner: generationGSourceKeyOwner,
        });
        resolveExternalSessionSurfaceOpsMock.mockRejectedValueOnce(
            new Error('hypothetical generation H operations must not be acquired'),
        );
        resolveCurrentExternalSessionAgentIdentityMock.mockResolvedValueOnce({
            identity: { pluginId: 'acme.generation-h', localId: 'opencode' },
            sourceKinds: ['opencodeServer'],
        });
        resolveExternalSessionSourceKeyOwnerMock.mockResolvedValueOnce({
            sourceKey: 'opencodeServer:h',
            resolveSourceKey: () => 'opencodeServer:h',
            resolvePersistedSourceKeys: () => ['opencodeServer:h'] as const,
        });

        const result = await executeExternalSessionCandidatesListAction({
            machineId: 'machine-1',
            agentId: 'opencode',
            source: { kind: 'opencodeServer' },
            limit: 1,
        });

        expect(result).toMatchObject({
            ok: true,
            candidates: [],
            nextCursor: null,
            autoLinkPolicyScopeV1: {
                qualifiedIdentity: {
                    agent: generationGIdentity,
                },
            },
        });
        expect(generationGProviderOps.listCandidates).toHaveBeenCalledOnce();
        expect(resolveExternalSessionSourceSurfaceMock).toHaveBeenCalledOnce();
        expect(resolveExternalSessionSurfaceOpsMock).not.toHaveBeenCalled();
        expect(resolveCurrentExternalSessionAgentIdentityMock).not.toHaveBeenCalled();
        expect(resolveExternalSessionSourceKeyOwnerMock).not.toHaveBeenCalled();
    });

    it('forwards unknown future Codex backend modes to the canonical link owner', async () => {
        ensureExternalSessionLinkMock.mockRejectedValueOnce(new ExternalSessionProviderFailureError({
            code: 'source_invalid',
            message: 'codex_backend_mode_unsupported',
            operation: 'externalSession.resolveLinkIdentity',
        }));

        const result = await executeExternalSessionLinkEnsureAction({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
            codexBackendMode: 'future-codex-mode',
            linkData: { projectId: 'project-b' },
        });

        expect(result.ok).toBe(false);
        expect(ensureExternalSessionLinkMock).toHaveBeenCalledWith(expect.objectContaining({
            source: { kind: 'codexHome', home: 'user' },
            remoteSessionId: 'remote-1',
            linkData: { projectId: 'project-b' },
            codexBackendMode: 'future-codex-mode',
        }), expect.any(Object));
    });

    it('reports a temporarily uninstalled Agent as unavailable instead of invalidating its persisted source', async () => {
        resolveExternalSessionSourceSurfaceMock.mockResolvedValueOnce({
            ok: false,
            code: 'agent_unavailable',
        });

        await expect(executeExternalSessionLinkEnsureAction({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_agent_unavailable',
        });
    });

    it('preserves a retryable Agent source failure through the execution surface', async () => {
        const contribution = Object.freeze({
            resolveSource: vi.fn(async () => ({
                ok: false as const,
                code: 'agent_unavailable' as const,
                message: 'OpenCode managed external-session endpoint is unavailable.',
                retryable: true,
            })),
            listCandidates: vi.fn(async () => ({
                ok: true as const,
                value: { candidates: [], nextCursor: null },
            })),
            resolveLinkIdentity: vi.fn(async (request) => ({
                ok: true as const,
                value: {
                    remoteSessionId: request.remoteSessionId,
                    source: request.source,
                    linkData: request.linkData ?? {},
                },
            })),
            resolveLinkedIdentity: vi.fn(async (request) => ({
                ok: true as const,
                value: {
                    remoteSessionId: request.remoteSessionId,
                    source: request.source,
                    linkData: request.linkData,
                },
            })),
            pageTranscript: vi.fn(async () => ({
                ok: true as const,
                value: { items: [], nextCursor: null },
            })),
            readAfterTranscript: vi.fn(async () => ({
                ok: true as const,
                value: { outcome: 'already_current' as const },
            })),
        }) satisfies BoundedAgentExternalSessionsContribution;
        resolveExternalSessionSourceSurfaceMock.mockImplementationOnce(async (_agentId, source) => ({
            ok: true,
            source,
            declaration: externalSessionSourceDeclarationDouble(source.kind),
            providerOps: createAgentExternalSessionsExecutionSurface(contribution),
        }));

        const result = await executeExternalSessionLinkEnsureAction({
            machineId: 'machine-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer' },
        });

        expect(ExternalSessionLinkEnsureResponseSchema.parse(result)).toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'agent_unavailable',
            retryable: true,
        });
    });

    it('links a plain external Session with token-only stored credentials', async () => {
        readCredentialsMock.mockResolvedValueOnce(null);
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'plain-token',
            encryption: null,
        });
        ensureExternalSessionLinkMock.mockResolvedValueOnce({
            sessionId: 'session-plain',
            created: true,
        });

        await expect(executeExternalSessionLinkEnsureAction({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        })).resolves.toEqual({
            ok: true,
            sessionId: 'session-plain',
            created: true,
        });

        expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
        expect(ensureExternalSessionLinkMock).toHaveBeenCalledWith(
            expect.objectContaining({
                credentials: {
                    token: 'plain-token',
                    encryption: null,
                },
            }),
            expect.any(Object),
        );
    });
});
