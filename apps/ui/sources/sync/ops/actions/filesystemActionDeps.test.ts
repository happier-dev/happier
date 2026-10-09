import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createUiFilesystemAction } from './filesystemActionDeps';
import { workspaceRenamePath, workspaceDeletePath } from '../workspaceFileSystem/pathMetadataMutations';
import { workspaceCreateDirectory } from '../workspaceFileSystem/directoryBrowsing';

const transport = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ success: false, error: 'Destination already exists' })));
// Machine RPC is the genuine cross-process boundary; Action admission remains real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({ callGuardedMachineRpcWithPolicy: transport }));

describe('UI filesystem Action transport', () => {
    it('preserves the addressed Home, machine, root and explicit conflict choice', async () => {
        const input = { rootPath: '/repo', from: 'a', to: 'b', overwrite: false };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), input, {
            serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
            surface: 'ui', authority: 'present_user',
        })).toEqual({ ok: true, result: { success: false, error: 'Destination already exists' } });
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home', accountId: 'account', machineId: 'machine',
            method: 'daemon.filesystem.rename', payload: input }));
    });
    it('routes live workspace callbacks through rooted semantic Actions', async () => {
        const target = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        await workspaceRenamePath(target, { from: 'a', to: 'b' });
        await workspaceDeletePath(target, { path: 'a' });
        await workspaceCreateDirectory(target, 'folder');
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.rename', payload: { rootPath: '/repo', from: '/repo/a', to: '/repo/b', overwrite: false } }));
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.delete', payload: { rootPath: '/repo', path: '/repo/a', recursive: false } }));
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.createDirectory', payload: { rootPath: '/repo', path: '/repo/folder' } }));
    });
    it('does not infer a machine target from the ambient session', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.createDirectory'), { rootPath: '/repo', path: 'folder' }, {
            surface: 'ui', authority: 'present_user', serverId: 'home', defaultSessionId: 'ambient',
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('addresses the literal selected tilde directory rather than the machine home', async () => {
        transport.mockClear();
        const target = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        await workspaceRenamePath(target, { from: '~/line\nbreak ', to: '~/renamed ' });
        await workspaceDeletePath(target, { path: '~/line\nbreak ' });
        await workspaceCreateDirectory(target, '~');
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.rename', payload: {
            rootPath: '/repo', from: '/repo/~/line\nbreak ', to: '/repo/~/renamed ', overwrite: false,
        } }));
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.delete', payload: {
            rootPath: '/repo', path: '/repo/~/line\nbreak ', recursive: false,
        } }));
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.filesystem.createDirectory', payload: {
            rootPath: '/repo', path: '/repo/~',
        } }));
    });
    it('refuses a generic transfer without concrete byte custody before preparing', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.download'), {
            rootPath: '/repo', path: 'binary', destination: { destinationId: 'arbitrary' }, asZip: false,
        }, { surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('rejects a cross-target copy whose destination differs from the admitted Action address', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute('daemon.filesystem.copy', { kind: 'target_copy',
            source: { serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'file' },
            destination: { serverId: 'other-home', machineId: 'other', rootPath: '/destination', path: 'copy' },
            overwrite: false, recursive: false,
        }, { serverId: 'home', runtimeAccountId: 'account', surface: 'ui', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('refuses to acquire cross-target bytes without a captured destination Account', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute('daemon.filesystem.copy', { kind: 'target_copy',
            source: { serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'file' },
            destination: { serverId: 'home', machineId: 'machine', rootPath: '/destination', path: 'copy' },
            overwrite: false, recursive: false,
        }, { serverId: 'home', runtimeAccountId: 'account', surface: 'ui', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });
});
