import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createHttpTeamCredentialDirectMaterialClient } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { PLUGIN_MANIFEST as AGENT37, PLUGIN as AGENT37_PLUGIN } from '../../../../../packages/plugins/machine-agent37/src/manifest';
import { PLUGIN_MANIFEST as BOAT, PLUGIN as BOAT_PLUGIN } from '../../../../../packages/plugins/machine-boat/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ProviderBrokerActionAdmissionResponseV3Schema, PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1,
  PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3, ProviderBrokerActionExecuteResponseV3Schema,
  type ProviderBrokerActionOpenRequestV3, type ProviderBrokerActionOpenResponseV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { openTeamCredentialProviderBroker } from '@/api/client/providerBrokerApi';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation, listQualifiedConnectedAccountsV4,
  listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { startPeerMediationLoopbackServer } from '@/daemon/peer/mediation/loopback/server';
import { startDaemonProviderBrokerRuntime } from './daemonProviderBrokerRuntime';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { createTeamCredentialBrokerActionExecutor } from './teamCredentialActionExecution';
import { withTeamCredentialActionRuntime } from './teamCredentialActionRuntime';
import { createTeamCredentialBrokerActionPurposeExecutor } from './teamCredentialActionClient';
import { captureConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';

const brokerProvider = vi.hoisted(() => ({ requests: [] as Array<{ authorization: string | null; body: string | undefined }> }));
// Home and the native carrier remain real. Only the external cloud HTTP API is substituted.
vi.mock('undici', async importOriginal => {
  const original = await importOriginal<typeof import('undici')>();
  return { ...original, fetch: async (url: Parameters<typeof original.fetch>[0], init?: Parameters<typeof original.fetch>[1]) => {
    if (new URL(String(url)).origin !== 'https://cloud.example.test') return await original.fetch(url, init);
    brokerProvider.requests.push({ authorization: new Headers(init?.headers as HeadersInit).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined });
    return Response.json({ region: 'eu', requesterVisible: true });
  } };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('two-Account declared provisioner Action material admission', () => {
  it.each([AGENT37, BOAT].flatMap(manifest => [
    { manifest, rootKind: 'generic' as const }, { manifest, rootKind: 'native-options' as const },
  ]))('admits $manifest.id direct material through a $rootKind signed root and retains it for the finite Action', async ({ manifest, rootKind }) => {
    const server = '../../../../server/sources/';
    const { createLightSqliteHarness, createAccountTokenForTests }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
    const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
    const { createTeamDirectActionMaterialFixture }: typeof import('../../../../server/sources/app/teams/credentials/directActionMaterial.testkit') = await import(server + 'app/teams/credentials/directActionMaterial.testkit');
    const { createReleaseLessDeclarationV1 }: typeof import('../../../../server/sources/app/plugins/availability/currentDeclaration') = await import(server + 'app/plugins/availability/currentDeclaration');
    const { registerTeamCredentialResourceRoutes }: typeof import('../../../../server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes') = await import(server + 'app/teams/credentials/registerTeamCredentialResourceRoutes');
    const { registerExternalActionRoutes }: typeof import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes') = await import(server + 'app/api/routes/actions/registerExternalActionRoutes');
    const homeId = 'srv_two_account_declared_action';
    const home = await createLightSqliteHarness({ tempDirPrefix: 'two-account-action-', initAuth: true, initEncrypt: true, env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
      HAPPIER_SERVER_IDENTITY_ID: homeId,
    } });
    onTestFinished(home.close);
    const descriptor = manifest.contributes.connectedAccountDescriptors[0]!;
    const selected = await createTeamDirectActionMaterialFixture({ manifest, serviceId: descriptor.id,
      authenticationModeId: descriptor.authentication.defaultModeId, homeServerIdentityId: homeId });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    onTestFinished(() => app.close());
    registerExternalActionRoutes(app);
    registerTeamCredentialResourceRoutes(app);
    const materialRequests: unknown[] = [];
    app.addHook('onRequest', async request => {
      if (request.url.endsWith('/direct-material')) materialRequests.push(request.headers);
    });
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await createAccountTokenForTests(selected.recipient.id, { kind: 'account', authority: 'present_user' });
    const signing = nacl.sign.keyPair();
    const installationId = crypto.randomUUID();
    await db.machine.update({ where: { id: selected.machine.id }, data: {
      installationId, installationPublicKey: signing.publicKey, operationProtocolCapabilitiesRevision: 1,
    } });
    await db.pluginMachineMaterialization.create({ data: { accountId: selected.recipient.id, serverIdentityId: homeId,
      machineId: selected.machine.id, materializationId: installationId, pluginId: manifest.id, version: manifest.version,
      sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: createReleaseLessDeclarationV1(manifest).manifestDigestSha256,
      uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });

    const happyHomeDir = await mkdtemp(join(tmpdir(), 'two-account-action-runtime-'));
    onTestFinished(() => rm(happyHomeDir, { recursive: true, force: true }));
    const controller = createPluginReloadController({ happyHomeDir });
    onTestFinished(() => controller.shutdown());
    const credentials = { token, encryption: null } as const;
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials, getAccountEncryptionMode: async () => 'plain',
      secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: 'two-account-fixture' }) });
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials, reloadController: controller,
      getAccountEncryptionMode: async () => 'plain', configuration: persistence.configuration });
    let root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
    let reviewedChild: ReviewedActionChildHttpProofV1 | undefined;
    let effectActionId = 'action.invoke';
    const direct = createHttpTeamCredentialDirectMaterialClient({ token, teamId: selected.team.id, serverUrl,
      readRecipientEncryptionMaterial: async () => ({ mode: 'plain' }),
      resolvePlatformOperationRequestHeaders: async request => {
        if (!root) throw new Error('No HTTP-issued root');
        return createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId,
          target: root.binding.target, installationId, privateKey: signing.secretKey, ...request,
          ...(reviewedChild ? { reviewedChild } : {}) });
      } });
    const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
      credentialOwnerAccountId: selected.recipient.id, workerMachineId: selected.machine.id, reloadController: controller,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised', openTeamDirect: direct.open,
      store: { read: async () => ({ v: 1, bindings: [] }),
        update: async () => { throw new Error('Finite Action must not change durable bindings'); }, subscribe: () => ({ dispose() {} }) } });
    const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir, controller, runtimeOptions: {
      pluginIds: [manifest.id], connectedAccounts: purposeRuntime.owner,
      scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
    } });
    onTestFinished(runtime.dispose);
    const canonicalManifest = normalizePluginManifestV2(manifest);
    const plugin = manifest.id === AGENT37.id ? AGENT37_PLUGIN : BOAT_PLUGIN;
    const activated = await activateContributionModule({ pluginId: manifest.id,
      occurrenceId: createPluginRuntimeOccurrenceId(manifest.id), manifest: canonicalManifest,
      moduleNamespace: { activateAccount: plugin.activateAccount },
      target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' }, isOccurrenceCurrent: () => true });
    const handlers = new Map(activated.registrations.flatMap((entry): [string, TargetActionInvocationRegistration['handler']][] =>
      entry.family === 'actions' ? [[entry.localId, (body, context) => Reflect.apply(entry.value, undefined, [body, context])]] : []));
    const providerRequests: Array<{ url: string; method?: string; headers?: Readonly<Record<string, string>> }> = [];
    // The provider's HTTP response is the sole substituted business boundary.
    const services = createProductionPluginInvocationServiceOwners({ connectedAccounts: purposeRuntime.owner, loggerSink: { write() {} },
      http: createStablePluginHttpHost({ adapter: { openWebSocket: async () => { throw new Error('Unexpected provider WebSocket'); },
        request: async request => {
          providerRequests.push(request);
          const path = new URL(request.url).pathname;
          const value = manifest.id === AGENT37.id ? request.method === 'POST' ? { id: 'ab12cd34ef', status: 'running' } : { data: [] }
            : path.endsWith('/limits') ? { ok: true, type: 'limits.info', sandboxPlanKey: 'box_100', sandboxPlanDollars: 100, canStart: true,
              activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
            : path.endsWith('/saved-snapshots') ? { ok: true, type: 'snapshot.saved.list', snapshots: [] }
            : request.method === 'POST' ? { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null,
              sandbox: { id: 'bx_23456789', state: 'provisioning' } } : { ok: true, type: 'sandbox.list', sandboxes: [] };
          return { status: request.method === 'POST' ? manifest.id === AGENT37.id ? 201 : 202 : 200,
            finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
        } } }) });
    const native = nativeFixture({ fixtureManifest: canonicalManifest, actionHandlers: handlers, executionRealm: 'account',
      credentialOwner: purposeRuntime.owner, createServices: services.createServices, resolveHostBinding: services.resolveHostBinding });
    onTestFinished(() => native.targetActionInvocations.dispose());

    for (const localId of rootKind === 'native-options' ? ['options'] : ['options', 'acquire']) {
      const action = { pluginId: manifest.id, localId };
      const purpose = { consumer: action, purpose: 'cloud-api' };
      const actionInput = localId === 'options' ? {} : manifest.id === AGENT37.id
        ? { managedId: 'shared-instance', launch: { kind: 'vm', size: '2-4', region: 'eu' } }
        : { managedId: 'shared-instance', launch: { size: 'small', source: { kind: 'blank' } } };
      const requestId = crypto.randomUUID();
      const qualifiedActionId = `${manifest.id}/actions/${localId}`;
      const rootActionId = rootKind === 'native-options' ? 'machines.provisioners.options' : 'action.invoke';
      const provider = { pluginId: manifest.id, localId: manifest.contributes.machineProvisioners[0]!.id };
      const rootInput = rootKind === 'native-options' ? { homeId, controller: { machineId: selected.machine.id, installationId },
        contribution: provider, occurrenceId: native.runtimeRegistry.readPluginOccurrenceId?.(manifest.id),
        credentials: [{ purpose: { consumer: provider, purpose: 'cloud-api' }, teamId: selected.team.id,
          selection: { source: 'team_resource', resourceId: selected.resource.id, deliveryMode: 'direct', disclosedMember: selected.sourceAccount } }] }
        : { action, input: actionInput };
      const issued = await app.inject({ method: 'POST', url: `/v1/actions/${rootActionId}/execution-authorization`,
        headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: selected.machine.id,
          envelope: { v: 1, requestId, target: { kind: 'machine', machineId: selected.machine.id }, input: rootInput } } });
      expect(issued.statusCode, issued.body).toBe(200);
      root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
      expect(root.binding.accountId).toBe(selected.recipient.id);
      effectActionId = rootKind === 'native-options' ? rootActionId : qualifiedActionId;
      reviewedChild = { actionId: qualifiedActionId, role: rootKind === 'generic' ? 'action_invoke' : localId,
        inputDigest: computeActionInputApprovalDigestV1(qualifiedActionId as ActionId, actionInput) };
      const admissionInput = { subject: { kind: 'action_operation' as const, operationId: root.binding.requestId,
        actionId: qualifiedActionId, pluginVersion: manifest.version, consumer: action, isCurrent: () => true },
        purposes: [purpose], bindings: [], signal: new AbortController().signal,
        teamResourceSelections: [{ purpose, teamId: selected.team.id, selection: { source: 'team_resource' as const,
          resourceId: selected.resource.id, deliveryMode: 'direct' as const, disclosedMember: selected.sourceAccount } }] };
      if (rootKind === 'native-options') {
        const correctChild = reviewedChild;
        reviewedChild = { ...correctChild, actionId: `${manifest.id}/actions/acquire` };
        const wrongChild = await direct.open({ resourceId: selected.resource.id,
          consumer: { kind: 'action_operation', operationId: requestId, actionId: qualifiedActionId,
            pluginVersion: manifest.version, purpose }, slot: { kind: 'connected_service_purpose', purpose }, disclosedMember: selected.sourceAccount });
        expect(wrongChild.ok).toBe(false);
        reviewedChild = correctChild;
      }
      const before = materialRequests.length;
      const admitted = await purposeRuntime.admitActionPurposeBindings(admissionInput);
      expect(admitted.kind).toBe('local');
      if (admitted.kind !== 'local') throw new Error('Expected direct Action admission');
      try {
        expect(materialRequests).toHaveLength(before + 1);
        const request = { kind: 'httpHeaders' as const, origin: manifest.id === AGENT37.id ? 'https://api.agent37.com' : 'https://boat.dev', headerNames: ['authorization'] };
        const materialize = () => purposeRuntime.owner.materialize({ purpose, serviceRefs: [selected.sourceAccount.service], request,
          exactPurposeBindingSubjectId: admitted.lease.subjectId, signal: admissionInput.signal });
        const expectedHeaders = { [manifest.id === AGENT37.id ? 'authorization' : 'Authorization']: 'Bearer shared-token' };
        expect(await materialize()).toMatchObject({ kind: 'httpHeaders', headers: expectedHeaders });
        const outcome = await native.targetActionInvocations.invoke({ ...action, input: actionInput, surface: 'plugin', requestId,
          exactPurposeBindingSubjectId: admitted.lease.subjectId, signal: admissionInput.signal });
        expect(outcome).toMatchObject({ status: 'executed', value: localId === 'options' ? { dimensions: expect.any(Object) }
          : manifest.id === AGENT37.id ? { kind: 'bound' } : { kind: 'pending' } });
        expect(providerRequests.length).toBeGreaterThan(0);
        expect(providerRequests.every(request => Object.entries(request.headers ?? {}).some(([key, value]) =>
          key.toLowerCase() === 'authorization' && value === 'Bearer shared-token'))).toBe(true);
        expect(JSON.stringify(outcome)).not.toContain('shared-token');
        await db.teamCredentialResource.update({ where: { id: selected.resource.id }, data: { memberGrants: { deleteMany: {} } } });
        expect(await materialize()).toMatchObject({ kind: 'httpHeaders', headers: expectedHeaders });
        expect(materialRequests).toHaveLength(before + 1);
        await expect(purposeRuntime.admitActionPurposeBindings(admissionInput)).rejects.toMatchObject({ code: 'plugin_connected_account_direct_access_removed' });
      } finally { admitted.lease.dispose(); }
      // Each role is a new real admission against the same resource owner.
      await db.teamCredentialResource.update({ where: { id: selected.resource.id }, data: { memberGrants: { create: {
        teamMembershipId: selected.membership.id, deliveryMode: 'direct' } } } });
    }
  });
});

