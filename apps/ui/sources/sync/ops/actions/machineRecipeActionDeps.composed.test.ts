import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiMachineRecipesRead } = await import('./machineRecipeActionDeps');
const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');

it('resolves enabled Account Software declarations through the UI host without a Machine read', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let machineReads = 0;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://inert-software.test', accountId: 'viewer',
        request: (url, init) => {
            if (new URL(String(url)).pathname.startsWith('/v1/machines')) machineReads++;
            return http.request(url, init);
        } });
    const previous = storage.getState();
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        storage.setState({ machines: {}, sessions: {} });
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/machine-recipes/src/manifest');
        // The default UI test config replaces the bundled byte inventory with an empty asset boundary.
        // Supply the real authored declaration through the Account HTTP response boundary instead.
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version, enabled: true,
                offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: PLUGIN_MANIFEST,
                collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [],
        });
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }], materializations: [], snapshots: [] } });
        machineReads = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            machineRecipesRead: createUiMachineRecipesRead(account),
        }));
        const result = await executor.execute('action.options.resolve', {
            optionsSourceId: 'machines.setup.software.available', draftInput: {},
        }, { surface: 'ui', authority: 'present_user', serverId: account.serverId, runtimeAccountId: account.accountId });
        expect(result).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
            expect.objectContaining({ value: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' },
                label: 'Google Chrome' }),
        ]) } });
        if (!result.ok) throw new Error('Expected Software offerings');
        expect(result.result).not.toHaveProperty('machineRecipeDetails');
        expect(machineReads).toBe(0);
    } finally { account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
