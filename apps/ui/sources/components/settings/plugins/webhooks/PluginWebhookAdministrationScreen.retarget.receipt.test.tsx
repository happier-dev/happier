import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createPackageAssetArchiveV1, PluginAccountAvailabilityIntentReadResponseV1Schema, PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginWebhookAccountStatusResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/statusV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createDeferred, createMachineFixture, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import type { PluginWebhookAdministrationHttpClient } from '@/sync/api/plugins/webhooks/endpointActions';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => params ? `${key}(${JSON.stringify(params)})` : key,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);

const account = createProviderSettingsAccountHarness();
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { buildPluginDomainAccountChangeEntityId } = await import('@happier-dev/protocol/changes/pluginDomain');

afterEach(async () => {
    standardCleanup();
    clearPluginAccountAvailabilityProjection();
    await account.reset();
});

it('refreshes mounted webhook readiness and queue facts after their Home publication and reconnect recovery', async () => {
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'plugins', true)).toBe(true);
    expect(tryWriteServerEnabledBitInPlace(features, 'plugins.webhooks', true)).toBe(true);
    await account.restore({ accountId: 'webhook-status-observer', features });
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the restored Account scope');
    const endpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
    const initial = PluginWebhookAccountStatusResultV1Schema.parse({ endpoints: [{
        webhookEndpointId: endpointId, revision: 1,
        contribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1', routing: 'accountEndpoint', readiness: 'ready', targetStatus: 'current',
        publicUrl: 'https://server.example/v1/plugins/webhooks/opaque', createdAt: 1,
        queue: { queued: 0, retrying: 0, claimed: 0, deadLetter: 0, oldestPendingAtMs: null },
    }], nextEndpointCursor: null, deadLetters: [] });
    let current = initial;
    let failRead = false;
    // The administration HTTP leaf changes; the mounted query, Home publication and UI stay real.
    const client: PluginWebhookAdministrationHttpClient = {
        readStatus: vi.fn(async () => {
            if (failRead) throw new Error('Transport unavailable');
            return current;
        }),
        executeAction: vi.fn(async () => ({ kind: 'unavailable' as const })),
        replayDelivery: vi.fn(async () => ({ kind: 'unavailable' as const })),
        discardDelivery: vi.fn(async () => ({ kind: 'unavailable' as const })),
    };
    const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
    const endpointTitle = () => screen.findAllByTestId(`settings.plugins.webhooks.endpoint.${endpointId}.status`)
        .find(node => typeof node.props.title === 'string')?.props.title;
    await vi.waitFor(() => expect(endpointTitle()).toContain('"readiness":"ready"'));
    expect(screen.getTextContent()).toContain('"queued":0');
    const readsBeforeWake = vi.mocked(client.readStatus).mock.calls.length;
    const changedEntity = buildPluginDomainAccountChangeEntityId({ pluginDomain: 'webhook', pluginId: 'acme.github' });
    current = PluginWebhookAccountStatusResultV1Schema.parse({ ...initial, endpoints: [{
        ...initial.endpoints[0]!, revision: 2, readiness: 'routeUnavailable', revokedAt: 2,
        queue: { ...initial.endpoints[0]!.queue, queued: 2, oldestPendingAtMs: 2 },
    }] });
    await act(async () => {
        publishHomeAccountChange('other-home', [changedEntity], { source: 'socket', changeKinds: ['pluginDomain'] });
        publishHomeAccountChange(scope.serverId, ['unrelated-session'], { source: 'socket', changeKinds: ['session'] });
    });
    expect(client.readStatus).toHaveBeenCalledTimes(readsBeforeWake);
    expect(endpointTitle()).toContain('"readiness":"ready"');
    await act(async () => {
        publishHomeAccountChange(scope.serverId, [changedEntity], { source: 'socket', changeKinds: ['pluginDomain'] });
    });
    await vi.waitFor(() => expect(endpointTitle()).toContain('"readiness":"routeUnavailable"'));
    expect(screen.getTextContent()).toContain('"queued":2');

    failRead = true;
    await act(async () => {
        publishHomeAccountChange(scope.serverId, [changedEntity], { source: 'socket', changeKinds: ['pluginDomain'] });
    });
    await vi.waitFor(() => expect(screen.findAllByTestId('settings.plugins.webhooks.loadError').length).toBeGreaterThan(0));
    failRead = false;
    current = { ...current, endpoints: [{ ...current.endpoints[0]!, queue: { ...current.endpoints[0]!.queue, queued: 3 } }] };
    await act(async () => {
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected', changesCatchUp: true });
    });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('"queued":3'));
    expect(screen.findAllByTestId('settings.plugins.webhooks.loadError')).toHaveLength(0);
    expect(client.readStatus).toHaveBeenCalledTimes(readsBeforeWake + 3);
});

