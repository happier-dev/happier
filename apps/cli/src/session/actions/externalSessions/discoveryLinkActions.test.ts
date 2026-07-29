import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';

const {
    readCredentialsMock,
    resolveExternalSessionSourceSurfaceMock,
    resolveLinkIdentityMock,
} = vi.hoisted(() => ({
    readCredentialsMock: vi.fn(),
    resolveExternalSessionSourceSurfaceMock: vi.fn(),
    resolveLinkIdentityMock: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('./providerOpsResolution', () => ({
    resolveExternalSessionSourceSurface: (...args: unknown[]) => resolveExternalSessionSourceSurfaceMock(...args),
    resolveExternalSessionSurfaceOps: async () => ({
        validateSource: ({ source }: Readonly<{ source: unknown }>) => ({ ok: true, source }),
        resolveLinkIdentity: (...args: unknown[]) => resolveLinkIdentityMock(...args),
    }),
    resolveExternalSessionSourceKeyOwner: async () => null,
}));

import { executeExternalSessionLinkEnsureAction } from './discoveryLinkActions';

describe('executeExternalSessionLinkEnsureAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readCredentialsMock.mockResolvedValue({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array([1]) },
        });
        resolveLinkIdentityMock.mockRejectedValue(new ExternalSessionProviderFailureError({
            code: 'source_invalid',
            message: 'codex_backend_mode_unsupported',
            operation: 'externalSession.resolveLinkIdentity',
        }));
        resolveExternalSessionSourceSurfaceMock.mockImplementation(async (_agentId, source) => ({
            ok: true,
            source,
            providerOps: {
                validateSource: ({ source }: Readonly<{ source: unknown }>) => ({ ok: true, source }),
                resolveLinkIdentity: (...args: unknown[]) => resolveLinkIdentityMock(...args),
            },
        }));
    });

    it('forwards unknown future Codex backend modes to the Codex leaf validator', async () => {
        const result = await executeExternalSessionLinkEnsureAction({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
            codexBackendMode: 'future-codex-mode',
            linkData: { projectId: 'project-b' },
        });

        expect(result.ok).toBe(false);
        expect(resolveLinkIdentityMock).toHaveBeenCalledWith(expect.objectContaining({
            source: { kind: 'codexHome', home: 'user' },
            remoteSessionId: 'remote-1',
            metadata: {
                linkData: {
                    projectId: 'project-b',
                    codexBackendMode: 'future-codex-mode',
                },
            },
        }));
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
});
