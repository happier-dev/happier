import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentSetActionInputV1Schema, PluginAvailabilityIntentSetActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm } }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
// Consent is dispatched through the real Action front door. Its cold graph is
// collection setup rather than part of the interaction under test.
await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

afterEach(async () => { standardCleanup(); await account.reset(); confirm.mockClear(); });

it('enables Account hosting only after the explicit hosting control is selected', async () => {
    const pluginId = 'example.brand';
    await account.restore({ accountId: 'account-a', currentAccount: true,
        serverIdentityId: 'srv_plugin_hosting_consent', machines: [] });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) throw new Error('Expected the restored Account lifetime');
    const scope = lifetime.scope;
    const release = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({ availabilityCursor: 4, facts: {
        ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Brand', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] } }),
        collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [{ resourceId: 'brand', path: 'assets/brand.png', mimeType: 'image/png', byteSize: 3, digestSha256: `sha256:${'d'.repeat(64)}` }] },
    } }).facts;
    let intent = PluginAvailabilityIntentSetActionOutputV1Schema.parse({ intent: {
        pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1',
    } }).intent;
    const intentPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'];
    // The real Sync hydrator and both UI/Action readers consume the same Home
    // responses under the captured canonical Account, not a local profile id.
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
        body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 4, snapshots: [] }),
    });
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
        select: () => ({ body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 4,
            pluginIds: [pluginId], failedPluginIds: [], intentReads: [{ pluginId, response:
                PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 4,
                    hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                    intent, release, uiArtifacts: [], packageAssets: [] }) }] }) }),
    });
    account.home.answer(account.serverId, intentPath, { select: body => {
        const input = PluginAvailabilityIntentSetActionInputV1Schema.parse(body);
        if (input.expectedRevision !== intent.revision) return { status: 409, body: { error: 'plugin_intent_revision_conflict' } };
        expect(input).toMatchObject({ pluginId, desiredVersion: '1.0.0', enabled: true,
            offlineUiHosting: 'enabled', expectedRevision: 'intent-1' });
        const { expectedRevision: _revision, managedResourceDispositions: _dispositions, ...next } = input;
        const response = PluginAvailabilityIntentSetActionOutputV1Schema.parse({ intent: { ...next, revision: 'intent-2' } });
        intent = response.intent;
        return { body: response };
    } });
    await getSyncSingleton().refreshPluginAccountAvailability();
    const reader = readPluginAccountAvailability(scope);
    await waitForHomeGovernance(() => expect(reader.readCurrentReleaseSelection({ pluginId })).toMatchObject({
        kind: 'available', intent: { offlineUiHosting: 'disabled', revision: 'intent-1' },
    }));
    const screen = await renderScreen(<PluginAccountReleaseSelectionSection
        pluginId={pluginId} version={null} reader={reader} projection={null}
        daemon={{ serverId: null, serverIdentityId: null, machineId: null }} testID="release"
    />);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.findByTestId('release.hosting')).not.toBeNull();
    expect(screen.findByTestId('release.hosting')?.props.disabled).not.toBe(true);
    expect(intent.offlineUiHosting).toBe('disabled');
    expect(account.home.requestsFor(intentPath)).toHaveLength(0);
    await act(async () => { screen.findByTestId('release.hosting')?.props.onPress(); });
    await waitForHomeGovernance(() => expect(reader.readCurrentReleaseSelection({ pluginId })).toMatchObject({
        kind: 'available', intent: { offlineUiHosting: 'enabled', revision: 'intent-2' },
    }));
    expect(intent.offlineUiHosting).toBe('enabled');
    expect(account.home.requestsFor(intentPath)).toHaveLength(1);
    expect(screen.findByTestId('release.clearCache')).toBeNull();
});
