import { randomBytes, randomUUID } from 'node:crypto';
import { connectFreshVercelThroughDeploymentUi, connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { expect } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_PLUGIN_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseReadStatementInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema,
  DeploymentTargetLinkResultV1Schema, DeploymentReceiptResultV1Schema,
  DeploymentReceiptGetResultV1Schema, DeploymentDomainMutationResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentTargetLinkContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';
import type { DeploymentJourneyProvider, DeploymentProvidersHttp } from '../testkit/deploymentProvidersHttp';
import { mutationResult as NeonProjectResultSchema } from '../../../plugins/deployment-neon/src/data/schemas';

/** A fresh person enrolls the real daemon before beginning provider Connect. */
export async function prepareFreshDeploymentProviderAccount(fixture: TeamSetupFFixture,
  provider: DeploymentJourneyProvider, boundary: DeploymentProvidersHttp) {
  const account = await fixture.createAccount(`${provider}-journey-${randomUUID()}`);
  const machine = await fixture.enrollDaemon(account, { env: { ...boundary.env,
    NODE_OPTIONS: `${fixture.sourceOptions} --import ${new URL('../testkit/deploymentProvidersHttpPreload.mjs', import.meta.url).href}`,
  } });
  return { account, machine };
}

export type PreparedDeploymentProviderAccount = Awaited<ReturnType<typeof prepareFreshDeploymentProviderAccount>>;

/** Starts before the credential exists. Both setup and provider verification use
 * public Actions rather than injecting a credential or prepared provider result. */
export async function runFreshDeploymentProviderConnect(fixture: TeamSetupFFixture,
  provider: DeploymentJourneyProvider, boundary: DeploymentProvidersHttp, prepared?: PreparedDeploymentProviderAccount) {
  const { account, machine } = prepared ?? await prepareFreshDeploymentProviderAccount(fixture, provider, boundary);
  async function invoke(actionId: ActionId, input: unknown,
    context: Parameters<typeof account.executeWithApproval>[3] = {}) {
    const result = await account.executeWithApproval(actionId, input, async (_artifactId, _signal, decide) => {
      const decision = await decide('approve');
      if (!decision.ok) throw new Error(`Journey approval refused (${decision.errorCode})`);
      return decision;
    }, {
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
      presentUserConfirmation: { actionId },
      ...context,
    });
    if (!result.ok) throw new Error(`${provider} ${actionId}: ${JSON.stringify(result)}`);
    return result.result;
  }
  const service = provider === 'vercel' ? { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }
    : { pluginId: provider === 'cloudflare' ? 'happier.deploy.cloudflare' : 'happier.deploy.neon', localId: provider };
  const empty = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list'].parse(
    await invoke('connectedServices.accounts.list', { service }));
  expect(empty.accounts).toEqual([]);
  const token = `${provider}-journey-only-fixture-token`;
  let credentialRef;
  if (provider === 'vercel') {
    credentialRef = await connectFreshVercelThroughDeploymentUi({ serverUrl: fixture.server.baseUrl,
      credentials: account.uiCredentials, teamId: boundary.vercel.teamId, token, providerFetch: boundary.fetch });
  } else {
  const values = provider === 'cloudflare' ? { accountId: boundary.cloudflare.accountId, features: ['Workers'], tokenOwner: 'user' }
      : { organizationId: boundary.neon.organizationId };
  let begun = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.beginConnect', {
    service, modeId: 'token', machineId: machine.target.machineId,
  }));
  if (begun.status === 'configurationRequired') {
    const configuration = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(
      await invoke('connectedServices.configuration.replace', { target: { kind: 'attempt', attemptId: begun.attemptId },
        expectedRevision: null, values, secretValues: {} }));
    begun = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.continueConnect', {
      attemptId: begun.attemptId, expectedConfigurationRevision: configuration.revision,
    }));
  }
  expect(begun, `${provider} Connect must reach its manual credential continuation${'code' in begun ? ` (${begun.code})` : ''}`)
    .toMatchObject({ status: 'awaitingManual' });
  if (begun.status !== 'awaitingManual') throw new Error(`${provider} Connect did not await credentials (${begun.status})`);
  const connected = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.submitManual', {
    attemptId: begun.attemptId, fields: { token },
  }));
  expect(connected, `${provider} provider verification must settle Connected`).toMatchObject({ status: 'connected' });
  if (connected.status !== 'connected') throw new Error(`${provider} Connect did not settle (${connected.status})`);
  credentialRef = connected.account;
  }
  const saved = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list'].parse(
    await invoke('connectedServices.accounts.list', { service }));
  expect(saved.accounts).toEqual([expect.objectContaining({ account: expect.objectContaining({ ref: credentialRef, status: 'connected' }) })]);
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(boundary.entries().some(entry => entry.authorizationFingerprint !== null)).toBe(true);
  return { account, machine, credentialRef, invoke };
}

