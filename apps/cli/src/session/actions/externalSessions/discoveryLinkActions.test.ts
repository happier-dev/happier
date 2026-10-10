import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalSessionLinkEnsureResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { mapCanonicalExternalSessionResponseToLegacyDirectSession } from '@/api/machine/legacyDirectSessionResponseCompatibility';
import { EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';

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
    lookupSessionsByTagsMock,
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
    lookupSessionsByTagsMock: vi.fn(),
    fetchAccountEncryptionCurrentnessMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
    return {
        ...actual,
        fetchSessionsPage: (...args: Parameters<typeof actual.fetchSessionsPage>) =>
            fetchSessionsPageMock(...args),
        lookupSessionsByTags: (...args: Parameters<typeof actual.lookupSessionsByTags>) =>
            lookupSessionsByTagsMock(...args),
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
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
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
    executeExternalSessionCandidateDeleteAction,
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
        // This account's server does not serve the indexed tag route, so annotation
        // keeps using the bounded page scan these cases assert against.
        lookupSessionsByTagsMock.mockResolvedValue({ state: 'unavailable' });
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

    it('normalizes released Codex selectors into plugin-owned link data before dispatch', async () => {
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
            linkData: {
                projectId: 'project-b',
                codexBackendMode: 'future-codex-mode',
            },
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

describe('host-synthesized external session candidate deletion', () => {
    const source = { kind: 'acpSessionList' } as const;

    function resolveSourceWith(candidateLifecycle: unknown) {
        resolveExternalSessionSourceSurfaceMock.mockResolvedValue({
            ok: true,
            source,
            declaration: externalSessionSourceDeclarationDouble(source.kind),
            providerOps: {
                validateSource: ({ source: candidateSource }: Readonly<{ source: unknown }>) => ({
                    ok: true,
                    source: candidateSource,
                }),
                listCandidates: async () => ({
                    candidates: [{ remoteSessionId: ' provider\nsession-1 ', updatedAtMs: 1 }],
                    nextCursor: null,
                }),
                resolveLinkIdentity: async (request: Readonly<{ remoteSessionId: string }>) => ({
                    remoteSessionId: request.remoteSessionId,
                    source,
                }),
            },
            currentAgent: {
                identity: { pluginId: 'happier.kimi', localId: 'kimi' },
                sourceKinds: [source.kind],
            },
            candidateLifecycle,
            sourceKeyOwner: {
                sourceKey: source.kind,
                resolveSourceKey: () => source.kind,
                resolvePersistedSourceKeys: () => [source.kind] as const,
            },
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        readCredentialsMock.mockResolvedValue({ token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } });
        readStoredCredentialsMock.mockResolvedValue({ token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } });
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({ mode: 'plain' });
        fetchSessionsPageMock.mockResolvedValue({ sessions: [], nextCursor: null, hasNext: false });
        lookupSessionsByTagsMock.mockResolvedValue({ state: 'unavailable' });
    });

    /**
     * A listing-request scope stands in for the host lifecycle: the capability
     * is whatever the connection that served *this* request negotiated.
     */
    function candidateLifecycleDouble(input: Readonly<{
        negotiatedDeleteSupport: boolean;
        deleteCandidate?: unknown;
    }>) {
        return {
            runListingRequest: async <T>(run: () => Promise<T>) => ({
                value: await run(),
                negotiatedDeleteSupport: input.negotiatedDeleteSupport,
            }),
            deleteCandidate: input.deleteCandidate
                ?? (async () => ({ ok: true, value: undefined })),
        };
    }

    it.each([
        ['negotiated', true, { deleteCandidate: true }],
        ['unnegotiated', false, undefined],
    ])('advertises candidate deletion on a listing only when the Agent %s it', async (
        _label,
        deleteSupported,
        expected,
    ) => {
        resolveSourceWith(candidateLifecycleDouble({ negotiatedDeleteSupport: deleteSupported }));

        const listed = await executeExternalSessionCandidatesListAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            limit: 10,
        });

        expect(listed).toMatchObject({ ok: true });
        expect((listed as Record<string, unknown>).capabilities).toEqual(expected);
    });

    it('derives the advertised capability from the request that served the rows', async () => {
        const runListingRequest = vi.fn(async <T>(run: () => Promise<T>) => ({
            value: await run(),
            negotiatedDeleteSupport: true,
        }));
        resolveSourceWith({
            runListingRequest,
            deleteCandidate: async () => ({ ok: true, value: undefined }),
        });

        await executeExternalSessionCandidatesListAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            limit: 10,
        });

        // The whole candidate query — live listing and any index-served page —
        // runs inside the one request scope that answers the capability.
        expect(runListingRequest).toHaveBeenCalledTimes(1);
    });

    it('never advertises deletion for a plugin-contributed source with no host lifecycle', async () => {
        resolveSourceWith(null);

        const listed = await executeExternalSessionCandidatesListAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            limit: 10,
        });

        expect(listed).not.toHaveProperty('capabilities');
    });

    it('deletes through the host lifecycle with the exact opaque candidate id', async () => {
        const deleteCandidate = vi.fn(async () => ({ ok: true as const, value: undefined }));
        resolveSourceWith(candidateLifecycleDouble({ negotiatedDeleteSupport: true, deleteCandidate }));

        await expect(executeExternalSessionCandidateDeleteAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            remoteSessionId: ' provider\nsession-1 ',
        })).resolves.toEqual({ ok: true, deleted: true });
        expect(deleteCandidate).toHaveBeenCalledWith(expect.objectContaining({
            source,
            remoteSessionId: ' provider\nsession-1 ',
        }));
    });

    /**
     * The released `daemon.directSessions.candidate.delete` alias reaches this
     * same canonical Action carrying `providerId`. It must resolve the same
     * Agent and perform exactly one deletion of the byte-exact opaque id — a
     * released client must never be answered by a second implementation.
     */
    it('serves the released provider-named delete request through the one canonical owner', async () => {
        const deleteCandidate = vi.fn(async () => ({ ok: true as const, value: undefined }));
        resolveSourceWith(candidateLifecycleDouble({ negotiatedDeleteSupport: true, deleteCandidate }));

        await expect(executeExternalSessionCandidateDeleteAction({
            machineId: 'machine-1',
            providerId: 'kimi',
            source,
            remoteSessionId: ' provider\nsession-1 ',
        })).resolves.toEqual({ ok: true, deleted: true });

        expect(resolveExternalSessionSourceSurfaceMock).toHaveBeenCalledWith(
            'kimi',
            source,
            expect.anything(),
        );
        expect(deleteCandidate).toHaveBeenCalledTimes(1);
        expect(deleteCandidate).toHaveBeenCalledWith(expect.objectContaining({
            source,
            remoteSessionId: ' provider\nsession-1 ',
        }));
    });

    /**
     * The released wire method itself must arrive here too: cli-v0.2.1 /
     * ui-web-v0.2.0 send `daemon.directSessions.candidate.delete`, and a new
     * client falls back to that spelling against an older daemon. Registration,
     * released-identity normalization and dispatch together must produce exactly
     * one Agent-side deletion of the byte-exact opaque id through the canonical
     * Action — never a second delete and never a second handler.
     */
    it('dispatches the released direct-session delete method into the one canonical deletion', async () => {
        const deleteCandidate = vi.fn(async () => ({ ok: true as const, value: undefined }));
        resolveSourceWith(candidateLifecycleDouble({ negotiatedDeleteSupport: true, deleteCandidate }));

        const registered = new Map<string, (input: unknown) => Promise<unknown>>();
        const dispatchedActionIds: string[] = [];
        registerActionSpecRpcHandlers({
            rpcHandlerManager: {
                registerHandler: (method: string, handler: (input: unknown) => Promise<unknown>) => {
                    registered.set(method, handler);
                },
                hasHandler: (method: string) => registered.has(method),
            } as never,
            actionExecutor: {
                execute: async (actionId, input) => {
                    dispatchedActionIds.push(actionId);
                    return {
                        ok: true,
                        result: await executeExternalSessionCandidateDeleteAction(input),
                    };
                },
            },
            scopes: EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
            mapResponseForMethod: ({ method, response }) => method.startsWith('daemon.directSessions.')
                ? mapCanonicalExternalSessionResponseToLegacyDirectSession(response)
                : response,
        });

        const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY);
        expect(handler).toBeDefined();

        await expect(handler!({
            machineId: 'machine-1',
            providerId: 'kimi',
            source,
            remoteSessionId: ' provider\nsession-1 ',
        })).resolves.toEqual({ ok: true, deleted: true });

        expect(dispatchedActionIds).toEqual(['sessions.external.candidate.delete']);
        expect(deleteCandidate).toHaveBeenCalledTimes(1);
        expect(deleteCandidate).toHaveBeenCalledWith(expect.objectContaining({
            source,
            remoteSessionId: ' provider\nsession-1 ',
        }));
    });

    it('reports an Agent refusal as a typed failure and never claims deletion', async () => {
        resolveSourceWith(candidateLifecycleDouble({
            negotiatedDeleteSupport: true,
            deleteCandidate: async () => ({ ok: false as const, code: 'agent_error', message: 'provider refused' }),
        }));

        await expect(executeExternalSessionCandidateDeleteAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            remoteSessionId: ' provider\nsession-1 ',
        })).resolves.toMatchObject({ ok: false, errorCode: 'agent_unavailable' });
    });

    it('refuses deletion for an Agent whose source has no host-synthesized lifecycle', async () => {
        resolveSourceWith(null);

        await expect(executeExternalSessionCandidateDeleteAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            remoteSessionId: ' provider\nsession-1 ',
        })).resolves.toMatchObject({ ok: false, errorCode: 'agent_unavailable' });
    });

    it('rejects a malformed deletion request before resolving any Agent source', async () => {
        resolveSourceWith(candidateLifecycleDouble({ negotiatedDeleteSupport: true, deleteCandidate: vi.fn() }));

        await expect(executeExternalSessionCandidateDeleteAction({
            machineId: 'machine-1',
            agentId: 'kimi',
            source,
            remoteSessionId: '   ',
        })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_request' });
        expect(resolveExternalSessionSourceSurfaceMock).not.toHaveBeenCalled();
    });
});
