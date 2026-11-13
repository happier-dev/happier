import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { upsertServerProfile, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';

// The app-package inventory is a filesystem/Expo boundary. Keep Account selection and discovery real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { PluginManifestV2LoadSchema } = await import('@happier-dev/protocol/plugins/manifest');
    const { CRABBOX_PLUGIN } = await import('../../../../../../packages/plugins/machine-crabbox/src/manifest');
    const { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } = await import(
        '../../../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    const { emptyBundledPluginUiAssetsModule } = await vi.importActual<typeof import('@/dev/testkit/mocks/bundledPluginUiAssets')>(
        '@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginManifestV2LoadSchema.parse(CRABBOX_PLUGIN.manifest);
    const declaration = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-crabbox',
        packageVersion: manifest.version, manifest, artifactGraphs: [] });
    return { ...emptyBundledPluginUiAssetsModule, BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [{
        ...await projectBundledPluginUiFirstPaintDeclaration(declaration), loadDeclaration: async () => declaration,
    }] };
});

installApprovalCommonModuleMocks();
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); clearPluginAccountAvailabilityProjection(); vi.restoreAllMocks(); });

describe('managed Account credential admission', () => {
    it.each(['check', 'options'] as const)('binds Account %s credentials and retains an authored provider refusal', async role => {
        const target = await upsertServerProfile({ serverUrl: `https://account-provisioner-credential-${role}.test` });
        const homeId = `srv_account_provisioner_credential_${role}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'account-a' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        setRuntimeFetch(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const { prepareUiManagedProvisionerAdmission } = await import('./managedProvisionerAction');
        const { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID, CRABBOX_COORDINATOR_PROVISIONER_ID,
            CRABBOX_CONNECTION_PURPOSE, CRABBOX_CONNECTION_SERVICE } = await import(
            '../../../../../../packages/plugins/machine-crabbox/src/machine/constants');
        const contribution = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_COORDINATOR_PROVISIONER_ID };
        const account = await captureLazyActionAccountContext(target.id);
        try {
            const actionId = role === 'check' ? 'machines.provisioners.check' as const : 'machines.provisioners.options' as const;
            const inputFor = (consumer: typeof contribution) => ({ homeId, contribution, selectors: {}, credentials: [{
                purpose: { consumer, purpose: CRABBOX_CONNECTION_PURPOSE },
                account: { service: CRABBOX_CONNECTION_SERVICE, accountId: 'selected-coordinator' },
            }] });
            const prepare = (consumer: typeof contribution) => prepareUiManagedProvisionerAdmission({
                actionId, input: inputFor(consumer), context: { serverId: target.id, surface: 'ui' },
            }, account);
            const exact = await prepare(contribution);
            if (!exact || !('children' in exact)) throw new Error('Expected exact provisioner credential admission');
            expect(exact.children).toEqual([{ action: { pluginId: CRABBOX_PLUGIN_ID, localId: `coordinator-${role}` }, role, input: {} }]);
            if (!exact.executeAdmittedAction) throw new Error('Expected admitted Account discovery execution');
            const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
            const { readPluginActionError } = await import('@happier-dev/protocol/plugins/actions/invocation');
            const refusal = await exact.executeAdmittedAction({ actionId, input: inputFor(contribution),
                // Account discovery runs only through the reviewed child port below.
                execute: async () => { throw new Error('Unexpected direct admitted execution'); },
                context: { surface: 'ui', serverId: target.id,
                actionRequestId: `authored-${role}`, hostReviewedChild: { invoke: async () => {
                    // Account plugin execution is the runtime boundary; credential admission and discovery stay real.
                    try { throw new PluginError({ code: 'credential_unavailable',
                        message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' },
                        details: { privateOutput: 'PRIVATE_PROVIDER_OUTPUT' } }); }
                    catch (error) {
                        const failure = readPluginActionError(error);
                        if (!failure) throw error;
                        return { ok: false, errorCode: failure.code, error: failure.message, details: failure.data };
                    }
                } } } });
            expect(refusal).toMatchObject({ ok: false, errorCode: 'credential_unavailable', details: {
                name: 'PluginError', message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' },
            } });
            expect(JSON.stringify(refusal)).not.toContain('PRIVATE_PROVIDER_OUTPUT');

            expect(await prepare({ ...contribution, localId: CRABBOX_PROVISIONER_ID })).toEqual({
                ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable',
            });
        } finally { account.dispose(); }
    });

    it('carries a Team resource credential as its Team selection, not as an Account binding', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://account-provisioner-credential-team.test' });
        const homeId = 'srv_account_provisioner_credential_team';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'account-a' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        setRuntimeFetch(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const { prepareUiManagedProvisionerAdmission } = await import('./managedProvisionerAction');
        const { CRABBOX_PLUGIN_ID, CRABBOX_COORDINATOR_PROVISIONER_ID, CRABBOX_CONNECTION_PURPOSE } = await import(
            '../../../../../../packages/plugins/machine-crabbox/src/machine/constants');
        const contribution = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_COORDINATOR_PROVISIONER_ID };
        const purpose = { consumer: contribution, purpose: CRABBOX_CONNECTION_PURPOSE };
        const selection = { source: 'team_resource' as const, resourceId: 'resource-a', deliveryMode: 'brokered' as const };
        const input = { homeId, contribution, selectors: {}, credentials: [{ purpose, teamId: 'team-a', selection }] };
        const account = await captureLazyActionAccountContext(target.id);
        try {
            const admitted = await prepareUiManagedProvisionerAdmission({ actionId: 'machines.provisioners.check', input,
                context: { serverId: target.id, surface: 'ui' } }, account);
            if (!admitted || !('children' in admitted) || !admitted.executeAdmittedAction) throw new Error('Expected admitted Team credential');
            const invocations: unknown[] = [];
            await admitted.executeAdmittedAction({ actionId: 'machines.provisioners.check', input,
                execute: async () => { throw new Error('Unexpected direct admitted execution'); },
                context: { surface: 'ui', serverId: target.id, actionRequestId: 'team-check', hostReviewedChild: { invoke: async invocation => {
                    invocations.push(invocation.invocationServices?.connectedAccountPurposeBinding?.purposeBindings);
                    return { ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
                } } } });
            expect(invocations).toEqual([{ v: 1, bindings: [], teamResourceSelections: [{
                purpose: { consumer: { pluginId: CRABBOX_PLUGIN_ID, localId: 'coordinator-check' }, purpose: CRABBOX_CONNECTION_PURPOSE },
                teamId: 'team-a', selection }] }]);
        } finally { account.dispose(); }
    });
});
