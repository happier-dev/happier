import { beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createScmCapabilities, ScmWorkingSnapshotSchema, type ScmHostingProviderRef } from '@happier-dev/protocol/scm';
import { mapProtocolSnapshotToUiSnapshot } from '@/scm/core/snapshotMappers';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

const { listProjectsForActions } = await import('./listProjects');

function workspaceRef(overrides: Partial<WorkspaceRefV1> = {}): WorkspaceRefV1 {
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
    refs: WorkspaceRefV1[];
    snapshotByRoot: Readonly<Record<string, { hostingProvider: ScmHostingProviderRef; repo: object }>>;
}>) {
    applyProjectAccountRowsFixture(storage, { workspaceRefs: input.refs });
    for (const [rootPath, { hostingProvider }] of Object.entries(input.snapshotByRoot)) {
        const snapshot = ScmWorkingSnapshotSchema.parse({
            projectKey: `machine-1:${rootPath}`, fetchedAt: 1,
            repo: { isRepo: true, rootPath, backendId: 'git', mode: '.git' },
            capabilities: createScmCapabilities(),
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0,
                includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        });
        storage.getState().updateWorkspaceScmSnapshot({ serverId: 'server-1', machineId: 'machine-1', rootPath },
            { ...mapProtocolSnapshotToUiSnapshot(snapshot, snapshot.projectKey), hostingProvider });
    }
}

function hostingProvider(overrides: Partial<ScmHostingProviderRef> = {}): ScmHostingProviderRef {
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
    beforeEach(() => {
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        storage.getState().activateProfileScope({ serverId: 'server-1', accountId: 'account-1' });
    });
    it('reports incomplete coverage instead of claiming an unavailable census is an empty complete registry', async () => {
        storage.setState({ projectAccountRows: null });
        expect(await listProjectsForActions({})).toEqual({ items: [], truncated: true, coverage: 'unknown' });
    });
    /**
     * The identity a launch joins on must carry the DEPLOYMENT. `id` is one
     * constant per forge plugin, so without it two Azure DevOps Server
     * deployments that both hold `DefaultCollection/api/web` are one identity
     * and a one-click launch lands in the wrong company's checkout.
     */
    it('reports the canonical deployment beside the provider id and repository', async () => {
        stateWith({
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
        stateWith({
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
        stateWith({
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

    it('does not revive retained identity disproven by an authoritative checkout observation', async () => {
        stateWith({ refs: [workspaceRef({ repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'old/repo' } })],
            snapshotByRoot: { '/repos/web': { hostingProvider: hostingProvider({ nameWithOwner: undefined }), repo: {} } } });
        expect((await listProjectsForActions({})).items[0]?.forge).toBeUndefined();
    });

    it('uses retained identity when the addressed checkout has never been observed', async () => {
        const repositoryIdentity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' };
        stateWith({ refs: [workspaceRef({ repositoryIdentity })], snapshotByRoot: {} });
        expect((await listProjectsForActions({})).items[0]?.forge).toEqual(repositoryIdentity);
    });

    /** An unusable base URL cannot produce a deployment, so it produces no identity. */
    it('reports no forge when the provider base URL cannot be read', async () => {
        stateWith({
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
