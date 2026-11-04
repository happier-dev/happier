import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMachineResourcesPolicyV1SnapshotFromMetadata } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol';
import { createLinuxVitalsFixture } from '../../vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from '../../vitals/readers/linux';
import { createMachineVitalsSampler } from '../../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../../vitals/history/minuteHistoryStore';
import { installLocalServiceCensusFixture } from '../../local/services/inventory/platform/censusFixture.testkit';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';

// OS memory, process/filesystem and CDP network boundaries only; admission,
// profiles, process settlement and view bindings execute their real owners.
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), totalmem: vi.fn() }));
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});
beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementation(fs.readFile);
    vi.mocked(readdir).mockImplementation(fs.readdir);
    vi.mocked(readlink).mockImplementation(fs.readlink);
    vi.mocked(totalmem).mockReturnValue(4 * 1024 ** 3);
});
afterEach(() => vi.clearAllMocks());

async function host(initialOverride: number | null = null,
    openPage = async () => ({ targetId: 'target', sessionId: 'cdp' }),
    dispatchPageCommand = async () => ({}),
    readMachineMemory: () => MachineVitalsSampleV1['memory'] | null = () => ({ reported: true,
        totalBytes: 4 * 1024 ** 3, availableBytes: 4 * 1024 ** 3, usedBytes: 0, pressure: { level: 'calm', source: 'none' } })) {
    let override = initialOverride;
    let failTransportDisposal = false;
    let deferredExit: (() => void) | undefined;
    const children: EventEmitter[] = [];
    const profiles = createBrowserProfileStore({ storageRootDirectory: '/unused/admission',
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: '/unused/admission' }),
        removeDirectory: async () => {},
    });
    const factory = createProductBrowserSidecarControlAdapterFactory({
        featureEnabled: true, profileStore: profiles,
        readMachineResourcesPolicy: () => readMachineResourcesPolicyV1SnapshotFromMetadata({
            metadata: { resourcesPolicyV1: { v: 1, processes: { browserMaxConcurrent: override } } },
            metadataVersion: 1, hasContentKey: true,
        }),
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            spawnProcess: () => {
                installLocalServiceCensusFixture([{ pid: 42, ppid: process.pid, command: ['chromium'] }]);
                const child = new EventEmitter();
                const stderr = new PassThrough();
                children.push(child);
                return Object.assign(child, { pid: 42, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                    kill: () => {
                        if (deferredExit) deferredExit();
                        else child.emit('exit', 0, 'SIGTERM');
                        return true;
                    } });
            },
            connectTransport: async () => ({ dispose: () => {
                if (failTransportDisposal) { failTransportDisposal = false; throw new Error('CDP connection cleanup failed'); }
            }, transport: { openPage,
                dispatchPageCommand, dispatchBrowserCommand: async () => ({ success: true }) } }),
        }),
    });
    const factoryInput = { machineId: 'machine', readMachineMemory };
    const runtime = await factory(factoryInput);
    if (!runtime.ok) throw new Error(runtime.disabledReason);
    const open = (session: string, viewId = 'view') => runtime.adapter.dispatchCommand({ kind: 'openView', commandId: `open_${session}_${viewId}`,
        browserSessionId: session, viewId, platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } });
    return { runtime, profiles, children, open, setOverride: (value: number | null) => { override = value; },
        deferProcessExit: () => new Promise<void>(resolve => { deferredExit = resolve; }),
        failNextTransportDisposal: () => { failTransportDisposal = true; } };
}

