import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import {
    readLocalServiceWorkspaceFacts,
    resolveLocalServiceWorkspaceFactsFromSessionMarkers,
} from './workspaces';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

afterEach(() => {
    vi.restoreAllMocks();
    withdrawActiveProjectAccountRowsSnapshot();
});

describe('resolveLocalServiceWorkspaceFactsFromSessionMarkers', () => {
    it('collects deduped absolute workspace roots from daemon-owned session marker facts', () => {
        const facts = resolveLocalServiceWorkspaceFactsFromSessionMarkers([
            { happySessionId: 'session-a', cwd: ' /repo/app ' },
            { happySessionId: 'session-b', metadata: { path: '/repo/app' } },
            { happySessionId: 'session-c', metadata: { path: '' } },
            { happySessionId: 'session-d', cwd: 'relative/path' },
        ]);

        expect(facts).toEqual([{ path: '/repo/app' }]);
    });

    it('collapses an agent marker path onto the current daemon workspace root', () => {
        const facts = resolveLocalServiceWorkspaceFactsFromSessionMarkers([
            {
                happySessionId: 'session-sandboxed',
                cwd: '/home/coder/project',
                metadata: {
                    path: '/home/coder/project',
                    sessionWorkspaceLocationV1: {
                        v: 1,
                        machineId: 'machine-local',
                        agentPath: '/home/coder/project',
                        machinePath: '/Users/alice/project',
                    },
                },
                respawn: { directory: '/Users/alice/project' },
            },
        ], 'machine-local');

        expect(facts).toEqual([{ path: '/Users/alice/project' }]);
    });
});

describe('readLocalServiceWorkspaceFacts', () => {
    const credentials = { token: 'project-token', encryption: null };
    const acceptedRef = {
        id: 'accepted-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/app/', createdAtMs: 1,
    } satisfies WorkspaceRefV1;
    const input = {
        credentials, serverId: 'home-a', serverBaseUrl: 'https://selected-home.example.test', machineId: 'machine-a', markers: [],
    } as const;

    function networkRows(refs: readonly WorkspaceRefV1[]) {
        // Only HTTP is substituted. Account mode, row opening/binding, publication and
        // Local Services workspace projection all remain their production owners.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
        return vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
            status: 'listed', coverage: 'complete', rows: refs.map(ref => {
                const key = { kind: 'workspace-ref', serverId: ref.serverId, id: ref.id };
                return { key, revision: 0, content: { t: 'plain', v: { key, value: ref } } };
            }),
        } });
    }

    it('discovers accepted roots without Sessions and excludes other Homes and Machines', async () => {
        const post = networkRows([
            acceptedRef,
            { ...acceptedRef, id: 'another-home', serverId: 'home-b', rootPath: '/repo/other-home' },
            { ...acceptedRef, id: 'another-machine', machineId: 'machine-b', rootPath: '/repo/other-machine' },
        ]);

        expect(await readLocalServiceWorkspaceFacts(input)).toEqual({
            facts: [{ id: acceptedRef.id, path: '/repo/app' }], acceptedWorkspaceRefs: [acceptedRef], diagnostics: [],
        });
        expect(post.mock.calls[0]?.[0]).toBe(`https://selected-home.example.test${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
        expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toBe('https://selected-home.example.test/v1/account/encryption');
    });

    it('keeps accepted identity when a Session shares that root while retaining Session-only roots', async () => {
        networkRows([acceptedRef]);

        expect(await readLocalServiceWorkspaceFacts({
            ...input,
            markers: [{ happySessionId: 'session-a', cwd: '/repo/app' }, { happySessionId: 'session-b', cwd: '/repo/session-only' }],
        })).toEqual({
            facts: [{ id: acceptedRef.id, path: '/repo/app' }, { path: '/repo/session-only' }], acceptedWorkspaceRefs: [acceptedRef], diagnostics: [],
        });
    });

    it('reports a failed accepted-row read without reusing previously opened Project roots', async () => {
        const post = networkRows([acceptedRef]);
        expect((await readLocalServiceWorkspaceFacts(input)).facts).toEqual([{ id: acceptedRef.id, path: '/repo/app' }]);
        post.mockRejectedValue(new Error('network unavailable'));

        expect(await readLocalServiceWorkspaceFacts({
            ...input, markers: [{ happySessionId: 'session-a', cwd: '/repo/session-only' }],
        })).toEqual({
            facts: [{ path: '/repo/session-only' }],
            acceptedWorkspaceRefs: [],
            diagnostics: [{ code: 'local_services_accepted_workspaces_unavailable', severity: 'warning', message: 'project_account_rows_unavailable' }],
        });

        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
        expect(await readLocalServiceWorkspaceFacts(input)).toEqual({
            facts: [], acceptedWorkspaceRefs: [],
            diagnostics: [{ code: 'local_services_accepted_workspaces_unavailable', severity: 'warning', message: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' }],
        });
    });
});
