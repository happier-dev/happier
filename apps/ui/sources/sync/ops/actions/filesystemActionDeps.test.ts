import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionIdsV1';
import { createUiFilesystemAction } from './filesystemActionDeps';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';

const transport = vi.hoisted(() => vi.fn<(_input: unknown) => Promise<unknown>>(async () => ({ success: false, error: 'Destination already exists' })));
// Machine RPC is the genuine cross-process boundary; Action admission remains real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({ callGuardedMachineRpcWithPolicy: transport }));

// The host fixture uses canonical Account policy waivers for these transport
// effects. The executor still validates authority, schemas and targets.
const context = { surface: 'ui', authority: 'present_user', actionsSettings: normalizeActionsSettingsV1({ v: 1,
    approvalWaivedSurfaces: Object.fromEntries(['daemon.filesystem.rename', 'daemon.filesystem.createDirectory', 'daemon.filesystem.download', 'daemon.filesystem.copy', 'daemon.filesystem.writeFile']
        .map(actionId => [actionId, ['ui']])),
}) } as const;

describe('UI filesystem Action transport', () => {
    it('refuses an unsupported Session carrier without borrowing the host Account RPC', async () => {
        transport.mockClear();
        const actionId = FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        const result = await executor.execute(actionId, { path: '/repo' }, {
            surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'account',
            actionRequestId: 'session-browser-read', actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
            rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session' },
            externalActionTarget: { kind: 'machine', machineId: 'machine' },
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }),
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('acknowledges only successful saved bytes on the admitted Account, including mounted byte delivery', async ({ onTestFinished }) => {
        const writes: Array<string | null> = [];
        const target = { serverId: 'home', accountId: 'account', machineId: 'machine', rootPath: '/repo' };
        const dispose = subscribeAcknowledgedWorkspaceFileWrites(target, 'file.txt', write => { writes.push(write.hash); });
        onTestFinished(dispose);
        const input = { rootPath: '/repo', path: '/repo/file.txt', content: 'bmV3' };
        const invocation = { ...context, serverId: 'home', runtimeAccountId: 'account',
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        transport.mockResolvedValueOnce({ success: true, hash: 'a'.repeat(64) })
            .mockResolvedValueOnce({ success: false, error: 'Changed', errorCode: 'hash_mismatch' });
        expect(await executor.execute('daemon.filesystem.writeFile', input, invocation)).toMatchObject({ ok: true, result: { success: true } });
        expect(writes).toEqual(['a'.repeat(64)]);
        await executor.execute('daemon.filesystem.writeFile', input, invocation);
        expect(writes).toEqual(['a'.repeat(64)]);
        const controller = new AbortController();
        const delivered = createUiFilesystemAction(undefined, { actionId: 'daemon.filesystem.writeFile', signal: controller.signal,
            execute: async () => ({ success: true, hash: 'b'.repeat(64) }) });
        await delivered({ actionId: 'daemon.filesystem.writeFile', input,
            context: { ...invocation, signal: controller.signal } });
        expect(writes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    });
    it('preserves the addressed Home, machine, root and explicit conflict choice', async () => {
        const input = { rootPath: '/repo', from: 'a', to: 'b', overwrite: false };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), input, {
            serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
            ...context,
        })).toEqual({ ok: true, result: { success: false, error: 'Destination already exists' } });
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home', accountId: 'account', machineId: 'machine',
            method: 'daemon.filesystem.rename', payload: input }));
    });
    it('does not infer a machine target from the ambient session', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.createDirectory'), { rootPath: '/repo', path: 'folder' }, {
            ...context, serverId: 'home', defaultSessionId: 'ambient',
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('refuses a generic transfer without concrete byte custody before preparing', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.download'), {
            rootPath: '/repo', path: 'binary', destination: { destinationId: 'arbitrary' }, asZip: false,
        }, { ...context, externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
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
        }, { ...context, serverId: 'home', runtimeAccountId: 'account',
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
        }, { ...context, serverId: 'home', runtimeAccountId: 'account',
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });
});