describe('two-Account finite broker Action through the real generic registry and native carrier', () => {
  it('executes once and refuses the same signed grant on a second carrier after withdrawal within its TTL', async () => {
    const server = '../../../../server/sources/';
    const { createLightSqliteHarness, createAccountTokenForTests }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
    const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
    const { createTeamDirectActionMaterialFixture }: typeof import('../../../../server/sources/app/teams/credentials/directActionMaterial.testkit') = await import(server + 'app/teams/credentials/directActionMaterial.testkit');
    const { registerTeamCredentialResourceRoutes }: typeof import('../../../../server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes') = await import(server + 'app/teams/credentials/registerTeamCredentialResourceRoutes');
    const { registerExternalActionRoutes }: typeof import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes') = await import(server + 'app/api/routes/actions/registerExternalActionRoutes');
    const { registerQualifiedConnectedAccountCredentialRoutesV4 }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4');
    const { accountRoutes }: typeof import('../../../../server/sources/app/api/routes/account/accountRoutes') = await import(server + 'app/api/routes/account/accountRoutes');
    const { featuresRoutes }: typeof import('../../../../server/sources/app/api/routes/features/featuresRoutes') = await import(server + 'app/api/routes/features/featuresRoutes');
    const { changesRoutes }: typeof import('../../../../server/sources/app/api/routes/changes/changesRoutes') = await import(server + 'app/api/routes/changes/changesRoutes');
    const { resolvePeerMediationGrantSigningConfig }: typeof import('../../../../server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1') = await import(server + 'app/machines/peer/mediation/mintDirectRouteGrantV1');
    const { startTeamCredentialActionSocketPresence }: typeof import('../../../../server/sources/testkit/teamCredentialActionSocketPresence.testkit') = await import(server + 'testkit/teamCredentialActionSocketPresence.testkit');
    // Home identity is process-scoped, including across this file's disposable databases.
    const homeId = 'srv_two_account_declared_action';
    const home = await createLightSqliteHarness({ tempDirPrefix: 'two-account-broker-', initAuth: true, initEncrypt: true, env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1', HAPPIER_SERVER_IDENTITY_ID: homeId,
    } });
    let closePresence: (() => Promise<void>) | undefined;
    onTestFinished(async () => {
      try { await closePresence?.(); }
      finally { await home.close(); }
    });
    const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'example.cloud', version: '1.0.0',
      displayName: 'Cloud', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [
        { id: 'cloud-api', capability: 'connectedAccounts', reason: 'Use the selected cloud account',
          scope: { serviceRefs: ['cloud'], operations: ['select', 'use'], materializationKinds: ['httpHeaders'] } },
        { id: 'cloud-http', capability: 'network', reason: 'Read cloud regions',
          scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://cloud.example.test' }], methods: ['GET'] } },
      ], optional: [] }, contributes: { connectedAccountDescriptors: [{ id: 'cloud', title: 'Cloud', authentication: {
        defaultModeId: 'api-key', modes: [{ id: 'api-key', kind: 'manual', outcomeReconciliation: 'none',
          fields: [{ id: 'token', title: 'API key', schema: { type: 'string' }, secret: true }] }],
      } }], actions: [{ id: 'options', title: 'Read cloud regions', scopes: ['global'], surfaces: ['cli', 'plugin'],
        dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['cloud-api', 'cloud-http'],
        inputSchema: { type: 'object', properties: { region: { type: 'string' } },
          required: ['region'], additionalProperties: false },
        resultSchema: { type: 'object', properties: { region: { type: 'string' }, requesterVisible: { type: 'boolean' } },
          required: ['region', 'requesterVisible'], additionalProperties: false },
      }] } });
    const shared = await createTeamDirectActionMaterialFixture({ manifest, deliveryMode: 'brokered', homeServerIdentityId: homeId });
    if (!shared.broker) throw new Error('Missing real custodian Machine');
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerExternalActionRoutes(app); registerTeamCredentialResourceRoutes(app);
    registerQualifiedConnectedAccountCredentialRoutesV4(app); accountRoutes(app); featuresRoutes(app); changesRoutes(app);
    const homeRefusals: Array<{ path: string; status: number; code: unknown; phase: unknown }> = [];
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode >= 400 && typeof payload === 'string') {
        let code: unknown;
        let phase: unknown;
        try {
          const parsed = JSON.parse(payload);
          code = parsed.code ?? parsed.error ?? parsed.reasonCode;
          phase = parsed.authorizationRefusal;
        } catch { /* Only structured refusal codes belong in test diagnostics. */ }
        homeRefusals.push({ path: request.url.split('?')[0]!, status: reply.statusCode, code, phase });
      }
      return payload;
    });
    let directMaterialReads = 0;
    app.addHook('onRequest', async request => { if (request.url.endsWith('/direct-material')) directMaterialReads++; });
    const presence = startTeamCredentialActionSocketPresence(app);
    closePresence = async () => { try { await presence.close(); } finally { await app.close(); } };
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const recipientCredentials = { token: await createAccountTokenForTests(shared.recipient.id, { kind: 'account', authority: 'present_user' }), encryption: null } as const;
    const custodianCredentials = { token: await createAccountTokenForTests(shared.custodian.id, { kind: 'account', authority: 'present_user' }), encryption: null } as const;
    const directory = await mkdtemp(join(tmpdir(), 'two-account-broker-runtime-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const source = await createDaemonMachineIrohRuntime({ happyHomeDir: join(directory, 'requester'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
    const target = await createDaemonMachineIrohRuntime({ happyHomeDir: join(directory, 'custodian'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
    onTestFinished(source.shutdown); onTestFinished(target.shutdown);
    expect(source.available, 'Native requester endpoint is required for this composed gate').toBe(true);
    expect(target.available, 'Native custodian endpoint is required for this composed gate').toBe(true);
    if (!source.available || !target.available) throw new Error('Real native Iroh runtime unavailable');
    const keys = nacl.sign.keyPair();
    const installationId = crypto.randomUUID();
    const custodianKeys = nacl.sign.keyPair();
    const custodianInstallationId = crypto.randomUUID();
    await db.machine.update({ where: { id: shared.machine.id }, data: { installationId, installationPublicKey: keys.publicKey,
      operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], ...source.endpoint } } } });
    await db.machine.update({ where: { id: shared.broker.id }, data: { installationId: custodianInstallationId,
      installationPublicKey: custodianKeys.publicKey, operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1, 3] }, irohMachineEndpoint: { protocolVersions: [1], ...target.endpoint } } } });
    await presence.connect({ baseUrl: serverUrl, token: recipientCredentials.token, accountId: shared.recipient.id,
      machineId: shared.machine.id, installationId, keys });
    await presence.connect({ baseUrl: serverUrl, token: custodianCredentials.token, accountId: shared.custodian.id,
      machineId: shared.broker.id, installationId: custodianInstallationId, keys: custodianKeys });
    const signing = resolvePeerMediationGrantSigningConfig(process.env);
    if (!signing.ok) throw new Error('Real Home route signing capability unavailable');
    const trustRoots = [signing.capability];
    const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({ accountId: shared.recipient.id,
      localMachineId: shared.machine.id, runtime: source, resolveTrustRoots: () => trustRoots });
    let opened: Extract<ProviderBrokerActionOpenResponseV3, { ok: true }> | undefined;
    let activeOpen: ProviderBrokerActionOpenResponseV3 | undefined;
    let homeOpenAttempts = 0;
    let homeAdmissionAttempts = 0;
    let opening: { request: ProviderBrokerActionOpenRequestV3; requestHeaders: Readonly<Record<string, string>> } | undefined;
    const brokerExecute = createTeamCredentialBrokerActionPurposeExecutor({ initiatorMachineId: shared.machine.id, openTunnel,
      openBroker: async (request, signal, requestHeaders) => {
        homeOpenAttempts++;
        const result = await openTeamCredentialProviderBroker({ token: recipientCredentials.token, serverBaseUrl: serverUrl,
          request, signal, requestHeaders });
        if (result.ok) {
          opened = result;
          opening = { request, requestHeaders };
          activeOpen = await openTeamCredentialProviderBroker({ token: recipientCredentials.token, serverBaseUrl: serverUrl,
            request, signal, requestHeaders });
        }
        return result;
      } });
    const moduleSource = `let invocations = 0;
export function readActionInvocationCount() { return invocations; }
export function activate(api) {
  api.connectedAccounts.register('cloud', {
    authentication: { modes: { 'api-key': { kind: 'manual', async complete() { return { status: 'connected', accountId: 'cloud', displayName: 'Cloud', scopes: [] }; } } } },
    async refresh() { return { status: 'unavailable' }; }, async revoke() { return { status: 'remoteUnsupported' }; },
    async status() { return { status: 'connected', displayName: 'Cloud' }; },
    async materialize(request, context) { const token = await context.credentials.get('token', { signal: context.signal });
      return { kind: 'httpHeaders', headers: { authorization: 'Bearer ' + token } }; }
  });
  api.actions.register('options', async (input, context) => {
    invocations++;
    const material = await context.services.connectedAccounts.materialize('cloud-api', { kind: 'httpHeaders', origin: 'https://cloud.example.test', headerNames: ['authorization'] });
    const response = await context.services.http.request({ url: 'https://cloud.example.test/regions?region=' + input.region, method: 'GET', headers: material.headers }, { signal: context.signal });
    return JSON.parse(new TextDecoder().decode(response.body));
  });
}`;
    const createRuntime = async (credentials: typeof recipientCredentials, machineId: string, name: string, requester: boolean) => {
      const happyHomeDir = join(directory, name);
      const controller = createPluginReloadController({ happyHomeDir });
      onTestFinished(() => controller.shutdown());
      const credentialApi = createConnectedServiceCredentialApi(credentials);
      const getAccountEncryptionMode = () => runWithServerHttpBaseUrl(serverUrl, () => credentialApi.getAccountEncryptionMode());
      const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials, getAccountEncryptionMode,
        secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
      const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials, reloadController: controller,
        getAccountEncryptionMode, configuration: persistence.configuration });
      const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
        credentialOwnerAccountId: requester ? shared.recipient.id : shared.custodian.id, workerMachineId: machineId,
        qualifiedApi: {
          listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, services, signal }),
          listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
          listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token: credentials.token, service, signal }),
          readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token: credentials.token, group, signal }),
        },
        reloadController: controller, resolveQualifiedConnectedAccountV4Support: async () => resolveQualifiedConnectedAccountAtomicV4Negotiation(
          await fetchServerFeaturesSnapshot({ serverUrl, token: credentials.token })),
        ...(requester ? { executeTeamCredentialBrokerAction: brokerExecute } : {}) });
      const runtime = await runWithServerHttpBaseUrl(serverUrl, () => createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, controller,
        plugins: [{ manifest, files: { 'daemon.mjs': moduleSource } }],
        resolveContributes: async homeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
          loadResult: await loadInstalledPlugins({ happyHomeDir: homeDir }), provenance: 'external' })),
        runtimeOptions: { connectedAccounts: purposes.owner, actionFormConnectedAccounts: purposes,
          scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() } },
      }));
      onTestFinished(runtime.dispose);
      return { ...runtime, purposes };
    };
    const recipient = await createRuntime(recipientCredentials, shared.machine.id, 'requester-plugin', true);
    const custodian = await createRuntime(custodianCredentials, shared.broker.id, 'custodian-plugin', false);
    const unreachable = async (): Promise<never> => { throw new Error('V3 must not invoke the unrelated V1 inference port'); };
    const broker = await startDaemonProviderBrokerRuntime({ machineId: shared.broker.id, resolveTrustRoots: () => trustRoots,
      nowMs: Date.now, createRequestId: crypto.randomUUID, resolveRequestPolicy: unreachable, admitRequest: unreachable,
      authorizeModelCatalog: unreachable,
      sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: shared.broker.id, custody: { retire: unreachable },
        selectConnectedServicesSourceMember: unreachable, openConnectedServicesSource: unreachable, openProviderConnectionSource: unreachable }),
      actionOperations: { execute: createTeamCredentialBrokerActionExecutor({ purposeBindings: custodian.purposes,
        withRuntime: async (read, request) => await runWithServerHttpBaseUrl(serverUrl, () => withTeamCredentialActionRuntime({
          native: custodian.lease, action: request.action,
          resolveAccount: async () => { throw new Error('Daemon Actions must not compose an Account host'); },
        }, read)) }),
        admit: async (request, signal) => {
          homeAdmissionAttempts++;
          const response = await fetch(`${serverUrl}${PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1}`, {
            method: 'POST', headers: { authorization: `Bearer ${custodianCredentials.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request), signal });
          return ProviderBrokerActionAdmissionResponseV3Schema.parse(await response.json());
        } },
    });
    onTestFinished(broker.close);
    const admission = await startPeerMediationLoopbackServer({ nowMs: Date.now, trustRoots,
      endpointExpiresAt: Date.now() + 300_000, expected: { accountId: shared.custodian.id, machineId: shared.broker.id,
        flowKind: 'machine_rpc', routeKind: 'loopback_direct', endpointFingerprint: target.endpoint.endpointId },
      irohMachineAdmission: { localEndpointId: target.endpoint.endpointId, role: 'acceptor', allowedFlows: [],
        resolveApplicationTarget: async () => null,
        resolveProviderBrokerApplicationTarget: broker.resolveProviderBrokerApplicationTarget } });
    onTestFinished(admission.stop);
    await target.startAttemptAcceptor({ admissionPort: Number(new URL(admission.url).port) });
    const action = { pluginId: manifest.id, localId: 'options' };
    const input = { region: 'eu' };
    const rootInput = { action, input };
    const requestId = crypto.randomUUID();
    const issued = await app.inject({ method: 'POST', url: '/v1/actions/action.invoke/execution-authorization',
      headers: { authorization: `Bearer ${recipientCredentials.token}` }, payload: { v: 1, machineId: shared.machine.id,
        envelope: { v: 1, requestId, target: { kind: 'machine', machineId: shared.machine.id }, input: rootInput } } });
    expect(issued.statusCode, issued.body).toBe(200);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
    const projected = await projectExternalActionRequesterHttpAuthorization({ authorization, target: authorization.binding.target,
      serverId: 'two-account-broker', serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
      installationId, privateKey: keys.secretKey, rootAdmitted: true });
    if (!projected) throw new Error('Real signed requester root projection unavailable');
    // Generic private selection fixture: real native/SCM producers are covered
    // by their composed journeys; the canonical registry consumes this seed.
    const selectedPurposes = captureConnectedAccountInvocationPurposeBinding({ identity: action, operationId: requestId,
      isCurrent: () => true, purposes: [shared.purpose], purposeBindings: { v: 1, bindings: [],
        teamResourceSelections: [{ purpose: shared.purpose, teamId: shared.team.id,
          selection: { source: 'team_resource', resourceId: shared.resource.id, deliveryMode: 'brokered' } }] } });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, runtimeAccountId: shared.recipient.id,
      invocationServices: { connectedAccountPurposeBindingSelection: { purposes: selectedPurposes.purposes,
        purposeBindings: selectedPurposes.purposeBindings } },
      externalActionExecutionAuthorization: projected, externalActionTarget: projected.binding.target, actionRequestId: requestId };
    const approvalContext = { ...context, hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'action.invoke', input: rootInput,
      context, reviewAdmitted: true }) };
    const count = (runtime: typeof recipient) => {
      const read = Reflect.get(runtime.modulesByPluginId.get(manifest.id)!, 'readActionInvocationCount');
      if (typeof read !== 'function') throw new Error('Missing authored Action observation');
      return Reflect.apply(read, undefined, []);
    };
    await recipient.registry.activateContributionsOnDemand([{ pluginId: manifest.id, family: 'actions', localId: action.localId }]);
    brokerProvider.requests.length = 0;
    const outcome = await runWithServerHttpBaseUrl(serverUrl, () => recipient.registry.targetActionInvocations.invoke({ ...action,
      input, surface: 'cli', invocationSurface: 'cli', invocationAuthority: 'present_user', requestId,
      approvalContext, signal: new AbortController().signal }));
    expect(outcome, JSON.stringify({ outcome, homeOpenAttempts, homeAdmissionAttempts,
      homeGrantCreated: opened !== undefined, homeRefusals, requesterHandlerInvocations: count(recipient),
      custodianHandlerInvocations: count(custodian), providerRequests: brokerProvider.requests.length,
    })).toMatchObject({ status: 'executed', value: { region: 'eu', requesterVisible: true } });
    expect(count(recipient)).toBe(0); expect(count(custodian)).toBe(1);
    expect(brokerProvider.requests).toHaveLength(1);
    expect(brokerProvider.requests[0]?.authorization).toBe('Bearer shared-token');
    expect(directMaterialReads).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain('shared-token');
    expect(opened?.authority.payload.initiator.accountId).toBe(shared.recipient.id);
    if (!opened) throw new Error('No actual Home-signed broker grant');
    expect(Date.now()).toBeLessThan(opened.authority.payload.expiresAt);
    await db.teamCredentialResource.update({ where: { id: shared.resource.id }, data: { memberGrants: { deleteMany: {} } } });
    const replay = await openTunnel({ brokerOpen: opened, signal: new AbortController().signal });
    try {
      const response = await fetch(`http://127.0.0.1:${replay.localPort}${PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3}`, {
        method: 'POST', headers: { 'content-type': 'application/json', [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: replay.localCapability },
        body: JSON.stringify({ input }) });
      expect(ProviderBrokerActionExecuteResponseV3Schema.parse(await response.json()))
        .toMatchObject({ ok: false, reasonCode: 'operation_not_current' });
    } finally { await replay.close(); }
    expect(count(custodian)).toBe(1); expect(brokerProvider.requests).toHaveLength(1);
    expect(activeOpen).toMatchObject({ ok: false, reasonCode: 'operation_not_current' });
    if (!opening) throw new Error('Missing actual finite Home request');
    const withdrawn = await openTeamCredentialProviderBroker({ token: recipientCredentials.token, serverBaseUrl: serverUrl,
      ...opening, signal: new AbortController().signal });
    expect(withdrawn.ok).toBe(false);
    expect(count(custodian)).toBe(1); expect(directMaterialReads).toBe(0);
  }, 180_000);
});
