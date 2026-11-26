import { expect, it, onTestFinished } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { PROJECT_DEFINITION_INSPECT_ACTION_ID } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { createExternalActionRequesterServerRequestHeaders, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createRequesterTeamCredentialDirectMaterialClient } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { prepareFiniteConnectedAccountProcessEnvironment } from '@/daemon/connectedServices/materialize/processConnectedAccountEnvironment';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveSystemToolLaunchPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import { reloadConfiguration } from '@/configuration';
import { readCurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';

it('delivers signed GitHub Direct material to a finite Project Setup process and refuses withdrawn access', async () => {
  const server = '../../../../server/sources/';
  const { createLightSqliteHarness, createAccountTokenForTests }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
  const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
  const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
  const { createTeamDirectActionMaterialFixture }: typeof import('../../../../server/sources/app/teams/credentials/directActionMaterial.testkit') = await import(server + 'app/teams/credentials/directActionMaterial.testkit');
  const { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2 }: typeof import('../../../../server/sources/app/plugins/availability/currentDeclaration') = await import(server + 'app/plugins/availability/currentDeclaration');
  const { registerTeamCredentialResourceRoutes }: typeof import('../../../../server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes') = await import(server + 'app/teams/credentials/registerTeamCredentialResourceRoutes');
  const { registerExternalActionRoutes }: typeof import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes') = await import(server + 'app/api/routes/actions/registerExternalActionRoutes');
  const { registerPluginAvailabilityRoutes }: typeof import('../../../../server/sources/app/plugins/availability/routes') = await import(server + 'app/plugins/availability/routes');
  const { registerQualifiedConnectedAccountCredentialRoutesV4 }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4');
  const { mutateQualifiedConnectedServiceCredential }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository');
  const homeId = 'srv_finite_setup_tool';
  const home = await createLightSqliteHarness({ tempDirPrefix: 'finite-setup-tool-', initAuth: true, initEncrypt: true, env: {
    HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
    HAPPIER_SERVER_IDENTITY_ID: homeId,
  } });
  onTestFinished(home.close);
  const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(value => value.id === 'github-account')!;
  const selected = await createTeamDirectActionMaterialFixture({ manifest: PLUGIN_MANIFEST,
    serviceId: descriptor.id, authenticationModeId: descriptor.authentication.defaultModeId,
    actionId: 'gh', purposeId: 'github.cli', homeServerIdentityId: homeId, seedRecipientDeclaration: false });
  const app = createAuthenticatedTestApp({
    authentication: 'real', bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
  });
  onTestFinished(() => app.close());
  const statuses: number[] = [];
  app.addHook('onResponse', async (request: { url: string }, reply: { statusCode: number }) => {
    if (request.url.endsWith('/direct-material')) statuses.push(reply.statusCode);
  });
  registerExternalActionRoutes(app);
  registerPluginAvailabilityRoutes(app);
  registerTeamCredentialResourceRoutes(app);
  registerQualifiedConnectedAccountCredentialRoutesV4(app);
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'finite-setup-plugin-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  env.patch({ HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_SERVER_URL: serverUrl, HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_ACTIVE_SERVER_ID: '' });
  reloadConfiguration();
  onTestFinished(async () => { env.restore(); reloadConfiguration(); await rm(happyHomeDir, { recursive: true, force: true }); });
  await updateMachineRegistration(() => ({ machineId: selected.machine.id }));
  const installation = await readCurrentMachineInstallation();
  if (!installation) throw new Error('Fixture Machine installation is missing');
  const { installationId, publicKey, privateKey } = installation.identity;
  await db.machine.update({ where: { id: selected.machine.id }, data: {
    accountId: selected.custodian.id, installationId, installationPublicKey: Buffer.from(publicKey, 'base64url'), operationProtocolCapabilitiesRevision: 1,
    operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
  } });
  await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.machine.id, accountId: selected.recipient.id,
    accessLevel: 'view', createdByAccountId: selected.custodian.id } });
  await db.pluginMachineMaterialization.create({ data: { accountId: selected.custodian.id, serverIdentityId: homeId,
    machineId: selected.machine.id, materializationId: installationId, pluginId: PLUGIN_MANIFEST.id,
    version: PLUGIN_MANIFEST.version, sourceClass: 'bundledFirstParty', portableRelease: false,
    archiveDigestSha256: createReleaseLessDeclarationV1(selected.manifest).manifestDigestSha256,
    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
  const token = await createAccountTokenForTests(selected.recipient.id, { kind: 'account', authority: 'present_user' });
  const custodianToken = await createAccountTokenForTests(selected.custodian.id, { kind: 'account', authority: 'present_user' });
  const credentials = { token, encryption: null } as const;
  const availability = async (action: 'account.plugins.availability.intent.set' | 'account.plugins.availability.intent.read',
    accountToken: string, input: object) => {
    const response = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1[action],
      headers: { authorization: `Bearer ${accountToken}` }, payload: { pluginId: PLUGIN_MANIFEST.id, ...input } });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const readAvailability = async (accountToken: string) =>
    PluginAvailabilityIntentReadActionOutputV1Schema.parse(await availability('account.plugins.availability.intent.read', accountToken, {}));
  await availability('account.plugins.availability.intent.set', token, {
    enabled: true, expectedRevision: null, desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: [],
  });
  const target = { kind: 'machine' as const, machineId: selected.machine.id };
  const actionId = PROJECT_PREPARE_ACTION_ID_V1;
  const workspace = { serverId: homeId, workspaceId: crypto.randomUUID(), machineId: selected.machine.id, rootPath: '/workspace' };
  const issue = async (root: string, input: unknown) => {
    const requestId = crypto.randomUUID();
    const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(root),
      headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: selected.machine.id,
        envelope: { v: 1, requestId, target, input } } });
    if (issued.statusCode !== 200) {
      const { error, failureCause } = issued.json();
      throw new Error(`Home refused test Action ${root} with HTTP ${issued.statusCode}: ${error} (${failureCause?.errorCode ?? 'no cause'})`);
    }
    const admitted = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
    expect(admitted.binding.accountId).toBe(selected.recipient.id);
    expect(admitted.binding.custodianAccountId).toBe(selected.custodian.id);
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted, serverId: homeId,
      serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, target: admitted.binding.target, installationId, privateKey: Buffer.from(privateKey, 'base64url') });
    if (!authorization) throw new Error('Home did not verify the issued Action');
    const context = { serverId: homeId, externalActionExecutionAuthorization: authorization };
    const resolveRequestHeaders = createExternalActionRequesterServerRequestHeaders(context);
    if (!resolveRequestHeaders) throw new Error('Issued root has no requester HTTP projection');
    return { requestId, context, resolveRequestHeaders };
  };
  const signed = await issue(actionId, { workspace, phase: 'setup' });
  const client = createRequesterTeamCredentialDirectMaterialClient({ credentials,
    serverHttpBaseUrl: serverUrl, readAccountEncryptionMode: async () => 'plain' });
  const openRequest = (consumer: Partial<typeof selected.consumer>, proof = signed) => ({
    teamId: selected.team.id, resourceId: selected.resource.id,
    consumer: { kind: 'action_operation' as const, operationId: proof.requestId, actionId,
      pluginVersion: PLUGIN_MANIFEST.version, purpose: selected.purpose, ...consumer },
    slot: { kind: 'connected_service_purpose' as const, purpose: consumer.purpose ?? selected.purpose }, disclosedMember: selected.sourceAccount,
  });
  const open = (consumer: Partial<typeof selected.consumer>, proof = signed) =>
    client.open({ ...openRequest(consumer, proof), resolvePlatformOperationRequestHeaders: proof.resolveRequestHeaders });

  const controller = createPluginReloadController({ happyHomeDir });
  onTestFinished(() => controller.shutdown());
  const getAccountEncryptionMode = async () => 'plain' as const;
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials, getAccountEncryptionMode,
    secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: 'finite-setup-fixture' }) });
  const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials, reloadController: controller,
    getAccountEncryptionMode, configuration: persistence.configuration });
  let selection: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [], teamResourceSelections: [{
    teamId: selected.team.id, purpose: selected.purpose, selection: { source: 'team_resource',
      deliveryMode: 'direct', resourceId: selected.resource.id, disclosedMember: selected.sourceAccount },
  }] };
  const runtime = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established, reloadController: controller,
    credentialOwnerAccountId: selected.recipient.id, workerMachineId: selected.machine.id, openTeamDirect: client.open,
    qualifiedApi: {
      listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token, services, signal }),
      listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token, service, signal }),
      listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token, service, signal }),
      readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token, group, signal }),
    },
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    store: { read: async () => selection, update: async () => { throw new Error('Setup must preserve the saved selection'); },
      subscribe: () => ({ dispose() {} }) } });
  const plugin = await createAdmittedPluginRuntimeFixture({ happyHomeDir, controller, runtimeOptions: {
    pluginIds: [PLUGIN_MANIFEST.id], connectedAccounts: runtime.owner,
    accountStorageDependencies: {
      readCredentials: async () => ({ token: custodianToken, encryption: null }),
      isCurrentAccount: () => true,
      resolveAccountScopeKey: () => selected.custodian.id,
      resolveBaseUrl: () => serverUrl,
    },
  } });
  onTestFinished(plugin.dispose);
  const declarations = resolveSystemToolLaunchPurposeDeclarations(controller.getState().activeRegistry!.contributes);
  const signal = new AbortController().signal;
  const prepare = (proof?: typeof signed) => prepareFiniteConnectedAccountProcessEnvironment({
    runtime, declarations, actionContext: proof?.context, signal,
    subject: { kind: 'action_operation', operationId: 'local-setup-operation', actionId, pluginVersion: '0.0.0', isCurrent: () => true },
  });
  const refused = { ok: false, reason: 'access_removed' };
  const accessRemoved = { code: 'plugin_connected_account_direct_access_removed' };
  await expect(prepare()).rejects.toMatchObject(accessRemoved);
  expect(statuses).toEqual([]);
  const beforePublication = await open({});
  await plugin.registry.claimReleaseLessDeclarations();
  expect((await readAvailability(token)).currentDeclaration).toBeNull();
  expect(await readAvailability(custodianToken))
    .toMatchObject({ machineDeclarations: [{ machineId: selected.machine.id, machineInstallationId: installationId }] });
  statuses.length = 0;

  const prepared = await prepare(signed);
  try {
    const produced = await prepared.produce({ GITHUB_TOKEN: 'native-fallback' }, signal);
    const child = await promisify(execFile)(process.execPath, ['-e',
      'process.exit(process.env.GH_TOKEN === "shared-token" && !process.env.GITHUB_TOKEN ? 0 : 1)'], { env: produced.environment });
    expect(child.stdout).toBe('');
    expect(statuses).toEqual([200]);
  } finally { prepared.dispose(); }
  expect(beforePublication).toMatchObject({ ok: false, operationError: { error: 'plugin_declaration_not_found' } });

  const materialPath = `/v2/teams/${selected.team.id}/credential-resources/${selected.resource.id}/direct-material`;
  const { teamId: _teamId, ...wrongRequestId } = openRequest({ operationId: 'local-setup-operation' });
  const headers = await signed.resolveRequestHeaders({ method: 'POST', path: materialPath, body: wrongRequestId });
  if (!headers) throw new Error('Wrong-request-id control requires a genuine signed request');
  const rejected = await app.inject({ method: 'POST', url: materialPath, headers, payload: wrongRequestId });
  expect(rejected.statusCode).toBe(401);
  expect(rejected.json()).toMatchObject({ error: 'invalid_token' });
  const inspect = await issue(PROJECT_DEFINITION_INSPECT_ACTION_ID, { workspace });
  await expect(open({}, inspect)).resolves.toMatchObject(refused);
  await expect(open({ purpose: { ...selected.purpose, consumer: { ...selected.purpose.consumer, localId: 'undeclared' } } })).resolves.toMatchObject(refused);
  await expect(open({ purpose: { ...selected.purpose, purpose: 'other-purpose' } })).resolves.toMatchObject(refused);
  const staleVersion = PLUGIN_MANIFEST.version === '0.0.0' ? '0.0.1' : '0.0.0';
  await expect(open({ pluginVersion: staleVersion })).resolves.toMatchObject(refused);
  const selectionKey = { accountId: selected.custodian.id, pluginId: PLUGIN_MANIFEST.id };
  const forInstallation = (id: string, manifest = selected.manifest) =>
    mergeReleaseLessDeclarationV2({ stored: null, declaration: createReleaseLessDeclarationV1(manifest),
      publisher: { machineId: selected.machine.id, installationId: id } }).stored;
  const altered = { ...selected.manifest, contributes: { ...selected.manifest.contributes,
    systemTools: selected.manifest.contributes.systemTools.map(tool => tool.id !== selected.purpose.consumer.localId ? tool : {
      ...tool, connectedAccountLaunch: { ...tool.connectedAccountLaunch!, service: 'other-service' },
    }) } };
  await db.accountPluginIntent.update({ where: { accountId_pluginId: selectionKey },
    data: { releaseLessDeclaration: forInstallation(installationId, altered) } });
  await expect(open({})).resolves.toMatchObject(refused);
  await db.accountPluginIntent.update({ where: { accountId_pluginId: selectionKey },
    data: { releaseLessDeclaration: forInstallation(crypto.randomUUID()) } });
  await expect(open({})).resolves.toMatchObject({ ok: false, operationError: { error: 'plugin_declaration_not_found' } });
  await db.accountPluginIntent.update({ where: { accountId_pluginId: selectionKey },
    data: { releaseLessDeclaration: forInstallation(installationId) } });

  const grantKey = { resourceId: selected.resource.id, teamMembershipId: selected.membership.id };
  await db.teamCredentialMemberGrant.update({ where: { resourceId_teamMembershipId: grantKey }, data: { deliveryMode: 'brokered' } });
  await expect(open({})).resolves.toMatchObject(refused);
  await db.teamMembership.delete({ where: { id: selected.membership.id } });
  await expect(prepare(await issue(actionId, { workspace, phase: 'setup' }))).rejects.toMatchObject(accessRemoved);

  const personal = { service: selected.sourceAccount.service, accountId: 'personal-github' };
  const written = await mutateQualifiedConnectedServiceCredential({ accountId: selected.recipient.id, ref: personal,
    authenticationModeId: descriptor.authentication.defaultModeId, expectedCredentialRevision: null,
    content: { t: 'plain', v: { v: 1, values: { token: 'personal-token' } } }, metadata: { scopes: [] } });
  expect(written.status).toBe('written');
  selection = { v: 1, bindings: [{ purpose: selected.purpose, target: { kind: 'account', account: personal } }] };
  const requestsBeforePersonal = statuses.length;
  await runWithServerHttpBaseUrl(serverUrl, async () => {
    const admitted = await prepare(signed);
    try {
      const produced = await admitted.produce({}, signal);
      expect(produced.environment.GH_TOKEN === 'personal-token').toBe(true);
    } finally { admitted.dispose(); }
  });
  expect(statuses).toHaveLength(requestsBeforePersonal);
}, 180_000);
