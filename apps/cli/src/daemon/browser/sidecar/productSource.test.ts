import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserOpenViewCommandV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { installLocalServiceCensusFixture } from '../../local/services/inventory/platform/censusFixture.testkit';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SidecarBrowserBinaryCandidate } from './binary';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import * as productSource from './productSource';

// The native process census reads the OS filesystem; lifecycle and ownership projection stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});
beforeEach(() => installLocalServiceCensusFixture([{ pid: 42, ppid: process.pid, command: ['chromium'] }]));

const MANAGED_PROVENANCE = {
    origin: 'managed_package' as const,
    pinnedVersion: '127.0.6533.88',
    channel: 'stable' as const,
    integrityDigest: `sha256:${'a'.repeat(64)}`,
    license: 'BSD-3-Clause',
};

function managedCandidate(): SidecarBrowserBinaryCandidate {
    return {
        source: 'managedBrowserPackage',
        executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
        discoveryKind: 'managedRuntime',
        available: true,
        provenance: MANAGED_PROVENANCE,
    };
}

describe('browser sidecar product source owner', () => {
    it('qualifies native observation only for the exact owned headless Session view', async () => {
        class OwnedProcess extends EventEmitter {
            pid = 42;
            stderr = new PassThrough();
            stdio = [null, null, this.stderr, new PassThrough(), new PassThrough()];
            kill() { queueMicrotask(() => this.emit('exit', 0, 'SIGTERM')); return true; }
        }
        const profileStore = createBrowserProfileStore({
            storageRootDirectory: '/unused',
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: '/unused' }),
            removeDirectory: async () => undefined,
        });
        const factory = productSource.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux', featureEnabled: true, profileStore,
            resolveManagedCandidate: async () => managedCandidate(),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({
                ...input,
                // Only the OS process and CDP network transport are replaced; both actual
                // launch owners, Session profile ownership and view-binding logic remain real.
                spawnProcess: (_executable, args) => {
                    expect(args).toContain('--headless=new');
                    const process = new OwnedProcess();
                    return process;
                },
                connectTransport: async () => ({ transport: {
                    openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                    dispatchPageCommand: async () => ({}),
                    dispatchBrowserCommand: async () => ({ success: true }),
                } }),
            }),
        });
        const automation = createBrowserAutomationOwnerRegistry();
        const runtime = await factory({ machineId: 'machine', resolveInputControl: automation.getInputControl,
            readSessionIdle: automation.readSessionIdle });
        expect(runtime.ok).toBe(true);
        if (!runtime.ok) return;
        const view = { browserSessionId: 'session', viewId: 'view' };
        try {
            expect(runtime.contextCapture?.resolveNativeObservation?.(view)).toBeUndefined();
            expect(await runtime.adapter.dispatchCommand({
                kind: 'openView', commandId: 'open', ...view, platform: 'web', focus: true,
                target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
            })).toMatchObject({ status: 'dispatched' });
            expect(runtime.contextCapture?.resolvePageHandle(view)).not.toBeNull();
            expect(runtime.contextCapture?.resolveNativeObservation?.(view)).toBe('not_observable');
            expect(runtime.contextCapture?.resolveNativeObservation?.({ ...view, viewId: 'unowned' })).toBeUndefined();
            expect(runtime.contextCapture?.resolveNativeObservation?.({ ...view, browserSessionId: 'other' })).toBeUndefined();
            const [target] = runtime.readResourceTargets!();
            expect(target).toMatchObject({ ownerRef: 'session', idle: true,
                root: { owner: { kind: 'browser_sidecar' }, pid: 42, live: true, start: { startTimeMs: 123_450 } } });
            expect(runtime.readProcessRoots!()[0]?.start).toEqual(target?.root.start);
            const reopen = target?.wayBack?.[0];
            expect(reopen).toMatchObject({ label: 'reopen', actionId: 'browser.view.open',
                input: { ...view, target: { kind: 'externalUrl', url: 'https://example.test' } } });
            const reopenCommand = BrowserOpenViewCommandV1Schema.parse(reopen?.input);
            expect(reopenCommand.commandId).not.toBe('open');
            automation.takeOver(view);
            expect(runtime.readResourceTargets!()[0]?.idle).toBe(false);
            automation.handBack(view);
            await target?.root.stop?.();
            expect(runtime.readResourceTargets!()).toEqual([]);
            expect(await runtime.adapter.dispatchCommand(reopenCommand)).toMatchObject({ status: 'dispatched' });
            await expect(target?.root.stop?.()).rejects.toThrow();
            await automation.acquireConfidentiality(view);
            expect(runtime.readResourceTargets!()[0]?.idle).toBe(false);
            await runtime.readResourceTargets!()[0]?.root.stop?.();
            expect(runtime.readResourceTargets!()).toEqual([]);
        } finally { await runtime.dispose?.(); }
        expect(runtime.contextCapture?.resolveNativeObservation?.(view)).toBeUndefined();
    });
    it('settles a pending process acquisition before purging a closed Session profile', async () => {
        class StartingProcess extends EventEmitter {
            pid = 42;
            stderr = new PassThrough();
            stdio = [null, null, this.stderr, new PassThrough(), new PassThrough()];
            exited = false;
            kill() {
                queueMicrotask(() => {
                    this.exited = true;
                    this.emit('exit', 0, 'SIGTERM');
                });
                return true;
            }
        }
        const process = new StartingProcess();
        const removed: string[] = [];
        const profileStore = createBrowserProfileStore({
            storageRootDirectory: '/unused',
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: '/unused' }),
            removeDirectory: async (directory) => {
                expect(process.exited).toBe(true);
                removed.push(directory);
            },
        });
        const factory = productSource.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux', featureEnabled: true, profileStore,
            resolveManagedCandidate: async () => managedCandidate(),
            createLaunchOwnerFactory: (input) => createBrowserSidecarLaunchOwnerControlAdapterFactory({
                ...input, spawnProcess: () => process,
            }),
        });
        const runtime = await factory({ machineId: 'machine' });
        expect(runtime.ok).toBe(true);
        if (!runtime.ok) return;
        const opening = runtime.adapter.dispatchCommand({
            kind: 'openView', commandId: 'open', browserSessionId: 'session', viewId: 'view', platform: 'web', focus: true,
            target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(profileStore.listProfiles()).toHaveLength(1);
        expect(removed).toEqual([]);
        await expect(profileStore.purgeForSessionDeleted({ sessionId: 'session' })).resolves.toMatchObject({ failedProfileIds: [] });
        await expect(opening).resolves.toMatchObject({ status: 'failed', error: { code: 'adapter_unavailable' } });
        expect(removed).toHaveLength(1);
        expect(profileStore.listProfiles()).toEqual([]);
    });
    it('rejects a resolved but server-disabled source', async () => {
        const factory = productSource.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            // Server-disabled `browser.sidecar` decision threaded from the daemon startup gate.
            featureEnabled: false,
            resolveManagedCandidate: vi.fn(async () => managedCandidate()),
        });
        expect(await factory({ machineId: 'machine_disabled' })).toMatchObject({ ok: false, errorCode: 'feature_disabled' });
    });

    it('stays fail-closed when no managed candidate is installed', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            resolveManagedCandidate: vi.fn(async () => null),
        });

        const result = await factory({ machineId: 'machine_missing' });

        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
    });

    // MCH-2: lazy-install trigger — a supported, digest-pinned platform whose artifact is missing
    // (available:false) installs once, then re-resolves to the freshly-installed candidate.
    it('lazily installs the managed binary when missing then re-resolves and delegates to launch', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const missingThenInstalled = vi
            .fn()
            .mockResolvedValueOnce({
                source: 'managedBrowserPackage' as const,
                discoveryKind: 'managedRuntime' as const,
                available: false as const,
                disabledReason: 'not installed',
            })
            .mockResolvedValueOnce(managedCandidate());
        const installManagedBrowserChromium = vi.fn(async () => ({
            ok: true as const,
            executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
            pinnedVersion: '127.0.6533.88',
            integrityDigest: `sha256:${'a'.repeat(64)}`,
        }));

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            resolveManagedCandidate: missingThenInstalled,
            installManagedBrowserChromium,
        });

        const result = await factory({ machineId: 'machine_lazy' });

        expect(installManagedBrowserChromium).toHaveBeenCalledOnce();
        expect(missingThenInstalled).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
    });

    it('does not lazily install when autoInstallWhenMissing is disabled', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const installManagedBrowserChromium = vi.fn(async () => ({ ok: true as const, executablePath: '/x', pinnedVersion: '1.2.3.4', integrityDigest: `sha256:${'a'.repeat(64)}` }));
        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            autoInstallWhenMissing: false,
            resolveManagedCandidate: vi.fn(async () => ({
                source: 'managedBrowserPackage' as const,
                discoveryKind: 'managedRuntime' as const,
                available: false as const,
                disabledReason: 'not installed',
            })),
            installManagedBrowserChromium,
        });

        const result = await factory({ machineId: 'machine_no_lazy' });

        expect(installManagedBrowserChromium).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
    });

    it('stays fail-closed when a managed candidate lacks provenance (never delegates to launch)', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            resolveManagedCandidate: vi.fn(async () => ({
                source: 'managedBrowserPackage' as const,
                executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
                discoveryKind: 'managedRuntime' as const,
                available: true,
            })),
        });

        const result = await factory({ machineId: 'machine_no_provenance' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe('binary_resolution_failed');
        }
    });
});
