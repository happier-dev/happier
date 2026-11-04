import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserCommandV1, BrowserEventV1, MachineVitalsSampleV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { createSidecarCdpBrowserContextSource } from '../context/cdp/productSource';
import type { BrowserSidecarCdpEventSubscriber } from './controlAdapter';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==';

function open(sessionId: string): Extract<BrowserCommandV1, { kind: 'openView' }> {
    return {
        kind: 'openView', commandId: `open_${sessionId}`, browserSessionId: sessionId,
        viewId: 'view', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test' },
    };
}

describe('product browser session isolation', () => {
    it('retains isolated session storage across final-view close and reopen, then purges retained profiles at session end', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-isolation-'));
        const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
        const removed: string[] = [];
        const store = createBrowserProfileStore({
            storageRootDirectory: root, partitionOwner,
            removeDirectory: async (directory) => { removed.push(directory); await rm(directory, { recursive: true, force: true }); },
        });
        const spawnArgs: string[][] = [];
        const stopped: string[] = [];
        const children = new Map<string, EventEmitter>();
        let failNextSpawn = false;
        const navigationScopes: Array<Readonly<{ deadlineMs?: number; signal?: AbortSignal }>> = [];
        const cdpListeners = new Map<string, Set<BrowserSidecarCdpEventSubscriber>>();
        function navigateFromEngine(sessionId: string, url: string): void {
            for (const listener of cdpListeners.get(sessionId) ?? []) {
                listener({ method: 'Page.frameNavigated', sessionId: 'cdp',
                    params: { frame: { id: 'frame', loaderId: 'loader', url } } });
            }
        }
        const factory = createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux', profileStore: store,
            resolveManagedCandidate: async () => ({
                source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true,
                provenance: {
                    origin: 'managed_package', pinnedVersion: '127.0.6533.88', channel: 'stable',
                    integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause',
                },
            }),
            createLaunchOwnerFactory: (input) => {
                const child = new EventEmitter();
                children.set(input.browserSessionId, child);
                const stderr = new PassThrough();
                const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
                cdpListeners.set(input.browserSessionId, listeners);
                return createBrowserSidecarLaunchOwnerControlAdapterFactory({
                    ...input,
                    spawnProcess: (_executable, args) => {
                        if (failNextSpawn) { failNextSpawn = false; throw new Error('Managed Chromium launch failed'); }
                        spawnArgs.push([...args]);
                        return Object.assign(child, {
                            pid: 123, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                            kill: () => { stopped.push(input.browserSessionId); child.emit('exit', 0, 'SIGTERM'); return true; },
                        });
                    },
                    connectTransport: async () => ({
                        transport: {
                            // Separate CDP connections may return the same session/target ids.
                            openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                            dispatchPageCommand: async (command) => {
                                if (command.method === 'Page.navigate') navigationScopes.push({ deadlineMs: command.deadlineMs, signal: command.signal });
                                return command.method === 'Page.captureScreenshot' ? { data: pngBase64 } : { ownerSession: input.browserSessionId };
                            },
                            dispatchBrowserCommand: async () => ({ success: true }),
                            subscribeCdpEvents: (listener) => {
                                listeners.add(listener);
                                return () => { listeners.delete(listener); };
                            },
                        },
                    }),
                });
            },
        });
        try {
            const factoryInput = { machineId: 'machine', readMachineMemory: (): MachineVitalsSampleV1['memory'] => ({ reported: true,
                totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedBytes: 0,
                pressure: { level: 'calm', source: 'none' } }) };
            const result = await factory(factoryInput);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const unboundSessions: string[] = [];
            const browserEvents: BrowserEventV1[] = [];
            result.contextCapture?.subscribeBrowserEvents?.(event => { browserEvents.push(event); });
            result.contextCapture?.subscribeViewLifecycle?.(event => {
                if (event.type === 'unbound') unboundSessions.push(event.browserSessionId);
            });
            expect(result.adapter.supportsOpenView(open('happier_session_a'))).toBe(true);
            expect(spawnArgs).toHaveLength(0);
            expect(await result.adapter.dispatchCommand(open('happier_session_a'))).toMatchObject({ status: 'dispatched' });
            expect(await result.adapter.dispatchCommand(open('happier_session_b'))).toMatchObject({ status: 'dispatched' });
            browserEvents.length = 0;
            navigateFromEngine('happier_session_a', 'https://example.test/engine-a');
            expect(result.contextCapture?.getNavigationState?.({ browserSessionId: 'happier_session_a', viewId: 'view' }))
                .toMatchObject({ currentUrl: 'https://example.test/engine-a', navigationGeneration: 1 });
            expect(result.contextCapture?.getNavigationState?.({ browserSessionId: 'happier_session_b', viewId: 'view' }))
                .toMatchObject({ currentUrl: 'https://example.test', navigationGeneration: 0 });
            expect(browserEvents).toMatchObject([{ browserSessionId: 'happier_session_a', viewId: 'view',
                kind: 'navigationStateChanged', currentUrl: 'https://example.test/engine-a' }]);
            const scope = { deadlineMs: Date.now() + 60_000, signal: new AbortController().signal };
            expect(await result.adapter.dispatchCommand({ kind: 'navigate', commandId: 'navigate_scoped',
                browserSessionId: 'happier_session_a', viewId: 'view', url: 'https://example.test/next' }, scope))
                .toMatchObject({ status: 'dispatched' });
            // Issued CDP navigation retains the containing deadline but drains its reply on abort.
            expect(navigationScopes).toEqual([{ deadlineMs: scope.deadlineMs, signal: undefined }]);
            const profiles = store.listProfiles();
            expect(profiles.map((profile) => profile.owner.id).sort()).toEqual(['happier_session_a', 'happier_session_b']);
            const directories = spawnArgs.map((args) => args.find((arg) => arg.startsWith('--user-data-dir=')));
            expect(new Set(directories).size).toBe(2);
            const markers = new Map<string, { profile: string; partition: string }>();
            for (const profile of profiles) {
                const partition = partitionOwner.register({ profileId: profile.profileId,
                    originKey: 'https://example.test', targetKind: 'externalUrl', persistence: 'ephemeral',
                    createdAt: 0, updatedAt: 0 });
                const profileDirectory = store.resolveProfileDirectory(profile.profileId);
                const partitionDirectory = partitionOwner.resolvePartitionDirectory(partition.partitionId);
                await mkdir(profileDirectory, { recursive: true });
                await mkdir(partitionDirectory, { recursive: true });
                const paths = { profile: join(profileDirectory, 'cookie-marker'), partition: join(partitionDirectory, 'storage-marker') };
                await writeFile(paths.profile, profile.owner.id);
                await writeFile(paths.partition, profile.owner.id);
                markers.set(profile.owner.id, paths);
            }
            for (const sessionId of ['happier_session_a', 'happier_session_b']) {
                const handle = result.contextCapture?.resolvePageHandle({ browserSessionId: sessionId, viewId: 'view' });
                expect(handle).toBeTruthy();
                if (!handle) continue;
                expect(await result.contextCapture?.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate' }))
                    .toEqual({ ownerSession: sessionId });
            }
            if (!result.contextCapture) throw new Error('Expected owned context source');
            const context = createSidecarCdpBrowserContextSource({
                contextCapture: result.contextCapture, workingDirectory: root,
                pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
            });
            expect(await context.captureScreenshot({ browserSessionId: 'happier_session_a', viewId: 'view', navigationGeneration: 0 }))
                .toMatchObject({ ok: true, media: { width: 1, height: 1 } });
            const mediaRoot = join(root, '.happier', 'uploads', 'artifacts');
            expect(await readdir(mediaRoot)).toEqual(['happier_session_a']);
            const mediaDirectory = join(mediaRoot, 'happier_session_a', 'browser_context_view_0');
            const mediaFiles = await readdir(mediaDirectory);
            expect(mediaFiles).toHaveLength(1);
            expect(await readFile(join(mediaDirectory, mediaFiles[0]!))).toEqual(Buffer.from(pngBase64, 'base64'));
            const close = (sessionId: string) => result.adapter.dispatchCommand({ kind: 'closeView', commandId: `close_${sessionId}`,
                browserSessionId: sessionId, viewId: 'view' });
            expect(await close('happier_session_a')).toMatchObject({ status: 'dispatched' });
            expect(stopped).toEqual(['happier_session_a']);
            expect(result.adapter.ownsView({ browserSessionId: 'happier_session_a', viewId: 'view' })).toBe(false);
            const markerA = markers.get('happier_session_a')!;
            expect(await readFile(markerA.profile, 'utf8')).toBe('happier_session_a');
            expect(await readFile(markerA.partition, 'utf8')).toBe('happier_session_a');
            failNextSpawn = true;
            expect(await result.adapter.dispatchCommand(open('happier_session_a'))).toMatchObject({ status: 'failed' });
            expect(await readFile(markerA.profile, 'utf8')).toBe('happier_session_a');
            expect(await readFile(markerA.partition, 'utf8')).toBe('happier_session_a');
            // With B still live, A can reopen only if closing its final view released
            // the old process slot. Its new process must use the same stored profile.
            expect(await result.adapter.dispatchCommand(open('happier_session_a'))).toMatchObject({ status: 'dispatched' });
            expect(spawnArgs).toHaveLength(3);
            expect(spawnArgs[2]?.find(arg => arg.startsWith('--user-data-dir='))).toBe(directories[0]);
            expect(await readFile(markerA.profile, 'utf8')).toBe('happier_session_a');
            expect(await readFile(markerA.partition, 'utf8')).toBe('happier_session_a');
            children.get('happier_session_a')!.emit('exit', 1, null);
            expect(await result.adapter.dispatchCommand(open('happier_session_a'))).toMatchObject({ status: 'dispatched' });
            expect(spawnArgs).toHaveLength(4);
            expect(spawnArgs[3]?.find(arg => arg.startsWith('--user-data-dir='))).toBe(directories[0]);
            expect(await readFile(markerA.profile, 'utf8')).toBe('happier_session_a');
            expect(await readFile(markerA.partition, 'utf8')).toBe('happier_session_a');
            expect(await close('happier_session_a')).toMatchObject({ status: 'dispatched' });
            const purging = store.purgeForSessionDeleted({ sessionId: 'happier_session_a' });
            // A Session purge claims the profile synchronously, so a concurrent
            // reopen must not register over it while disk removal is in flight.
            const reopeningDuringPurge = result.adapter.dispatchCommand(open('happier_session_a'));
            const purged = await purging;
            expect(await reopeningDuringPurge).toMatchObject({ status: 'failed' });
            expect(spawnArgs).toHaveLength(4);
            expect(purged.failedProfileIds).toEqual([]);
            expect(purged.purgedProfileIds).toHaveLength(1);
            expect(stopped).toEqual(['happier_session_a', 'happier_session_a']);
            expect(unboundSessions).toEqual(['happier_session_a', 'happier_session_a', 'happier_session_a']);
            expect(removed).toHaveLength(1);
            await expect(stat(markerA.profile)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(markerA.partition)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(result.adapter.ownsView({ browserSessionId: 'happier_session_a', viewId: 'view' })).toBe(false);
            expect(result.adapter.ownsView({ browserSessionId: 'happier_session_b', viewId: 'view' })).toBe(true);
            browserEvents.length = 0;
            navigateFromEngine('happier_session_a', 'https://example.test/stale-a');
            expect(result.contextCapture.getNavigationState?.({ browserSessionId: 'happier_session_a', viewId: 'view' })).toBeNull();
            expect(browserEvents).toEqual([]);
            navigateFromEngine('happier_session_b', 'https://example.test/engine-b');
            expect(result.contextCapture.getNavigationState?.({ browserSessionId: 'happier_session_b', viewId: 'view' }))
                .toMatchObject({ currentUrl: 'https://example.test/engine-b', navigationGeneration: 1 });
            expect(browserEvents).toMatchObject([{ browserSessionId: 'happier_session_b', viewId: 'view',
                kind: 'navigationStateChanged', currentUrl: 'https://example.test/engine-b' }]);
            store.register({ profileId: 'other_session_profile', storageMode: 'session',
                owner: { kind: 'session', id: 'happier_session_b' } });
            expect(await close('happier_session_b')).toMatchObject({ status: 'dispatched' });
            const markerB = markers.get('happier_session_b')!;
            expect(await readFile(markerB.profile, 'utf8')).toBe('happier_session_b');
            await result.dispose?.();
            expect(unboundSessions).toEqual(['happier_session_a', 'happier_session_a', 'happier_session_a', 'happier_session_b']);
            // Adapter disposal ends a Chromium runtime, not its owning Session.
            expect(await readFile(markerB.profile, 'utf8')).toBe('happier_session_b');
            expect(await readFile(markerB.partition, 'utf8')).toBe('happier_session_b');
            const resumed = await factory(factoryInput);
            expect(resumed.ok).toBe(true);
            if (!resumed.ok) throw new Error(resumed.disabledReason);
            expect(await resumed.adapter.dispatchCommand(open('happier_session_b'))).toMatchObject({ status: 'dispatched' });
            expect(spawnArgs[4]?.find(arg => arg.startsWith('--user-data-dir='))).toBe(directories[1]);
            expect(await readFile(markerB.profile, 'utf8')).toBe('happier_session_b');
            expect(await readFile(markerB.partition, 'utf8')).toBe('happier_session_b');
            expect(await store.purgeForSessionDeleted({ sessionId: 'happier_session_b' }))
                .toMatchObject({ failedProfileIds: [], purgedProfileIds: expect.arrayContaining(['other_session_profile']) });
            expect(store.listProfiles()).toEqual([]);
            expect(resumed.adapter.ownsView({ browserSessionId: 'happier_session_b', viewId: 'view' })).toBe(false);
            await resumed.dispose?.();
            await expect(stat(markerB.profile)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(markerB.partition)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