async function prepareEnvironment(fixture: TeamSetupFFixture, provider: DeploymentJourneyProvider, boundary: DeploymentProvidersHttp,
  prepared?: PreparedDeploymentProviderAccount) {
  const connected = await runFreshDeploymentProviderConnect(fixture, provider, boundary, prepared);
  const { account, machine, credentialRef, invoke } = connected;
  const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', { serverId: fixture.serverId,
    name: `${provider} first app`, requestKey: randomUUID(), defaultRef: 'main', repository: {
      provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'journey/app', cloneUrl: 'https://github.com/journey/app.git' }, protocol: 'https',
    } }));
  if (!source.ok) throw new Error(`${provider} Source creation: ${source.error}`);
  // The Environment Action owns preparation and sealing of the authored repository.
  const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await invoke('deployments.environments.create', {
    serverId: fixture.serverId, projectSourceId: source.source.id, requestKey: randomUUID(), protection: 'nonProduction',
    purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.target.machineId,
    name: `${provider} first environment`, retainPreviousDeployments: 1, definition: { from: 'repository', ref: 'main' },
  }));
  if (!environment.ok) throw new Error(`${provider} Environment creation: ${environment.error}`);
  const address = { serverId: fixture.serverId, environmentId: environment.environmentId };
  return { ...connected, source, environment, address };
}

async function prepareProviderEnvironment(fixture: TeamSetupFFixture, provider: 'vercel' | 'cloudflare', boundary: DeploymentProvidersHttp) {
  const prepared = await prepareEnvironment(fixture, provider, boundary);
  const { account, credentialRef, invoke, source, environment, address } = prepared;
  const pluginId = provider === 'vercel' ? 'happier.deploy.vercel' : 'happier.deploy.cloudflare';
  const localId = provider === 'vercel' ? 'project-create' : 'workers-inspect';
  const principal = { kind: 'account' as const, accountId: readAccountIdFromToken(account.credentials.token),
    purpose: { consumer: { pluginId, localId }, purpose: 'deploy.manage' }, target: { kind: 'account' as const, account: credentialRef } };
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'journey/app' };
  const target = provider === 'vercel' ? { targetId: `${pluginId}/runtime`, targetKind: 'vercel',
    source: { kind: 'plugin', contribution: { pluginId, localId: 'runtime' } },
    providerCreate: { credentialRef, credentialPrincipal: principal, providerAccountId: boundary.vercel.teamId,
      providerEnvironment: { kind: 'production' }, resourceName: boundary.vercel.name, sourceMethod: 'gitIntegration',
      repository, productionBranch: 'main' } }
    : { targetId: `${pluginId}/workers`, targetKind: 'cloudflare-workers',
      source: { kind: 'plugin', contribution: { pluginId, localId: 'workers' } },
      provider: DeploymentTargetLinkContentV1Schema.parse(await invoke('action.invoke', { action: { pluginId, localId }, input: {
        v: 1, ...address, expectedRevision: environment.revision, credentialRef, credentialPrincipal: principal,
        providerIdentity: { providerAccountId: boundary.cloudflare.accountId, providerResourceId: boundary.cloudflare.projectId,
          providerEnvironment: `script:${boundary.cloudflare.name}` }, providerEnvironment: { kind: 'script', scriptName: boundary.cloudflare.name },
        triggerUuid: boundary.cloudflare.triggerUuid, repository, sourceMethod: 'gitIntegration',
      } }, { presentUserConfirmation: undefined })) };
  const link = DeploymentTargetLinkResultV1Schema.parse(await invoke('deployments.targets.link', { ...address,
    expectedRevision: environment.revision, requestKey: randomUUID(), role: 'runtime', machines: [], ...target }));
  if (!link.ok || !('targetLinkId' in link)) throw new Error(`${provider} target did not link`);
  const deploy = { ...address, targetLinkId: link.targetLinkId, sourceMethod: 'gitIntegration', requestKey: randomUUID(),
    sourceIntent: { kind: 'repository', projectSourceId: source.source.id, sourceRevision: source.source.revision, sha: '1'.repeat(40) } };
  return { ...prepared, targetLinkId: link.targetLinkId, link, deploy };
}

