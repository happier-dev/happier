import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentSetActionInputV1Schema,
    PluginAvailabilityIntentSetActionOutputV1Schema, PluginAvailabilityReleaseReadActionOutputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema, PluginMachineMaterializationV1Schema,
    type PackageAssetArchiveDescriptorV1 } from '@happier-dev/protocol/plugins/availability';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { renderScreen } from '@/dev/testkit';
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';

// HTTP/credentials/socket and the native modal host are system boundaries.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: navigation }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createPluginAccountReleaseSelectionController } = await import('./pluginAccountReleaseSelectionController');
const { Modal } = await import('@/modal');
// Source-module transformation belongs to collection, outside the behavior
// testcase budget, as in the other real default-executor composition suites.
await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createPluginAccountAvailabilityReader } = await import('@/sync/domains/plugins/availability/reader');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');

let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    vi.mocked(Modal.show).mockClear();
    vi.mocked(Modal.alert).mockClear();
    navigation.push.mockClear();
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Plugin admission', serverUrl: 'https://plugin-admission.test',
        serverIdentityId: 'srv_plugin_admission', accountId: 'owner', currentAccount: true });
    const home = homes.findByServerUrl('https://plugin-admission.test');
    if (!home?.token) throw new Error('Expected authenticated Home');
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, serverIdentityId: 'srv_plugin_admission',
        accountId: 'owner', credentials: { token: home.token }, request: homes.request });
    serverId = connection.home.id;
});
afterEach(async () => { await connection?.dispose(); connection = null; await homes.reset(); });

async function setActionPolicy(raw: unknown) {
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse(raw);
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applySettingsLocal({ actionsSettingsV1 });
    homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: { actionsSettingsV1 } } } });
}

const operations = [
    ['plugins.account.release.select', (controller: ReturnType<typeof createPluginAccountReleaseSelectionController>) => controller.select({
        pluginId: 'example.tasks', version: '2.0.0', reader: null, projection: null,
        daemon: { serverId: null, serverIdentityId: null, machineId: null },
    })],
    ['plugins.account.hosting.set', (controller: ReturnType<typeof createPluginAccountReleaseSelectionController>) => controller.setHostedArtifactsEnabled({
        pluginId: 'example.tasks', reader: null, enabled: true,
    })],
    ['plugins.account.hosting.remove', (controller: ReturnType<typeof createPluginAccountReleaseSelectionController>) => controller.disableAndRemoveHostedArtifacts({
        pluginId: 'example.tasks', reader: null,
    })],
    ['plugins.account.cache.clear', (controller: ReturnType<typeof createPluginAccountReleaseSelectionController>) => controller.clearHostedArtifactCache({
        pluginId: 'example.tasks', reader: null,
    })],
] as const;