describe('browser session memory admission', () => {
    it('keeps one usable engine when memory is unreported and honors an explicit override', async () => {
        const h = await host(null, undefined, undefined, () => null);
        try {
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            expect(await h.open('second')).toMatchObject({ status: 'failed', error: { code: 'waiting_for_memory' } });
            h.setOverride(2);
            expect(await h.open('second')).toMatchObject({ status: 'dispatched' });
        } finally { await h.runtime.dispose?.(); }
    });

    it('uses the sampler effective cgroup total instead of physical host RAM', async () => {
        vi.mocked(totalmem).mockReturnValue(128 * 1024 ** 3);
        const fixture = await createLinuxVitalsFixture();
        await fixture.put('/proc/meminfo', 'MemTotal: 134217728 kB\nMemAvailable: 67108864 kB\n');
        await fixture.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
        await fixture.put('/sys/fs/cgroup/memory.max', String(8 * 1024 ** 3));
        await fixture.put('/sys/fs/cgroup/memory.current', String(1024 ** 3));
        await fixture.put('/sys/fs/cgroup/memory.stat', 'inactive_file 0\n');
        const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
            historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'history') }) });
        let h: Awaited<ReturnType<typeof host>> | undefined;
        try {
            await sampler.start();
            const sample = MachineVitalsSampleV1Schema.parse(sampler.latest());
            expect(sample.memory).toMatchObject({ reported: true, totalBytes: 8 * 1024 ** 3, limitSource: 'cgroup' });
            h = await host(null, undefined, undefined, () => sampler.latest()?.memory ?? null);
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            expect(await h.open('second')).toMatchObject({ status: 'dispatched' });
            expect(BrowserCommandDispatchResultV1Schema.parse(await h.open('third')))
                .toMatchObject({ status: 'failed', error: { code: 'waiting_for_memory', retryable: true } });
        } finally { await h?.runtime.dispose?.(); await sampler.stop(); await fixture.cleanup(); }
    });

    it('releases an engine with no usable views after a failed first open so a waiting session can recover', async () => {
        let failOpen = true;
        const h = await host(null, async () => {
            if (failOpen) { failOpen = false; throw new Error('CDP page creation failed'); }
            return { targetId: 'target', sessionId: 'cdp' };
        });
        try {
            expect(await h.open('failed')).toMatchObject({ status: 'failed', completion: 'unknown' });
            expect(await h.open('waiting')).toMatchObject({ status: 'dispatched' });
            expect(h.profiles.listProfiles()).toHaveLength(1);
        } finally { await h.runtime.dispose?.(); }
    });

    it('does not retire an empty engine while another view is still opening in that session', async () => {
        let resolvePage!: (value: { targetId: string; sessionId: string }) => void;
        const pendingPage = new Promise<{ targetId: string; sessionId: string }>(resolve => { resolvePage = resolve; });
        let opens = 0;
        const h = await host(null, async () => {
            if (++opens === 1) throw new Error('First CDP page creation failed');
            return pendingPage;
        });
        try {
            const failed = h.open('same', 'failed');
            const pending = h.open('same', 'pending');
            expect(await failed).toMatchObject({ status: 'failed' });
            expect(await h.open('waiting')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            resolvePage({ targetId: 'pending', sessionId: 'cdp' });
            expect(await pending).toMatchObject({ status: 'dispatched' });
            expect(h.runtime.adapter.listViews?.('same')).toHaveLength(1);
        } finally { resolvePage({ targetId: 'pending', sessionId: 'cdp' }); await h.runtime.dispose?.(); }
    });

    it.each([[4, 1], [8 - 1 / 1024 ** 3, 1], [8, 2], [12 - 1 / 1024 ** 3, 2], [12, 3], [16 - 1 / 1024 ** 3, 3], [16, 4], [128, 4]])(
        'admits up to the derived bound on %s GiB, including concurrent starts and existing-session views', async (ram, limit) => {
            const h = await host(null, undefined, undefined, () => ({ reported: true,
                totalBytes: ram * 1024 ** 3, availableBytes: ram * 1024 ** 3, usedBytes: 0,
                pressure: { level: 'calm', source: 'none' } }));
            try {
                const opened = await Promise.all(Array.from({ length: limit + 1 }, (_, i) => h.open(`session_${i}`)));
                expect(opened.slice(0, limit).every(result => result.status === 'dispatched')).toBe(true);
                expect(opened[limit]).toMatchObject({ status: 'failed', completion: 'known', error: { code: 'waiting_for_memory', retryable: true } });
                expect(await h.open('session_0', 'second')).toMatchObject({ status: 'dispatched' });
                const waiting = await h.open('waiting');
                expect(waiting).toMatchObject({ status: 'failed', completion: 'known', error: { code: 'waiting_for_memory', retryable: true } });
                expect(BrowserCommandDispatchResultV1Schema.safeParse(waiting).success).toBe(true);
                expect(h.children).toHaveLength(limit);
                expect(h.profiles.listProfiles()).toHaveLength(limit);
            } finally { await h.runtime.dispose?.(); }
        });

    it('retries waiting opens after the last view closes or a process exits, keeping other sessions intact', async () => {
        const h = await host();
        try {
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            expect(await h.open('waiting')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            expect(await h.runtime.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'first', viewId: 'view' }))
                .toMatchObject({ status: 'dispatched' });
            expect(await h.open('waiting')).toMatchObject({ status: 'dispatched' });
            h.children[1]!.emit('exit', 1, null);
            expect(await h.open('after_crash')).toMatchObject({ status: 'dispatched' });
            expect(h.profiles.listProfiles()).toHaveLength(1);
        } finally { await h.runtime.dispose?.(); }
    });

    it('keeps a stopping engine admitted until its actual exit, then allows a waiting session to retry', async () => {
        const h = await host();
        try {
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            const stopping = h.deferProcessExit();
            const close = h.runtime.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'first', viewId: 'view' });
            await stopping;
            expect(await h.open('waiting')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            h.children[0]!.emit('exit', 0, 'SIGTERM');
            expect(await close).toMatchObject({ status: 'dispatched' });
            expect(await h.open('waiting')).toMatchObject({ status: 'dispatched' });
        } finally {
            // The fixture deliberately delays OS exit; settle every owned child
            // before awaiting teardown, including on an assertion failure.
            const disposal = h.runtime.dispose?.();
            await Promise.resolve();
            for (const child of h.children) child.emit('exit', 0, 'SIGTERM');
            await disposal;
        }
    });

    it('retires the last-view engine after an already-issued navigation drains', async () => {
        let started!: () => void;
        const navigating = new Promise<void>(resolve => { started = resolve; });
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const h = await host(null, undefined, async () => { started(); await acknowledgement; return {}; });
        try {
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            const navigation = h.runtime.adapter.dispatchCommand({ kind: 'navigate', commandId: 'navigate',
                browserSessionId: 'first', viewId: 'view', url: 'https://example.test/next' });
            await navigating;
            expect(await h.runtime.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'first', viewId: 'view' }))
                .toMatchObject({ status: 'dispatched' });
            expect(await h.open('waiting')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            acknowledge();
            await navigation;
            expect(await h.open('waiting')).toMatchObject({ status: 'dispatched' });
        } finally { acknowledge(); await h.runtime.dispose?.(); }
    });

    it('applies custom overrides on the next open without stopping existing work and restores Auto', async () => {
        const h = await host(5);
        try {
            for (let i = 0; i < 5; i++) expect(await h.open(`session_${i}`)).toMatchObject({ status: 'dispatched' });
            expect(await h.open('waiting')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            h.setOverride(6);
            expect(await h.open('waiting')).toMatchObject({ status: 'dispatched' });
            h.setOverride(null);
            expect(await h.open('another')).toMatchObject({ error: { code: 'waiting_for_memory' } });
            expect(await h.open('session_0', 'second')).toMatchObject({ status: 'dispatched' });
            expect(h.children).toHaveLength(6);
        } finally { await h.runtime.dispose?.(); }
    });

    it('releases an exited engine even when CDP cleanup fails, while keeping that profile unusable', async () => {
        const h = await host();
        try {
            expect(await h.open('first')).toMatchObject({ status: 'dispatched' });
            h.failNextTransportDisposal();
            expect(await h.profiles.purgeForSessionDeleted({ sessionId: 'first' })).toMatchObject({ failedProfileIds: [expect.any(String)] });
            expect(await h.open('other')).toMatchObject({ status: 'dispatched' });
            expect(await h.open('first')).toMatchObject({ status: 'failed' });
            expect(h.children).toHaveLength(2);
            expect(h.profiles.listProfiles().find(profile => profile.owner.id === 'first')?.lifecycleState).toBe('unusable');
        } finally { await h.runtime.dispose?.(); }
    });
});
