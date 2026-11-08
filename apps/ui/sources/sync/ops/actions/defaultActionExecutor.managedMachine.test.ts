import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { upsertServerProfile, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import type { ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineProvisionerOptionsFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

// The app-package inventory is a filesystem/Expo boundary. Keep Account selection and discovery real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { PluginManifestV2LoadSchema } = await import('@happier-dev/protocol/plugins/manifest');
    const { PLUGIN } = await import('../../../../../../packages/plugins/machine-vercel/src/manifest');
    const { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } = await import(
        '../../../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    const { emptyBundledPluginUiAssetsModule } = await vi.importActual<typeof import('@/dev/testkit/mocks/bundledPluginUiAssets')>(
        '@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginManifestV2LoadSchema.parse(PLUGIN.manifest);
    const declaration = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-vercel',
        packageVersion: manifest.version, manifest, artifactGraphs: [] });
    return { ...emptyBundledPluginUiAssetsModule, BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [{
        ...await projectBundledPluginUiFirstPaintDeclaration(declaration), loadDeclaration: async () => declaration,
    }] };
});

installApprovalCommonModuleMocks();
const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({
    kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none',
});
// The census list and the by-id Machine rows reader (a532f4a1e0) answer from the same external rows.
function answerMachineRows(url: URL, init: RequestInit | undefined, rows: unknown): Response {
    if (url.pathname === '/v1/machines') return Response.json(rows);
    const list = Array.isArray(rows) ? rows as ReadonlyArray<{ id: string; access?: { custodian?: { accountId?: string } } }> : [];
    // A by-id read returns a full published row; the census rows here carry only the fields each case is about.
    return createMachineReadBatchResponseFixture(init?.body, id => {
        const row = list.find(candidate => candidate.id === id);
        return row ? { ...createPlainMachineRowFixture({ id, accountId: row.access?.custodian?.accountId ?? 'account-a' }), ...row } : null;
    });
}
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); actionOperationStore.reset(); clearPluginAccountAvailabilityProjection(); vi.restoreAllMocks(); });

