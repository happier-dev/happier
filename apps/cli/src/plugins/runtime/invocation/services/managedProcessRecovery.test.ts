import { describe, expect, it, vi } from 'vitest';

import { createManagedServiceProcessSupervisorHost, type ManagedServiceProcessHandle } from './managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from './exec';
import { readProcessRunState } from '@/daemon/processRunState';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createManagedServiceDurabilityOwner, observeManagedServiceProcessStartIdentity } from './managedServiceDurability';

const observedProcFiles = vi.hoisted(() => [] as string[]);
// Observe the real procfs boundary; retain the actual census and lifecycle logic.
vi.mock('node:fs/promises', async importOriginal => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, open: (...args: Parameters<typeof original.open>) => {
        observedProcFiles.push(String(args[0]));
        return original.open(...args);
    } };
});

async function launchProjectProcess(options: Parameters<typeof createManagedServiceProcessSupervisorHost>[0] = {}) {
    const host = createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon', ...options });
    const root = process.cwd();
    const handle = await host.bind({ kind: 'project', isOccurrenceCurrent: () => true }).supervise({
        id: 'recovered-project', mode: { kind: 'managedSpawn', endpointNone: true },
        watchdog: { intervalMs: 5_000, missedIntervals: 2 },
        authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
            signal, assertCurrent() {},
            projectLaunch: { status: 'ready', reviewedEffectDigest: 'recovery-fixture', toolchain: {
                selection: { kind: 'host' }, root, platform: process.platform,
                io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
            } },
            launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root,
                env: { PROJECT_RECOVERY_PRIVATE: 'private-recovery-value' }, release() {} },
        }),
    });
    return { host, handle };
}

describe('Project process recovery at the process supervisor', () => {
    it.skipIf(process.platform !== 'linux')('shares the one launch birth observation with durable process custody', async () => {
        await withTempDir('project-process-birth-', async rootDir => {
            observedProcFiles.length = 0;
            const { handle } = await launchProjectProcess({
                durability: createManagedServiceDurabilityOwner({ rootDir }),
                captureProcessStartIdentity: observeManagedServiceProcessStartIdentity,
            });
            try {
                expect(observedProcFiles.filter(path => path === `/proc/${handle.snapshot().pid}/stat`)).toHaveLength(1);
            } finally { await handle.stop(); }
        });
    });

    it('retains the launch birth witness and re-adopts a live process with working Stop and observers', async () => {
        const { host, handle } = await launchProjectProcess();
        let recovered: ManagedServiceProcessHandle | undefined;
        try {
            observedProcFiles.length = 0;
            const record = await host.captureProjectProcess(handle);
            expect(record).not.toBeNull();
            if (!record) throw new Error('Missing project process recovery witness');
            expect(record.process).toMatchObject({ pid: handle.snapshot().pid,
                start: { startTimeMs: expect.any(Number) } });
            expect(JSON.stringify(record)).not.toContain('private-recovery-value');
            expect(record.snapshot).not.toHaveProperty('diagnostics');
            // Persistence consumes the launch observation instead of sampling a later PID.
            expect(observedProcFiles).toEqual([]);
            recovered = await createManagedServiceProcessSupervisorHost({}).restoreProjectProcess(record);
            expect(recovered.snapshot()).toMatchObject({ ...record.snapshot, state: 'running' });
            const statPath = `/proc/${record.process.pid}/stat`;
            if (process.platform === 'linux') expect(observedProcFiles.filter(path => path === statPath)).toHaveLength(1);
            const restoreObservations = observedProcFiles.length;
            for (let read = 0; read < 100; read++) {
                expect(recovered.snapshot().state).toBe('running');
                recovered.observeHealth!(() => {}).dispose();
            }
            expect(observedProcFiles).toHaveLength(restoreObservations);
            const states: string[] = [];
            const healthStates: string[] = [];
            recovered.observe!(snapshot => states.push(snapshot.state));
            recovered.observeHealth!(snapshot => healthStates.push(snapshot.state));
            expect((await recovered.inspectCurrentOccurrence!()).state).toBe('running');
            await expect(recovered.stop()).resolves.toEqual({ status: 'stopped' });
            expect(recovered.snapshot()).toMatchObject({ state: 'stopped', baseUrl: null, port: null, pid: null });
            expect(states).toEqual(['running', 'stopped']);
            expect(healthStates).toEqual(['running', 'stopped']);
            const stoppedObservations = observedProcFiles.length;
            await expect(recovered.stop()).resolves.toEqual({ status: 'stopped' });
            expect(observedProcFiles).toHaveLength(stoppedObservations);
            await expect(recovered.waitUntilHealthy()).rejects.toMatchObject({ code: 'plugin_managed_server_stopped' });
        } finally {
            await recovered?.dispose();
            await handle.stop();
        }
    });

    it.each(['before recovery', 'after recovery'] as const)('settles a process that vanished %s and makes repeated Stop harmless', async when => {
        const { host, handle } = await launchProjectProcess();
        try {
            const record = await host.captureProjectProcess(handle);
            if (!record) throw new Error('Missing project process recovery witness');
            if (when === 'before recovery') await handle.stop();
            const recovered = await host.restoreProjectProcess(record);
            if (when === 'after recovery') {
                expect(recovered.snapshot().state).toBe('running');
                await handle.stop();
                await expect(recovered.stop()).resolves.toEqual({ status: 'stopped' });
            }
            expect(recovered.snapshot()).toMatchObject({ state: 'stopped', baseUrl: null, port: null, pid: null,
                instanceId: record.snapshot.instanceId, startedAtMs: record.snapshot.startedAtMs });
            await expect(recovered.stop()).resolves.toEqual({ status: 'stopped' });
            await expect(recovered.dispose()).resolves.toBeUndefined();
            expect(await host.captureProjectProcess(recovered)).toEqual(record);
        } finally {
            await handle.stop();
        }
    });

    it('never signals a reused PID when its retained birth differs', async () => {
        const { host, handle } = await launchProjectProcess();
        try {
            const record = await host.captureProjectProcess(handle);
            if (!record) throw new Error('Missing project process recovery witness');
            const reused = { ...record, process: { ...record.process,
                start: { ...record.process.start, startTimeMs: record.process.start.startTimeMs + 1 } } };
            const recovered = await host.restoreProjectProcess(reused);
            expect(recovered.snapshot()).toMatchObject({ state: 'stopped', pid: null });
            await expect(recovered.stop()).resolves.toEqual({ status: 'stopped' });
            await recovered.dispose();
            await expect(readProcessRunState(record.process.pid)).resolves.toBe('servable');
            expect((await handle.inspectCurrentOccurrence!()).state).toBe('running');
            expect(await host.captureProjectProcess(handle)).toEqual(record);
        } finally {
            await handle.stop();
        }
    });

    it('does not manufacture recovery custody for external attachment', async () => {
        const host = createManagedServiceProcessSupervisorHost({});
        const handle = await host.bind({ kind: 'project', isOccurrenceCurrent: () => true }).supervise({
            id: 'external', mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152' },
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
        });
        try { expect(await host.captureProjectProcess(handle)).toBeNull(); }
        finally { await handle.dispose(); }
    });
});
