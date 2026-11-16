import { afterEach, expect, it, onTestFinished } from 'vitest';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';
import { PLUGIN as DAYTONA_PLUGIN } from '../../../../../../packages/plugins/machine-daytona/src/manifest';
import { ACCOUNT_ID, ACCOUNT_PURPOSE } from '../../../../../../packages/plugins/machine-daytona/src/account';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachinePresetActionInputSchemasV1, machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { prepareUiManagedProvisionerAdmission } from './managedProvisionerAction';
import { executeUiMachinePresetArchive } from './machinePresetArchive';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
afterEach(() => standardCleanup());

async function archiveFixture(originalMachineId?: string, accountNative = false, cold = false) {
    await homes.reset();
    const lifetime = new AbortController();
    onTestFinished(() => lifetime.abort());
    const manifest = PluginPortableReleaseManifestV1Schema.parse(accountNative ? DAYTONA_PLUGIN.manifest : LIMA_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([
        { plugin: LIMA_PLUGIN, packageName: '@happier-dev/plugins-machine-lima', displayName: 'Lima' },
        { plugin: DAYTONA_PLUGIN, packageName: '@happier-dev/plugins-machine-daytona', displayName: 'Daytona' },
    ].map(({ plugin, packageName, displayName }) => {
        const normalizedManifest = PluginPortableReleaseManifestV1Schema.parse(plugin.manifest);
        return { pluginId: normalizedManifest.id, pluginVersion: normalizedManifest.version, packageName, displayName,
            normalizedManifest, hasMachineProvisioners: true, entriesById: projectPluginPortableUiDeclarationsV1(normalizedManifest, []) };
    })));
    const homeId = 'srv_original_image_home';
    const serverId = await homes.addHome({ name: 'Original image', serverUrl: 'https://archive-original-image.test',
        serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    // Account bootstrap publishes this verified network projection before the UI offers native Actions.
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const provisioner = manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const connectedAccount = { service: { pluginId: manifest.id, localId: ACCOUNT_ID }, accountId: 'original-account' };
    const launch = { provider, schemaVersion: provisioner.schemaVersion, choices: accountNative ? { snapshot: 'base' } : {},
        ...(accountNative ? { credentials: [{ purpose: { consumer: provider, purpose: ACCOUNT_PURPOSE }, account: connectedAccount }] } : {}) };
    const credentialConfigurations = accountNative ? [{ account: connectedAccount, revision: 'original-account-revision' }] : [];
    const prepared = { operationId: 'original-prepare', status: cold ? 'cancelled' : 'ready', binding: {
        configuration: { launch }, cliIdentity: 'original-cli', credentialConfigurations,
        ...(originalMachineId ? { machineId: originalMachineId } : {}) },
        ...(cold ? {} : { artifact: { contributionRef: launch.provider, schemaVersion: launch.schemaVersion, value: { image: 'original-image' } } }) };
    let preset = ManagedMachinePresetV1Schema.parse({ id: 'preset', homeId, revision: 1,
        owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { v: 1, name: 'Preset', launch: { ...launch, name: 'Guest' }, prepared } } });
    homes.answer(serverId, machinePresetActionEndpointPathV1('machines.presets.get'), { select: () => ({ body: { kind: 'found', preset } }) });
    homes.answer(serverId, machinePresetActionEndpointPathV1('machines.presets.update'), { select: value => {
        const update = MachinePresetActionInputSchemasV1['machines.presets.update'].parse(value);
        if (update.expectedRevision !== preset.revision) return { body: { kind: 'conflict', currentRevision: preset.revision } };
        preset = ManagedMachinePresetV1Schema.parse({ ...preset, ...update.patch, revision: preset.revision + 1 });
        return { body: { kind: 'saved', preset } };
    } });
    for (const actionId of ['machines.presets.archive', 'machines.presets.restore'] as const) {
        homes.answer(serverId, machinePresetActionEndpointPathV1(actionId), { select: value => {
            const update = MachinePresetActionInputSchemasV1[actionId].parse(value);
            if (update.expectedRevision !== preset.revision) return { body: { kind: 'conflict', currentRevision: preset.revision } };
            const { archivedAt: _archivedAt, ...rest } = preset;
            preset = { ...rest, revision: preset.revision + 1, ...(actionId === 'machines.presets.archive' ? { archivedAt: 1 } : {}) };
            return { body: { kind: 'saved', preset } };
        } });
    }
    return { serverId, homeId, account, row: () => preset, signal: lifetime.signal };
}

it('retains a prepared local image and refuses Archive when its original host is unknown', async () => {
    const fixture = await archiveFixture();
    const { serverId, homeId } = fixture;
    const preset = fixture.row();
    const result = await createDefaultActionExecutor().executeConfirmed('machines.presets.archive', {
        homeId, id: preset.id, expectedRevision: preset.revision,
    }, { serverId, surface: 'ui', authority: 'present_user', actionRequestId: 'archive-original', signal: fixture.signal });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'controller_unavailable' });
    expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.archive'))).toHaveLength(0);
    expect(fixture.row().content).toMatchObject({ t: 'plain', v: { prepared: { artifact: { value: { image: 'original-image' } } } } });
});

