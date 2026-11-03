import { afterEach, expect, it, onTestFinished } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
const { storage } = await import('@/sync/domains/state/storage');
const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
const actionId = 'connectedServices.purposes.default.set';

afterEach(async () => { await standardCleanup(); clearPluginAccountAvailabilityProjection(); await account.reset(); });

it.each(['plain', 'e2ee'] as const)('persists an admitted %s Account purpose default without a Machine and never substitutes Account admission for an explicit Machine', async mode => {
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
        packageName: '@happier-dev/plugins-scm-github', displayName: 'GitHub', entriesById: {}, normalizedManifest: manifest }]));
    const secret = new Uint8Array(32).fill(23);
    const scope = await account.restore({ machines: [], waivedActions: [actionId],
        ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}) });
    const catalog = createConnectedPurposeCatalogHttpBoundary({ mode, material: mode === 'e2ee' ? { type: 'legacy', secret } : null });
    account.home.answer(scope.serverId, catalog.path, { select: async (_input, request) => {
        const response = await catalog.handle(request.url, request.init);
        if (!response) throw new Error('Expected purpose catalog HTTP');
        return { status: response.status, body: await response.json() };
    } });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    expect((await readPluginAccountAvailability(scope).ensureCurrentAccountExecution(manifest.id)).kind).toBe('available');
    const connected = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'github-owner' },
        status: 'connected', authenticationModeId: manifest.contributes.connectedAccountDescriptors
            .find(descriptor => descriptor.id === GITHUB_CONNECTED_ACCOUNT_SERVICE.localId)!.authentication.defaultModeId,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, displayName: 'Owner', scopes: [] });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [connected] });
    const purpose = { consumer: { pluginId: manifest.id, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE };
    const target = { kind: 'account' as const, account: connected.ref };
    const executor = createDefaultActionExecutor();
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        presentUserConfirmation: { actionId } };
    expect(await executor.execute(actionId, { purpose, target }, context)).toEqual({ ok: true, result: { applied: true } });
    expect(catalog.value.bindings).toEqual([{ purpose, target }]);
    expect(catalog.writes).toHaveLength(1);
    expect(catalog.writes[0]?.content?.t).toBe(mode === 'e2ee' ? 'encrypted' : 'plain');
    expect(rpc.state.requests).toHaveLength(0);
    expect(await executor.execute(actionId, { machineId: 'unavailable-machine', purpose, target }, context)).toMatchObject({ ok: false });
    expect(await executor.execute(actionId, { purpose: { ...purpose, purpose: 'undeclared' }, target }, context))
        .toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    expect(await executor.execute(actionId, { purpose, target: { kind: 'account', account: { ...connected.ref, accountId: 'another-owners-account' } } }, context))
        .toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    expect(catalog.writes).toHaveLength(1);
    const ownedProfile = storage.getState().profile;
    storage.getState().applyProfile({ ...ownedProfile, id: 'another-account' });
    expect(await executor.execute(actionId, { purpose, target }, context))
        .toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    expect(catalog.writes).toHaveLength(1);
    storage.getState().applyProfile(AccountProfileSchema.parse({ ...ownedProfile, connectedAccountGroupsV4: [{ v: 1,
        ref: { service: connected.ref.service, groupId: 'work' }, incarnation: 'row-work', displayName: 'Work',
        policy: { v: 1, strategy: 'expiry_first', autoSwitch: true }, activeConnectedAccountId: connected.ref.accountId,
        generation: 1, runtimeStateRevision: 1, state: { status: 'ready' }, createdAt: 1, updatedAt: 1,
        members: [{ v: 1, connectedAccountId: connected.ref.accountId, priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }] }] }));
    const groupTarget = { kind: 'group' as const, service: connected.ref.service, groupId: 'work' };
    expect(await executor.execute(actionId, { purpose, target: groupTarget }, context)).toEqual({ ok: true, result: { applied: true } });
    expect(catalog.value.bindings).toEqual([{ purpose, target: groupTarget }]);
    expect(catalog.writes).toHaveLength(2);
});
