import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { FeaturesResponseSchema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';

import { createDaemonControlApp } from '@/daemon/controlServer';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
import type { TrackedSession } from '@/daemon/types';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from '../actions/controlTransport';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserExtensionService } from '../extensions/service';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';

const profileIngresses = ['Session', 'signed Machine'] as const;
const profileRoles = ['use', undefined, 'manage', 'owner'] as const;
it.each(profileIngresses.flatMap(ingress => profileRoles.map(role => ({ ingress, role }))))(
    'isolates guest profiles while preserving $role custody through $ingress', async ({ role, ingress }) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-guest-profile-'));
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const persistent = await profiles.registerPersistentProfile({ profileId: 'owner-personal', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, cleanupOnSessionClose: false });
    const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
        source: { kind: 'unpacked' as const, directory: '/fixture' }, directory: join(root, 'extension'),
        permissions: [], hostPermissions: [], actionPopup: 'popup.html' };
    await profiles.setExtension(persistent.profileId, extension);
    // Private lifecycle custody, with the same shape as the SEC-FIX-CU fixture.
    const guest = { happySessionId: 'guest-session', startedBy: 'daemon', pid: 4242,
        requesterSessionRuntimeContext: role === 'owner' ? undefined : { bootstrap: { savedSecretOperationContext: { machineAdmission: {
            actorAccountId: 'guest', custodianAccountId: 'owner', role } } } } } as unknown as TrackedSession;
    const launches: string[][] = [];
    const runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            // Only the native process and CDP transport boundaries are substituted.
            spawnProcess: (_executable, args) => {
                launches.push([...args]);
                const child = new EventEmitter();
                const stderr = new PassThrough();
                return Object.assign(child, { pid: 84, stderr,
                    stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                    kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
            },
            connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }) } }),
        }),
    })({ machineId: 'machine', readMachineMemory: () => ({ reported: true, totalBytes: 8 * 1024 ** 3,
        availableBytes: 8 * 1024 ** 3, usedBytes: 0, pressure: { level: 'calm', source: 'none' } }) });
    if (!runtime.ok) throw new Error(runtime.errorCode);
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(runtime.adapter);
    const control = createBrowserDaemonControlRoutes({ broker,
        extensions: createBrowserExtensionService({ profileStore: profiles, runtime: runtime.extensions }) });
    const app = createDaemonControlApp({ getChildren: () => [guest], machineId: 'machine', controlToken: 'profile-test',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {},
            resolveRouteOwners: () => ({ browserControl: control }),
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
            } }) }),
        }) });
    const open = (sessionId: string, browserSessionId = sessionId, profileId?: string) =>
        app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('profile-test'), payload: { sessionId, actionId: 'browser.view.open', input: {
                kind: 'openView', commandId: `open:${sessionId}:${browserSessionId}`, browserSessionId, viewId: 'view', platform: 'web',
                ...(profileId ? { profileId } : {}), target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' },
            } } });
    const machineContext = (admittedRole: typeof role) => {
        if (admittedRole === 'owner') return undefined;
        // Admitted host-private ingress fixture: only the custody facet used by Browser is populated.
        const authorization = { requesterAccountProjection: { [requesterActionContext]: {
            savedSecretOperationContext: { machineAdmission: {
                actorAccountId: 'guest', custodianAccountId: 'owner', role: admittedRole,
            } },
        } } } as unknown as ExternalActionExecutionAuthorizationV1;
        return { externalActionExecutionAuthorization: authorization };
    };
    try {
        if (ingress === 'signed Machine') {
            const selected = await control.dispatchCommand({ kind: 'openView', commandId: 'machine-profile-open',
                browserSessionId: 'machine-session', viewId: 'view', platform: 'web', profileId: persistent.profileId,
                target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } }, machineContext(role));
            const popup = await control.extensions!.execute('browser.extensions.openActionPopup', {
                machineId: 'machine', browserSessionId: 'machine-session', viewId: 'popup', commandId: 'machine-popup',
                profileId: persistent.profileId, extensionId: extension.id,
            }, machineContext(role));
            const permitted = role === 'manage' || role === 'owner';
            expect(selected).toMatchObject({ status: permitted ? 'dispatched' : 'failed' });
            expect(popup).toMatchObject({ status: permitted ? 'dispatched' : 'failed' });
            const persistentDirectory = `--user-data-dir=${profiles.resolveProfileDirectory(persistent.profileId)}`;
            expect(launches.some(args => args.includes(persistentDirectory))).toBe(permitted);
            return;
        }
        const ownerDefault = await open('owner-session');
        expect(ownerDefault.statusCode).toBe(200);
        expect(ownerDefault.json().result).toMatchObject({ status: 'dispatched' });
        const selected = await open('guest-session', 'guest-session', persistent.profileId);
        expect(selected.statusCode).toBe(200);
        const popup = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('profile-test'), payload: { sessionId: 'guest-session',
                actionId: 'browser.extensions.openActionPopup', input: { machineId: 'machine',
                    browserSessionId: 'guest-session', viewId: 'popup', commandId: 'open-popup',
                    profileId: persistent.profileId, extensionId: extension.id } } });
        expect(popup.statusCode).toBe(200);
        // Security falsifier: a guest must not launch the custodian's persistent directory.
        const persistentDirectory = `--user-data-dir=${profiles.resolveProfileDirectory(persistent.profileId)}`;
        if (role === 'manage' || role === 'owner') {
            expect(selected.json().result).toMatchObject({ status: 'dispatched' });
            expect(popup.json().result).toMatchObject({ status: 'dispatched' });
            expect(launches.at(-1)).toContain(persistentDirectory);
        } else {
            expect(launches).toHaveLength(1);
            expect(launches.at(-1)).not.toContain(persistentDirectory);
            expect(selected.json().result).toMatchObject({ status: 'failed' });
            expect(popup.json().result).toMatchObject({ status: 'failed' });
            const ownDefault = await open('guest-session');
            expect(ownDefault.json().result).toMatchObject({ status: 'dispatched' });
            const directoryArgs = launches.map(args => args.find(arg => arg.startsWith('--user-data-dir=')));
            expect(new Set(directoryArgs).size).toBe(2);
            expect(directoryArgs).not.toContain(persistentDirectory);
            expect(runtime.contextCapture?.resolveProfile?.({ browserSessionId: 'guest-session', viewId: 'view' }))
                .toMatchObject({ storageMode: 'ephemeral', owner: { kind: 'session', id: 'guest-session' } });
        }
        // Machine opens carry the same private role to the same selection owner.
        const machine = await control.dispatchCommand({ kind: 'openView', commandId: 'machine-open',
            browserSessionId: 'guest-session', viewId: 'machine-view', platform: 'web',
            profileId: persistent.profileId, target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } },
            machineContext(role));
        expect(machine).toMatchObject({ status: role === 'manage' || role === 'owner' ? 'dispatched' : 'failed' });
        if (role === 'manage') {
            // A new Use open cannot silently reuse a persistent engine by omitting profileId.
            expect(await control.dispatchCommand({ kind: 'openView', commandId: 'reuse-owner-profile',
                browserSessionId: 'guest-session', viewId: 'new-guest-view', platform: 'web',
                target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } },
                machineContext('use'))).toMatchObject({ status: 'failed' });
        }
        const forgedSession = await open('guest-session', 'owner-session');
        expect(forgedSession.statusCode).toBe(200);
        expect(forgedSession.json().result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    } finally { await app.close(); await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
});
