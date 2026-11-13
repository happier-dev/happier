import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserOpenViewCommandV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { installLocalServiceCensusFixture } from '../../local/services/inventory/platform/censusFixture.testkit';
import { createSidecarCdpDiagnosticsRuntime } from './diagnostics/runtime';
import { createBrowserDiagnosticsDaemonStore } from '../diagnostics/store';
import { createBrowserDiagnosticsRoutes } from '../diagnostics/routes';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import type { BrowserSidecarCdpEventSubscriber } from './controlAdapter';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SidecarBrowserBinaryCandidate } from './binary';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import * as productSource from './productSource';
import * as chromiumInstaller from '@/packagedRuntime/installables/sourceAdapters/chromiumForTesting';

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
    it('routes interaction and current-generation diagnostics to the owning Session through the product source', async () => {
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
        const connections = new Map<string, { emit: BrowserSidecarCdpEventSubscriber; pasted: string[] }>();
        const factory = productSource.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux', profileStore,
            resolveManagedCandidate: async () => managedCandidate(),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({
                ...input,
                // Only OS processes and the CDP network are substituted; Session routing,
                // launch/control/interaction owners and Action settlement remain real.
                spawnProcess: () => {
                    const child = new OwnedProcess();
                    return child;
                },
                connectTransport: async () => {
                    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
                    const pasted: string[] = [];
                    connections.set(input.browserSessionId, {
                        pasted, emit: event => { for (const listener of [...listeners]) listener(event); },
                    });
                    return { transport: {
                        openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                        dispatchPageCommand: async command => {
                            if (command.method === 'Runtime.evaluate') return { result: { value: `selected:${input.browserSessionId}` } };
                            if (command.method === 'Input.insertText') pasted.push(String(command.params?.text));
                            return {};
                        },
                        dispatchBrowserCommand: async () => ({ success: true }),
                        subscribeCdpEvents: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                    } };
                },
            }),
        });
        const runtime = await factory({ machineId: 'machine', readMachineMemory: () => ({ reported: true,
            totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedBytes: 0,
            pressure: { level: 'calm', source: 'none' } }) });
        if (!runtime.ok) throw new Error(runtime.errorCode);
        const capture = runtime.contextCapture;
        if (!capture?.subscribeCdpEvents || !capture.subscribeViewLifecycle || !capture.getNavigationState) throw new Error('live capture missing');
        const diagnosticsStore = createBrowserDiagnosticsDaemonStore({ machineId: 'machine' });
        const diagnostics = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: 'machine', store: diagnosticsStore,
            contextCapture: { ...capture, getNavigationState: capture.getNavigationState, subscribeCdpEvents: capture.subscribeCdpEvents,
                subscribeViewLifecycle: capture.subscribeViewLifecycle }, isEnabled: () => true });
        const diagnosticsRoutes = createBrowserDiagnosticsRoutes({ store: diagnosticsStore });
        const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: capture }),
        }) });
        let requestId = 0;
        const execute = (browserSessionId: string, actionKind: 'clipboardRead' | 'clipboardWrite' | 'getInteractionState', payload = {}) => service.execute({
            v: 1, browserSessionId, viewId: 'view', automationRequestId: `clipboard:${++requestId}`,
            navigationGeneration: capture?.getNavigationState?.({ browserSessionId, viewId: 'view' })?.navigationGeneration ?? 0,
            requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'fixture' }, actionKind, payload, timeoutMs: 10_000,
        });
        const changed: string[] = [];
        const unsubscribe = capture?.interactions?.subscribe(view => changed.push(view.browserSessionId));
        try {
            for (const browserSessionId of ['session-a', 'session-b']) {
                expect(await runtime.adapter.dispatchCommand({ kind: 'openView', commandId: `open:${browserSessionId}`,
                    browserSessionId, viewId: 'view', platform: 'web', focus: true,
                    target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test' },
                })).toMatchObject({ status: 'dispatched' });
                expect(await execute(browserSessionId, 'clipboardRead')).toMatchObject({ status: 'succeeded',
                    interactionResult: { kind: 'clipboard', text: `selected:${browserSessionId}` }, resultSummary: {} });
                expect(await execute(browserSessionId, 'clipboardWrite', { text: `paste:${browserSessionId}` }))
                    .toMatchObject({ status: 'succeeded' });
                expect(connections.get(browserSessionId)?.pasted).toEqual([`paste:${browserSessionId}`]);
            }
            const view = { browserSessionId: 'session-a', viewId: 'view' };
            const emit = (method: string, params: Record<string, unknown>) => connections.get('session-a')?.emit({ method, params, sessionId: 'cdp' });
            emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'document-1', url: 'https://example.test/next' } });
            const navigationGeneration = capture.getNavigationState?.(view)?.navigationGeneration;
            expect(navigationGeneration).toBe(1);
            emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'current page' }] });
            const read = { ...view, navigationGeneration: navigationGeneration! };
            const initial = await diagnosticsRoutes.readViewSnapshot(read);
            expect(initial.revision).toBeGreaterThan(0);
            expect(initial.snapshot.events).toEqual(expect.arrayContaining([expect.objectContaining({
                family: 'console', fidelity: 'cdp', navigationGeneration: 1,
            })]));
            const delta = diagnosticsRoutes.readViewSnapshot({ ...read, sinceRevision: initial.revision });
            emit('Network.requestWillBeSent', { requestId: 'next', request: { method: 'GET', url: 'https://example.test/api' } });
            emit('Network.loadingFinished', { requestId: 'next', timestamp: 2, encodedDataLength: 7 });
            const diagnosticsDelta = await delta;
            expect(diagnosticsDelta.snapshot.events).toEqual([expect.objectContaining({ family: 'network', navigationGeneration: 1 })]);
            const reconnected = await diagnosticsRoutes.readViewSnapshot(read);
            expect(reconnected.snapshot.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ family: 'console', navigationGeneration: 1 }),
                expect.objectContaining({ family: 'network', navigationGeneration: 1 }),
            ]));
            expect((await diagnosticsRoutes.readViewSnapshot({ browserSessionId: 'session-b', viewId: 'view', navigationGeneration: 0 })).snapshot.events)
                .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'network.finished' })]));
            connections.get('session-a')?.emit({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp',
                params: { type: 'prompt', message: 'private dialog', defaultPrompt: 'private default' } });
            expect(changed).toContain('session-a');
            expect(await execute('session-a', 'getInteractionState')).toMatchObject({ status: 'succeeded',
                resultSummary: { dialog: { type: 'prompt', message: 'private dialog' } } });
            expect(await execute('session-b', 'getInteractionState')).toMatchObject({ status: 'succeeded',
                resultSummary: { dialog: null } });
            expect(capture?.interactions?.getState({ browserSessionId: 'session-a', viewId: 'view' })?.dialog?.message).toBe('private dialog');
            const timeline = JSON.stringify(service.getTimeline({ browserSessionId: 'session-a', viewId: 'view' }));
            for (const privateValue of ['selected:session-a', 'paste:session-a', 'private dialog', 'private default']) {
                expect(timeline).not.toContain(privateValue);
            }
            expect(await runtime.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close-a', browserSessionId: 'session-a', viewId: 'view' }))
                .toMatchObject({ status: 'dispatched' });
            expect(capture?.interactions?.getState({ browserSessionId: 'session-a', viewId: 'view' })).toBeNull();
            const changesAfterClose = [...changed];
            connections.get('session-a')?.emit({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp',
                params: { type: 'alert', message: 'retired dialog' } });
            expect(changed).toEqual(changesAfterClose);
            expect(await execute('session-b', 'clipboardRead')).toMatchObject({ status: 'succeeded',
                interactionResult: { kind: 'clipboard', text: 'selected:session-b' } });
        } finally {
            unsubscribe?.();
            service.dispose();
            diagnostics.dispose();
            await runtime.dispose?.();
        }
    });

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
            platform: 'linux', profileStore,
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
            platform: 'linux', profileStore,
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

    it('binds the admitted source without replaying its feature decision', async () => {
        const factory = productSource.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            resolveManagedCandidate: vi.fn(async () => managedCandidate()),
        });
        expect(await factory({ machineId: 'machine_disabled' })).toMatchObject({ ok: true });
    });

    it('stays fail-closed when no managed candidate is installed', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            
            resolveManagedCandidate: vi.fn(async () => null),
        });

        const result = await factory({ machineId: 'machine_missing' });

        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
    });

    it('leaves a missing managed binary to the dispatch provisioner without installing at factory resolution', async () => {
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
        const installManagedBrowserChromium = vi.spyOn(chromiumInstaller, 'installChromiumForTesting').mockResolvedValue({
            ok: true as const,
            executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
            pinnedVersion: '127.0.6533.88',
            integrityDigest: `sha256:${'a'.repeat(64)}`,
        });

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            
            resolveManagedCandidate: missingThenInstalled,
        });

        const result = await factory({ machineId: 'machine_lazy' });

        expect(installManagedBrowserChromium).not.toHaveBeenCalled();
        expect(missingThenInstalled).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
        installManagedBrowserChromium.mockRestore();
    });

    it('stays fail-closed when a managed candidate lacks provenance (never delegates to launch)', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            
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
