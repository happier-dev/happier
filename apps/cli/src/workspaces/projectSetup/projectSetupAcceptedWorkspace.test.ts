import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';

describe('preparation accepted workspace association', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        withdrawActiveProjectAccountRowsSnapshot();
    });
    const address = { serverId: 'home', workspaceId: 'accepted', machineId: 'teammate', rootPath: '/repo' };
    const workspace = { id: 'accepted', serverId: 'home', machineId: 'teammate', rootPath: '/repo', createdAtMs: 1, projectKey: 'stable-project' };
    const input = { address, credentials: { token: 'requester', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://requester.example' };

    it('uses the requester Home row and refuses a caller-swapped Machine or directory', async () => {
        vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
            expect(url).toBe('https://requester.example/v1/account/encryption');
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, options) => {
            expect(url).toBe('https://requester.example/v1/account/project-rows/list');
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            const key = { kind: 'workspace-ref', serverId: 'home', id: 'accepted' };
            return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 1, content: { t: 'plain', v: { key, value: workspace } } }] } };
        });
        expect(await resolveProjectSetupAcceptedWorkspace(input)).toEqual({ workspace, project: { serverId: 'home', projectId: 'stable-project' } });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input, address: { ...address, machineId: 'custodian' } })).rejects.toMatchObject({ code: 'project_workspace_changed' });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input, address: { ...address, rootPath: '/elsewhere' } })).rejects.toMatchObject({ code: 'project_workspace_changed' });
        // The reserved-row owner retains deletion tombstones. A later complete
        // census represents this deletion with a newer revision, not omission.
        post.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key: { kind: 'workspace-ref', serverId: 'home', id: 'accepted' }, revision: 2, content: null }] } });
        await expect(resolveProjectSetupAcceptedWorkspace(input)).rejects.toMatchObject({ code: 'project_workspace_unavailable' });
    });

    it('accepts equivalent target-platform root spellings without changing the accepted checkout', async () => {
        const windowsWorkspace = { ...workspace, rootPath: 'C:\\Users\\alice\\repo' };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const key = { kind: 'workspace-ref', serverId: 'home', id: 'accepted' };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
            { key, revision: 1, content: { t: 'plain', v: { key, value: windowsWorkspace } } },
        ] } });

        await expect(resolveProjectSetupAcceptedWorkspace({
            ...input, address: { ...address, rootPath: 'c:/Users/alice/repo/' },
        })).resolves.toEqual({ workspace: windowsWorkspace, project: { serverId: 'home', projectId: 'stable-project' } });
    });
});
