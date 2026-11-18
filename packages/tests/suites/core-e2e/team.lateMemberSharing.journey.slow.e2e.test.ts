import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { connectUiActionClient, installBundledPluginUiDeclarationsForTests } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedAcceptedV1Schema, ManagedGetOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sealManagedMachinePresetContentV1, openManagedMachinePresetRecipientProjectionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamCredentialSourceCandidateListOutputV1Schema } from '@happier-dev/protocol/teams/credentials/sourceCandidatesV1';
import { TeamCredentialResourceEntitledPageV1Schema, teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1, openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { InternalTaskMutationOutputSchema, InternalTaskReadOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, PluginCollectionMutationResultV1Schema, type PluginAccountCollectionContributionV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { PluginCollectionSharingActionOutputSchemasV1 } from '@happier-dev/protocol/plugins/data/collectionSharingActionsV1';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as collectionActions } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { openCliPrivateLabel } from '../../../../apps/cli/src/api/privateLabels';
import { guestCliExecutable } from '../../../../apps/cli/src/machines/managed/enrollmentPayload.testkit';
import { packLocalPlugin } from '../../../../apps/cli/src/plugins/packaging/pack';
import type { PluginChangeRequestResult } from '../../../../apps/cli/src/plugins/daemon/changeContract';
import { projectBundledPluginUiDeclaration } from '../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'team-late-member-sharing' });
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: TeamSetupFFixture | undefined;
let ownerUi: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let restoreDeclarations: (() => void) | undefined;
const ownedManagedIds = new Set<string>();
const sandboxImage = process.env.HAPPIER_TEST_SANDBOX_IMAGE ?? '';
type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
function accountId(account: Account) {
  const id = readAccountIdFromToken(account.credentials.token);
  if (!id) throw new Error('Fixture Account token has no Account id');
  return id;
}

beforeAll(async () => {
  if (!sandboxImage) throw new Error('Set HAPPIER_TEST_SANDBOX_IMAGE to an existing local Docker image');
  const manifest = PluginManifestV2LoadSchema.parse(JSON.parse(await readFile(resolve(repoRootDir(),
    'apps/cli/assets/bundled-plugin-manifests/devcontainer.json'), 'utf8')));
  restoreDeclarations = installBundledPluginUiDeclarationsForTests([await projectBundledPluginUiDeclaration({
    packageName: '@happier-dev/plugins-devcontainer', packageVersion: manifest.version, manifest, artifactGraphs: [],
  })]);
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir: run.testDir('late-joiner'), dbProvider: 'postgres', guestReachableHome: true, serverEnv: {
    DATABASE_URL: postgres.homeDatabaseUrl, HAPPIER_FEATURE_TEAMS__ENABLED: '1',
    HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
  } });
}, 0);
afterAll(async () => {
  try {
    await ownerUi?.close();
  } finally {
    try { await fixture?.stop(); } finally {
      try {
        for (const managedId of ownedManagedIds) {
          const args = ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`, '--format', '{{.ID}}'];
          const containerIds = execFileSync('docker', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
          for (const containerId of containerIds) if (spawnSync('docker', ['inspect', containerId], { stdio: 'ignore' }).status === 0) {
            execFileSync('docker', ['rm', '--force', containerId], { stdio: 'pipe' });
          }
          expect(execFileSync('docker', args, { encoding: 'utf8' }).trim()).toBe('');
        }
      } finally { try { await postgres?.stop(); } finally { restoreDeclarations?.(); } }
    }
  }
}, 0);

// The Account-sync wake is deliberately real: calling prepare/repair here would
// supply the missing production leg and let the late-member regression pass.
it('a late Team joiner opens existing encrypted shares; departed members and outsiders receive nothing', async () => {
  const home = fixture;
  if (!home) throw new Error('Sharing journey Home did not start');
  const owner = await home.createAccount('owner');
  const departed = await home.createAccount('departed');
  const later = await home.createAccount('later');
  const outsider = await home.createAccount('outsider');
  async function act(account: Account, actionId: ActionId, input: unknown) {
    const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId } });
    if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
    return result.result;
  }
  const request = async (account: Account, path: string, body?: unknown) => fetch(`${home.server.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`,
      'Content-Type': 'application/json',
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // Install and select a portable fixture through the existing daemon and
  // Account lifecycle, so the real catalog owns this Collection's contract.
  const pluginId = 'example.late-member-sharing';
  const contribution = { id: 'documents', schemaVersion: 1, rowIdField: 'id', identityFields: [],
    schema: { type: 'object' as const, properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'note'], additionalProperties: false },
    serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
  } satisfies PluginAccountCollectionContributionV1;
  const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
    displayName: 'Late-member sharing fixture', engines: { happier: '^0.2.0' },
    entrypoints: { daemon: './daemon.mjs' }, activation: { events: [{ kind: 'startup' }] },
    contributes: { accountCollections: [contribution] } });
  const testDir = run.testDir('late-joiner');
  const pluginRoot = join(testDir, 'collection-plugin');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'late-member-sharing-fixture', version: manifest.version,
    type: 'module', keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin/plugin.json', 'daemon.mjs'] }));
  const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'late-member-sharing',
    captureEnvironmentKeys: [], logFullStdin: true });
  const payloadRoot = join(testDir, 'non-enrolling-guest-payload');
  await mkdir(payloadRoot, { recursive: true });
  // Allocation and native controller reports are real; this journey does not
  // exercise guest enrollment, so use its existing executable boundary fixture.
  await writeFile(join(payloadRoot, 'happier'), guestCliExecutable('exit 1\n'), { mode: 0o755 });
  const machine = await home.enrollDaemon(owner, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payloadRoot } });
  const packed = await packLocalPlugin({ locator: pluginRoot, outPath: join(testDir, 'collection-plugin.tgz') });
  expect(packed.ok).toBe(true);
  if (!packed.ok) throw new Error('Collection fixture package was refused');
  const { archivePath, archiveIntegrity } = packed;
  async function selectCollectionPlugin(account: Account, daemon: typeof machine) {
    const installed = await daemonControlPostJson<PluginChangeRequestResult>({ port: daemon.daemon.state.httpPort,
      controlToken: daemon.daemon.state.controlToken, path: '/plugins/change/request',
      body: { kind: 'installArchive', locator: archivePath, expectedIntegrity: archiveIntegrity } });
    expect(installed.status).toBe(200);
    if (installed.data.kind === 'reviewRequired') {
      const approved = await daemonControlPostJson({ port: daemon.daemon.state.httpPort,
        controlToken: daemon.daemon.state.controlToken, path: '/plugins/change/decide',
        body: { pendingChangeId: installed.data.pendingChangeId, decision: 'installAndTrust', optionalSelections: [] } });
      expect(approved.data, JSON.stringify(approved.data)).toMatchObject({ kind: 'committed' });
    } else expect(installed.data, JSON.stringify(installed.data)).toMatchObject({ kind: 'committed' });
    expect(await account.executeAsPerson('plugins.account.release.select', { pluginId, version: manifest.version,
      daemon: { serverId: home.serverId, serverIdentityId: home.serverId, machineId: daemon.target.machineId } }))
      .toMatchObject({ ok: true, result: { kind: 'selected' } });
  }
  await selectCollectionPlugin(owner, machine);
  // Every reader knows the same declared Collection contract. In particular,
  // outsider refusal must prove resource authorization, not a missing plugin.
  for (const account of [departed, later, outsider]) {
    await selectCollectionPlugin(account, await home.enrollDaemon(account));
  }
  await home.claimHomeOwner(owner);
  const teamId = TeamSummaryV1Schema.parse(await act(owner, 'teams.create', { v: 1, name: 'Previously shared resources',
    initialOwnerAccountId: accountId(owner), requestKey: randomUUID() })).id;
  const joinTeam = async (account: Account) => TeamMembershipV1Schema.parse(await act(owner, 'teams.members.add', { v: 1, teamId,
    accountId: accountId(account), role: 'member', historyAccess: 'all_existing' }));
  const departedMembership = await joinTeam(departed);

  const ref = { service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: randomUUID() };
  const metadata = { displayName: 'Synthetic sharing credential', providerIdentity: { accountId: ref.accountId } };
  const credentialPayload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'api-key',
    payload: { v: 1, values: { credentialMode: 'manual', inferenceKey: 'journey-only-synthetic-key' } }, metadata, now: Date.now() });
  const imported = await request(owner, '/v4/connect/qualified/credential', QualifiedConnectedAccountCredentialMutationV4Schema.parse({
    ref, authenticationModeId: 'api-key', metadata, expectedCredentialRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
      material: { type: 'dataKey', machineKey: owner.auth.accountMachineKey }, payload: credentialPayload, randomBytes }),
  }));
  expect(imported.status).toBe(200);
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await imported.json());
  const candidate = TeamCredentialSourceCandidateListOutputV1Schema.parse(await act(owner, 'teams.credentials.sources.list', { teamId }))
    .candidates.find(row => row.source.kind === 'connected_account' && row.source.target.account.accountId === ref.accountId);
  if (!candidate) throw new Error('Credential import did not produce a shareable source');
  const resourceId = randomUUID();
  await act(owner, 'teams.credentials.create', { teamId, resourceId, displayName: 'Previously shared credential', source: candidate.source,
    deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
    brokerPlacement: { kind: 'machine', machineId: machine.target.machineId }, requestPolicy: null,
    allMembersAllowedRoutes: ['brokered'], groupGrants: [], memberGrants: [], usageLimits: [],
  });
  console.info('LATE-MEMBER PRODUCER: credential shared');

  const secretId = randomUUID();
  const secretKey = new Uint8Array(randomBytes(32));
  const secretContent = { v: 1 as const, name: 'Previously shared secret', kind: 'token' as const, value: 'journey-only-secret' };
  await act(owner, 'secrets.shared.create', { resourceId: secretId, displayName: secretContent.name, kind: secretContent.kind,
    encryptionMode: 'e2ee', teamGrants: [teamId], storedContent: sealSavedSecretResourceStoredContentV1({
      resourceId: secretId, mode: 'e2ee', resourceDataKey: secretKey, content: secretContent, randomBytes }),
    keyEnvelopes: [owner, departed].map(account => ({ recipientAccountId: accountId(account),
      ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: secretKey,
        recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey, randomBytes }) })),
  });
  const createdTask = InternalTaskMutationOutputSchema.parse(await act(owner, 'tasks.internal.create', {
    fields: { title: 'Previously shared Task' },
  }));
  if (createdTask.status !== 'applied') throw new Error('Task producer did not apply');
  const address = { taskId: createdTask.todo.id, ownerAccountId: accountId(owner) };
  await act(owner, 'tasks.internal.share', { scope: { serverId: home.serverId, accountId: accountId(owner) },
    ...address, principal: { kind: 'team', teamId }, accessLevel: 'view' });
  console.info('LATE-MEMBER PRODUCER: Saved Secret and Task shared');

  const contract = normalizePluginAccountCollectionContractV1({ pluginId, contribution });
  const collectionRef = { pluginId, collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
  const document = { id: 'before-join', note: 'Previously shared private Collection content' };
  const validateDocument = compilePluginJsonSchema(contract.schema);
  const encoded = encodePluginCollectionLogicalValueV1({ contract, value: document,
    isValidLogicalValue: (value): value is typeof document => validateDocument(value),
    encryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: owner.auth.accountMachineKey }, randomBytes });
  if (encoded.status !== 'encoded') throw new Error('Collection producer did not encode');
  const initial = await request(owner, PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, { pluginId, collectionId: contract.collectionId,
    writerContext: { schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest },
    operations: [{ kind: 'put', rowId: document.id, expectedRevision: 'absent', expectedAbsenceEpoch: 0,
      content: encoded.content, projection: encoded.projection }] });
  expect(initial.status).toBe(200);
  expect(PluginCollectionMutationResultV1Schema.parse(await initial.json())).toMatchObject({ status: 'updated' });
  await act(owner, collectionActions.setGrant, { collectionRef, rowId: document.id, principal: { kind: 'team', teamId },
    accessLevel: 'view', expectedRevision: 1 });
  const collectionAddress = { collectionRef, ownerAccountId: accountId(owner), rowId: document.id };
  console.info('LATE-MEMBER PRODUCER: Collection shared');

  const readCredential = async (account: Account) => {
    const result = TeamCredentialResourceEntitledPageV1Schema.parse(await act(account, 'teams.credentials.entitled.list', { teamId, resourceId }))
      .resources.find(row => row.id === resourceId);
    if (!result?.displayName) return null;
    expect(result.displayName.content.t).toBe('encrypted');
    expect(JSON.stringify(result.displayName)).not.toContain('Previously shared credential');
    return openCliPrivateLabel({ binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId), label: result.displayName,
      readPolicy: { kind: 'team-resource' }, accountKey: account.auth.accountMachineKey });
  };
  const readSecret = async (account: Account) => {
    const listed = SharedSavedSecretListOutputV1Schema.parse(await act(account, 'secrets.shared.list', { sharedWithTeamId: teamId }));
    expect(listed.resources).toContainEqual(expect.objectContaining({ ref: formatSharedSavedSecretRefV1(secretId) }));
    const response = await request(account, `/v1/account/saved-secrets/resources/materials?resourceId=${secretId}`);
    expect(response.status).toBe(200);
    const material = SavedSecretResourceMaterialsResponseV1Schema.parse(await response.json()).resources
      .find(row => 'resourceId' in row && row.resourceId === secretId);
    if (!material || !('recipientEnvelope' in material) || !material.recipientEnvelope) return null;
    const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(material.recipientEnvelope.encryptedDataKey),
      recipientSecretKeyOrSeed: account.auth.accountMachineKey });
    return key ? openSavedSecretResourceStoredContentV1({ resourceId: secretId, mode: 'e2ee', resourceDataKey: key,
      storedContent: material.storedContent }) : null;
  };
  // Use the existing devcontainer journey topology. The real controller must
  // retain the acquired ciphertext; authoring a newer source key below must
  // not replace that snapshot's independent key.
  const inventorySchema = getActionSpec('machines.list').outputSchema;
  if (!inventorySchema) throw new Error('Machine inventory output schema unavailable');
  const inventory = inventorySchema.parse(await act(owner, 'machines.list', { serverId: home.serverId }));
  if (!inventory || typeof inventory !== 'object' || !('items' in inventory) || !Array.isArray(inventory.items)) {
    throw new Error('Machine inventory has no items');
  }
  const controllerRow: unknown = inventory.items.find(row => row && typeof row === 'object'
    && 'machineId' in row && row.machineId === machine.target.machineId);
  if (!controllerRow || typeof controllerRow !== 'object' || !('installationId' in controllerRow)
    || typeof controllerRow.installationId !== 'string') throw new Error('Controller installation unavailable');
  const controller = { machineId: machine.target.machineId, installationId: controllerRow.installationId };
  // Team preset visibility alone does not grant access to its controller's
  // retained resources. Share that existing authority through its real Action.
  expect(await owner.executeAsPerson('machines.access.grant.set', { ...machine.target,
    principal: { kind: 'team', teamId }, level: 'admin' })).toMatchObject({ ok: true });
  const presetOwner = { kind: 'team' as const, teamId };
  const presetId = randomUUID();
  const censusResponse = await request(owner, '/v1/machines/presets/recipient-census', {
    homeId: home.serverId, owner: presetOwner, controller,
  });
  expect(censusResponse.status).toBe(200);
  const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await censusResponse.json());
  if (census.kind !== 'ready') throw new Error(`Preset census unavailable: ${census.code}`);
  const presetContent = { v: 1 as const, name: 'Previously shared retained preset', launch: {
    provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
    name: 'Previously shared retained preset', choices: { runtime: 'docker', configuration: {
      kind: 'image', image: sandboxImage,
    } },
  } };
  const originalPreset = sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee', content: presetContent,
    recipientCensus: census.recipients, randomBytes });
  const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(await act(owner, 'machines.presets.create', {
    id: presetId, homeId: home.serverId, owner: presetOwner, controller, retention: { kind: 'until-delete' },
    contentEncryptionMode: 'e2ee', ...originalPreset,
  }));
  if (saved.kind !== 'saved') throw new Error('Preset producer did not save');
  const acquisition = await owner.executeAsPerson('machines.managed.acquire', {
    selection: { kind: 'preset', homeId: home.serverId, id: presetId, revision: saved.preset.revision },
  }, { managedPresetOrigin: saved.preset });
  expect(acquisition, JSON.stringify(acquisition)).toMatchObject({ ok: true, result: { managedId: expect.any(String) } });
  if (!acquisition.ok) throw new Error(`Native preset acquisition refused: ${acquisition.errorCode}`);
  const acquired = ManagedAcceptedV1Schema.parse(acquisition.result);
  const managedId = acquired.managedId;
  ownedManagedIds.add(managedId);
  console.info('LATE-MEMBER PRODUCER: managed preset acquisition admitted');
  const managedAddress = { homeId: home.serverId, managedId };
  const readSnapshot = async (account: Account) => {
    const read = ManagedGetOutputV1Schema.parse(await act(account, 'machines.managed.get', managedAddress));
    if (!('presetContent' in read)) throw new Error('Managed Machine has no opaque preset snapshot');
    expect(read.presetContent.content.t).toBe('encrypted');
    return { machine: unwrapManagedMachineReadV1(read), content: openManagedMachinePresetRecipientProjectionV1({
      presetId, mode: 'e2ee', projection: read.presetContent,
      accountId: accountId(account), accountKey: account.auth.accountMachineKey,
    }) };
  };
  if (acquired.operation) {
    const observation = await owner.executeAsPerson('action.operations.get', {
      serverId: home.serverId, machineId: controller.machineId, managed: managedAddress,
      operationId: acquired.operation.operationId, waitForTerminal: true,
    });
    expect(observation, JSON.stringify(observation)).toMatchObject({ ok: true });
    if (!observation.ok) throw new Error(`Retained preset acquisition observation refused: ${observation.errorCode}`);
    const observed = ActionOperationGetV1ResponseSchema.parse(observation.result);
    expect(observed.kind).toBe('found');
    if (observed.kind !== 'found') throw new Error('Accepted retained preset acquisition operation is unavailable');
  }
  expect((await readSnapshot(owner)).machine.allocation).toBe('bound');
  const retainedContent = (await readSnapshot(owner)).content;
  if (!retainedContent) throw new Error('Owner cannot decrypt the bound preset snapshot');
  expect(retainedContent).toMatchObject({ v: presetContent.v, name: presetContent.name,
    launch: { provider: presetContent.launch.provider, schemaVersion: presetContent.launch.schemaVersion,
      choices: presetContent.launch.choices } });
  // The native provider resolves the launch display name during acquisition.
  // Every recipient must open the same retained definition the owner observes.
  const retainedDefinition = { v: retainedContent.v, name: retainedContent.name, launch: retainedContent.launch };
  const control = await home.assertKnownGoodSessionControl(owner, machine);
  const controlPrompt = 'Confirm the sharing journey reaches its enrolled Agent.';
  await act(owner, 'session.message.send', { sessionId: control.sessionId, message: controlPrompt });
  await waitForFakeClaudeUserText(agent.logPath, text => text.includes(controlPrompt), { invocationId: 'late-member-sharing' });
  console.info('LATE-MEMBER CONTROL PASS: CLI Action → PostgreSQL Home → real enrolled daemon Session');
  // Same-share controls prove the keys and public consumers before any refusal.
  expect(await readCredential(departed)).toBe('Previously shared credential');
  expect(await readSecret(departed)).toEqual(secretContent);
  expect(await act(departed, 'tasks.internal.read', address)).toMatchObject({ status: 'applied', todo: { title: 'Previously shared Task' } });
  expect(PluginCollectionSharingActionOutputSchemasV1[collectionActions.get].parse(
    await act(departed, collectionActions.get, collectionAddress)).value).toEqual(document);
  expect((await readSnapshot(departed)).content).toMatchObject(retainedDefinition);
  console.info('LATE-MEMBER EXISTING-SHARE CONTROL PASS: credential, Saved Secret, Task, Collection, retained preset decrypt');

  const replacement = sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee',
    content: { ...presetContent, name: 'Later source preset with another key' }, recipientCensus: census.recipients, randomBytes });
  const rotated = MachinePresetActionOutputSchemasV1['machines.presets.update'].parse(await act(owner, 'machines.presets.update', {
    homeId: home.serverId, id: presetId, expectedRevision: saved.preset.revision, patch: replacement,
  }));
  if (rotated.kind !== 'saved') throw new Error('Source preset rotation did not save');
  expect(rotated.preset.content).toEqual(replacement.content);
  expect(rotated.preset.content).not.toEqual(originalPreset.content);

  ownerUi = await connectUiActionClient({ serverUrl: home.server.baseUrl, credentials: owner.uiCredentials });
  await waitFor(() => ownerUi!.isAccountReady(), { context: 'keyholder Account sync ready' });
  await act(owner, 'teams.members.remove', { v: 1, teamId, membershipId: departedMembership.id });
  await joinTeam(later);
  // An ordinary keyholder read is the Collection's production repair trigger.
  await act(owner, collectionActions.get, collectionAddress);
  await waitFor(async () => {
    const task = await later.execute('tasks.internal.read', address);
    const parsed = task.ok ? InternalTaskReadOutputSchema.safeParse(task.result) : null;
    return parsed?.success === true && parsed.data.status === 'applied';
  }, { context: 'membership push repairs existing Task recipient envelope' });
  expect(await act(later, 'tasks.internal.read', address)).toMatchObject({ status: 'applied', todo: { title: 'Previously shared Task' } });
  await waitFor(async () => await readCredential(later) === 'Previously shared credential', { context: 'membership push repairs credential label' });
  await waitFor(async () => {
    const content = await readSecret(later);
    return content !== null && 'value' in content && content.value === secretContent.value;
  }, { context: 'membership push repairs Saved Secret' });
  expect(PluginCollectionSharingActionOutputSchemasV1[collectionActions.get].parse(
    await act(later, collectionActions.get, collectionAddress)).value).toEqual(document);
  const retained = await readSnapshot(owner);
  expect(await owner.executeAsPerson('machines.managed.power.set', { ...managedAddress, intent: 'stop', when: 'now',
    expectedRevision: retained.machine.intentRevision }))
    .toMatchObject({ ok: true });
  // Native control reports are the production snapshot-envelope repair trigger.
  await waitFor(async () => {
    expect((await readSnapshot(later)).content).toMatchObject(retainedDefinition);
    return true;
  }, {
    context: 'native controller report repairs retained snapshot key independently of source key',
  });

  for (const denied of [departed, outsider]) {
    expect(await denied.execute('teams.credentials.entitled.list', { teamId, resourceId }))
      .toMatchObject({ ok: false, errorCode: 'not_found_or_not_visible' });
    expect(await act(denied, 'tasks.internal.read', address)).toMatchObject({ status: 'refused', reason: 'task_not_found' });
    expect(await denied.execute(collectionActions.get, collectionAddress)).toMatchObject({ ok: false, errorCode: 'collection_unavailable' });
    const snapshot = await denied.execute('machines.managed.get', managedAddress);
    expect(snapshot).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(snapshot).not.toHaveProperty('result');
    const catalog = await denied.execute('secrets.shared.list', { sharedWithTeamId: teamId });
    expect(catalog).toMatchObject({ ok: false, errorCode: 'forbidden' });
    expect(catalog).not.toHaveProperty('result');
    const material = await request(denied, `/v1/account/saved-secrets/resources/materials?resourceId=${secretId}`);
    expect(material.status).toBe(200);
    expect(SavedSecretResourceMaterialsResponseV1Schema.parse(await material.json()).resources).toEqual([]);
  }
}, 0);
