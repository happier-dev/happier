import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';

describe('product Browser Session stop', () => {
    // Explicit installed engine only; the test never acquires a runtime or opens user data.
    it.skipIf(!process.env.HAPPIER_BROWSER_TEST_EXECUTABLE).each([
        'last-view', 'session-stop', 'private', 'already-exited', 'transport-closed', 'purge-failure',
    ] as const)('settles through the real caller: %s', async mode => {
        const directory = await mkdtemp(join(tmpdir(), 'browser-product-stop-'));
        const children: ChildProcess[] = [];
        const exits: Promise<void>[] = [];
        const server = createServer((_request, response) => response.end('<!doctype html><title>Stop fixture</title>'));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Page fixture unavailable');
        const profiles = createBrowserProfileStore({ storageRootDirectory: directory,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: directory }),
            // Filesystem removal is the substituted boundary for the purge-failure control.
            ...(mode === 'purge-failure' ? { removeDirectory: async () => { throw new Error('fixture_remove_failed'); } } : {}),
        });
        if (mode !== 'private') profiles.register({ profileId: 'retained', storageMode: 'user',
            owner: { kind: 'user', id: 'fixture' }, cleanupOnSessionClose: false });
        const runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage',
                executablePath: process.env.HAPPIER_BROWSER_TEST_EXECUTABLE!, available: true, discoveryKind: 'managedRuntime',
                provenance: { origin: 'managed_package', pinnedVersion: '145.0.7632.6', channel: 'stable',
                    integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                // OS process boundary only. Both lifecycle owners and the inherited CDP transport stay real.
                spawnProcess: (file, args) => {
                    const child = spawn(file, [...args, '--no-sandbox'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
                    children.push(child);
                    exits.push(new Promise(resolve => child.once('exit', () => resolve())));
                    console.info(JSON.stringify({ event: 'engine_started', mode, pid: child.pid }));
                    return child;
                },
            }),
        })({ machineId: 'stop-fixture' });
        if (!runtime.ok || !runtime.contextCapture) throw new Error('Browser fixture unavailable');
        const view = { browserSessionId: 'fixture-session', viewId: 'fixture-view' };
        const open = () => runtime.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web',
            ...(mode === 'private' ? {} : { profileId: 'retained' }),
            target: { kind: 'externalUrl', targetId: 'fixture-page', url: `http://127.0.0.1:${address.port}/` } });
        const pageCommand = (method: string, params?: Record<string, unknown>) => {
            const handle = runtime.contextCapture!.resolvePageHandle(view);
            if (!handle) throw new Error('Page fixture unavailable');
            return runtime.contextCapture!.transport.dispatchPageCommand({ ...handle, method, params });
        };
        try {
            expect(await open()).toMatchObject({ status: 'dispatched' });
            const profile = profiles.listProfiles()[0]!;
            const profileDirectory = profiles.resolveProfileDirectory(profile.profileId);
            expect(await pageCommand('Network.setCookie', { name: 'recent_stop', value: 'present',
                url: `http://127.0.0.1:${address.port}/`, expires: Math.floor(Date.now() / 1000) + 3600 }))
                .toMatchObject({ success: true });
            if (mode === 'already-exited') {
                children[0]!.kill('SIGTERM');
                await exits[0];
            } else if (mode === 'transport-closed') {
                children[0]!.stdio[3]?.destroy();
                children[0]!.stdio[4]?.destroy();
            }
            if (mode === 'last-view') {
                expect(await runtime.adapter.dispatchCommand({ ...view, kind: 'closeView', commandId: 'close-last' }))
                    .toMatchObject({ status: 'dispatched' });
            } else if (mode === 'purge-failure') {
                expect(await profiles.purgeForExplicitRequest({ profileIds: [profile.profileId] }))
                    .toMatchObject({ failedProfileIds: [profile.profileId] });
            } else {
                await runtime.stopSession?.(view.browserSessionId);
            }
            expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
            if (mode === 'last-view' || mode === 'session-stop') {
                const lockLeft = await lstat(join(profileDirectory, 'SingletonLock')).then(() => true, () => false);
                expect(await open()).toMatchObject({ status: 'dispatched' });
                const stored = await pageCommand('Network.getCookies', { urls: [`http://127.0.0.1:${address.port}/`] }) as {
                    cookies: { name: string; value: string }[];
                };
                expect(stored.cookies.some(cookie => cookie.name === 'recent_stop' && cookie.value === 'present')).toBe(true);
                expect(lockLeft).toBe(false);
            } else if (mode === 'private') {
                await profiles.purgeForSessionDeleted({ sessionId: view.browserSessionId });
                await expect(access(profileDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
            } else if (mode === 'purge-failure') {
                expect(profiles.getProfile(profile.profileId)?.lifecycleState).toBe('unusable');
            }
        } finally {
            await runtime.dispose?.();
            for (const child of children) {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            }
            await Promise.all(exits);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });
});