/** One uninterrupted fresh-account path from Connect to verified retirement. */
export async function runDeploymentProviderJourney(fixture: TeamSetupFFixture, provider: 'vercel' | 'cloudflare', boundary: DeploymentProvidersHttp) {
  const prepared = await prepareProviderEnvironment(fixture, provider, boundary);
  const { invoke, address, deploy } = prepared;
  const deployed = DeploymentReceiptResultV1Schema.parse(await invoke('deployments.deploy', deploy));
  expect(deployed).toMatchObject({ ok: true });
  if (!deployed.ok || !('deploymentId' in deployed)) throw new Error(`${provider} deployment admission did not produce a receipt`);
  const observed = DeploymentReceiptResultV1Schema.parse(await invoke('deployments.receipts.observe', { ...address, deploymentId: deployed.deploymentId }));
  expect(observed).toMatchObject({ ok: true, state: 'succeeded', deploymentId: deployed.deploymentId });
  const retained = await invoke('deployments.receipts.get', { ...address, deploymentId: deployed.deploymentId });
  expect(retained).toMatchObject({ ok: true, deployment: { id: deployed.deploymentId, state: 'succeeded' } });
  const current = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
  if (!current.ok) throw new Error(`${provider} Environment read failed: ${current.error}`);
  const link = current.targetLinks.find(row => row.id === prepared.targetLinkId);
  if (!link) throw new Error(`${provider} created TargetLink was not retained`);
  const domainAddress = { ...address, domainId: randomUUID() };
  const added = DeploymentDomainMutationResultV1Schema.parse(await invoke('deployments.domains.add', {
    ...domainAddress, targetLinkId: link.id, expectedRevision: current.environment.revision,
    expectedTargetLinkRevision: link.revision, requestKey: randomUUID(),
    content: { hostname: 'journey.example.test', target: { kind: 'provider',
      ...(provider === 'cloudflare' ? { zone: { zoneId: boundary.cloudflare.zoneId, name: 'example.test' } } : {}) } } }));
  expect(added).toMatchObject({ ok: true, domain: { id: domainAddress.domainId, provider: true } });
  if (!added.ok) throw new Error(`${provider} Domain Add failed: ${added.error}`);
  const verified = DeploymentDomainMutationResultV1Schema.parse(await invoke('deployments.domains.verify', {
    ...domainAddress, expectedRevision: added.revision, expectedDomainRevision: added.domain.revision, requestKey: randomUUID(),
  }));
  expect(verified).toMatchObject({ ok: true, domain: { id: domainAddress.domainId, provider: true, state: 'active' } });
  const teardown = DeploymentReceiptResultV1Schema.parse(await invoke('deployments.teardown', { ...address, targetLinkId: link.id, reason: 'manual' }));
  expect(teardown).toMatchObject({ ok: true, state: 'succeeded' });
  if (!teardown.ok || !('deploymentId' in teardown)) throw new Error(`${provider} teardown did not produce a receipt`);
  const proof = DeploymentReceiptGetResultV1Schema.parse(await invoke('deployments.receipts.get', { ...address, deploymentId: teardown.deploymentId }));
  expect(proof).toMatchObject({ ok: true, deployment: { id: teardown.deploymentId, state: 'succeeded' } });
  if (!proof.ok) throw new Error(`${provider} teardown receipt was not retained`);
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
    addressAnchorUrl: fixture.server.baseUrl, accountSecret: prepared.account.auth.accountSigningSeed });
  try {
    const detail = await ui.readDeploymentReceipt(address.environmentId, teardown.deploymentId);
    if (!detail.ok) throw new Error(`${provider} teardown proof unavailable: ${detail.failure.code}`);
    expect(detail.value.content.teardown?.proofs).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'verify' })]));
  } finally { await ui.close(); }
  expect(boundary.isAbsent(provider), `${provider} provider resource must be absent after teardown verification`).toBe(true);
  return { deployed, observed, added, verified, teardown, proof };
}

/** A real Neon create captures the application's database URL into shared
 * secret custody, then the database Action selects that same managed branch. */
