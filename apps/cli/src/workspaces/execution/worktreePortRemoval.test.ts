import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { createWorktreePortsOwner } from './worktreePorts';
import { subscribeWorktreePortRemoval } from './worktreePortRemoval';
import { logger } from '@/ui/logger';

it.each([true, false])('releases the captured local root after deletion with Workspace association %s while retaining another Machine and sibling assignment', async associated => {
    const root = await mkdtemp(join(tmpdir(), 'happier-worktree-removal-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    const statePath = join(root, 'assignments.json');
    await Promise.all([mkdir(first), mkdir(second)]);
    const owner = createWorktreePortsOwner({ statePath });
    const broker = createStablePluginEventsBroker();
    const subscription = subscribeWorktreePortRemoval({ broker, portsOwner: owner,
        resolveCurrentMachineId: () => 'machine', isCurrent: () => true });
    let arrivals = 0;
    const observed = broker.subscribeHost({
        target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
        listener() { arrivals += 1; }, isCurrent: () => true,
    });
    try {
        expect(await owner.assign({ rootPath: first, slots: 2, listenerKeys: ['capture', 'otlp'] })).toMatchObject({ kind: 'ready' });
        expect(await owner.assign({ rootPath: second, slots: 2, listenerKeys: ['capture', 'otlp'] })).toMatchObject({ kind: 'ready' });
        const capturedRoot = await realpath(first);
        const before = JSON.parse(await readFile(statePath, 'utf8'));
        const removal = {
            workspace: associated ? { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: first } : null,
            project: null, machineId: 'machine', operationId: 'remove', worktreePath: capturedRoot,
            outcome: 'removed' as const, removalKind: 'deleted' as const,
        };
        broker.publishHostEventEnvelope({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' },
            payload: { kind: 'worktreeRemoved', serverId: 'home', occurredAt: 100,
                removal: { ...removal, machineId: 'other', workspace: removal.workspace ? { ...removal.workspace, machineId: 'other' } : null } } });
        await vi.waitFor(() => expect(arrivals).toBe(1));
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(before);
        await rm(first, { recursive: true });
        broker.publishHostEventEnvelope({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' },
            payload: { kind: 'worktreeRemoved', serverId: 'home', occurredAt: 100, removal } });
        await vi.waitFor(async () => {
            const after = JSON.parse(await readFile(statePath, 'utf8'));
            expect(after.assignments[capturedRoot]).toBeUndefined();
            expect(after.assignments[await realpath(second)]).toEqual(before.assignments[await realpath(second)]);
        });
    } finally {
        await observed.dispose();
        await subscription.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

it('preserves damaged assignment state and reports the release failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-worktree-removal-damaged-'));
    const statePath = join(root, 'assignments.json');
    const damaged = '{damaged';
    await writeFile(statePath, damaged);
    const broker = createStablePluginEventsBroker();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const subscription = subscribeWorktreePortRemoval({ broker, portsOwner: createWorktreePortsOwner({ statePath }),
        resolveCurrentMachineId: () => 'machine', isCurrent: () => true });
    try {
        broker.publishHostEventEnvelope({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' },
            payload: { kind: 'worktreeRemoved', serverId: 'home', occurredAt: 100, removal: {
                workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: root },
                project: null, machineId: 'machine', operationId: 'remove', worktreePath: root,
                outcome: 'removed', removalKind: 'deleted',
            } } });
        await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            code: expect.any(String), reason: expect.any(String),
        })));
        expect(await readFile(statePath, 'utf8')).toBe(damaged);
    } finally {
        warning.mockRestore();
        await subscription.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