describe('managed native UI Action frontdoor', () => {
    it('keeps check qualification selectors outside the Account role’s closed input', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://account-check-qualifiers.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_account_check_qualifiers');
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
        const account = await captureLazyActionAccountContext(target.id);
        const contribution = { pluginId: 'happier.machine.vercel', localId: 'vercel' };
        try {
            const prepared = await prepareUiManagedProvisionerAdmission({ actionId: 'machines.provisioners.check',
                input: { homeId: 'srv_account_check_qualifiers', contribution, selectors: { image: 'node22' },
                    credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' },
                        account: { service: { pluginId: contribution.pluginId, localId: 'vercel-account' }, accountId: 'selected' } }] },
                context: { serverId: target.id, surface: 'ui' } }, account);
            if (!prepared || !('children' in prepared)) throw new Error('Expected Account role admission');
            expect(prepared.children).toEqual([{ action: { pluginId: contribution.pluginId, localId: 'check' },
                role: 'check', input: {} }]);
        } finally { account.dispose(); }
    });
    it.each(['forged-exec', 'forged-provider', 'authentic', 'native-selected'] as const)('admits only the host-selected provisioner before role review (%s)', async variant => {
        const target = await upsertServerProfile({ serverUrl: 'https://selected-provisioner-admission.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_selected_provider');
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'account-a' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        const effects: string[] = [];
        let machineReads = 0;
        setRuntimeFetch(async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            const artifact = artifacts.handle(path, init);
            if (artifact) return artifact;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'action.invoke': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (variant === 'native-selected' && path === '/v1/machines/read-batch') {
                machineReads++;
                return answerMachineRows(new URL(String(rawUrl)), init, [
                    { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account-a' }), installationId: 'installation' },
                ]);
            }
            effects.push(path);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' as const };
        const listed = await executor.execute('machines.provisioners.list', { homeId: 'srv_selected_provider' }, context);
        if (!listed.ok) throw new Error(listed.errorCode);
        const [selected] = ManagedMachineActionOutputSchemasV1['machines.provisioners.list'].parse(listed.result).provisioners;
        if (!selected) throw new Error('The real bundled selection must supply Vercel');
        const bootstrapTransport = selected.descriptor.bootstrapTransport;
        if (bootstrapTransport?.kind !== 'native') throw new Error('The selected Vercel descriptor must own native exec');
        // The controller-discovery response can name a native-only custom plugin, not an Account member.
        const controller = variant === 'native-selected' ? { machineId: 'controller', installationId: 'installation' } : undefined;
        const admittedDescriptor = variant === 'authentic' || variant === 'native-selected';
        const launch = { provider: { ...selected.contribution, ...(controller ? { pluginId: 'custom.native-only' } : {}),
            ...(variant === 'forged-provider' ? { localId: 'not-selected' } : {}) }, schemaVersion: 1, name: 'guest',
            choices: { image: 'node22', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 } };
        const reviewedFacts = buildManagedConfigurationFactsV1({
            choicesSchema: createPluginJsonSchemaZodValueAdapter(selected.descriptor.launchSchema), launch, ...(controller ? { controller } : {}),
            provisioner: variant === 'forged-exec' ? { ...selected.descriptor,
                bootstrapTransport: { ...bootstrapTransport, exec: 'not-a-provisioner-role' } } : selected.descriptor,
            optionStatus: 'current', prerequisites: [], billing: selected.descriptor.billing, retentionCapabilities: selected.descriptor.retention,
            machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        if (controller) clearPluginAccountAvailabilityProjection();
        const actionInput = { enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_selected_provider', launch, ...(controller ? { controller } : {}),
                retention: reviewedFacts.retention, wakeOnAcceptedMessage: reviewedFacts.wakeOnAcceptedMessage }, reviewedFacts,
        };
        if (controller) {
            // Ordinary native execution delegates admission to the controller; reviewOnly
            // is the app-local preparation path that consumes this shared host hook.
            const prepared = await executor.prepare('machines.managed.acquire', actionInput, context, { reviewOnly: true });
            expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
            expect(artifacts.list()).toHaveLength(0);
            expect(effects).toEqual([]);
            return;
        }
        const result = await executor.execute('machines.managed.acquire', actionInput, context);
        expect(result).toMatchObject(admittedDescriptor
            ? { ok: true, result: { kind: 'approval_request_created' } }
            : { ok: false, errorCode: 'admission_unavailable' });
        expect(artifacts.list()).toHaveLength(admittedDescriptor ? 1 : 0);
        expect(effects).toEqual([]);
        if (!controller) expect(machineReads).toBe(0);
    });

    it.each(['execute', 'prepare', 'selected'] as const)('lists bundled Account provisioners before the first Machine or plugin intent exists (%s)', async method => {
        const { ACCOUNT_PURPOSE } = await import('../../../../../../packages/plugins/machine-vercel/src/machine/credentials');
        const { ACCOUNT_ID } = await import('../../../../../../packages/plugins/machine-vercel/src/account');
        const target = await upsertServerProfile({ serverUrl: 'https://first-account-provisioners.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_first_compute');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'account-a' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const unexpected: string[] = [];
        let accountReads = 0;
        setRuntimeFetch(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v4/connect/qualified/accounts') { accountReads++; return Response.json({ service: { pluginId: 'happier.machine.vercel', localId: ACCOUNT_ID }, accounts: [] }); }
            unexpected.push(path);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' as const };
        const input = { homeId: 'srv_first_compute', ...(method === 'selected' ? { contribution: { pluginId: 'happier.machine.vercel', localId: 'vercel' } } : {}) };
        const result = method !== 'prepare' ? await executor.execute('machines.provisioners.list', input, context)
            : await (async () => {
                const prepared = await executor.prepare('machines.provisioners.list', input, context);
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            })();
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({ ok: true, result: { provisioners: expect.arrayContaining([
            expect.objectContaining({ contribution: { pluginId: 'happier.machine.vercel', localId: 'vercel' } }),
        ]) } });
        expect(unexpected).toEqual([]);
        if (method === 'selected') {
            expect(result).toMatchObject({ ok: true, result: { provisioners: [{
                credentialPurposes: [{ purpose: { consumer: input.contribution, purpose: ACCOUNT_PURPOSE }, options: [] }],
            }] } });
        }
        expect(accountReads).toBe(method === 'selected' ? 1 : 0);
    });
    it.each(['execute', 'prepare'] as const)('lets the receiving service owner apply an Environment waiver before global log approval (%s)', async method => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-service-log-scope.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_service_logs');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const actionId = 'machines.services.logs.read';
        const input = { serverId: 'srv_native_service_logs', machineId: 'service-machine', serviceId: 'instance/db' };
        const scope = { kind: 'environment' as const, environmentId: 'environment-a' };
        const settings = setScopedActionApprovalPreference({ actionId, scope, surface: 'ui', mode: 'waived',
            settings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) });
        const page = { kind: 'page', page: { sourceRevision: 'container-a', text: 'db output', nextCursor: null, truncated: false } };
        // Only Home HTTP is substituted; client Account capture and approval admission stay real.
        // The Protocol owner suite separately exercises the receiving host's exact-scope policy.
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: settings,
            } }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [
                createPlainMachineRowFixture({ id: input.machineId, accountId: 'account-a' }),
            ]);
            expect(url.pathname).toBe(`/v1/actions/${actionId}`);
            const envelope = JSON.parse(String(init?.body)) as { requestId: string; input: unknown; target: unknown };
            expect(envelope).toMatchObject({ input, target: { kind: 'machine', machineId: input.machineId } });
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: page } });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' as const };
        const result = method === 'execute' ? await executor.execute(actionId, input, context)
            : await (async () => {
                const prepared = await executor.prepare(actionId, input, context);
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            })();
        expect(result).toEqual({ ok: true, result: page });
        expect(artifacts.list()).toHaveLength(0);
    });

    it.each(['execute', 'prepare'] as const)('keeps required Delete approval at the retained controller (%s)', async method => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-delete-approval.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_delete');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        let retainedReads = 0;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.delete': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') {
                retainedReads++;
                return Response.json({
                id: 'managed-a', homeId: 'srv_native_delete', custodianAccountId: 'account-a',
                controller: { machineId: 'controller-a', installationId: 'installation-a' },
                launch: { provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 3,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                });
            }
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            expect(url.pathname).toBe('/v1/actions/machines.managed.delete');
            const requestId = String((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
            if (method === 'prepare') return Response.json({ v: 1, requestId, actionId: 'machines.managed.delete',
                execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' } } });
            actionOperationStore.mergeSnapshots({ serverId: target.id, snapshots: [ActionOperationSnapshotV1Schema.parse({
                version: 1, operationId: 'delete-operation', requestId, revision: 2,
                actionId: 'machines.managed.delete', state: 'running', scope: { accountId: 'account-a', machineId: 'controller-a' },
                title: 'Delete managed machine', createdAt: 1, startedAt: 2, cancellation: 'supported',
                progress: { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting for approval',
                    approval: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' } },
            })] });
            return await new Promise<Response>(() => {});
        });
        const executor = createDefaultActionExecutor();
        const input = {
            homeId: 'srv_native_delete', managedId: 'managed-a', when: 'now', expectedRevision: 3,
            intent: 'delete', reviewedDependencies: true,
        };
        const context = { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' as const, authority: 'present_user' as const };
        const execution = method === 'execute' ? executor.execute('machines.managed.delete', input, context)
            : (async () => {
                const prepared = await executor.prepare('machines.managed.delete', input, context);
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            })();
        expect(await Promise.race([execution, new Promise(resolve => setTimeout(() => resolve('still-pending'), 100))])).toEqual({
            ok: true, result: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' },
        });
        expect(artifacts.list()).toHaveLength(0);
        expect(retainedReads).toBe(1);
    });
    it.each(['no-controller', 'foreign', 'use', 'bypass', 'wrong-managed', 'wrong-home'] as const)('preserves Account approval and relay admission refusals (%s)', async relationship => {
        const target = await upsertServerProfile({ serverUrl: `https://managed-delete-${relationship}.test` });
        const homeId = `srv_managed_delete_${relationship}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        const nativeEffects: string[] = [];
        let accountConfiguration: Record<string, unknown> = {};
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.delete': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') {
                // Home's Manage boundary refuses unrelated Accounts and Use-only members.
                if (relationship === 'foreign' || relationship === 'use') return Response.json({ code: 'permission_denied' }, { status: 403 });
                return Response.json({ id: relationship === 'wrong-managed' ? 'different-managed' : 'managed-a',
                    homeId: relationship === 'wrong-home' ? 'different-home' : homeId, custodianAccountId: 'account-a',
                    ...(relationship !== 'no-controller' ? { controller: { machineId: 'controller-a', installationId: 'installation-a' } } : {}),
                    launch: { provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, name: 'Guest', choices: {} },
                    resource: { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, value: {} },
                    ...accountConfiguration,
                    desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 3,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
            }
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            nativeEffects.push(url.pathname);
            return Response.json({ code: 'permission_denied' }, { status: 403 });
        });
        const executor = createDefaultActionExecutor();
        if (relationship === 'no-controller') {
            replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'account-a' },
                snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
            const listed = await executor.execute('machines.provisioners.list', { homeId }, { serverId: target.id, surface: 'ui' });
            if (!listed.ok) throw new Error(listed.errorCode);
            const [selected] = ManagedMachineActionOutputSchemasV1['machines.provisioners.list'].parse(listed.result).provisioners;
            if (!selected) throw new Error('The bundled Account provisioner must be available');
            const launch = { provider: selected.contribution, schemaVersion: 1, name: 'Guest',
                choices: { image: 'node22', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 } };
            accountConfiguration = { launch,
                resource: { contributionRef: selected.contribution, schemaVersion: 1, value: {} },
                reviewedFacts: buildManagedConfigurationFactsV1({
                choicesSchema: createPluginJsonSchemaZodValueAdapter(selected.descriptor.launchSchema), launch,
                provisioner: selected.descriptor, optionStatus: 'current', prerequisites: [], billing: selected.descriptor.billing,
                retentionCapabilities: selected.descriptor.retention,
                machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            }) };
        }
        const result = await executor.execute('machines.managed.delete', {
            homeId, managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'delete', reviewedDependencies: true,
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
            ...(relationship === 'bypass' ? { bypassApprovals: true } : {}) });
        expect(result, JSON.stringify(result)).toMatchObject(relationship === 'no-controller'
            ? { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.delete' } }
            : { ok: false, errorCode: relationship === 'bypass' ? 'admission_unavailable'
                : relationship === 'wrong-managed' || relationship === 'wrong-home' ? 'managed_response_invalid' : 'permission_denied' });
        expect(artifacts.list()).toHaveLength(relationship === 'no-controller' ? 1 : 0);
        expect(nativeEffects).toEqual([]);
    });
    it.each([
        ['ui', 'machines.provisioners.options'], ['voice', 'machines.provisioners.options'],
        ['ui', 'machines.setup.apply'], ['voice', 'machines.setup.apply'],
        ['ui', 'machines.setup.plan'], ['voice', 'machines.setup.plan'],
        ['ui', 'machines.setup.remove'], ['voice', 'machines.setup.remove'],
    ] as const)(
        'retains %s %s authority through the captured Account ingress', async (surface, actionId) => {
        const target = await upsertServerProfile({ serverUrl: `https://native-${surface}-${actionId.replaceAll('.', '-')}.test` });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_options');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const setupEffect = actionId === 'machines.setup.apply' || actionId === 'machines.setup.remove';
        const input = actionId === 'machines.provisioners.options'
            ? { homeId: 'srv_native_options', controller: { machineId: 'controller', installationId: 'installation' },
                contribution: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, selectors: {} }
            : { homeId: 'srv_native_options', machineId: 'controller',
                ...(actionId === 'machines.setup.apply' ? { targets: [{ homeId: 'srv_native_options', machineId: 'controller',
                    sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [] }] } : {}),
                ...(actionId === 'machines.setup.remove' ? {
                    sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0,
                    removeItemKeys: [], removalPlans: [],
                } : {}) };
        const output = actionId === 'machines.provisioners.options'
            ? createMachineProvisionerOptionsFixture({ base: { launch: { name: 'guest' } } })
            : actionId === 'machines.setup.plan' ? { desiredRevision: 0, exclusions: [], support: [],
                sources: [{ kind: 'direct', setup: {} }] }
            : { operationId: 'setup', terminalId: 'setup-terminal' };
        const requests: unknown[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [
                { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account-a' }), runnerContentKeyBinding: null },
            ]);
            expect(url.pathname).toBe(`/v1/actions/${actionId}`);
            expect(new Headers(init?.headers).get(AUTHORITY_CEILING_HEADER_V1)).toBe(surface === 'voice' ? 'account_automation' : null);
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            requests.push(envelope);
            return Response.json({ v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: surface === 'voice' && setupEffect
                    ? { kind: 'approval_request_created', actionId, artifactId: 'native-ask' } : output } });
        });
        expect(await createDefaultActionExecutor().execute(actionId, input, {
            serverId: target.id, expectedAccountId: 'account-a', surface,
            ...(surface === 'ui' && setupEffect ? { presentUserConfirmation: { actionId } } : {}),
        })).toEqual({ ok: true, result: surface === 'voice' && setupEffect
            ? { kind: 'approval_request_created', actionId, artifactId: 'native-ask' } : output });
        expect(requests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' }, input })]);
    });

    it('refuses native Voice admission for a terminal credential despite caller-supplied present-user authority', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-voice-terminal.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_voice_terminal');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            effects.push(path);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        expect(await createDefaultActionExecutor().execute('machines.provisioners.options', {
            homeId: 'srv_voice_terminal', controller: { machineId: 'controller', installationId: 'installation' },
            contribution: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, selectors: {},
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'voice', authority: 'present_user' }))
            .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
        expect(effects).toEqual([]);
    });

    it.each(['own', 'foreign'] as const)('admits Move at the selected destination when the retained controller is unavailable (%s row)', async (ownership) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-move.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_move');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const current = { machineId: 'current-controller', installationId: 'current-installation' };
        const destination = { machineId: 'destination-controller', installationId: 'destination-installation' };
        const effects: unknown[] = [];
        const input = { homeId: 'srv_native_move', managedId: 'managed-a', expectedIntentRevision: 3,
            controller: destination, reviewedPendingEffects: true as const };
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            // This foreign fixture deliberately has no installed-key discovery;
            // refusal must come from that real missing custody, not a mock assertion.
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json({
                id: 'managed-a', homeId: 'srv_native_move', custodianAccountId: ownership === 'own' ? 'account-a' : 'other-account',
                controller: current, launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now',
                allocation: 'bound', creationState: 'active', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            });
            expect(url.pathname).toBe('/v1/actions/machines.managed.controller.update');
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            effects.push(envelope);
            return Response.json({ v: 1, actionId: 'machines.managed.controller.update', requestId: envelope.requestId,
                execution: { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.controller.update', artifactId: 'move-ask' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.controller.update', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui',
        });
        expect(result).toMatchObject(ownership === 'own' ? { ok: true } : { ok: false });
        expect(effects).toEqual(ownership === 'own' ? [expect.objectContaining({ target: { kind: 'machine', machineId: destination.machineId }, input })] : []);
    });

    it('does not borrow a foreign Manage controller approval owner for keyless Plain acquisition', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-foreign-acquire.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_foreign_acquire');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'foreign-controller', kind: 'persistent', active: false,
                installationId: 'foreign-installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                runnerContentKeyBinding: null, access: { custodian: { accountId: 'controller-owner', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            effects.push(url.pathname);
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: envelope.requestId,
                execution: { ok: true, result: { managedId: 'foreign-managed-a' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_foreign_acquire',
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'foreign-controller', installationId: 'foreign-installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' });
        expect(result).toMatchObject({ ok: false });
        expect(effects).toEqual([]);
    });

    it('admits keyless Plain acquisition through the captured ordinary Account ingress and retains the offline identity receipt', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-acquire.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_acquire')).toMatchObject({ serverIdentityId: 'srv_native_acquire' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const input = { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId: 'srv_native_acquire',
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        let admitted = false;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'controller-a', kind: 'persistent', active: false,
                installationId: 'installation-a', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                runnerContentKeyBinding: null, access: { custodian: { accountId: 'account-a', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            expect(url.pathname).toBe('/v1/actions/machines.managed.acquire');
            expect(JSON.parse(String(init?.body))).toEqual({ v: 1, requestId: 'acquire-offline-a',
                target: { kind: 'machine', machineId: 'controller-a' }, input });
            admitted = true;
            return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: 'acquire-offline-a',
                execution: { ok: true, result: { managedId: 'offline-managed-a' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user', actionRequestId: 'acquire-offline-a',
        });
        expect(result).toEqual({ ok: true, result: { managedId: 'offline-managed-a' } });
        expect(admitted).toBe(true);
    });

    it('retains consent but refuses native execution when public ingress cannot consume its approval custody', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-approved.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_approved')).toMatchObject({ serverIdentityId: 'srv_native_approved' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.acquire': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (init?.method === 'POST') effects.push(url.pathname);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const actionArgs = {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_native_approved',
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'controller-a', installationId: 'installation-a' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        };
        // Exercise replay of an already persisted outer approval. Its real
        // Artifact producer is independent of a new ordinary native request,
        // which now delegates its single Ask to the installed executor.
        const request = StoredApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' },
            requestedSurface: 'ui', actionId: 'machines.managed.acquire', actionArgs, summary: 'Acquire Guest',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: target.id, accountId: 'account-a', actionId: 'machines.managed.acquire', requestId: 'approved-acquire-a' },
        });
        const account = await captureLazyActionAccountContext(target.id);
        try { await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
        finally { account.dispose(); }
        const stored = artifacts.list();
        expect(stored).toHaveLength(1);
        const result = await executor.execute('approval.request.decide', { artifactId: stored[0].id, decision: 'approve' }, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
        });
        // The server-owned action records consent before exact-daemon replay.
        // Missing origin refuses that replay without claiming an effect receipt.
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable', effectAttempted: false });
        const retained = StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(stored[0].id) ?? 'null'));
        expect(retained.status).toBe('approved');
        expect(retained.decision).toMatchObject({ kind: 'approve' });
        expect(retained).not.toHaveProperty('execution');
        expect(effects).toEqual([]);
    });

    it.each(['sealed', 'offline', 'uncorrelated', 'downgrade'] as const)('keeps E2EE acquisition whole-action and exposes only genuine correlated custody (%s response)', async (responseKind) => {
        const target = await upsertServerProfile({ serverUrl: `https://native-encrypted-${responseKind}.test` });
        const homeId = `srv_native_e2ee_${responseKind}`;
        expect(await setServerProfileIdentityForUrl(target.serverUrl, homeId)).toMatchObject({ serverIdentityId: homeId });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        const credentials = { token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const material = { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() };
        const binding = { serverIdentityId: homeId, accountId: 'account-a', authentication: { kind: 'account' as const, tokenEpoch: 3 },
            actionId: 'machines.managed.acquire' as const, requestId: 'encrypted-acquire-a', target: { kind: 'machine' as const, machineId: 'controller-a' } };
        const selection = { kind: 'one-off' as const, homeId,
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller-a', installationId: 'installation-a' }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const input = { selection, enrollmentIdentity, agentStart: { directory: { kind: 'path' as const, path: '/repo' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
            creationKey: 'managed-agent-start', initialInput: { text: 'private bootstrap instruction' } } };
        let admitted = false;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'controller-a', kind: 'persistent', active: false,
                revokedAt: null, replacedByMachineId: null, installationId: 'installation-a', dataEncryptionKey: null,
                storageMode: 'e2ee', metadata: 'opaque Account ciphertext', metadataVersion: 1, daemonState: null,
                daemonStateVersion: 0, keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 },
                runnerContentKeyBinding: null, installationPublicKey: null, contentPublicKeyFingerprint: null,
                operationProtocolCapabilities: null, operationProtocolCapabilitiesRevision: null,
                replacedAt: null, replacementReason: null, replacementSource: null, replacementActorUserId: null,
                seq: 1, activeAt: 1, createdAt: 1, updatedAt: 1,
                access: { custodian: { accountId: 'account-a', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } }]);
            expect(url.pathname).toBe('/v1/actions/machines.managed.acquire');
            expect(String(init?.body)).not.toContain('private bootstrap instruction');
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
            expect(envelope.managedAdmission).toEqual({ actionId: 'machines.managed.acquire', input: { selection, enrollmentIdentity }, continuationPresent: true });
            expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })).toEqual({ input });
            admitted = true;
            if (responseKind === 'offline' || responseKind === 'uncorrelated') return Response.json({ error: 'invalid_request', code: 'target_unavailable',
                ...(responseKind === 'offline' ? { requestId: binding.requestId } : {}),
                managedAdmission: { managedId: 'offline-managed-a' } }, { status: 409 });
            if (responseKind === 'downgrade') return Response.json({ v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { managedId: 'forged-plaintext-id' } } });
            return Response.json(prepareExternalActionResponseV2({ binding, request: envelope, material, randomBytes: getRandomBytes,
                executedMachineId: 'controller-a', execution: { ok: true, result: { managedId: 'sealed-managed-a' } } }).response);
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user', actionRequestId: binding.requestId,
        });
        expect(result).toEqual(responseKind === 'sealed' ? { ok: true, result: { managedId: 'sealed-managed-a' } }
            : responseKind === 'offline' ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { error: 'invalid_request', code: 'target_unavailable', requestId: binding.requestId, managedAdmission: { managedId: 'offline-managed-a' } } }
            : responseKind === 'uncorrelated' ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
            : { ok: false, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' });
        expect(admitted).toBe(true);
    });
    it.each(['own', 'foreign'] as const)('keeps native approval in its real Account custody (%s controller)', async (ownership) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-target.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_power')).toMatchObject({ serverIdentityId: 'srv_native_power' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        // Genuine credential-store boundary: current structured provenance, not a legacy Account alias.
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const contribution = { pluginId: 'happier.machine.lima', localId: 'lima' };
        const paths: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            paths.push(url.pathname);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/artifacts') {
                // Echo the genuine Artifact request so a local Ask is observable, not a setup failure.
                const create = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
                return Response.json({ ...create, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json({
                id: 'managed-a', homeId: 'srv_native_power', custodianAccountId: ownership === 'own' ? 'account-a' : 'account-custodian',
                controller: { machineId: 'controller-a', installationId: 'installation-a' },
                launch: { provider: contribution, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: contribution, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now',
                allocation: 'bound', creationState: 'active', enrolledMachineId: 'stopped-guest-a',
                intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
            });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, { machines: [] });
            expect(url.pathname).toBe('/v1/actions/machines.managed.power.set');
            const envelope: unknown = JSON.parse(String(init?.body));
            expect(envelope).toMatchObject({ v: 1, target: { kind: 'machine', machineId: 'controller-a' },
                input: { homeId: 'srv_native_power', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start' } });
            expect(envelope).not.toHaveProperty('authority');
            expect(envelope).not.toHaveProperty('executionAuthorization');
            const requestId = typeof envelope === 'object' && envelope !== null && 'requestId' in envelope ? envelope.requestId : undefined;
            return Response.json({ v: 1, actionId: 'machines.managed.power.set', ...(requestId ? { requestId } : {}),
                execution: { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.power.set', artifactId: 'installed-ask-a' } } });
        });
        const action = await createDefaultActionExecutor().prepare('machines.managed.power.set', {
            homeId: 'srv_native_power', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start',
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
            // The foreign case lacks the current installation needed for
            // private Account custody, independently of local Ask.
            ...(ownership === 'foreign' ? { presentUserConfirmation: { actionId: 'machines.managed.power.set' as const } } : {}),
        });
        const result = action.kind === 'settled' ? action.result : await action.invocation.run();
        expect(result).toEqual(ownership === 'own'
            ? { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.power.set', artifactId: 'installed-ask-a' } }
            : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
        if (ownership === 'own') expect(paths).toContain('/v1/actions/machines.managed.power.set');
        else expect(paths).not.toContain('/v1/actions/machines.managed.power.set');
        expect(paths).not.toContain('/v1/artifacts');
    });

    it.each(['agent', 'plugin', 'api'] as const)('does not turn an automation-qualified %s origin into a present-user native relay', async (origin) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-refusal.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_origin')).toMatchObject({ serverIdentityId: 'srv_native_origin' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (init?.method === 'POST') effects.push(url.pathname);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.power.set', {
            homeId: 'srv_native_origin', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start',
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: origin, authority: 'account_automation' });
        expect(result).toMatchObject({ ok: false });
        expect(effects).toEqual([]);
    });
});