export async function runNeonDeploymentDataJourney(fixture: TeamSetupFFixture, boundary: DeploymentProvidersHttp,
  freshAccount: PreparedDeploymentProviderAccount) {
  const prepared = await prepareEnvironment(fixture, 'neon', boundary, freshAccount);
  const { account, invoke, machine, address, source, environment, credentialRef } = prepared;
  const pluginId = 'happier.deploy.neon';
  const accountId = readAccountIdFromToken(account.credentials.token);
  const principal = (localId: string) => ({ kind: 'account' as const, accountId,
    purpose: { consumer: { pluginId, localId }, purpose: 'deploy-manage' }, target: { kind: 'account' as const, account: credentialRef } });
  const project = NeonProjectResultSchema.parse(await invoke('action.invoke', { action: { pluginId, localId: 'projects-provision' }, input: {
    v: 1, ...address, expectedRevision: environment.revision, credentialRef, credentialPrincipal: principal('projects-provision'),
    providerAccountId: boundary.neon.organizationId, providerEnvironment: { kind: 'custom', id: boundary.neon.branchId },
    id: 'database', purpose: 'data.connection', database: 'neondb', role: 'owner',
    labels: { DATABASE_URL: 'Application database', DIRECT_URL: 'Migration database' }, audience: { accountGrants: [accountId] },
    rolePasswordLabel: 'Generated Neon password', name: 'Journey Neon project', regionId: 'aws-eu-central-1', requestKey: randomUUID(),
  } }, { presentUserConfirmation: undefined }));
  expect(project).toMatchObject({ status: 'provisioned', ready: true, providerProjectId: boundary.neon.projectId,
    branchId: boundary.neon.branchId, connectionSave: { status: 'complete', incomplete: [], connections: {
      DATABASE_URL: { ref: expect.any(String), resourceRevision: expect.any(Number) },
      DIRECT_URL: { ref: expect.any(String), resourceRevision: expect.any(Number) },
    } } });
  if (!project.providerIdentity || !project.providerEnvironment || !project.connectionSave?.connections.DATABASE_URL) {
    throw new Error('Neon provision omitted its selected project or application connection');
  }
  expect(JSON.stringify(project)).not.toContain('postgresql://');
  const link = DeploymentTargetLinkResultV1Schema.parse(await invoke('deployments.targets.link', { ...address,
    expectedRevision: environment.revision, requestKey: randomUUID(), role: 'data', machines: [],
    targetId: `${pluginId}/database`, targetKind: 'neon', source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } },
    provider: { credentialPrincipal: principal('projects-link'), providerIdentity: project.providerIdentity,
      providerEnvironment: project.providerEnvironment, providerResourceOrigin: project.providerResourceOrigin,
      data: { engine: 'postgres', ...(project.providerConsole ? { providerConsole: project.providerConsole } : {}) } },
  }));
  if (!link.ok || !('targetLinkId' in link)) throw new Error('Neon selected data project did not link');
  const applicationConnection = project.connectionSave.connections.DATABASE_URL;
  // The provider fixture owns its dedicated read login; the person puts that
  // credential into real Saved Secret custody before selecting it for queries.
  const resourceId = randomUUID();
  const resourceDataKey = Uint8Array.from(randomBytes(32));
  let readRole: ReturnType<typeof SharedSavedSecretMutationOutputV1Schema.parse>;
  try {
    readRole = SharedSavedSecretMutationOutputV1Schema.parse(await invoke('secrets.shared.create', { resourceId, displayName: 'Neon journey read role', kind: 'token', encryptionMode: 'e2ee',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey, randomBytes,
        content: { v: 1, name: 'Neon journey read role', kind: 'token', value: boundary.neon.readRolePassword } }),
      keyEnvelopes: [{ recipientAccountId: accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
        recipientContentPublicKey: account.credentials.encryption.publicKey, randomBytes }) }] }));
  } finally { resourceDataKey.fill(0); }
  const bound = await account.executeAsPerson('deployments.bindings.set', { ...address, expectedRevision: link.revision,
    set: [{ purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime',
      source: { kind: 'secret', ref: applicationConnection.ref, resourceRevision: applicationConnection.resourceRevision } },
      { purpose: 'dataRole', targetLinkId: link.targetLinkId, role: 'readOnlyPassword',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(readRole.resourceId), resourceRevision: readRole.revision } }], remove: [] },
    { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
  if (!bound.ok) throw new Error(`Neon bindings: ${JSON.stringify(bound)}`);
  const binding = bound.result;
  expect(binding).toMatchObject({ ok: true });
  const sql = DatabaseOperationResultV1Schema.parse(await invoke('action.invoke', {
    action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
    input: DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read',
      target: { kind: 'managed_deployment', environment: { ...address, projectSourceId: source.source.id }, targetLinkId: link.targetLinkId,
        contribution: { pluginId, contributionId: 'database' }, platformProjectId: project.providerProjectId,
        branchId: project.branchId, database: 'neondb' },
      statement: { sql: 'SELECT $1::text AS marker', parameters: [{ type: 'text', value: 'journey-neon-selected' }] },
    }),
  }, { presentUserConfirmation: undefined }));
  const sqlRequest = boundary.entries().find(entry => entry.method === 'POST'
    && entry.connectTarget === 'api.eu-central-1.aws.neon.tech:443' && entry.path === '/sql');
  expect(sqlRequest, 'Neon selected statement must reach the provider HTTPS boundary').toBeDefined();
  expect(JSON.parse(sqlRequest!.body)).toMatchObject({ queries: [expect.anything(),
    { query: 'SELECT $1::text AS marker', params: ['journey-neon-selected'] }] });
  // SQL parameters remain confidential when the provider echoes them in a cell.
  expect(sql).toMatchObject({ ok: true, operation: 'statement.run', results: [{
    columns: [{ name: 'marker' }], rows: [{ cells: [{ type: 'text', value: '[REDACTED]' }] }],
  }] });
  return { project, link, binding, sql };
}
