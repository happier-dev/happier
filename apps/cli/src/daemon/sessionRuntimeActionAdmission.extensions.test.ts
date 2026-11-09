import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { BROWSER_EXTENSION_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';

import { createDaemonControlApp } from './controlServer';
import { buildDaemonControlHttpHeaders } from './controlHttp';
import { createDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import type { TrackedSession } from './types';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from './browser/actions/controlTransport';
import { createBrowserDaemonControlBroker } from './browser/control/broker';
import { createBrowserDaemonControlRoutes } from './browser/control/routes';
import { createBrowserExtensionService } from './browser/extensions/service';
import { createBrowserProfileStore } from './browser/profiles/store';
import { createBrowserStoragePartitionOwner } from './browser/storage/partitions';

it.each(['use', undefined, 'manage', 'owner'] as const)('requires Manage custody before a Session installs extensions (%s)', async role => {
    const root = await mkdtemp(join(tmpdir(), 'browser-extension-admission-'));
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    await profiles.registerPersistentProfile({ profileId: 'owner-personal', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, cleanupOnSessionClose: false });
    // Private lifecycle custody is supplied by the daemon, never the request body.
    const child = { happySessionId: 'session', startedBy: 'daemon', pid: 4242,
        ...(role === 'owner' ? {} : { requesterSessionRuntimeContext: { bootstrap: {
            savedSecretOperationContext: { machineAdmission: { role } },
        } } }),
    } as unknown as TrackedSession;
    const app = createDaemonControlApp({ getChildren: () => [child], machineId: 'machine', controlToken: 'extension-admission',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {},
            resolveRouteOwners: () => ({ browserControl: createBrowserDaemonControlRoutes({ broker: createBrowserDaemonControlBroker(),
                extensions: createBrowserExtensionService({ profileStore: profiles }) }) }),
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
            } }) }),
        }) });
    try {
        const directory = join(root, 'unpacked');
        await mkdir(directory);
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3,
            name: 'Admission fixture', version: '1.0', permissions: ['storage'] }));
        const response = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('extension-admission'), payload: { sessionId: 'session',
                actionId: 'browser.extensions.install', input: { machineId: 'machine', profileId: 'owner-personal',
                    source: { kind: 'unpacked', directory },
                    reviewedPermissions: { version: '1.0', permissions: ['storage'], hostPermissions: [] } } } });
        expect(response.statusCode).toBe(200);
        if (role === 'manage' || role === 'owner') {
            expect(response.json().result).toMatchObject({ status: 'updated', entry: { profileId: 'owner-personal' } });
            expect(await profiles.listExtensions('owner-personal')).toMatchObject({ ok: true, extensions: [{ name: 'Admission fixture' }] });
        } else {
            expect(response.json().result).toMatchObject({ ok: false, errorCode: 'access_denied' });
            expect(await profiles.listExtensions('owner-personal')).toMatchObject({ ok: true, extensions: [] });
            for (const actionId of BROWSER_EXTENSION_MUTATION_ACTION_IDS.filter(id => id !== 'browser.extensions.install')) {
                const mutation = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
                    headers: buildDaemonControlHttpHeaders('extension-admission'), payload: { sessionId: 'session', actionId,
                        input: { machineId: 'machine', profileId: 'owner-personal', extensionId: 'a'.repeat(32),
                            ...(actionId === 'browser.extensions.update' ? { expectedVersion: '1.0' } : {}) } } });
                expect(mutation.statusCode).toBe(200);
                expect(mutation.json().result).toMatchObject({ ok: false, errorCode: 'access_denied' });
            }
        }
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
