import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { mockProjectAccountRowsHttpBoundary } from '../projectAccountRows.testkit';

describe('preparation accepted workspace association', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        withdrawActiveProjectAccountRowsSnapshot();
    });
    const address = { serverId: 'home', workspaceId: 'accepted', machineId: 'teammate', rootPath: '/repo' };
    const workspace = { id: 'accepted', serverId: 'home', machineId: 'teammate', rootPath: '/repo', createdAtMs: 1, projectKey: 'stable-project' };
    const input = { address, credentials: { token: 'requester', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://requester.example' };

    it('keeps ordinary roots usable on a predecessor Home without treating failed Project reads as empty', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
        const launch = { ...input, address: { serverId: 'home', machineId: 'teammate', rootPath: '/ordinary-folder' },
            allowUnassociated: true as const };
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).resolves.toBeNull();
        await expect(resolveProjectSetupAcceptedWorkspace(input)).rejects.toMatchObject({ code: 'project_account_rows_unsupported' });
        post.mockResolvedValue({ status: 403, data: { error: 'forbidden' } });
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).rejects.toMatchObject({ code: 'forbidden', response: { status: 403 } });
        post.mockResolvedValue({ status: 500, data: { error: 'internal' } });
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).rejects.toMatchObject({ code: 'internal', response: { status: 500 } });
    });

    it('distinguishes an unassociated cold launch root from unavailable Account rows', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200,
            data: { status: 'listed', coverage: 'complete', rows: [] } });
        const launch = { ...input, address: { serverId: 'home', machineId: 'teammate', rootPath: '/ordinary-folder' },
            allowUnassociated: true as const };
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).resolves.toBeNull();
        const transportFailure = Object.assign(new Error('Home transport unavailable'), { code: 'ECONNREFUSED' });
        post.mockRejectedValue(transportFailure);
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).rejects.toBe(transportFailure);
    });

    it('keeps cancellation authoritative when an unsupported cold-root read settles after abort', async () => {
        const controller = new AbortController();
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            controller.abort();
            return { status: 404, data: { error: 'not_found' } };
        });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input,
            address: { serverId: 'home', machineId: 'teammate', rootPath: '/ordinary-folder' },
            allowUnassociated: true, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('resolves an explicitly selected self Project without activating an ordinary cold root', async () => {
        const key = { kind: 'workspace-ref', serverId: 'home', id: 'ordinary-workspace' };
        mockProjectAccountRowsHttpBoundary([{
            key, revision: 1, content: { t: 'plain', v: { key, value: {
                id: key.id, serverId: 'home', machineId: 'teammate', rootPath: '/ordinary-folder', createdAtMs: 1,
            } } },
        }]);
        const launch = { ...input, address: { serverId: 'home', machineId: 'teammate', rootPath: '/ordinary-folder' },
            allowUnassociated: true as const };
        await expect(resolveProjectSetupAcceptedWorkspace(launch)).resolves.toBeNull();
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input, address: { ...launch.address, workspaceId: key.id } }))
            .resolves.toMatchObject({ workspace: { id: key.id }, project: { serverId: 'home', projectId: key.id } });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...launch, allowProjectless: true })).resolves.toMatchObject({
            workspace: { id: key.id, rootPath: '/ordinary-folder' }, project: null,
        });
    });

    it('uses the requester Home row and refuses a caller-swapped Machine or directory', async () => {
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'accepted' };
        const rows: unknown[] = [{ key, revision: 1, content: { t: 'plain', v: { key, value: workspace } } }];
        const post = mockProjectAccountRowsHttpBoundary(rows);
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            expect(url).toBe('https://requester.example/v1/account/encryption');
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        const transport = post.getMockImplementation()!;
        post.mockImplementation(async (...args) => {
            const [url, body, options] = args;
            expect(url).toBe('https://requester.example/v1/account/project-rows/read');
            expect(body).toEqual({ key });
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            return await transport(...args);
        });
        expect(await resolveProjectSetupAcceptedWorkspace(input)).toEqual({ workspace, project: { serverId: 'home', projectId: 'stable-project' } });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input, address: { ...address, machineId: 'custodian' } })).rejects.toMatchObject({ code: 'project_workspace_changed' });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...input, address: { ...address, rootPath: '/elsewhere' } })).rejects.toMatchObject({ code: 'project_workspace_changed' });
        rows[0] = { key, revision: 2, content: null };
        await expect(resolveProjectSetupAcceptedWorkspace(input)).rejects.toMatchObject({ code: 'project_workspace_unavailable' });
    });

    it('accepts equivalent target-platform root spellings without changing the accepted checkout', async () => {
        const windowsWorkspace = { ...workspace, rootPath: 'C:\\Users\\alice\\repo' };
        const key = { kind: 'workspace-ref', serverId: 'home', id: 'accepted' };
        mockProjectAccountRowsHttpBoundary([
            { key, revision: 1, content: { t: 'plain', v: { key, value: windowsWorkspace } } },
        ]);

        await expect(resolveProjectSetupAcceptedWorkspace({
            ...input, address: { ...address, rootPath: 'c:/Users/alice/repo/' },
        })).resolves.toEqual({ workspace: windowsWorkspace, project: { serverId: 'home', projectId: 'stable-project' } });
    });
});
