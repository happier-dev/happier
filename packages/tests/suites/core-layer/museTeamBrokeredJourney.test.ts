import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { getBundledAgentDeclaration } from '../../../../apps/ui/sources/agents/catalog/catalog';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';
import { ProviderBrokerOpenResponseV1Schema, PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
  PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { TeamCredentialResourceCreateInputV1Schema, TeamCredentialResourceSummaryV1Schema,
  TeamCredentialResourceAudienceInputV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createLightSqliteHarness, createAccountTokenForTests,
  type LightSqliteHarness } from '../../../../apps/server/sources/testkit/lightSqliteHarness';
import { resolvePeerMediationGrantSigningConfig } from '../../../../apps/server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { verifyProviderBrokerRouteGrantSignatureV1 } from '../../../../apps/server/sources/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { peerMediationGrantSigningEnv } from '../../../../apps/server/sources/testkit/env';
import { createAuthenticatedTestApp } from '../../../../apps/server/sources/app/api/testkit/sqliteFastify';
import { registerTeamCredentialResourceRoutes } from '../../../../apps/server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes';
import { homeDomainActionPathForMethod } from '../../../../apps/server/sources/app/api/routes/actions/homeDomainActionRoute';
import { db } from '../../../../apps/server/sources/storage/db';
import { inTx } from '../../../../apps/server/sources/storage/inTx';
import { mutateQualifiedConnectedServiceCredential } from '../../../../apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { createServiceAccountTokenIdentityFields } from '../../../../apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { writeSessionTeamCredentialBindingsInTx } from '../../../../apps/server/sources/app/teams/credentials/sessionBinding';
import { readCurrentContributionRegistry } from '../../../../apps/cli/src/agent/catalog/snapshot';
import { createConnectedAccountPurposeBindingOwner } from '../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountModelObserver } from '../../../../apps/cli/src/providers/modelManagement/connectedAccountModelObservation';
import { projectConnectedAccountCatalog } from '../../../../apps/cli/src/providers/modelManagement/connectedAccountCatalog';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '../../../../apps/cli/src/providers/broker/applicationProjection';
import { normalizeSessionTeamCredentialLaunch } from '../../../../apps/cli/src/session/services/sessionTeamCredentialLaunch';
import { readSessionTeamCredentialResourceCatalog } from '../../../../apps/cli/src/session/services/sessionTeamCredentialCatalog';
import { openSessionTeamCredentialProviderBinding } from '../../../../apps/cli/src/providers/broker/sessionTeamCredentialProviderBinding';
import { createAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { composeConnectedServiceTeamCredentialBindingIntents } from '../../../../apps/ui/sources/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { buildNewSessionConnectedServicesSelectionListModel, createTeamResourceServiceOptionId } from '../../../../apps/ui/sources/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import { buildSessionModelPickerSections } from '../../../../apps/ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';
import { createPiAgentRuntime } from '../../../plugins/pi/src/agent/runtime/engine';
import { hostBoundaries } from '../../../plugins/pi/src/agent/runtime/nativeProcess.test-support';

const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' } as const;
const serviceKey = `${service.pluginId}/${service.localId}`;
const piTarget = 'agent:happier.agent.pi/pi';
const modelId = 'muse-spark-1.3-contributor';
let harness: LightSqliteHarness | undefined;
let app: ReturnType<typeof createAuthenticatedTestApp> | undefined;

beforeAll(async () => {
  harness = await createLightSqliteHarness({ tempDirPrefix: 'muse-team-journey-', initAuth: true, initEncrypt: true,
    env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test', ...peerMediationGrantSigningEnv() } });
  app = createAuthenticatedTestApp({ authentication: 'real' });
  registerTeamCredentialResourceRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => { await app?.close(); await harness?.close(); });

it('shares Muse through Meta into recipient Pi, hides it from Muse, and refuses the next launch after revocation', async () => {
  if (!app) throw new Error('Home did not start');
  const home = app;
  const address = home.server.address();
  if (!address || typeof address === 'string') throw new Error('Home has no TCP address');
  const homeUrl = `http://127.0.0.1:${address.port}`;
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
  const [ownerToken, recipientToken] = await Promise.all([owner, recipient].map(account => createAccountTokenForTests(
    account.id, { kind: 'account', authority: 'present_user' })));
  const team = await db.team.create({ data: { name: 'Muse broker journey' } });
  await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
  const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
  const machines = await Promise.all([owner, recipient].map((account, index) => db.machine.create({ data: {
    id: crypto.randomUUID(), accountId: account.id, metadata: '{}', active: true, kind: 'persistent',
    operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: String(index + 1).repeat(64) },
      ...(index === 0 ? { providerBrokerIngress: { protocolVersions: [1] } } : {}) },
    operationProtocolCapabilitiesRevision: 1,
  } })));
  const broker = machines[0]!;
  const worker = machines[1]!;
  const account = { service, accountId: 'muse-inference' };
  const stored = await mutateQualifiedConnectedServiceCredential({ accountId: owner.id, ref: account,
    authenticationModeId: 'api-key', content: { t: 'plain', v: { v: 1,
      values: { credentialMode: 'manual', inferenceKey: 'synthetic-owner-muse-key' } } },
    metadata: { scopes: [], kind: 'token' }, expectedCredentialRevision: null });
  expect(stored.status).toBe('written');
  const credential = await db.serviceAccountToken.findFirstOrThrow({ where: {
    accountId: owner.id, ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId: 'api-key' }),
  } });
  async function post(path: string, token: string, input: unknown) {
    const response = await fetch(`${homeUrl}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const result: unknown = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  }
  const actionPath = (action: Parameters<typeof homeDomainActionPathForMethod>[0]) => homeDomainActionPathForMethod(action, 'POST');
  const resource = TeamCredentialResourceSummaryV1Schema.parse(await post(actionPath('teams.credentials.create'), ownerToken!,
    TeamCredentialResourceCreateInputV1Schema.parse({ teamId: team.id, resourceId: crypto.randomUUID(), displayName: 'Team Muse',
      source: { v: 1, kind: 'connected_account', target: { kind: 'account', account }, credentialIncarnation: credential.id },
      deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
      brokerPlacement: { kind: 'machine', machineId: broker.id }, requestPolicy: null, allMembersAllowedRoutes: null,
      groupGrants: [], memberGrants: [{ teamMembershipId: membership.id, allowedRoutes: ['brokered'] }], usageLimits: [] })));

  const registry = readCurrentContributionRegistry();
  const piDeclaration = getBundledAgentDeclaration('pi');
  if (!piDeclaration?.providerRequirements) throw new Error('Pi has no provider requirements');
  const applications = projectAgentProviderBrokerApplications({ registry, agentTargetKey: piTarget,
    acceptedProtocols: piDeclaration.providerRequirements.acceptsProtocols }).filter(candidate => candidate.protocol === 'openai-responses');
  const application = applications.find(candidate => resolveManagedProviderBrokerPurpose({ registry, application: candidate, service })?.purpose === 'meta-upstream');
  if (!application) throw new Error('Pi has no declared Meta application');
  const unexpected = async (): Promise<never> => { throw new Error('Catalog must not materialize owner credentials'); };
  // Account metadata storage, daemon RPC, native model probe and carrier are IO
  // boundaries. Share issuance, catalog, UI, admission and Pi preparation stay real.
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveTarget: async target => target.kind === 'account' && await db.serviceAccountToken.findUnique({ where: { id: credential.id } })
      ? { account: target.account, displayName: 'Owner Muse' } : null,
  });
  const observeModels = createConnectedAccountModelObserver({ registry, invoke: async request => {
    expect(request.params).toMatchObject({ connectedServices: { bindingsByServiceId: {
      [serviceKey]: { source: 'connected', profileId: account.accountId },
    } } });
    return { ok: true, result: { agentId: 'muse', source: 'dynamic', observedAt: 1,
      supportsFreeform: false, availableModels: [{ id: `meta/${modelId}`, name: 'Muse Spark Contributor' }] } };
  } });
  home.machineDaemonPresence = { in: () => ({ fetchSockets: async () => machines.map(machine => ({
    data: { clientType: 'machine-scoped', userId: machine.accountId, machineId: machine.id },
  })) }) };
  home.forwardRpcForUser = async ({ params }: { params: unknown }) => {
    const request = DaemonProviderModelProjectionRequestV1Schema.parse(params);
    const projection = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
      resolveSelection: purposes.resolveBindingIntentSelection, observeModels, request });
    return { ok: true, result: projection.error ? { status: 'error', error: projection.error }
      : { status: 'success', agentTargetKey: request.agentTargetKey, groups: projection.groups } };
  };
  const readCatalog = () => readSessionTeamCredentialResourceCatalog({ applications: [application], teamIds: [team.id],
    executionMachineId: worker.id,
    homeDomainAction: request => post(actionPath(request.actionId), recipientToken!, request.input) });
  const resources = await readCatalog();
  expect(resources).toHaveLength(1);
  expect(resources[0]).toMatchObject({ id: resource.id, mayBroker: true, mayReceiveDirect: false,
    providerModels: [{ descriptor: { id: modelId }, application }] });
  const selection = resources[0]!.connectedServiceSelections[0]!;
  expect(selection.deliveryMode).toBe('brokered');
  const sourceChoices = (agentTargetKey: string) => buildNewSessionConnectedServicesSelectionListModel({
    supportedServiceIds: [serviceKey], profileOptionsByServiceId: {}, groupOptionsByServiceId: {}, bindingsByServiceId: {},
    nativeRoute: { agentTargetKey, active: true }, teamCredentialResources: resources,
    setBindingForService() {}, onOpenSettings() {}, translate: key => key, resolveServiceTitle: key => key,
    renderRowIcon: () => null, renderBrowseMark: () => null, renderSettingsIcon: () => null,
  }).rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
  expect(sourceChoices(piTarget).map(option => option.id)).toContain(createTeamResourceServiceOptionId(selection));
  expect(sourceChoices('agent:happier.agent.muse/muse').map(option => option.id)).not.toContain(createTeamResourceServiceOptionId(selection));
  const picker = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey: piTarget,
    nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
    teamCredentialResources: resources }).flatMap(section => section.options);
  expect(picker).toHaveLength(1);
  expect(picker[0]?.disabled).toBe(false);
  const bindings = { v: 2 as const, bindingsByServiceId: { [serviceKey]: selection } };
  const intents = composeConnectedServiceTeamCredentialBindingIntents({ consumer: piDeclaration.identity,
    declarations: (piDeclaration.connectedAccounts ?? []).map(purpose => ({ ...purpose,
      service: qualifyPluginContributionReferenceV1(purpose.service, piDeclaration.identity.pluginId) })), bindings, resources });
  const launchOptions = { directory: harness!.baseDir, connectedServices: bindings, teamCredentialBindings: intents,
    modelSelection: { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: piTarget, providerConnectionId: null, modelId } } };
  const normalize = () => normalizeSessionTeamCredentialLaunch({ options: launchOptions, agentId: 'pi', agentTargetKey: piTarget,
    executionMachineId: worker.id, contributions: registry, applications: [application], readCatalog });
  const admitted = await normalize();
  const binding = admitted.options.teamCredentialBindings?.find(intent => intent.slot.kind === 'provider_model');
  if (!binding) throw new Error('Launch did not select the Meta provider model');
  const session = await db.session.create({ data: { accountId: recipient.id, tag: crypto.randomUUID(), metadata: '{}', active: true } });
  await db.accessKey.create({ data: { accountId: recipient.id, machineId: worker.id, sessionId: session.id, data: '{}' } });
  expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { accountId: recipient.id, sessionId: session.id,
    authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [], tokenEpoch: 0 },
    intents: admitted.options.teamCredentialBindings! }))).toEqual({ ok: true });
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { contributes: registry, pluginIds: ['happier.agent.pi'],
    scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
  const directory = await mkdtemp(join(tmpdir(), 'muse-pi-native-'));
  const capability = 'c'.repeat(64);
  const carrierRequests: { path: string | undefined; capability: string | string[] | undefined }[] = [];
  const endpoint = createServer((request, response) => {
    carrierRequests.push({ path: request.url, capability: request.headers[MACHINE_HTTP_LOCAL_CAPABILITY_HEADER] });
    response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' }); response.end();
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const endpointAddress = endpoint.address();
  if (!endpointAddress || typeof endpointAddress === 'string') throw new Error('Carrier has no TCP address');
  try {
    const opened = await openSessionTeamCredentialProviderBinding({ sessionId: session.id, machineId: worker.id,
      agentId: 'pi', agentTargetKey: piTarget, modelId, binding, lease: runtime.lease, materializationBaseDir: directory,
      signal: new AbortController().signal, readCatalog: async () => (await readCatalog()).flatMap(row => row.providerModels),
      openBroker: async request => {
        const result = ProviderBrokerOpenResponseV1Schema.parse(await post(PROVIDER_BROKER_OPEN_HTTP_PATH_V1, recipientToken!, request));
        expect(result.ok).toBe(true);
        if (result.ok) {
          const signing = resolvePeerMediationGrantSigningConfig(process.env);
          if (!signing.ok) throw new Error('Home has no signing capability');
          expect(verifyProviderBrokerRouteGrantSignatureV1({ authority: result.authority,
            signingCapability: signing.capability, nowMs: Date.now() })).toBe(true);
        }
        return result;
      },
      openTunnel: async () => ({ localPort: endpointAddress.port, localCapability: capability, observedPath: 'relay',
        retire: async () => {}, close: async () => {} }),
    });
    if (!opened) throw new Error('Pi binding did not open');
    expect(carrierRequests).toContainEqual({ path: '/v1/_happier/provider-broker/endpoint', capability });
    try {
      const boundary = hostBoundaries();
      const values: Record<string, string> = {};
      const unset: string[] = [];
      for (const entry of opened.environmentOverlay) {
        if (entry.value === null) unset.push(entry.name); else values[entry.name] = entry.value;
      }
      const native = await createPiAgentRuntime().sessions.open({ kind: 'create', sessionId: session.id, cwd: directory,
        providerBinding: opened.providerBinding, launchEnvironment: { values, unset } }, boundary.context);
      try {
        const actual = boundary.spawn.mock.calls[0]![0].launch;
        expect(actual.args).toEqual(expect.arrayContaining(['happier-provider', modelId]));
        expect(actual.env).toMatchObject({ HAPPIER_PI_PROVIDER_API_KEY: capability });
        expect(actual.env).not.toHaveProperty('META_API_KEY');
        expect(JSON.stringify(actual)).not.toContain('synthetic-owner-muse-key');
        expect(boundary.getBinding).not.toHaveBeenCalled();
        expect(await db.serviceAccountToken.count({ where: { accountId: recipient.id } })).toBe(0);
        const materialization = opened.providerBinding.materialization;
        if (materialization?.kind !== 'configFile') throw new Error('Pi did not use its native provider config');
        expect(await readFile(join(materialization.rootPath, 'models.json'), 'utf8')).toContain(modelId);
      } finally { await native.dispose(); }
    } finally { await opened.cleanup(); }
    await post(actionPath('teams.credentials.audience.set'), ownerToken!, TeamCredentialResourceAudienceInputV1Schema.parse({
      resourceId: resource.id, expectedRevision: resources[0]!.resourceRevision, allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
    }));
    expect(await readCatalog()).toEqual([]);
    await expect(normalize()).rejects.toMatchObject({ code: 'resource_unavailable' });
  } finally {
    await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
