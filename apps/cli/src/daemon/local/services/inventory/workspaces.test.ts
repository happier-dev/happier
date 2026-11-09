import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import {
    readLocalServiceWorkspaceFacts,
    resolveLocalServiceWorkspaceFactsFromSessionMarkers,
} from './workspaces';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import * as persistence from '@/persistence';
import { createLocalServicesDaemonRuntime } from '../runtime';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';

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
        const refs = [
            acceptedRef,
            { ...acceptedRef, id: 'another-home', serverId: 'home-b', rootPath: '/repo/other-home' },
            { ...acceptedRef, id: 'another-machine', machineId: 'machine-b', rootPath: '/repo/other-machine' },
        ];
        const post = mockProjectAccountRowsHttpBoundary([
            ...refs.map(ref => createPlainProjectAccountRefRow(ref)),
            ...Array.from({ length: 1024 }, (_, index) => {
                const key = { kind: 'project-organization', serverId: 'home-a', projectKey: `unrelated-${index}` };
                return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
            }),
        ]);

        expect(await readLocalServiceWorkspaceFacts(input)).toEqual({
            facts: [{ id: acceptedRef.id, path: '/repo/app' }], acceptedWorkspaceRefs: [acceptedRef], diagnostics: [],
        });
        expect(post.mock.calls[0]?.[0]).toBe(`https://selected-home.example.test${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
        expect(post.mock.calls.map(([, body]) => body)).toEqual([{ kinds: ['workspace-ref'], serverId: 'home-a' }]);
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

    it('qualifies accepted portable Home roots through the saved daemon profile binding', async () => {
        // Saved profile reads are a persistence boundary; Home admission and row
        // opening remain real, as they are in the daemon startup path.
        const portableRef = { ...acceptedRef, serverId: 'srv_selected_home' };
        const profile = {
            id: 'saved-home', name: 'Selected Home', serverUrl: input.serverBaseUrl,
            webappUrl: input.serverBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        };
        const readSettings = vi.spyOn(persistence, 'readSettings').mockResolvedValue({
            schemaVersion: 6, onboardingCompleted: true,
            servers: { [profile.id]: { ...profile, homeConnectionDescriptor: {
                v: 1, homeServerIdentityId: portableRef.serverId,
                canonicalServerUrl: input.serverBaseUrl, revision: 1,
                endpoints: [{ kind: 'https', url: input.serverBaseUrl }],
            } } },
        });
        networkRows([
            portableRef,
            { ...portableRef, id: 'foreign-home', serverId: 'srv_other_home', rootPath: '/repo/foreign' },
            { ...portableRef, id: 'foreign-machine', machineId: 'machine-b', rootPath: '/repo/foreign-machine' },
        ]);

        expect(await readLocalServiceWorkspaceFacts({ ...input, serverId: profile.id })).toEqual({
            facts: [{ id: acceptedRef.id, path: '/repo/app' }],
            acceptedWorkspaceRefs: [portableRef], diagnostics: [],
        });

        readSettings.mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, servers: { [profile.id]: profile } });
        expect(await readLocalServiceWorkspaceFacts({ ...input, serverId: profile.id })).toEqual({
            facts: [], acceptedWorkspaceRefs: [], diagnostics: [],
        });
    });

    it('feeds all six manifest declarations from a portable Home acceptance with no Session markers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-accepted-services-'));
        const portableRef = { ...acceptedRef, rootPath: root, serverId: 'srv_selected_home' };
        const profile = { id: 'saved-home', name: 'Selected Home', serverUrl: input.serverBaseUrl,
            webappUrl: input.serverBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true,
            servers: { [profile.id]: { ...profile, homeConnectionDescriptor: { v: 1,
                homeServerIdentityId: portableRef.serverId, canonicalServerUrl: input.serverBaseUrl,
                revision: 1, endpoints: [{ kind: 'https', url: input.serverBaseUrl }] } } } });
        networkRows([portableRef]);
        const names = ['web', 'api', 'jobs', 'approval-digest-notifications', 'storybook', 'db'];
        await mkdir(join(root, '.happier'));
        await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
            services: Object.fromEntries(names.map(name => [name, { source: { kind: 'command', command: `run-${name}` } }])) }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: portableRef.machineId, startLoop: false,
            inventoryEnabled: () => true,
            workspaceFacts: () => readLocalServiceWorkspaceFacts({ ...input, serverId: profile.id }),
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
        });
        try {
            const snapshot = await runtime.launcherRoutes.getSnapshot({ scope: 'workspace', workspaceRoot: root });
            expect(snapshot.targets.map(target => target.declaration?.selection)).toEqual(expect.arrayContaining(
                names.map(name => ({ kind: 'manifest', name }))));
            expect(snapshot.targets).toHaveLength(6);
            expect(snapshot.targets.every(target => target.workspace?.serverId === portableRef.serverId)).toBe(true);
            expect(snapshot).not.toHaveProperty('sessionId');
        } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
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