it('returns an observable preparation failure while Account availability has not loaded', async () => {
    const fixture = await archiveFixture();
    clearPluginAccountAvailabilityProjection();
    const preset = fixture.row();
    const result = await createDefaultActionExecutor().executeConfirmed('machines.presets.archive', {
        homeId: fixture.homeId, id: preset.id, expectedRevision: preset.revision,
    }, { serverId: fixture.serverId, surface: 'ui', authority: 'present_user', actionRequestId: 'archive-unavailable', signal: fixture.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'account_availability_not_loaded' });
    expect(fixture.row()).not.toHaveProperty('archivedAt');
    expect(fixture.row().content).toMatchObject({ t: 'plain', v: { prepared: { artifact: { value: { image: 'original-image' } } } } });
});

it.each([{ refuseFirst: false, accountNative: false }, { refuseFirst: true, accountNative: false },
    { refuseFirst: false, accountNative: true }])('cleans the original image and restores cold (%j)', async ({ refuseFirst, accountNative }) => {
    const fixture = await archiveFixture(accountNative ? undefined : 'original-host', accountNative);
    const account = fixture.account;
    const input = { homeId: fixture.homeId, id: fixture.row().id, expectedRevision: fixture.row().revision };
    const native: unknown[] = [];
    let refuse = refuseFirst;
    const executor = createActionExecutor({
        prepareHostReviewedChildren: request => prepareUiManagedProvisionerAdmission(request, account),
        machinePresetArchive: request => executeUiMachinePresetArchive(request, account),
        // Native plugin execution is the OS/process boundary; review, custody,
        // Common cleanup, HTTP persistence and final Archive remain real.
        routeHostChildAction: async ({ actionId, input: childInput, context }) => {
            expect(readHostReviewedChildOperationV1(context, actionId, childInput)?.parent)
                .toMatchObject({ actionId: 'machines.presets.archive', input: { homeId: input.homeId, id: input.id } });
            expect(context.invocationServices).not.toHaveProperty('managedMachine');
            expect(context.invocationServices).not.toHaveProperty('managedBootstrapCredential');
            if (accountNative) expect(context.invocationServices?.connectedAccountPurposeBinding).toMatchObject({
                managedOperation: { credentialConfigurations: [{ revision: 'original-account-revision' }] },
            });
            native.push(childInput);
            if (refuse) { refuse = false; return { ok: true, result: { kind: 'refused', code: 'native_cleanup_denied' } }; }
            return { ok: true, result: { kind: 'confirmed' } };
        },
    });
    const executeArchive = async () => {
        const currentInput = { ...input, expectedRevision: fixture.row().revision };
        const context = {
            serverId: fixture.serverId, serverIdentityId: fixture.homeId, surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, runtimeAccountId: account.accountId, ...(accountNative ? {} : { runtimeActionMachineId: 'original-host' }),
            actionRequestId: 'archive-original', signal: fixture.signal,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.presets.archive': ['ui'] } }),
        } satisfies ActionExecutorContext;
        return await executor.execute('machines.presets.archive', currentInput, context);
    };
    if (refuseFirst) {
        expect(await executeArchive()).toMatchObject({ ok: false, errorCode: 'native_cleanup_denied' });
        expect(fixture.row()).not.toHaveProperty('archivedAt');
        expect(fixture.row().content).toMatchObject({ t: 'plain', v: { prepared: { artifact: { value: { image: 'original-image' } } } } });
    }
    const archived = await executeArchive();
    expect(archived, JSON.stringify(archived)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    expect(native).toMatchObject(Array.from({ length: refuseFirst ? 2 : 1 }, () => ({ input: { artifact: { value: { image: 'original-image' } } } })));
    expect(fixture.row()).toHaveProperty('archivedAt');
    expect(fixture.row().content).toMatchObject({ t: 'plain', v: { prepared: { status: 'cancelled' } } });
    expect(JSON.stringify(fixture.row().content)).not.toContain('original-image');
    const restoreInput = { homeId: fixture.homeId, id: fixture.row().id, expectedRevision: fixture.row().revision };
    const restored = await createDefaultActionExecutor().executeConfirmed('machines.presets.restore', restoreInput, {
        serverId: fixture.serverId, surface: 'ui', authority: 'present_user', actionRequestId: 'restore-cold', signal: fixture.signal,
    });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    expect(fixture.row()).not.toHaveProperty('archivedAt');
    expect(JSON.stringify(fixture.row().content)).not.toContain('original-image');
    expect(native).toHaveLength(refuseFirst ? 2 : 1);
});

it('archives a restored cold definition without requiring its previous provider', async () => {
    const fixture = await archiveFixture(undefined, false, true);
    const restore = installBundledPluginUiDeclarationsForTests([]);
    clearPluginAccountAvailabilityProjection();
    try {
        const preset = fixture.row();
        const result = await createDefaultActionExecutor().executeConfirmed('machines.presets.archive', {
            homeId: fixture.homeId, id: preset.id, expectedRevision: preset.revision,
        }, { serverId: fixture.serverId, surface: 'ui', authority: 'present_user', actionRequestId: 'archive-cold', signal: fixture.signal });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'saved' } });
        expect(fixture.row()).toHaveProperty('archivedAt');
    } finally { restore(); }
});
