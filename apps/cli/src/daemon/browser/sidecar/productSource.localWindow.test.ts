import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import type { BrowserCommandV1 } from '@happier-dev/protocol';

import { createBrowserCdpScreencastProducer } from '../capture/cdpScreencast';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import type { BrowserSidecarCdpEventSubscriber } from './controlAdapter';
import { createSurfaceInputControl } from '../../surfaces/inputControl';

it('launches a per-view local window through the same profile, CDP control and screencast owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-local-window-'));
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const profile = await profiles.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
        owner: { kind: 'user', id: 'person' }, cleanupOnSessionClose: false });
    await profiles.setExtension(profile.profileId, { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
        source: { kind: 'unpacked', directory: '/source/extension' }, directory: '/profiles/extension',
        permissions: [], hostPermissions: [], actionPopup: 'popup.html' });
    const launchedArgs: string[][] = [];
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: string[] = [];
    let connected = 0;
    let probes = 0;
    const control = createSurfaceInputControl();
    let desktopOutput = 'User=1000\nActive=yes\nRemote=no\nType=x11\nDisplay=:0\n';
    const runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
        localWindowHost: { platform: 'linux', env: { DISPLAY: ':0' }, uid: 1000, execute: async () => { probes++; return desktopOutput; } },
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            // Only the native process, GUI-session probe and CDP network boundaries are substituted.
            spawnProcess: (_executable, args) => {
                launchedArgs.push([...args]);
                const child = new EventEmitter();
                const stderr = new PassThrough();
                return Object.assign(child, { pid: 424242, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()], kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
            },
            connectTransport: async () => {
                connected++;
                return { transport: { openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                    dispatchPageCommand: async command => { commands.push(command.method); return {}; },
                    dispatchBrowserCommand: async () => ({ success: true }),
                    subscribeCdpEvents: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                } };
            },
        }),
    })({ machineId: 'machine', resolveInputControl: () => control, readMachineMemory: () => ({ reported: true, totalBytes: 8 * 1024 ** 3,
        availableBytes: 8 * 1024 ** 3, usedBytes: 0, pressure: { level: 'calm', source: 'none' } }) });
    if (!runtime.ok) throw new Error(runtime.errorCode);
    const open = (browserSessionId: string, persistent = false): Extract<BrowserCommandV1, { kind: 'openView' }> => ({
        kind: 'openView', commandId: `open:${browserSessionId}`, browserSessionId, viewId: 'view', platform: 'web', focus: true,
        ...(persistent ? { profileId: profile.profileId } : {}),
        target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' },
    });
    const view = { browserSessionId: 'window', viewId: 'view' };
    try {
        expect(runtime.localWindow).toBeDefined();
        expect(probes).toBe(0);
        expect(await runtime.localWindow?.showAsWindow(open('window', true))).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(launchedArgs[0]).not.toContain('--headless=new');
        expect(launchedArgs[0]).toContain(`--user-data-dir=${profiles.resolveProfileDirectory(profile.profileId)}`);
        expect(launchedArgs[0]).toContain('--load-extension=/profiles/extension');
        expect(runtime.contextCapture?.resolveProfile?.(view)?.profileId).toBe(profile.profileId);
        expect(runtime.contextCapture?.resolveNativeObservation?.(view)).toBeUndefined();
        expect(await runtime.adapter.dispatchCommand({ kind: 'navigate', commandId: 'agent-navigate', ...view, url: 'https://example.test/agent' }))
            .toMatchObject({ status: 'dispatched' });
        expect(commands).toContain('Page.navigate');
        const frames: string[] = [];
        const producer = createBrowserCdpScreencastProducer({ contextCapture: runtime.contextCapture! });
        const subscription = await producer.start({ view, purpose: 'humanViewer', onFrame: frame => frames.push(frame.dataBase64) });
        for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp', params: { sessionId: 1, data: 'frame' } });
        expect(frames).toEqual(['frame']);
        expect(connected).toBe(1);
        await subscription?.stop();
        await producer.dispose();
        expect(await runtime.adapter.dispatchCommand(open('headless'))).toMatchObject({ status: 'dispatched' });
        expect(launchedArgs[1]).toContain('--headless=new');
        expect(probes).toBe(1);
        expect(runtime.contextCapture?.resolveNativeObservation?.({ browserSessionId: 'headless', viewId: 'view' })).toBe('not_observable');
        expect(await runtime.localWindow?.showAsWindow({ ...open('headless'), viewId: 'missing' }))
            .toMatchObject({ ok: false, reason: 'view_not_found' });
        expect(await runtime.localWindow?.showAsWindow({ ...open('headless'), profileId: 'different' }))
            .toMatchObject({ ok: false, reason: 'profile_mismatch' });
        let finishInput!: () => void;
        const activeInput = control.execute({ requestedBy: 'agent',
            effect: () => new Promise<void>(resolve => { finishInput = resolve; }), classifyCompletion: () => 'known' });
        expect(await runtime.localWindow?.showAsWindow(open('headless'))).toMatchObject({ ok: false, reason: 'browser_busy' });
        finishInput();
        await activeInput;
        // Relaunch the exact running view, keeping its profile and latest navigated URL.
        expect(await runtime.adapter.dispatchCommand({ kind: 'navigate', commandId: 'navigate-before-relaunch',
            browserSessionId: 'headless', viewId: 'view', url: 'https://example.test/current' })).toMatchObject({ status: 'dispatched' });
        // The real engine reports navigation for both native clicks and CDP actions on this target.
        for (const listener of listeners) listener({ method: 'Page.frameNavigated', sessionId: 'cdp',
            params: { frame: { id: 'main', url: 'https://example.test/current' } } });
        expect(await runtime.localWindow?.showAsWindow(open('headless'))).toMatchObject({ ok: true });
        expect(launchedArgs[2]).not.toContain('--headless=new');
        expect(launchedArgs[2]?.find(arg => arg.startsWith('--user-data-dir=')))
            .toBe(launchedArgs[1]?.find(arg => arg.startsWith('--user-data-dir=')));
        expect(runtime.contextCapture?.getNavigationState?.({ browserSessionId: 'headless', viewId: 'view' })?.currentUrl)
            .toBe('https://example.test/current');
        expect(await runtime.localWindow?.showAsWindow(open('headless'))).toMatchObject({ ok: true });
        expect(launchedArgs).toHaveLength(3);
        // A per-view request must never restart a sibling tab or silently change profile.
        await runtime.adapter.dispatchCommand({ ...open('headless'), commandId: 'sibling', viewId: 'sibling' });
        expect(await runtime.localWindow?.showAsWindow(open('headless')))
            .toMatchObject({ ok: false, reason: 'shared_browser_session' });
        expect(launchedArgs).toHaveLength(3);
        desktopOutput = desktopOutput.replace('Active=yes', 'Active=no');
        expect(await runtime.localWindow?.showAsWindow(open('refused'))).toEqual({ ok: false, reason: 'daemon_not_in_gui_session' });
        expect(launchedArgs).toHaveLength(3);
    } finally { await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
});
