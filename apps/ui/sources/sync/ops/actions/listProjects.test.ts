import { describe, expect, it, vi } from 'vitest';

const storageState: { current: unknown } = { current: null };

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState.current,
        },
    });
});

const { listProjectsForActions } = await import('./listProjects');

function workspaceRef(overrides: Record<string, unknown> = {}) {
    return {
        id: 'workspace_1',
        serverId: 'server-1',
        machineId: 'machine-1',
        rootPath: '/repos/web',
        label: 'web',
        createdAtMs: 1,
        lastOpenedAtMs: 2,
        ...overrides,
    };
}

function stateWith(input: Readonly<{
    refs: readonly Record<string, unknown>[];
    snapshotByRoot: Readonly<Record<string, unknown>>;
}>) {
    return {
        settings: { workspaceRefsV1: input.refs },
        machines: { 'machine-1': { active: true } },
        getWorkspaceScmSnapshot: (scope: { rootPath: string }) => input.snapshotByRoot[scope.rootPath] ?? null,
    };
}

function hostingProvider(overrides: Record<string, unknown> = {}) {
    return {
        id: 'happier.scm.forge.azure-devops/azure-devops',
        kind: 'azure-devops',
        displayName: 'Azure DevOps',
        baseUrl: 'https://tfs-a.example.com/DefaultCollection',
        nameWithOwner: 'DefaultCollection/api/web',
        urlSafety: { allowedSchemes: ['https:'] },
        ...overrides,
    };
}

describe('projects.list forge identity', () => {
    /**
     * The identity a launch joins on must carry the DEPLOYMENT. `id` is one
     * constant per forge plugin, so without it two Azure DevOps Server
     * deployments that both hold `DefaultCollection/api/web` are one identity
     * and a one-click launch lands in the wrong company's checkout.
     */
    it('reports the canonical deployment beside the provider id and repository', async () => {
        storageState.current = stateWith({
            refs: [workspaceRef()],
            snapshotByRoot: { '/repos/web': { hostingProvider: hostingProvider(), repo: {} } },
        });

        const result = await listProjectsForActions({});

        expect(result.items[0]?.forge).toEqual({
            kind: 'azure-devops',
            deployment: 'https://tfs-a.example.com/DefaultCollection',
            repository: 'DefaultCollection/api/web',
        });
    });

    /**
     * Canonicalization is the incumbent owner's, not a second spelling rule:
     * the host and scheme fold, a trailing slash goes, and the base path — which
     * IS case-significant — survives verbatim.
     */
    it('canonicalizes the deployment through the incumbent SCM identity owner', async () => {
        storageState.current = stateWith({
            refs: [workspaceRef()],
            snapshotByRoot: {
                '/repos/web': {
                    hostingProvider: hostingProvider({
                        baseUrl: 'https://TFS-A.Example.com/DefaultCollection/',
                    }),
                    repo: {},
                },
            },
        });

        const result = await listProjectsForActions({});

        expect(result.items[0]?.forge?.deployment).toBe('https://tfs-a.example.com/DefaultCollection');
    });

    /** A provider that resolved no repository is no identity, not a deployment-wide one. */
    it('reports no forge when the snapshot resolved no repository name', async () => {
        storageState.current = stateWith({
            refs: [workspaceRef()],
            snapshotByRoot: {
                '/repos/web': {
                    hostingProvider: hostingProvider({ nameWithOwner: undefined }),
                    repo: {},
                },
            },
        });

        const result = await listProjectsForActions({});

        expect(result.items[0]?.forge).toBeUndefined();
    });

    /** An unusable base URL cannot produce a deployment, so it produces no identity. */
    it('reports no forge when the provider base URL cannot be read', async () => {
        storageState.current = stateWith({
            refs: [workspaceRef()],
            snapshotByRoot: {
                '/repos/web': {
                    hostingProvider: hostingProvider({ baseUrl: 'not a url' }),
                    repo: {},
                },
            },
        });

        const result = await listProjectsForActions({});

        expect(result.items[0]?.forge).toBeUndefined();
    });
});