describe('Account plugin administration admission through the production UI front door', () => {
    it('explains a machine-local install without offering an impossible Account selection before the census loads', async () => {
        const screen = await renderScreen(createElement(PluginAccountReleaseSelectionSection, {
            pluginId: 'example.tasks', version: '2.0.0', reader: null, projection: null,
            installedDistribution: { kind: 'localPath', canonicalPath: '/tmp/own-plugin' },
            daemon: { serverId, serverIdentityId: 'srv_plugin_admission', machineId: 'machine-a' },
            testID: 'release',
        }));
        expect(screen.findAllByTestId('release').filter(node => node.type !== PluginAccountReleaseSelectionSection)).toHaveLength(0);
        const row = screen.findAllByTestId('release.machineLocal').find(node => typeof node.props.subtitle === 'string');
        expect(row).not.toBeNull();
        expect(row?.props.onPress).toBeUndefined();
        expect(row?.props.subtitle).toBeTruthy();
        expect(homes.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.release.read'])).toHaveLength(0);
    });
    it('opens the exact Account approval and keeps hosted-removal rejection quiet without an Availability mutation', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected active Account');
        await homes.requireUiApproval(serverId, 'plugins.account.hosting.remove');
        const archive = { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [{ resourceId: 'brand',
            path: 'assets/brand.png', mimeType: 'image/png', byteSize: 3, digestSha256: `sha256:${'d'.repeat(64)}` }] } satisfies PackageAssetArchiveDescriptorV1;
        const release = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({ availabilityCursor: 2, facts: {
            ref: { pluginId: 'example.tasks', version: '2.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2 as const, id: 'example.tasks', version: '2.0.0', displayName: 'Tasks',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 as const },
                contributes: { resources: [{ id: 'brand', kind: 'asset' as const, path: 'assets/brand.png', contentType: 'image/png' }] } },
            collectionContracts: [], uiSlots: [], packageAssetArchive: archive } }).facts;
        const reader = createPluginAccountAvailabilityReader({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 2, materializations: [], snapshots: [], intentReads: [{ pluginId: 'example.tasks', response: {
                availabilityCursor: 2, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId: 'example.tasks', desiredVersion: '2.0.0', enabled: true,
                    offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
                release, uiArtifacts: [], packageAssets: [{ release: release.ref,
                    artifactId: '00000000-0000-4000-8000-000000000001', descriptor: archive }],
            } }],
        } });
        const statusController = createPluginAccountReleaseSelectionController();
        expect(statusController.readHostedArtifactStatus({ pluginId: 'example.tasks', reader })).toBe('hosted');
        statusController.retire();
        const screen = await renderScreen(createElement(PluginAccountReleaseSelectionSection, {
            pluginId: 'example.tasks', version: null, reader, projection: null,
            daemon: { serverId: null, serverIdentityId: null, machineId: null }, testID: 'plugin.release',
        }));
        const removal = () => screen.findAllByTestId('plugin.release.removeHosted')
            .find(node => typeof node.props.onPress === 'function');
        try {
            const row = removal();
            expect(row, 'The hosted release must expose its removal control').toBeDefined();
            if (!row) throw new Error('Expected hosted-removal control');
            expect(row.props.disabled).toBe(false);
            await act(async () => { row.props.onPress(); });
            expect(removal()?.props.disabled, 'The removal intent must enter its pending lifetime').toBe(true);
            const artifactId = await waitForHomeGovernance(() => {
                const artifact = homes.artifacts(serverId).list()[0];
                expect(artifact).toBeDefined();
                return artifact!.id;
            });
            const request = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null'));
            expect(request).toMatchObject({ actionId: 'plugins.account.hosting.remove',
                executionOriginV1: { serverId: lifetime.scope.serverId, accountId: lifetime.scope.accountId } });
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
                props: expect.objectContaining({ artifactId, serverId }),
                chrome: expect.objectContaining({ testID: 'approvals.in-place.modal' }),
            })));
            await vi.waitFor(() => expect(homes.requestsFor(`/v1/artifacts/${artifactId}`))
                .toContainEqual(expect.objectContaining({ serverUrl: 'https://plugin-admission.test' })));
            expect(navigation.push).not.toHaveBeenCalled();
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' }, {
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                    surface: 'ui', authority: 'present_user',
                })).toMatchObject({ ok: true });
            });
            await waitForHomeGovernance(() => expect(removal()?.props.disabled).toBe(false));
            expect(Modal.alert).not.toHaveBeenCalled();
            expect(homes.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'])).toHaveLength(0);
            expect(homes.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.remove'])).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it.each(['absent', 'unselected'] as const)('executes the admitted release selection with an %s intent through the real default handler and Availability CAS', async (prior) => {
        await setActionPolicy({ v: 1, approvalWaivedSurfaces: { 'plugins.account.release.select': ['ui'] } });
        const releasePath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.release.read'];
        const intentPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'];
        const release = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({ availabilityCursor: 2, facts: {
            ref: { pluginId: 'example.tasks', version: '2.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: 'example.tasks', version: '2.0.0', displayName: 'Tasks',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} },
            collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        } });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected active Account');
        const expectedRevision = prior === 'unselected' ? 'intent-3' : null;
        let selectedIntent: ReturnType<typeof PluginAvailabilityIntentSetActionOutputV1Schema.parse>['intent'] | null = prior === 'unselected'
            ? { pluginId: 'example.tasks', desiredVersion: null, enabled: false,
                offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-3' }
            : null;
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 2, materializations: [], snapshots: [], intentReads: [{ pluginId: 'example.tasks', response: {
                availabilityCursor: 2, hostingCapability: { enabled: false },
                intent: prior === 'unselected' ? { pluginId: 'example.tasks', desiredVersion: null, enabled: false,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-3' } : null,
                release: null, uiArtifacts: [], packageAssets: [],
            } }],
        } });
        homes.answer(serverId, releasePath, { body: release });
        // The server persists the acknowledged CAS. No socket publication is
        // delivered by this disconnected transport fixture; the mutation must
        // wake the existing Availability acquisition/publication owner.
        homes.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
            body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 3, snapshots: [] }),
        });
        homes.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
            select: () => ({ body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 3,
                pluginIds: ['example.tasks'], failedPluginIds: [], intentReads: [{ pluginId: 'example.tasks',
                    response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 3,
                        hostingCapability: { enabled: false }, intent: selectedIntent,
                        release: selectedIntent?.desiredVersion ? release.facts : null, uiArtifacts: [], packageAssets: [] }) }] }) }),
        });
        homes.answer(serverId, intentPath, { select: body => {
            const request = PluginAvailabilityIntentSetActionInputV1Schema.parse(body);
            if (request.expectedRevision !== expectedRevision) return { status: 409, body: { error: 'plugin_intent_revision_conflict' } };
            expect(request).toMatchObject({ pluginId: 'example.tasks', desiredVersion: '2.0.0', expectedRevision });
            const { expectedRevision: _expectedRevision, managedResourceDispositions: _dispositions, ...intent } = request;
            const response = PluginAvailabilityIntentSetActionOutputV1Schema.parse({ intent: { ...intent, revision: 'selected-1' } });
            selectedIntent = response.intent;
            return { body: response };
        } });
        const controller = createPluginAccountReleaseSelectionController();
        try {
            const result = await operations[0][1](controller);
            expect(result).toMatchObject({ kind: 'selected', intent: { desiredVersion: '2.0.0', revision: 'selected-1' } });
            expect(getActionSpec('plugins.account.release.select').outputSchema?.safeParse(result).success).toBe(true);
            expect(homes.requestsFor(intentPath)).toHaveLength(1);
            await waitForHomeGovernance(() => expect(readPluginAccountAvailability(lifetime.scope)
                .readCurrentReleaseSelection({ pluginId: 'example.tasks' }))
                .toMatchObject({ kind: 'available', intent: { desiredVersion: '2.0.0', revision: 'selected-1' } }));
        } finally { controller.retire(); }
    });
    it.each(operations)('honors Off before any domain read or mutation (%s)', async (actionId, run) => {
        await setActionPolicy({ v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } } });
        const controller = createPluginAccountReleaseSelectionController();
        try {
            await expect(run(controller)).rejects.toMatchObject({ code: 'action_disabled' });
            expect(homes.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.release.read'])).toHaveLength(0);
        } finally { controller.retire(); }
    });
    it.each(operations)('enters Ask-first admission before domain execution (%s)', async (actionId, run) => {
        await homes.requireUiApproval(serverId, actionId);
        const controller = createPluginAccountReleaseSelectionController();
        let settled = false;
        const pending = run(controller).then(value => { settled = true; return value; }, error => { settled = true; return error; });
        try {
            const admission = await waitForHomeGovernance(() => {
                const artifacts = homes.artifacts(serverId).list();
                expect(settled || artifacts.length > 0).toBe(true);
                return { settled, artifacts };
            });
            expect(admission.artifacts).toHaveLength(1);
        } finally {
            controller.retire();
            await pending;
        }
    });
    it.each(['localPath', 'bundledFirstParty'] as const)('does not offer an immutable Account release for a %s declaration', async (sourceClass) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected active Account');
        const materialization = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_plugin_admission', machineId: 'machine-local',
            materializationId: 'local-install', pluginId: 'store.fixtures125', version: '1.0.0',
            sourceClass, portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: 1,
        });
        const reader = createPluginAccountAvailabilityReader({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 2, intentReads: [], snapshots: [], materializations: [materialization],
        } });
        expect(reader.classifyRelease(materialization).validation).toEqual({ kind: 'rejected', reason: 'non_portable' });
        const screen = await renderScreen(createElement(PluginAccountReleaseSelectionSection, {
            pluginId: materialization.pluginId, version: materialization.version, reader, projection: null,
            daemon: { serverId: null, serverIdentityId: null, machineId: null }, testID: 'plugin.release',
        }));
        try {
            expect(screen.findAllByTestId('plugin.release')
                .filter(node => typeof node.props.onPress === 'function')).toHaveLength(0);
            expect(screen.findAllByTestId('plugin.release.machineLocal').length).toBeGreaterThan(0);
            expect(homes.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.release.read'])).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

});
