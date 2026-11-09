import { describe, expect, it, onTestFinished } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
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
    it('refuses browser-ineligible compute before Home admission or provider allocation', async () => {
        const serverUrl = 'https://browser-managed-account.test';
        const homeId = 'srv_browser_managed_account';
        const credentials = { token: createAccountTokenForTests('creator', { currentAccount: true }) };
        const browser = await installBrowserRuntimeForTests({ url: serverUrl });
        onTestFinished(() => browser.restore());
        onTestFinished(installBundledPluginUiDeclarationsForTests([{
            pluginId: manifest.id, pluginVersion: manifest.version, packageName: '@happier-dev/plugins-machine-vercel',
            displayName: 'Vercel', normalizedManifest: manifest, hasMachineProvisioners: true,
            entriesById: projectPluginPortableUiDeclarationsV1(manifest, []),
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
        const provisioner = manifest.contributes.machineProvisioners?.[0];
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
