import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectUiPersonActionClient, mountUiWorkflowEnginePicker, readUiBundledClaudeDeclaration } from '@happier-tests/ui-action-client';
import tweetnacl from 'tweetnacl';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamCredentialSourceCandidateListOutputV1Schema } from '@happier-dev/protocol/teams/credentials/sourceCandidatesV1';
import { TeamCredentialResourceDiscoveryPageV1Schema, TeamCredentialResourceSummaryV1Schema,
  teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { decrypt } from '../../../../apps/cli/src/api/encryption';
import { readCurrentContributionRegistry } from '../../../../apps/cli/src/agent/catalog/snapshot';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '../../../../apps/cli/src/providers/broker/applicationProjection';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { fakeClaudeFixturePath, FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { decodeBase64 } from '../../src/testkit/messageCrypto';
import { readDecryptedSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { fetchMessagesSince } from '../../src/testkit/sessions';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
const modelId = 'muse-spark-1.3-contributor';
type Account = Awaited<ReturnType<FinJourneyFixture['createAccount']>>;

// Only native provider processes are doubled. Credential import, sharing,
// application pairing, model projection, encrypted Save and recipient launch
// use their public HTTP/Action owners and the real server, DB and two daemons.
describe('FIN Account B shared model through the real authoring picker and native Session', () => {
  let fixture: FinJourneyFixture | undefined;
  let owner: Account;
  let member: Account;
  let hub: Awaited<ReturnType<FinJourneyFixture['enrollDaemon']>>;
  let worker: Awaited<ReturnType<FinJourneyFixture['enrollDaemon']>>;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let picker: Awaited<ReturnType<typeof mountUiWorkflowEnginePicker>> | undefined;
  let auditPath: string;
  let nativeEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
  const testDir = run.testDir(`fin-team-model-${randomUUID()}`);
  const bin = join(testDir, 'bin');
  const nativeHome = join(testDir, 'native-home');
  auditPath = join(testDir, 'native-launches.jsonl');
  await Promise.all([bin, nativeHome].map(path => mkdir(path, { recursive: true })));
  const recording = await readMuseLoginRecording();
  const musePath = join(bin, 'muse');
  await writeFile(musePath, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.15'); process.exit(0); }
const capture = ${JSON.stringify(recording)};
for (const row of capture.rows) { const models = row.message?.result?.models;
  if (Array.isArray(models) && process.env.META_API_KEY === 'fin-synthetic-muse-key') {
    for (const id of ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']) {
      const base = models.find(model => model.modelId === id.replace('-contributor', ''));
      models.push({ ...base, modelId: id, displayLabel: id, isDefault: false });
    }
  }
}
process.env.MUSE_TEST_RECORDING = JSON.stringify(capture);
process.env.MUSE_TEST_SCHEMA = '{}';
${MUSE_MSP_PLAYBACK_SCRIPT}
`, { mode: 0o755 });
  const claudePath = join(bin, 'claude.mjs');
  await writeFile(claudePath, `import { appendFileSync } from 'node:fs';
if (process.argv.includes('--output-format')) appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
  model: process.argv[process.argv.indexOf('--model') + 1],
  brokerEndpoint: /^http:\\/\\/127\\.0\\.0\\.1:/.test(process.env.ANTHROPIC_BASE_URL || ''),
  ownerCredentialPresent: Object.values(process.env).some(value => value === 'fin-synthetic-muse-key'),
}) + '\\n');
await import(${JSON.stringify(pathToFileURL(fakeClaudeFixturePath()).href)});
`);
  const features = { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
    HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' };
  nativeEnv = { ...features, HOME: nativeHome, USERPROFILE: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'),
    XDG_DATA_HOME: join(nativeHome, 'data'), HAPPIER_MUSE_PATH: musePath, MUSE_INSTALL_DIR: bin,
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), HAPPIER_CLAUDE_PATH: claudePath,
    META_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
    fixture = await startFinJourneyFixture({ testDir, serverEnv: features });
    owner = await fixture.createAccount('team-owner');
    member = await fixture.createAccount('team-member');
    await fixture.claimHomeOwner(owner);
  });
  beforeEach(async () => {
    if (!fixture) throw new Error('Team Home did not start');
    hub = await fixture.enrollDaemon(owner, { env: nativeEnv });
  });
  beforeEach(async () => {
    if (!fixture) throw new Error('Team Home did not start');
    worker = await fixture.enrollDaemon(member, { env: nativeEnv });
  });
  afterEach(async () => {
    try { await picker?.close(); }
    finally {
      picker = undefined;
      try { await ui?.close(); }
      finally { ui = undefined; await fixture?.stop(); fixture = undefined; }
    }
  });
  it('J8 Account B pairs a shared Muse model with Claude, reopens it, and opens with late sensitive environment', async () => {
    const home = fixture;
    if (!home) throw new Error('Team model journey fixture did not start');
    async function act(account: Account, actionId: ActionId, input: unknown) {
      const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId },
        externalActionTarget: { kind: 'machine', machineId: worker.target.machineId,
          project: { machineId: worker.target.machineId, directory: worker.workspaceDir } } });
      expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
      return result.result;
    }
    const ref = { service, accountId: randomUUID() };
    const metadata = { displayName: 'FIN synthetic Muse', providerIdentity: { accountId: ref.accountId } };
    const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'api-key',
      payload: { v: 1, values: { credentialMode: 'manual', inferenceKey: 'fin-synthetic-muse-key' } }, metadata, now: Date.now() });
    const imported = await fetchJson<unknown>(`${home.server.baseUrl}/v4/connect/qualified/credential`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref, authenticationModeId: 'api-key',
        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
          material: { type: 'dataKey', machineKey: owner.auth.accountMachineKey }, payload, randomBytes }),
        metadata, expectedCredentialRevision: null })),
    });
    expect(imported.status).toBe(200);
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(imported.data);
    const ownerId = await fetchAccountId(home.server.baseUrl, owner.credentials.token);
    const memberId = await fetchAccountId(home.server.baseUrl, member.credentials.token);
    const teamId = TeamSummaryV1Schema.parse(await act(owner, 'teams.create', { v: 1, name: 'FIN model sharing',
      initialOwnerAccountId: ownerId, requestKey: randomUUID() })).id;
    await act(owner, 'teams.members.add', { v: 1, teamId, accountId: memberId, role: 'member', historyAccess: 'all_existing' });
    const source = TeamCredentialSourceCandidateListOutputV1Schema.parse(await act(owner, 'teams.credentials.sources.list', { teamId }))
      .candidates.find(candidate => candidate.source.kind === 'connected_account' && candidate.source.target.account.accountId === ref.accountId);
    if (!source) throw new Error('Public source discovery omitted the imported credential');
    const resourceId = randomUUID();
    const labelKey = Uint8Array.from(randomBytes(32));
    const displayName = sealPrivateLabelV1({ mode: 'e2ee', binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId),
      value: 'FIN Team Muse', dataKey: labelKey, randomBytes,
      recipients: [{ accountId: ownerId, account: owner }, { accountId: memberId, account: member }].map(({ accountId, account }) => ({ accountId,
        envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey, randomBytes }) })) });
    const resource = TeamCredentialResourceSummaryV1Schema.parse(await act(owner, 'teams.credentials.create', {
      teamId, resourceId, displayName, source: source.source, deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'personal_allowed', brokerPlacement: { kind: 'machine', machineId: hub.target.machineId },
      requestPolicy: null, allMembersAllowedRoutes: ['brokered'], groupGrants: [], memberGrants: [], usageLimits: [],
    }));
    const target = 'agent:happier.agent.claude/claude';
    const declaration = await readUiBundledClaudeDeclaration();
    const registry = readCurrentContributionRegistry();
    const application = projectAgentProviderBrokerApplications({ registry, agentTargetKey: target,
      acceptedProtocols: declaration.acceptsProtocols }).find(candidate =>
      resolveManagedProviderBrokerPurpose({ registry, application: candidate, service })?.purpose === 'meta-upstream');
    if (!application) throw new Error('Claude has no declared Muse Provider application');
    const entitled = TeamCredentialResourceDiscoveryPageV1Schema.parse(await act(member, 'teams.credentials.entitled.list', {
      teamIds: [teamId], application, executionMachineId: worker.target.machineId }));
    expect(entitled.failures).toEqual([]);
    const projection = DaemonProviderModelProjectionResponseV1Schema.parse(await act(member, 'providers.models.projection', {
      machineId: worker.target.machineId, agentTargetKey: target, mode: 'picker', teamCredentialResources: entitled.resources }));
    expect(projection.status).toBe('success');
    if (projection.status !== 'success') throw new Error(`Model projection failed: ${projection.error.code}`);
    const selected = projection.teamCredentialResources?.find(row => row.id === resourceId)?.providerModels
      .find(row => row.selection.modelId === modelId && row.application.agentTargetKey === target);
    expect(selected, 'Account B must receive the exact supported cross-service Provider/model pairing').toBeDefined();
    if (!selected) throw new Error('Shared Muse contributor model absent');
    ui = await connectUiPersonActionClient({ serverUrl: home.actionServerApiUrl, accountSecret: member.auth.accountSigningSeed });
    picker = await mountUiWorkflowEnginePicker({ serverId: ui.serverId, machineId: worker.target.machineId,
      directory: worker.workspaceDir, values: { agentTarget: { kind: 'agent', identity: declaration.identity },
        conversation: { kind: 'fresh' } } });
    expect(await picker.waitForModelRow(selected.selection)).toMatchObject({ disabled: false });
    const authored = await picker.chooseModel(selected.selection);
    const binding = authored.teamCredentialBindings?.find(candidate => candidate.slot.kind === 'provider_model');
    expect(binding).toMatchObject({ teamId, resourceId, expectedResourceRevision: resource.revision,
      deliveryMode: 'brokered', providerModelSelection: { agentTargetKey: target, modelId, application,
        executionMachineId: worker.target.machineId } });
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act(member, 'workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Account B shared model' }, definition: { version: 1,
        defaults: authored,
        blocks: [{ kind: 'step', id: 'shared-model', inputMode: 'none', document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
    }));
    const reopened = WorkflowDefinitionCreateResultV1Schema.parse(await act(member, 'workflow.definition.get', { definitionId: saved.definitionId }));
    expect(reopened.definition.defaults?.teamCredentialBindings).toEqual(authored.teamCredentialBindings);
    await picker.reopen(reopened.definition.defaults ?? {});
    expect(await picker.waitForModelRow(selected.selection, { selected: true }))
      .toMatchObject({ disabled: false, selected: true });
    expect(await owner.execute('workflow.definition.get', { definitionId: saved.definitionId }))
      .toMatchObject({ ok: false });
    const { kind: _selectionKind, ...teamModelRef } = selected.selection;
    const started = SessionSpawnNewActionResultV1Schema.parse(await act(member, 'session.spawn_new', {
      executionTarget: worker.target, directory: { kind: 'path', path: worker.workspaceDir },
      agentTarget: { kind: 'agent', identity: declaration.identity },
      modelSelection: { v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...teamModelRef } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
    }));
    expect(started).toMatchObject({ type: 'success' });
    if (started.type !== 'success') throw new Error('Shared model native Session did not open');
    await act(member, 'session.message.send', { sessionId: started.sessionId, message: 'Verify the shared model launch.' });
    await waitFor(async () => (await readFile(auditPath, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { model: string }).some(row => row.model === modelId), { context: 'Account B native model launch' });
    const evidence = (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { model: string; brokerEndpoint: boolean; ownerCredentialPresent: boolean });
    expect(evidence).toContainEqual({ model: modelId, brokerEndpoint: true, ownerCredentialPresent: false });
    // A launch audit alone cannot distinguish a usable native Session from a
    // child that exits before replying. Observe the persisted assistant turn.
    const sessionCrypto = await readDecryptedSessionMetadataV2({ baseUrl: home.server.baseUrl,
      token: member.credentials.token, sessionId: started.sessionId, machineKeys: [member.auth.accountMachineKey] });
    const sessionSecret = sessionCrypto.selectedSecret;
    if (!sessionSecret) throw new Error('Expected the fixture Session content key');
    await waitFor(async () => {
      const replies = (await fetchMessagesSince({ baseUrl: home.server.baseUrl, token: member.credentials.token,
        sessionId: started.sessionId, afterSeq: 0 })).map(row => decrypt(sessionSecret,
          sessionCrypto.selectedUsesDataKeyVariant ? 'dataKey' : 'legacy', decodeBase64(row.content.c)) as unknown);
      expect(replies).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'agent',
        content: expect.objectContaining({ type: 'acp', agentId: 'claude', data: expect.objectContaining({
          type: 'message', message: 'FAKE_CLAUDE_OK_1',
        }) }),
      })]));
      return true;
    }, { timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, context: 'Account B persists a native assistant reply' });
    // The same recipient selection also enters a detached Workflow Run; its
    // model carrier differs from the ordinary Session spawn above.
    async function workflowAct(actionId: ActionId, input: unknown) {
      if (!ui) throw new Error('Team model UI Action client is not mounted');
      const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: home.serverId,
        actionRequestId: randomUUID(), externalActionTarget: { kind: 'machine', machineId: worker.target.machineId,
          project: { machineId: worker.target.machineId, directory: worker.workspaceDir } } });
      expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
      return result.result;
    }
    const workflow = WorkflowRunStartResultV1Schema.parse(await workflowAct('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'detached_run' }, inputs: {},
      source: { kind: 'inline', definition: { version: 1, inputs: [],
        defaults: { agentTarget: { kind: 'agent', identity: declaration.identity },
          permissionMode: 'read-only', conversation: { kind: 'fresh' },
          modelSelection: { v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...teamModelRef } } },
        blocks: [{ kind: 'step', id: 'shared-model', document: { text: 'Reply with the shared model.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } },
    }));
    expect(await workflowAct('workflow.run.wait', { runId: workflow.run.id, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const workflowEvidence = (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { model: string; brokerEndpoint: boolean; ownerCredentialPresent: boolean });
    expect(workflowEvidence.length).toBeGreaterThan(evidence.length);
    expect(workflowEvidence.slice(evidence.length)).toContainEqual({ model: modelId, brokerEndpoint: true, ownerCredentialPresent: false });
  });
});