it('publishes the acknowledged retarget with real origin admission while queue status revalidates', async () => {
    const pluginId = 'acme.github';
    const serverIdentityId = 'srv_webhook_receipt';
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } });
    expect(tryWriteServerEnabledBitInPlace(features, 'plugins', true)).toBe(true);
    expect(tryWriteServerEnabledBitInPlace(features, 'plugins.webhooks', true)).toBe(true);
    const machine = createMachineFixture({ id: 'machine-new', active: true, activeAt: Date.now() });
    const scope = await account.restore({ serverIdentityId, machines: [machine], features });
    const normalizedManifest = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Webhook fixture',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} };
    const archive = createPackageAssetArchiveV1({ manifest: normalizedManifest, files: [] });
    if (!archive) throw new Error('Expected a valid empty package asset archive');
    const availability = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
        release: {
            ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest, collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor,
        },
        packageAssets: [], uiArtifacts: [],
    });
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId, machineId: machine.id, materializationId: 'materialization-new', pluginId, version: '1.0.0',
        archiveDigestSha256: availability.release!.archiveDigestSha256,
        sourceClass: 'registryPackage', portableRelease: true, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
    });
    // The Account projection binds the applied portable scope, not the transport profile alias.
    const appliedScope = getActiveServerAccountScope();
    if (!appliedScope || appliedScope.accountId !== scope.accountId) throw new Error('Expected the restored Account scope');
    replacePluginAccountAvailabilityProjection({ scope: appliedScope, snapshot: {
        availabilityCursor: 1, intentReads: [{ pluginId, response: availability }], materializations: [materialization],
        snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] }],
    } });
    expect(readPluginAccountAvailability(appliedScope).classifyRelease(materialization)).toMatchObject({
        releaseContent: 'matched', validation: { kind: 'admitted' },
    });
    expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id })).not.toBeNull();
    const oldTarget = { machineId: 'machine-old', materializationId: 'materialization-old', pluginId };
    const target = { machineId: machine.id, materializationId: materialization.materializationId, pluginId };
    const initialStatus = PluginWebhookAccountStatusResultV1Schema.parse({ endpoints: [{
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
        contribution: { pluginId, localId: 'issues' }, targetMaterialization: oldTarget,
        sourceInstanceId: 'source-1', routing: 'accountEndpoint', readiness: 'ready', targetStatus: 'current',
        publicUrl: 'https://server.example/v1/plugins/webhooks/opaque', createdAt: 1,
        queue: { queued: 1, retrying: 0, claimed: 0, deadLetter: 0, oldestPendingAtMs: 1 },
    }], nextEndpointCursor: null, deadLetters: [] });
    const revalidation = createDeferred<void>();
    const client: PluginWebhookAdministrationHttpClient = {
        executeAction: vi.fn(async () => ({ kind: 'retargeted', webhookEndpointId: initialStatus.endpoints[0]!.webhookEndpointId,
            revision: 2, previousTargetMaterialization: oldTarget, targetMaterialization: target })),
        readStatus: vi.fn().mockResolvedValueOnce(initialStatus).mockImplementation(() => revalidation.promise.then(() => ({
            ...initialStatus, endpoints: [{ ...initialStatus.endpoints[0]!, revision: 2, targetMaterialization: target }],
        }))),
        replayDelivery: vi.fn(async () => ({ kind: 'unavailable' as const })),
        discardDelivery: vi.fn(async () => ({ kind: 'unavailable' as const })),
    };
    const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
    const id = `settings.plugins.webhooks.endpoint.${initialStatus.endpoints[0]!.webhookEndpointId}.retarget`;
    try {
        await vi.waitFor(() => {
            const control = screen.findHostByTestId(id);
            expect(control).not.toBeNull();
            expect(Boolean(control!.props.disabled), screen.getTextContent()).toBe(false);
        });
        await act(async () => screen.pressByTestId(id));
        await vi.waitFor(() => expect(client.executeAction).toHaveBeenCalledWith('plugin.webhook.endpoint.retarget', expect.objectContaining({
            expectedRevision: 1, targetMaterialization: target,
        })));
        await vi.waitFor(() => expect(client.readStatus).toHaveBeenCalledTimes(2));
        await act(async () => { await Promise.resolve(); });
        const control = screen.findHostByTestId(id)!;
        expect(Boolean(control.props.accessibilityState?.busy)).toBe(false);
        expect(Boolean(control.props.disabled)).toBe(true);
        const status = screen.findAllByTestId(`settings.plugins.webhooks.endpoint.${initialStatus.endpoints[0]!.webhookEndpointId}.status`)
            .find(node => typeof node.props.subtitle === 'string');
        expect(status?.props.subtitle).toContain(machine.id);
    } finally {
        revalidation.resolve();
        await screen.unmount();
    }
});
