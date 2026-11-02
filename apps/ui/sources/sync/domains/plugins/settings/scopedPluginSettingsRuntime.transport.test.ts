import { describe, expect, it, onTestFinished } from 'vitest';
import type { SettingsChange } from '@happier-dev/plugin-sdk/settings';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
// Load the real Sync/Settings graph after its network boundary is installed,
// before the test's observable-operation deadline begins.
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { createUiAccountActionSettingsService } = await import('./accountActionSettings');
const { publishActiveScopedPluginSettingsChanges } = await import('./scopedPluginSettingsChangeWatch');


describe('Account plugin Settings HTTP issue admission', () => {
    it('observes only changed portable Account setting ids through the real scoped record and retires its watch', async () => {
        const bridge = await loadSyncSingletonForTests();
        let revision = 1;
        let values = { limit: 5, other: 'before' };
        let reads = 0;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://portable-settings.test', serverIdentityId: 'srv_portable_settings', accountId: 'account-a',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/plugin-settings/acme.settings') {
                    reads += 1;
                    return Response.json({ status: 'present', revision, content: { t: 'plain', v: { v: 1, values } } });
                }
                return null;
            },
        });
        onTestFinished(async () => { clearPluginAccountAvailabilityProjection(); await connection.dispose(); bridge.dispose(); });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real active Account lifetime');
        const declaration = ingestPluginManifestV2({ schemaVersion: 2, id: 'acme.settings', version: '1.0.0',
            displayName: 'Settings reader', runtime: { apiVersion: 1 }, contributes: { settings: [{
                id: 'preferences', version: 1, title: 'Preferences', target: { kind: 'plugin' }, scope: 'account',
                fields: [{ id: 'limit', title: 'Limit', schema: { type: 'integer' }, default: 3 },
                    { id: 'other', title: 'Other', schema: { type: 'string' }, default: 'default' }],
                presentation: { sections: [], subagentSections: [] },
            }] } });
        if (!declaration.ok) throw new Error(JSON.stringify(declaration.diagnostics));
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId: declaration.manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: declaration.manifest.id, desiredVersion: '1.0.0', enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: declaration.manifest.id, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: declaration.manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const controller = new AbortController();
        const settings = createUiAccountActionSettingsService({ pluginId: declaration.manifest.id,
            accountLifetime: lifetime, signal: controller.signal, isCurrent: () => lifetime.isCurrent(),
        }).forScope({ kind: 'account' });
        const changes: SettingsChange[] = [];
        let onChange = createDeferred<SettingsChange>();
        const watch = settings.watch(change => { changes.push(change); onChange.resolve(change); });
        const publish = () => publishActiveScopedPluginSettingsChanges([{ cursor: revision, kind: 'pluginDomain',
            entityId: 'pluginDomain/acme.settings/settings', changedAt: revision,
            hint: { pluginDomain: 'settings', pluginId: 'acme.settings', scope: 'account', revision } }]);
        try {
            await expect(settings.snapshot()).resolves.toMatchObject({ revision: '1', values });
            await flushHookEffects();
            revision = 2;
            values = { ...values, other: 'after' };
            publish();
            await expect(onChange.promise).resolves.toMatchObject({ changedIds: ['other'], values });
            onChange = createDeferred<SettingsChange>();
            // Repeated level-triggered hints do not invent a field change.
            publish();
            await flushHookEffects();
            expect(changes.map(change => change.changedIds)).toEqual([['other']]);
            revision = 3;
            values = { ...values, limit: 9 };
            publish();
            await expect(onChange.promise).resolves.toMatchObject({ changedIds: ['limit'], values });
            await flushHookEffects();
            expect(changes.map(change => change.changedIds)).toEqual([['other'], ['limit']]);
            controller.abort();
            const beforeRetirement = reads;
            revision = 4;
            publish();
            expect(reads).toBe(beforeRetirement);
        } finally {
            controller.abort(); watch.dispose();
        }
    });

    it.each(['field-retired', 'account-retired', 'current'] as const)(
        'checks the existing intent after encryption preparation: %s', async disposition => {
            const bridge = await loadSyncSingletonForTests();
            const mode = createDeferred<Response>();
            const preparingWrite = createDeferred<void>();
            const posts: unknown[] = [];
            let recordRead = false;
            let intentCurrent = true;
            const connection = await restoreServerAccountForTest({
                serverUrl: 'https://plugin-settings-issue.test', serverIdentityId: 'srv_settings_issue', accountId: 'account-a',
                request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/v1/account/encryption') {
                        if (recordRead) { preparingWrite.resolve(); return mode.promise; }
                        return Response.json({ mode: 'plain', updatedAt: 1 });
                    }
                    if (path === '/v1/account/plugin-settings/acme.settings') {
                        if (init?.method === 'POST') {
                            posts.push(JSON.parse(String(init.body)));
                            return Response.json({ status: 'updated', revision: 1 });
                        }
                        recordRead = true;
                        return Response.json({ status: 'absent' });
                    }
                    return null;
                },
            });
            try {
                const { scopedPluginSettingsStorageAdapterForTests: scopedPluginSettingsAdapter } = await import('./scopedPluginSettingsRuntime');
                const write = scopedPluginSettingsAdapter.write({
                    pluginId: 'acme.settings', scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'srv_settings_issue' },
                    fields: [{ key: 'endpoint', redacted: false }], fieldId: 'endpoint',
                    mutation: { kind: 'set', value: 'https://endpoint.test' },
                    expectedRevision: { kind: 'account', value: 'absent' }, isCurrent: () => intentCurrent,
                });
                await preparingWrite.promise;
                if (disposition === 'field-retired') intentCurrent = false;
                if (disposition === 'account-retired') {
                    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                    await disconnectActiveServerConnection();
                }
                mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
                const result = await write;
                if (disposition === 'current') {
                    expect(result.status).toBe('ready');
                    expect(posts).toEqual([{ expectedRevision: 'absent', content: {
                        t: 'plain', v: { v: 1, values: { endpoint: 'https://endpoint.test' } },
                    } }]);
                } else {
                    expect(posts).toEqual([]);
                    expect(result).toEqual({ status: 'unavailable', reason: 'transport' });
                }
            } finally { mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 })); await connection.dispose(); bridge.dispose(); }
        },
    );
});
