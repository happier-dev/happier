import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
// Select the canonical procfs fixture before a browser import creates the census singleton.
import { localServiceProcfsFixture, installLocalServiceCensusFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { createProductBrowserSidecarControlAdapterFactory } from '@/daemon/browser/sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '@/daemon/browser/sidecar/launchOwner';
import { createBrowserProfileStore } from '@/daemon/browser/profiles/store';
import { createBrowserStoragePartitionOwner } from '@/daemon/browser/storage/partitions';
import { createTerminateDetectedService } from '@/daemon/local/services/actions/terminate';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '@/daemon/local/services/inventory/scanner';
import { createProcessTreeTerminator } from '@/processes/terminate/terminateProcessTree';
import { readLinuxCensus } from '@/processes/census/linux';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess } from '@/terminal/pty/provider';
import { createProcessActionOwnerAdapters } from './processActionOwnerAdapters';

// Only OS filesystem reads used by the browser's native birth observation are replaced.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

describe('Process Actions through retained lifecycle owners', () => {
    it('retains browser storage on automatic stop, purges it on explicit Process stop, and reopens the original target', async () => {
        const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const directory = await fs.mkdtemp(join(tmpdir(), 'happier-browser-process-purge-'));
        installLocalServiceCensusFixture([{ pid: 42, ppid: process.pid, command: ['chromium'] }]);
        class NativeProcess extends EventEmitter {
            pid = 42;
            stderr = new PassThrough();
            stdio = [null, null, this.stderr, new PassThrough(), new PassThrough()];
            kill() { queueMicrotask(() => this.emit('exit', 0, 'SIGTERM')); return true; }
        }
        const partitions = createBrowserStoragePartitionOwner({ storageRootDirectory: directory });
        const profileStore = createBrowserProfileStore({ storageRootDirectory: directory, partitionOwner: partitions });
        const factory = createProductBrowserSidecarControlAdapterFactory({ platform: 'linux', profileStore,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                spawnProcess: () => { const child = new NativeProcess();
                    return child; },
                connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'page', sessionId: 'cdp' }),
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }) } }),
            }) });
        const browser = await factory({ machineId: 'machine', readMachineMemory: () => ({ reported: true,
            totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedBytes: 0,
            pressure: { level: 'calm', source: 'none' } }) });
        if (!browser.ok) throw new Error(browser.disabledReason);
        try {
            const originalOpen = { kind: 'openView', commandId: 'original-open', browserSessionId: 'session',
                viewId: 'view', platform: 'web', focus: true,
                target: { kind: 'externalUrl', targetId: 'original-target', url: 'https://example.test/original' } } as const;
            expect(await browser.adapter.dispatchCommand(originalOpen)).toMatchObject({ status: 'dispatched' });
            expect(await browser.adapter.dispatchCommand({ ...originalOpen, browserSessionId: 'other', commandId: 'other-open' }))
                .toMatchObject({ status: 'dispatched' });
            const markers = new Map<string, { profile: string; partition: string }>();
            for (const profile of profileStore.listProfiles()) {
                const partition = partitions.register({ profileId: profile.profileId, originKey: 'https://example.test',
                    targetKind: 'externalUrl', persistence: 'ephemeral', createdAt: 0, updatedAt: 0 });
                const profileDirectory = profileStore.resolveProfileDirectory(profile.profileId);
                const partitionDirectory = partitions.resolvePartitionDirectory(partition.partitionId);
                await fs.mkdir(profileDirectory, { recursive: true });
                await fs.mkdir(partitionDirectory, { recursive: true });
                const paths = { profile: join(profileDirectory, 'cookie-marker'), partition: join(partitionDirectory, 'storage-marker') };
                await fs.writeFile(paths.profile, profile.owner.id);
                await fs.writeFile(paths.partition, profile.owner.id);
                markers.set(profile.owner.id, paths);
            }
            const originalMarkers = markers.get('session')!;
            const otherMarkers = markers.get('other')!;
            profileStore.register({ profileId: 'separate_session_profile', storageMode: 'session',
                owner: { kind: 'session', id: 'session' } });
            const separateDirectory = profileStore.resolveProfileDirectory('separate_session_profile');
            await fs.mkdir(separateDirectory, { recursive: true });
            const separateMarker = join(separateDirectory, 'separate-marker');
            await fs.writeFile(separateMarker, 'same Session, separate profile');
            const target = browser.readResourceTargets?.()[0];
            if (!target) throw new Error('Browser root missing');
            // Guard consumes this native stop directly, without Process Action capture.
            await target.root.stop?.();
            expect(await fs.readFile(originalMarkers.profile, 'utf8')).toBe('session');
            expect(await fs.readFile(originalMarkers.partition, 'utf8')).toBe('session');
            expect(await browser.adapter.dispatchCommand(originalOpen)).toMatchObject({ status: 'dispatched' });
            const explicitTarget = browser.readResourceTargets?.().find(item => item.ownerRef === 'session');
            if (!explicitTarget) throw new Error('Reopened browser root missing');
            const actions = createProcessActionOwnerAdapters({ readBrowsers: browser.readResourceTargets,
                getBrowserAdapter: () => browser.adapter });
            const retainedRoot = actions.captureBrowserRoot(explicitTarget);
            await actions.stopOwner(retainedRoot, {});
            await expect(fs.stat(originalMarkers.profile)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(fs.stat(originalMarkers.partition)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await fs.readFile(otherMarkers.profile, 'utf8')).toBe('other');
            expect(await fs.readFile(otherMarkers.partition, 'utf8')).toBe('other');
            expect(await fs.readFile(separateMarker, 'utf8')).toBe('same Session, separate profile');
            expect(browser.adapter.ownsView({ browserSessionId: 'other', viewId: 'view' })).toBe(true);
            await expect(actions.startOwner(retainedRoot, {})).resolves.toEqual({ status: 'started' });
            expect(browser.adapter.ownsView({ browserSessionId: 'session', viewId: 'view' })).toBe(true);
            await expect(fs.stat(originalMarkers.profile)).rejects.toMatchObject({ code: 'ENOENT' });
            const reopened = browser.readResourceTargets?.().find(item => item.ownerRef === 'session');
            expect(reopened?.wayBack?.[0]?.input).toMatchObject({ target: { url: 'https://example.test/original' } });
            const controller = new AbortController(); controller.abort();
            await expect(actions.startOwner(retainedRoot, { signal: controller.signal }))
                .resolves.toEqual({ status: 'refused', reasonCode: 'access_denied' });
        } finally { await browser.dispose?.(); await fs.rm(directory, { recursive: true, force: true }); }
    });

    it('closes the actual PTY manager through terminal custody', async () => {
        const exitListeners = new Set<(exit: PtyExitEvent) => void>();
        const pty: PtyProcess = { pid: 5012, ownedProcessGroupId: 5012, write() {}, resize() {},
            kill() { for (const listener of exitListeners) listener({ exitCode: 0, signal: 1 }); },
            onData: () => ({ dispose() {} }),
            onExit: listener => { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; } };
        const manager = createTerminalPtySessionManager({ ptyProvider: { spawn: () => pty }, platform: 'linux', env: {},
            probeProcessGroup: () => 'absent', config: { bufferMaxBytes: 1000,
                bufferMaxEvents: 100, bufferRetentionMs: 1000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000,
                defaultCols: 80, defaultRows: 24 } });
        try {
            const opened = await manager.ensure({ terminalKey: 'fixture', cwd: '/fixture' });
            if (!opened.ok) throw new Error(opened.error);
            const actions = createProcessActionOwnerAdapters({ terminal: manager });
            await expect(actions.closeTerminal({ kind: 'terminal', terminalId: opened.terminalId }, {})).resolves.toEqual({ ok: true });
            expect(manager.list()).toEqual([]);
        } finally { manager.dispose(); }
    });

    it('uses the native listener owner to reject changed identity and unverified port release', async () => {
        const pid = 4321;
        const fixture = localServiceProcfsFixture([{ pid }]);
        const census = await readLinuxCensus({ boundary: fixture, selfPid: process.pid, capturedAtMs: 0, logicalCpus: 1 });
        if (census.status !== 'ok') throw new Error('Fixture census missing');
        const row = census.rows.find(row => row.pid === pid)!;
        const entry: NormalizedLocalServiceInventoryEntry = { id: 'listener', machineId: 'machine',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port: 5173, protocol: 'tcp',
            detectedAt: 0, lastSeenAt: 0, state: 'listening', source: 'detected', labels: [], diagnostics: [],
            confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high',
            provenance: { process: { pid, processStartTimeMs: row.start.startTimeMs, lineagePids: [pid], command: '', redacted: true } } };
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot({ v: 1, machineId: 'machine', generatedAt: 0, refreshState: 'idle', entries: [entry], diagnostics: [] });
        const live = new Set([pid]);
        let changed = true;
        const terminateDetectedService = createTerminateDetectedService({
            probeListener: async () => ({ status: 'held', identity: { pid, startTime: row.start.startTimeMs + (changed ? 1 : 0) } }),
            terminateTree: createProcessTreeTerminator({ platform: 'linux', kill: target => { live.delete(target); },
                censusDependencies: { platform: 'linux', linuxBoundary: {
                    readdir: async path => localServiceProcfsFixture([...live].map(pid => ({ pid }))).readdir(path),
                    readFile: async path => localServiceProcfsFixture([...live].map(pid => ({ pid }))).readFile(path),
                    readlink: async path => localServiceProcfsFixture([...live].map(pid => ({ pid }))).readlink(path),
                } } }), wait: async () => undefined,
        }, { graceMs: 0, verifyAttempts: 0 });
        const actions = createProcessActionOwnerAdapters({ refreshInventory: async () => registry.getSnapshot(), terminateDetectedService });
        await expect(actions.terminateDetected(row, {})).resolves.toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(live.has(pid)).toBe(true);
        changed = false;
        const cancelled = await actions.terminateDetected(row, { authorizeSnapshot: async () => false, tree: false });
        expect(cancelled?.status).not.toBe('succeeded');
        expect(live.has(pid)).toBe(true);
        await expect(actions.terminateDetected(row, {})).resolves.toEqual({ status: 'failed', reasonCode: 'port_not_released' });
        expect(live.has(pid)).toBe(false);
    });
});
