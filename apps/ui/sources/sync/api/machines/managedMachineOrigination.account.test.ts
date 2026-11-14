import { describe, expect, it, onTestFinished } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { prepareUiManagedProvisionerAdmission } from '@/sync/ops/actions/managedProvisionerAction';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { readRuntimeFetchHost, resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest';

installApprovalCommonModuleMocks();
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);

describe('Account managed creation through the app Action executor', () => {
    it('retires a controllerless resource through the existing Account control admission', async () => {
        const serverUrl = 'https://account-managed-retire.test';
        const homeId = 'srv_account_managed_retire';
        const profile = await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, {
            token: createAccountTokenForTests('creator', { currentAccount: true }),
        });
        const provider = { pluginId: manifest.id, localId: manifest.contributes.machineProvisioners[0]!.id };
        const machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: 'creator',
            launch: { provider, schemaVersion: 1, name: 'Retained', choices: {} }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 2, archivedAt: 1,
            cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const requests: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/actions/get')) return Response.json(machine);
            if (path.endsWith('/admit-control')) {
                requests.push(JSON.parse(String(init?.body)));
                return Response.json({ machine, replayed: false });
            }
            throw new Error(`Unexpected HTTP effect: ${path}`);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(profile.id);
        onTestFinished(() => account.dispose());
        const input = { homeId, managedId: machine.id, expectedIntentRevision: 1, manualResponsibility: true };
        expect(await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.retire', input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'retire-reviewed' } }))
            .toEqual({ ok: true, result: machine });
        expect(requests).toEqual([{ action: 'machines.managed.retire', input, requestId: 'retire-reviewed' }]);
    });

    it('preserves the typed unsupported dimension from an admitted Account resize', async () => {
        const serverUrl = 'https://account-managed-resize.test';
        const homeId = 'srv_account_managed_resize';
        const profile = await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, {
            token: createAccountTokenForTests('creator', { currentAccount: true }),
        });
        const provisioner = manifest.contributes.machineProvisioners[0]!;
        const machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: 'creator',
            launch: { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: 1, name: 'Retained', choices: {} },
            resource: { contributionRef: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: 1, value: { id: 'same-native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const reports: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/actions/get')) return Response.json(machine);
            if (path.endsWith('/admit-control')) return Response.json({ machine, replayed: false, resizeProvisioner: provisioner });
            if (path.endsWith('/report-resize')) {
                reports.push(JSON.parse(String(init?.body)));
                return Response.json({ machine });
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path.includes('/plugins/')) return Response.json({ intents: [], releases: [] });
            throw new Error(`Unexpected HTTP effect: ${path}`);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(profile.id);
        onTestFinished(() => account.dispose());
        const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.resize',
            input: { homeId, managedId: machine.id, size: { diskBytes: 21 * 1024 ** 3 } },
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'resize-reviewed' } });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            result: { kind: 'unsupported', dimension: 'diskBytes', code: 'resize_unsupported' },
        } });
        expect(reports).toEqual([{ homeId, managedId: machine.id, requestId: 'resize-reviewed',
            result: { kind: 'unsupported', dimension: 'diskBytes', code: 'resize_unsupported' } }]);
    });
    it('refuses browser-ineligible compute before Home admission or provider allocation', async () => {
        const serverUrl = 'https://browser-managed-account.test';
        const homeId = 'srv_browser_managed_account';
        const credentials = { token: createAccountTokenForTests('creator', { currentAccount: true }) };
        const browser = await installBrowserRuntimeForTests({ url: serverUrl });
        onTestFinished(() => browser.restore());
        // Vercel itself supports browsers; this case needs an explicitly ineligible declaration.
        const browserIneligibleManifest = PluginPortableReleaseManifestV1Schema.parse({ ...manifest,
            contributes: { ...manifest.contributes, machineProvisioners: manifest.contributes.machineProvisioners.map(
                provisioner => ({ ...provisioner, browserReachable: false })) } });
        onTestFinished(installBundledPluginUiDeclarationsForTests([{
            pluginId: manifest.id, pluginVersion: manifest.version, packageName: '@happier-dev/plugins-machine-vercel',
            displayName: 'Vercel', normalizedManifest: browserIneligibleManifest, hasMachineProvisioners: true,
            entriesById: projectPluginPortableUiDeclarationsV1(browserIneligibleManifest, []),
        }]));
        const profile = await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, credentials);
        const paths: string[] = [];
        // Home and vendor HTTP are the only effect boundary. The real app
        // admission, reviewed-child issuer and shared acquire driver stay live.
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path.includes('/plugins/')) return Response.json({ intents: [], releases: [] });
            throw new Error(`Unexpected HTTP effect: ${path}`);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(profile.id);
        onTestFinished(() => account.dispose());
        expect(await readRuntimeFetchHost(account.endpointUrl)).toBe('browser');
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const provisioner = browserIneligibleManifest.contributes.machineProvisioners?.[0];
        if (!provisioner) throw new Error('Vercel must publish its managed declaration');
        const launch = { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: 1, name: 'Guest',
            choices: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 } };
        const retention = { kind: 'until-delete' as const };
        const input = ManagedAcquireInputV1Schema.parse({
            selection: { kind: 'one-off', homeId, launch, retention, wakeOnAcceptedMessage: false },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention, wakeOnAcceptedMessage: false },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            prepareHostReviewedChildren: request => prepareUiManagedProvisionerAdmission(request, account),
            managedMachineAction: async request => {
                const result = await executeManagedMachineNativeAction({ account, ...request });
                return result.ok ? result.result : result;
            },
        }));
        const context = bindPresentUserActionConfirmation('machines.managed.acquire', input, {
            surface: 'ui', authority: 'present_user', runtimeAccountId: 'creator', serverId: profile.id, serverIdentityId: homeId,
            actionRequestId: 'browser-managed-create',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
        });
        const result = await executor.execute('machines.managed.acquire', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false,
            errorCode: 'provider_unavailable' });
        expect(paths.filter(path => path.endsWith('/admit'))).toEqual([]);
        expect(paths.filter(path => path.includes('/sandboxes'))).toEqual([]);
    });
});
