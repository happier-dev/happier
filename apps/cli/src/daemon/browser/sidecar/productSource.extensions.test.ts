import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';
import type { BrowserEventV1 } from '@happier-dev/protocol';

import { createBrowserExtensionService } from '../extensions/service';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';

describe('persistent browser profile launch', () => {
    it('cold-loads selected profile extensions on each process start and retains storage after the last view closes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-extension-launch-'));
        const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        const prepared = createStore();
        const profile = await prepared.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
            owner: { kind: 'user', id: 'personal' }, cleanupOnSessionClose: false });
        const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
            source: { kind: 'unpacked' as const, directory: '/source/extension' },
            directory: join(prepared.resolveProfileDirectory(profile.profileId), 'extensions', 'packages', 'fixture'),
            permissions: [], hostPermissions: [], actionPopup: 'popup.html', optionsPage: 'options.html' };
        await prepared.setExtension(profile.profileId, extension);
        await prepared.setExtension(profile.profileId, { ...extension, id: 'b'.repeat(32), enabled: false, directory: '/disabled' });
        const profiles = createStore();
        const launches: string[][] = [];
        let openedPages = 0;
        const factory = createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                // Only the native process and CDP network boundaries are substituted.
                spawnProcess: (_executable, args) => {
                    launches.push([...args]);
                    const child = new EventEmitter();
                    const stderr = new PassThrough();
                    return Object.assign(child, { pid: 84, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                        kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
                },
                connectTransport: async () => ({ transport: {
                    openPage: async () => {
                        const page = ++openedPages;
                        return { targetId: `target_${page}`, sessionId: `cdp_${page}` };
                    },
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
                } }),
            }),
        });
        const runtime = await factory({ machineId: 'machine', readMachineMemory: () => ({ reported: true,
            totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedBytes: 0,
            pressure: { level: 'calm', source: 'none' } }) });
        if (!runtime.ok) throw new Error(runtime.errorCode);
        const extensionService = createBrowserExtensionService({ profileStore: profiles, runtime: runtime.extensions });
        const browserEvents: BrowserEventV1[] = [];
        runtime.contextCapture?.subscribeBrowserEvents?.(event => browserEvents.push(event));
        const open = (browserSessionId: string, profileId?: string) => runtime.adapter.dispatchCommand({
            kind: 'openView', commandId: `open:${browserSessionId}`, browserSessionId, viewId: 'view', platform: 'web', focus: true,
            ...(profileId ? { profileId } : {}), target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test' },
        });
        const close = (browserSessionId: string) => runtime.adapter.dispatchCommand({
            kind: 'closeView', commandId: `close:${browserSessionId}`, browserSessionId, viewId: 'view',
        });
        try {
            expect(await open('session', profile.profileId)).toMatchObject({ status: 'dispatched',
                events: expect.arrayContaining([expect.objectContaining({ kind: 'sessionCreated', profileId: profile.profileId })]) });
            expect(runtime.contextCapture?.resolveProfile?.({ browserSessionId: 'session', viewId: 'view' })?.profileId).toBe(profile.profileId);
            expect(launches[0]).toEqual(expect.arrayContaining([
                `--user-data-dir=${profiles.resolveProfileDirectory(profile.profileId)}`,
                `--load-extension=${extension.directory}`, `--disable-extensions-except=${extension.directory}`,
            ]));
            expect(runtime.extensions?.getProfileRuntime?.(profile.profileId)).toEqual({ active: true, extensionDirectories: [extension.directory] });
            const extensionView = { machineId: 'machine', browserSessionId: 'session',
                profileId: profile.profileId, extensionId: extension.id };
            expect(await extensionService.execute('browser.extensions.openActionPopup', {
                ...extensionView, commandId: 'popup', viewId: 'popup' })).toMatchObject({ status: 'dispatched',
                    events: expect.arrayContaining([expect.objectContaining({ kind: 'viewOpened', viewId: 'popup' })]) });
            expect(await extensionService.execute('browser.extensions.openOptions', {
                ...extensionView, commandId: 'options', viewId: 'options' })).toMatchObject({ status: 'dispatched',
                    events: expect.arrayContaining([expect.objectContaining({ kind: 'viewOpened', viewId: 'options' })]) });
            const disable = { machineId: 'machine', profileId: profile.profileId, extensionId: extension.id };
            expect(await extensionService.execute('browser.extensions.disable', disable)).toEqual({
                status: 'needs_restart_confirmation', profileId: profile.profileId,
            });
            expect(await profiles.listExtensions(profile.profileId)).toMatchObject({ ok: true,
                extensions: expect.arrayContaining([expect.objectContaining({ id: extension.id, enabled: true })]) });
            expect(launches).toHaveLength(1);
            expect(runtime.extensions?.getProfileRuntime?.(profile.profileId)).toEqual({ active: true, extensionDirectories: [extension.directory] });
            expect(await open('other', profile.profileId)).toMatchObject({ status: 'failed' });
            expect(await open('session', 'absent')).toMatchObject({ status: 'failed' });
            expect(runtime.adapter.listViews?.('session')).toHaveLength(3);
            expect(await extensionService.execute('browser.extensions.disable', { ...disable, restartConfirmed: true }))
                .toMatchObject({ status: 'updated', entry: { extension: { id: extension.id, enabled: false } } });
            expect(browserEvents.filter(event => event.kind === 'viewClosed').map(event => event.viewId).sort())
                .toEqual(['options', 'popup', 'view']);
            expect(await extensionService.execute('browser.extensions.openActionPopup', {
                ...extensionView, commandId: 'disabled-popup', viewId: 'disabled-popup' }))
                .toEqual({ status: 'unavailable', code: 'extension_disabled' });
            expect(runtime.extensions?.getProfileRuntime?.(profile.profileId)).toEqual({ active: false, extensionDirectories: [] });
            expect(await profiles.purgeForSessionDeleted({ sessionId: 'session' })).toEqual({ purgedProfileIds: [], failedProfileIds: [] });
            expect((await profiles.listExtensions(profile.profileId)).ok).toBe(true);
            expect(await open('session', profile.profileId)).toMatchObject({ status: 'dispatched' });
            expect(launches).toHaveLength(2);
            expect(launches[1]?.some(arg => arg.startsWith('--load-extension='))).toBe(false);
            await close('session');
            expect(await open('missing', 'absent')).toMatchObject({ status: 'failed' });
            expect(await profiles.loadPersistentProfile('absent')).toBeNull();
        } finally { await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
    });

    it('requires confirmation before changing a profile whose native engine is still starting', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-extension-starting-'));
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        const profile = await profiles.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
            owner: { kind: 'user', id: 'personal' } });
        const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
            source: { kind: 'unpacked' as const, directory: '/source/extension' },
            directory: join(profiles.resolveProfileDirectory(profile.profileId), 'extensions', 'packages', 'fixture'),
            permissions: [], hostPermissions: [] };
        await profiles.setExtension(profile.profileId, extension);
        let notifySpawn: () => void = () => {};
        const spawned = new Promise<void>(resolve => { notifySpawn = resolve; });
        const factory = createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                // The native pipe stays open while the Browser.getVersion readiness reply is pending.
                spawnProcess: () => {
                    const child = new EventEmitter();
                    notifySpawn();
                    return Object.assign(child, { pid: 84, stderr: new PassThrough(), stdio: [null, null, null, new PassThrough(), new PassThrough()],
                        kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
                },
            }),
        });
        const runtime = await factory({ machineId: 'machine' });
        if (!runtime.ok) throw new Error(runtime.errorCode);
        const service = createBrowserExtensionService({ profileStore: profiles, runtime: runtime.extensions });
        const opening = runtime.adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: 'session',
            viewId: 'view', platform: 'web', focus: true, profileId: profile.profileId,
            target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test' } });
        try {
            await spawned;
            const disable = { machineId: 'machine', profileId: profile.profileId, extensionId: extension.id };
            expect(await service.execute('browser.extensions.disable', disable)).toEqual({
                status: 'needs_restart_confirmation', profileId: profile.profileId,
            });
            expect(await profiles.listExtensions(profile.profileId)).toMatchObject({ ok: true, extensions: [{ enabled: true }] });
            expect(await service.execute('browser.extensions.disable', { ...disable, restartConfirmed: true }))
                .toMatchObject({ status: 'updated', entry: { extension: { enabled: false } } });
            expect(await opening).toMatchObject({ status: 'failed' });
            expect(runtime.extensions?.getProfileRuntime?.(profile.profileId)).toEqual({ active: false, extensionDirectories: [] });
        } finally { await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
    });
});
