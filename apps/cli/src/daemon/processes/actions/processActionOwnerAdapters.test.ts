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
    it('stops and reopens the original browser through its product launch owner', async () => {
        installLocalServiceCensusFixture([{ pid: 42, ppid: process.pid, command: ['chromium'] }]);
        class NativeProcess extends EventEmitter {
            pid = 42;
            stderr = new PassThrough();
            stdio = [null, null, this.stderr, new PassThrough(), new PassThrough()];
            kill() { queueMicrotask(() => this.emit('exit', 0, 'SIGTERM')); return true; }
        }
        const profileStore = createBrowserProfileStore({ storageRootDirectory: '/unused',
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: '/unused' }),
            removeDirectory: async () => undefined });
        const factory = createProductBrowserSidecarControlAdapterFactory({ platform: 'linux', featureEnabled: true, profileStore,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                spawnProcess: () => { const child = new NativeProcess();
                    return child; },
                connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'page', sessionId: 'cdp' }),
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }) } }),
            }) });
        const browser = await factory({ machineId: 'machine' });
        if (!browser.ok) throw new Error(browser.disabledReason);
        try {
            await browser.adapter.dispatchCommand({ kind: 'openView', commandId: 'original-open', browserSessionId: 'session',
                viewId: 'view', platform: 'web', focus: true,
                target: { kind: 'externalUrl', targetId: 'original-target', url: 'https://example.test/original' } });
            const target = browser.readResourceTargets?.()[0];
            if (!target) throw new Error('Browser root missing');
            const actions = createProcessActionOwnerAdapters({ readBrowsers: browser.readResourceTargets,
                getBrowserAdapter: () => browser.adapter });
            const retainedRoot = actions.captureBrowserRoot(target);
            await actions.stopOwner(retainedRoot, {});
            expect(browser.readResourceTargets?.()).toEqual([]);
            await expect(actions.startOwner(retainedRoot, {})).resolves.toEqual({ status: 'started' });
            expect(browser.adapter.ownsView({ browserSessionId: 'session', viewId: 'view' })).toBe(true);
            const reopened = browser.readResourceTargets?.()[0];
            expect(reopened?.wayBack?.[0]?.input).toMatchObject({ target: { url: 'https://example.test/original' } });
            await expect(actions.startOwner(retainedRoot, { verifyCurrent: async () => false }))
                .resolves.toEqual({ status: 'refused', reasonCode: 'access_denied' });
        } finally { await browser.dispose?.(); }
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
            const opened = manager.ensure({ terminalKey: 'fixture', cwd: '/fixture' });
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
