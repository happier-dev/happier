import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createBrowserRoutePublication } from './routePublication';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createProductBrowserSidecarControlAdapterFactory } from '../sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../sidecar/launchOwner';
import { createSnapshotMaskingFixture } from '../context/cdp/snapshotMasking.testkit';
import { createDaemonSessionMutationCustody } from '../../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { BrowserDaemonControlRoutes } from './routes';
import type { BrowserContextRoutes } from '../context/routes';

const environment = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', async importOriginal => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: new Proxy(actual.configuration, { get(target, key, receiver) {
        if (key === 'happyHomeDir') return environment.home;
        if (key === 'logsDir') return join(environment.home, 'logs');
        return Reflect.get(target, key, receiver);
    } }) };
});

it.each(['actionPopup', 'optionsPage'] as const)('captures an admitted persistent-profile extension $0 through published context routes', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'browser-popup-context-'));
    environment.home = root;
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const profile = await profiles.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, cleanupOnSessionClose: false });
    const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
        source: { kind: 'unpacked' as const, directory: '/fixture' }, directory: join(root, 'extension'),
        permissions: [], hostPermissions: [], actionPopup: 'popup.html', optionsPage: 'options.html' };
    await profiles.setExtension(profile.profileId, extension);
    let managedPackageAvailable = false;
    const factory = createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
        resolveManagedCandidate: async () => managedPackageAvailable ? ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }) : null,
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            // Only OS process and Chromium/CDP boundaries are substituted.
            spawnProcess: () => {
                const child = new EventEmitter(); const stderr = new PassThrough();
                return Object.assign(child, { pid: 84, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                    kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
            },
            connectTransport: async () => ({ transport: {
                openPage: async () => ({ targetId: 'popup-target', sessionId: 'popup-cdp' }),
                dispatchBrowserCommand: async () => ({}),
                dispatchPageCommand: async command => {
                    if (command.method === 'DOMSnapshot.captureSnapshot') return createSnapshotMaskingFixture();
                    if (command.method === 'Runtime.evaluate') return { result: { type: 'string', value: 'Extension control' } };
                    return {};
                },
            } }),
        }),
    });
    let control: BrowserDaemonControlRoutes | undefined;
    let context: BrowserContextRoutes | undefined;
    const credentials = { token: 'fixture', encryption: null } as const;
    const features = FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
        viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true }, context: { enabled: true } } } });
    const publication = createBrowserRoutePublication({ params: {
        machineId: 'machine', credentials, serverBaseUrl: 'http://127.0.0.1:3030', processEnv: {},
        readMachineMemory: () => ({ reported: true, totalBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3,
            usedBytes: 0, pressure: { level: 'calm', source: 'none' } }),
        getApiMachineForSessions: () => null, browserSidecarControlAdapterFactory: factory,
        daemonSessionMutationCustody: createDaemonSessionMutationCustody({ credentials }),
        onBrowserControlRoutesReady: value => { control = value; },
        onBrowserContextRoutesReady: value => { context = value; },
    }, readSessionAccountId: () => 'owner', runtimeActionRouteProviderTarget: {},
        setGuardBrowserResourceOwner: () => {}, shutdownSignal: new AbortController().signal,
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
    try {
        await publication.refreshBrowserRouteOwners();
        expect(await control?.extensions?.execute('browser.extensions.list', { machineId: 'machine' }))
            .toMatchObject({ status: 'ready', entries: [{ profileId: profile.profileId, extension }] });
        expect(await control?.extensions?.execute('browser.extensions.openActionPopup',
            { machineId: 'machine', browserSessionId: 'session', viewId: 'before-install',
                profileId: profile.profileId, extensionId: extension.id, commandId: 'before-install' }))
            .toMatchObject({ status: 'unavailable', code: 'managed_browser_required' });
        managedPackageAvailable = true;
        await publication.refreshBrowserRouteOwners();
        const view = { browserSessionId: 'session', viewId: 'extension-view' };
        expect(await control?.extensions?.execute(kind === 'actionPopup' ? 'browser.extensions.openActionPopup' : 'browser.extensions.openOptions',
            { machineId: 'machine', ...view, profileId: profile.profileId, extensionId: extension.id, commandId: 'open' }))
            .toMatchObject({ status: 'dispatched' });
        expect(await context?.captureSnapshot?.({ ...view, navigationGeneration: 0, contextId: 'snapshot' }))
            .toMatchObject({ visibleText: 'Extension control', sourceViewId: view.viewId });
        expect(control?.getCommandAccessFailure?.(view, { machineAdmission: { role: 'use', actorAccountId: 'guest', custodianAccountId: 'owner' } }))
            .toMatchObject({ status: 'failed', error: { code: 'profile_policy_denied' } });
        const openInNextSession = () => control?.extensions?.execute(kind === 'actionPopup' ? 'browser.extensions.openActionPopup' : 'browser.extensions.openOptions',
            { machineId: 'machine', browserSessionId: 'next-session', viewId: 'next-view', profileId: profile.profileId,
                extensionId: extension.id, commandId: 'next-open' });
        expect(await openInNextSession()).toMatchObject({ status: 'failed', error: { code: 'profile_policy_denied' } });
        await publication.purgeBrowserStorageForSessionDeleted('unrelated-session');
        expect(await openInNextSession()).toMatchObject({ status: 'failed', error: { code: 'profile_policy_denied' } });
        await publication.purgeBrowserStorageForSessionDeleted(view.browserSessionId);
        expect(control?.listViews?.(view.browserSessionId)).toEqual([]);
        expect(await profiles.loadPersistentProfile(profile.profileId)).toMatchObject({ lifecycleState: 'active' });
        expect((await profiles.listExtensions(profile.profileId)).ok).toBe(true);
        expect(await openInNextSession()).toMatchObject({ status: 'dispatched' });
    } finally {
        await publication.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
