// J2 drives the real UI picker and Session birth; the real CLI session.message.send
// Action supplies native-turn stimulus (MUSE ORCH scope ruling, 2026-11-17 08:22Z).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { readProviderReasoningEffortOption } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamCredentialSourceCandidateListOutputV1Schema } from '@happier-dev/protocol/teams/credentials/sourceCandidatesV1';
import { TeamCredentialResourceSummaryV1Schema, teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { ProviderBrokerOpenResponseV1Schema, PROVIDER_BROKER_OPEN_HTTP_PATH_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { getBundledAgentDeclaration } from '../../../../apps/ui/sources/agents/catalog/catalog';
import { buildSessionModelPickerSections, resolveSessionModelSourceDescriptor } from '../../../../apps/ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';
import { isTeamCredentialProviderModelPickerValue } from '../../../../apps/ui/sources/components/sessions/modelPicker/sessionModelSelectionKey';
import { readCurrentContributionRegistry } from '../../../../apps/cli/src/agent/catalog/snapshot';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '../../../../apps/cli/src/providers/broker/applicationProjection';
import { readSessionTeamCredentialResourceCatalog } from '../../../../apps/cli/src/session/services/sessionTeamCredentialCatalog';
import { writeExecutableShimSync } from '../../../../apps/cli/src/testkit/fs/executableShim';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { CODEX_SUPPORTED_RUNTIME_VERSION } from '../../../plugins/codex/src/agent/cli/supportedRuntime';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';

const run = createRunDirs({ runLabel: 'muse-team-journey' });
const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
const modelId = 'muse-spark-1.3-contributor';
type Fixture = Awaited<ReturnType<typeof startTeamSetupFFixture>>;
type Account = Awaited<ReturnType<Fixture['createAccount']>>;

async function nativeBoundaries(directory: string) {
  await mkdir(directory, { recursive: true });
  const home = join(directory, 'native-home');
  await mkdir(home, { recursive: true });
  const audit = join(directory, 'native-launches.jsonl');
  const claudeLog = join(directory, 'claude.jsonl');
  const museScript = join(directory, 'muse.cjs');
  const recording = await readMuseLoginRecording();
  // This is the native Muse process boundary, using the sanitized 1.4.14 MSP
  // capture and the 1.4.15 envKey contributor catalog characterized by Muse.
  await writeFile(museScript, [
    "if (process.argv.includes('--version')) { console.log('1.4.15'); process.exit(0); }",
    `const playback = ${JSON.stringify(recording)};`,
    "for (const row of playback.rows) { const models = row.message?.result?.models; if (Array.isArray(models) && process.env.META_API_KEY === 'synthetic-team-muse-key') { for (const id of ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']) { const base = models.find(model => model.modelId === id.replace('-contributor', '')); models.push({ ...base, modelId: id, displayLabel: id, isDefault: false }); } } }",
    'process.env.MUSE_TEST_RECORDING = JSON.stringify(playback);',
    "process.env.MUSE_TEST_SCHEMA = '{}';",
    MUSE_MSP_PLAYBACK_SCRIPT,
  ].join('\n'));
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  function executable(name: string, script: string) {
    return writeExecutableShimSync({ dir: directory, fileName: process.platform === 'win32' ? `${name}.cmd` : name,
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
  }
  const muse = executable('muse', museScript);
  const claudeScript = join(directory, 'claude.mjs');
  // Only booleans and model ids cross the native evidence boundary. In
  // particular, no credential or broker authority is copied to a log.
  await writeFile(claudeScript, `import { appendFileSync } from 'node:fs';
process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG = ${JSON.stringify(claudeLog)};
process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN = '1';
if (process.argv.includes('--output-format')) appendFileSync(${JSON.stringify(audit)}, JSON.stringify({
  agent: 'claude', brokerEndpoint: /^http:\\/\\/127\\.0\\.0\\.1:/.test(process.env.ANTHROPIC_BASE_URL || ''),
  ownerCredentialPresent: Object.values(process.env).some(value => value === 'synthetic-team-muse-key'),
  model: process.argv[process.argv.indexOf('--model') + 1],
}) + '\\n');
await import(${JSON.stringify(pathToFileURL(fakeClaudeFixturePath()).href)});
`);
  const codexScript = join(directory, 'codex.cjs');
  // Native app-server replies mirror runtime.nativeAttach.test-support.ts;
  // current Unix Codex uses its WebSocket socket and raw proxy transport.
  // Happier's app-server client, startup admission and socket readiness are real.
  await writeFile(codexScript, `const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli ${CODEX_SUPPORTED_RUNTIME_VERSION}'); process.exit(0); }
if (process.argv[2] === 'features') { console.log('realtime_conversation under development true'); process.exit(0); }
const handle = (line, send) => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result = {};
  switch (message.method) {
    case 'initialize': result = { userAgent: 'happier_cli/${CODEX_SUPPORTED_RUNTIME_VERSION} (fixture)' }; break;
    case 'config/read': result = { config: { cli_auth_credentials_store: 'file', mcp_servers: {}, features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } }; break;
    case 'model/list': result = { data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT 5.4', isDefault: true }], nextCursor: null }; break;
    case 'experimentalFeature/list': result = { data: [{ name: 'realtime_conversation', enabled: true }], nextCursor: null }; break;
    case 'collaborationMode/list': case 'skills/list': result = { data: [] }; break;
    case 'plugin/list': result = { marketplaces: [] }; break;
    case 'thread/start': case 'thread/resume': {
      // Current Codex receives its selected upstream in thread/start config.
      const config = JSON.stringify(message.params.config || {});
      const upstream = message.params.config?.['model_providers.' + message.params.modelProvider];
      fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ agent: 'codex',
        model: message.params.model, brokerEndpoint: /^http:\\/\\/127\\.0\\.0\\.1:/.test(upstream?.base_url || ''),
        ownerCredentialPresent: Object.values(process.env).some(value => value === 'synthetic-team-muse-key') || config.includes('synthetic-team-muse-key'),
      }) + '\\n');
      result = { model: message.params.model, thread: { id: message.params.threadId || 'fixture-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' }; break;
    }
    case 'thread/read': result = { thread: { id: message.params.threadId, turns: [] } }; break;
    case 'thread/turns/list': result = { data: [], nextCursor: null }; break;
    case 'turn/start':
      fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ agent: 'codex', phase: 'turn',
        receivedTeamPrompt: message.params.input?.some(item => item.type === 'text' && item.text.includes('Verify the Team Muse launch.')) === true,
      }) + '\\n');
      result = { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } }; break;
  }
  send({ id: message.id, result });
  if (message.method === 'turn/start') send({ method: 'turn/completed', params: {
    threadId: message.params.threadId, turn: { id: 'fixture-turn', status: 'completed' },
  } });
};
const listen = process.argv[process.argv.indexOf('--listen') + 1];
if (process.argv.includes('proxy')) {
  const socket = require('node:net').connect(process.argv[process.argv.indexOf('--sock') + 1]);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('end', () => process.exit(0)); socket.on('error', () => process.exit(1));
} else if (typeof listen === 'string' && listen.startsWith('unix://')) {
  const socketPath = listen.slice('unix://'.length);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = require('node:http').createServer();
  const { WebSocketServer } = require(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', payload =>
    handle(payload.toString(), value => socket.send(JSON.stringify(value)))));
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
} else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line =>
    handle(line, value => process.stdout.write(JSON.stringify(value) + '\\n')));
}
`);
  const codex = executable('codex', codexScript);
  return { audit, claudeLog, env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'), PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
    [resolveAgentCliOverrideEnvKey('muse')]: muse, HAPPIER_CLAUDE_PATH: claudeScript,
    HAPPIER_CODEX_PATH: codex, HAPPIER_CODEX_APP_SERVER_BIN: codex, META_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } };
}

it('MUSE.J2 shares A’s Muse with B, launches Claude and Codex from the UI, preserves effort parity and refuses self brokerage', async () => {
  const directory = run.testDir(`team-claude-codex-${randomUUID()}`);
  const native = await nativeBoundaries(join(directory, 'native'));
  let fixture: Fixture | undefined;
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let primaryFailure: unknown;
  try {
    postgres = await startDatabaseWorkbenchPostgres();
    fixture = await startTeamSetupFFixture({ testDir: directory, dbProvider: 'postgres', serverEnv: {
      DATABASE_URL: postgres.homeDatabaseUrl,
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
    } });
    const owner = await fixture.createAccount('muse-owner');
    const member = await fixture.createAccount('muse-member');
    for (const account of [owner, member]) {
      await upsertEncryptedAccountSettingsV2({ baseUrl: fixture.server.baseUrl, token: account.auth.token,
        secret: account.auth.accountSigningSeed, settings: { claudeUnifiedTerminalEnabled: false,
          claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] } });
    }
    const capabilitySelection = { mcp: { managedServersEnabled: false, happierToolsEnabled: false,
      forceIncludeServerIds: [], forceExcludeServerIds: [] } };
    const hub = await fixture.enrollDaemon(owner, { env: native.env });
    const worker = await fixture.enrollDaemon(member, { env: native.env });
    const control = await owner.executeAsPerson('session.spawn_new', { executionTarget: hub.target,
      directory: { kind: 'path', path: hub.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' }, capabilitySelection });
    if (!control.ok) throw new Error(`Known-good UI control refused: ${control.errorCode}: ${control.error}`);
    const ownerControl = SessionSpawnNewActionResultV1Schema.parse(control.result);
    expect(ownerControl.type, 'Known-good native Claude control precedes Muse Team assertions').toBe('success');
    if (ownerControl.type !== 'success') throw new Error('Known-good native Claude control failed');
    console.info('[MUSE.J2] Native Claude control spawned');
    const controlPrompt = 'Verify the owner native Claude control.';
    // Native turn stimulus uses the real CLI Action; picker and Session birth use the real UI Action.
    expect(await owner.execute('session.message.send', { sessionId: ownerControl.sessionId,
      message: controlPrompt })).toMatchObject({ ok: true });
    console.info('[MUSE.J2] Native Claude control prompt admitted');
    await waitForFakeClaudeUserText(native.claudeLog, text => text.includes(controlPrompt));
    console.info('[MUSE.J2] Known-good native Claude control passed');
    const ref = { service, accountId: randomUUID() };
    const metadata = { displayName: 'Synthetic Muse account', providerIdentity: { accountId: ref.accountId } };
    const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'api-key',
      payload: { v: 1, values: { credentialMode: 'manual', inferenceKey: 'synthetic-team-muse-key' } }, metadata, now: Date.now() });
    const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
      material: { type: 'dataKey', machineKey: owner.auth.accountMachineKey }, payload, randomBytes });
    const imported = await fetchJson<unknown>(`${fixture.server.baseUrl}/v4/connect/qualified/credential`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref, authenticationModeId: 'api-key',
        content, metadata, expectedCredentialRevision: null })),
    });
    expect(imported.status).toBe(200);
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(imported.data);
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    const nativeCatalog = await owner.executeAsPerson('agents.models.list', {
      agentId: 'muse', machineId: hub.target.machineId,
      probe: { cwd: hub.workspaceDir, bypassCache: true, connectedServices: { v: 2, bindingsByServiceId: {
        [`${service.pluginId}/${service.localId}`]: { source: 'connected', profileId: ref.accountId },
      } } },
    });
    expect(nativeCatalog, JSON.stringify(nativeCatalog)).toMatchObject({ ok: true, result: {
      items: expect.arrayContaining([expect.objectContaining({ modelId: `meta/${modelId}` })]),
    } });
    const ownerId = await fetchAccountId(fixture.server.baseUrl, owner.credentials.token);
    const created = await owner.executeAsPerson('teams.create', { v: 1, name: 'Muse Team journey',
      requestKey: randomUUID(), initialOwnerAccountId: ownerId });
    if (!created.ok) throw new Error(`Team create refused: ${created.errorCode}`);
    const teamId = TeamSummaryV1Schema.parse(created.result).id;
    const memberId = await fetchAccountId(fixture.server.baseUrl, member.credentials.token);
    expect(await owner.executeAsPerson('teams.members.add', { v: 1, teamId, accountId: memberId,
      role: 'member', historyAccess: 'all_existing' })).toMatchObject({ ok: true });
    const sources = await owner.executeAsPerson('teams.credentials.sources.list', { teamId });
    if (!sources.ok) throw new Error(`Muse source discovery refused: ${sources.errorCode}`);
    const source = TeamCredentialSourceCandidateListOutputV1Schema.parse(sources.result).candidates.find(candidate =>
      candidate.source.kind === 'connected_account' && candidate.source.target.account.accountId === ref.accountId);
    expect(source, 'The real custodian must discover the imported Muse account').toBeDefined();
    if (!source) throw new Error('Muse source absent');
    const resourceId = randomUUID();
    const labelKey = Uint8Array.from(randomBytes(32));
    const displayName = sealPrivateLabelV1({ mode: 'e2ee', binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId),
      value: 'Team Muse', dataKey: labelKey, randomBytes, recipients: [
        { accountId: ownerId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(owner.auth.accountMachineKey).publicKey, randomBytes }) },
        { accountId: memberId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(member.auth.accountMachineKey).publicKey, randomBytes }) },
      ] });
    const shared = await owner.executeAsPerson('teams.credentials.create', { teamId, resourceId, displayName, source: source.source,
      deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
      brokerPlacement: { kind: 'machine', machineId: hub.target.machineId }, requestPolicy: null,
      allMembersAllowedRoutes: ['brokered'], groupGrants: [], memberGrants: [], usageLimits: [] });
    if (!shared.ok) throw new Error(`Muse Team share refused: ${shared.errorCode}`);
    const resource = TeamCredentialResourceSummaryV1Schema.parse(shared.result);
    const registry = readCurrentContributionRegistry();
    for (const agent of ['claude', 'codex'] as const) {
      const target = `agent:happier.agent.${agent}/${agent}`;
      const declaration = getBundledAgentDeclaration(agent);
      const applications = projectAgentProviderBrokerApplications({ registry, agentTargetKey: target,
        acceptedProtocols: declaration.providerRequirements!.acceptsProtocols }).filter(application =>
        resolveManagedProviderBrokerPurpose({ registry, application, service })?.purpose === 'meta-upstream');
      expect(applications).not.toHaveLength(0);
      const catalog = (account: Account, machineId: string) => readSessionTeamCredentialResourceCatalog({
        applications, teamIds: [teamId], resourceId, executionMachineId: machineId,
        homeDomainAction: async request => {
          const result = await account.executeAsPerson(request.actionId, request.input);
          if (!result.ok) throw new Error(`Team catalog refused: ${result.errorCode}`);
          return result.result;
        },
      });
      const resources = await catalog(member, worker.target.machineId);
      const projected = await member.executeAsPerson('providers.models.projection', { machineId: worker.target.machineId,
        agentTargetKey: target, teamCredentialResources: resources });
      if (!projected.ok) throw new Error(`Recipient projection refused: ${projected.errorCode}`);
      const teamProjection = DaemonProviderModelProjectionResponseV1Schema.parse(projected.result);
      if (teamProjection.status !== 'success') throw new Error(`Recipient projection failed: ${teamProjection.error.code}`);
      const projectedResources = teamProjection.teamCredentialResources;
      expect(projectedResources, 'The recipient daemon must produce the Team picker projection').toBeDefined();
      if (!projectedResources) throw new Error('Recipient Team projection absent');
      const options = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey: target,
        nativeModels: [], providerGroups: teamProjection.groups, hiddenNativeModelKeys: new Set(),
        providerProjectionAuthoritative: true, teamCredentialResources: projectedResources }).flatMap(section => section.options);
      const option = options.find(option => isTeamCredentialProviderModelPickerValue(option.value) && option.value.modelId === modelId);
      const catalogEvidence = projectedResources.map(resource => ({ readiness: resource.readiness,
        models: resource.providerModels.map(row => ({ modelId: row.selection.modelId, availability: row.availability,
          unavailableReason: row.deliveryUnavailableReason, compatibility: row.compatibility?.result.status })),
      }));
      expect(option, `${agent} Team picker catalog: ${JSON.stringify(catalogEvidence)}`).toBeDefined();
      if (!option || !isTeamCredentialProviderModelPickerValue(option.value)) throw new Error('Team model picker option absent');
      expect(option.disabled).not.toBe(true);
      const { kind: _kind, ...teamModelRef } = option.value;
      const descriptor = resolveSessionModelSourceDescriptor({ selected: option.value, providerGroups: teamProjection.groups,
        teamCredentialResources: projectedResources });
      if (!descriptor) throw new Error('Exact Team model descriptor absent');
      const personalResult = await owner.executeAsPerson('providers.models.projection', { machineId: hub.target.machineId,
        agentTargetKey: target, connectedAccountTarget: { kind: 'account', account: ref } });
      if (!personalResult.ok) throw new Error(`Own-account projection refused: ${personalResult.errorCode}`);
      const personal = DaemonProviderModelProjectionResponseV1Schema.parse(personalResult.result);
      if (personal.status !== 'success') throw new Error(`Own-account projection failed: ${personal.error.code}`);
      const personalModel = personal.groups.flatMap(group => group.rows).find(row => row.ref.modelId === modelId)?.descriptor;
      expect(personalModel, 'Compare Team effort against the same real own-account source').toBeDefined();
      if (!personalModel) throw new Error('Own-account model descriptor absent');
      const personalEfforts = readProviderReasoningEffortOption(personalModel)?.options?.map(option => option.value);
      const teamEfforts = readProviderReasoningEffortOption(descriptor)?.options?.map(option => option.value);
      expect(personalEfforts).toContain('high');
      // Claude excludes Minimal; Codex preserves the source's declared tiers.
      if (agent === 'claude') expect(personalEfforts, 'Claude excludes unsupported Minimal effort').not.toContain('minimal');
      expect(teamEfforts).toEqual(personalEfforts);
      // Consumes HUNT-TEAM-PARITY-1116's canonical self-share exclusion. This
      // assertion deliberately fails if that producer has not landed.
      expect(await catalog(owner, hub.target.machineId), 'A must use its own account instead of its own Team share').toEqual([]);
      const launched = await member.executeAsPerson('session.spawn_new', { executionTarget: worker.target,
        directory: { kind: 'path', path: worker.workspaceDir },
        agentTarget: { kind: 'agent', identity: declaration.identity },
        modelSelection: { v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...teamModelRef } },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' }, capabilitySelection });
      if (!launched.ok) throw new Error(`${agent} UI launch refused: ${launched.errorCode}`);
      console.info(`[MUSE.J2] ${agent} Team launch returned`);
      const session = SessionSpawnNewActionResultV1Schema.parse(launched.result);
      expect(session).toMatchObject({ type: 'success' });
      if (session.type !== 'success') throw new Error(`${agent} native launch failed`);
      expect(await member.execute('session.message.send', { sessionId: session.sessionId,
        message: 'Verify the Team Muse launch.' })).toMatchObject({ ok: true });
      await waitFor(async () => (await readFile(native.audit, 'utf8').catch(() => '')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { agent: string; model: string }).some(row => row.agent === agent && row.model === modelId), { timeoutMs: 60_000 });
      const observed = (await readFile(native.audit, 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { agent: string; model: string; brokerEndpoint: boolean; ownerCredentialPresent: boolean })
        .find(row => row.agent === agent && row.model === modelId);
      expect(observed).toMatchObject({ agent, model: modelId, brokerEndpoint: true, ownerCredentialPresent: false });
      if (agent === 'claude') {
        await waitForFakeClaudeUserText(native.claudeLog, text => text.includes('Verify the Team Muse launch.'));
      } else {
        await waitFor(async () => (await readFile(native.audit, 'utf8')).split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as { agent: string; phase?: string; receivedTeamPrompt?: boolean })
          .some(row => row.agent === 'codex' && row.phase === 'turn' && row.receivedTeamPrompt === true),
        { context: 'Team Muse prompt reaches the native Codex turn' });
      }
      console.info(`[MUSE.J2] ${agent} Team native turn passed`);
      // The Account owns its opaque metadata, so a direct client can attempt
      // an explicit self binding even when the picker hides it. Use the public
      // atomic metadata/binding mutation on a real active owner Session, with
      // its real Machine AccessKey; another Account's Session would merely
      // exercise consumer authorization before reaching the self-custody guard.
      const current = await fetchSessionV2(fixture.server.baseUrl, owner.credentials.token, ownerControl.sessionId);
      const selfBinding = await fetchJson<unknown>(`${fixture.server.baseUrl}/v2/sessions/${ownerControl.sessionId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json',
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        body: JSON.stringify({ mode: 'owner_team_credential_binding', operation: 'session.model.set', metadataLayoutVersion: 1,
          expectedOwnerMetadata: current.ownerMetadata, ownerMetadata: current.ownerMetadata,
          sharedMetadata: { ciphertext: current.metadata, expectedVersion: current.metadataVersion },
          agentState: { ciphertext: current.agentState, expectedVersion: current.agentStateVersion },
          teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, teamId, resourceId,
            expectedResourceRevision: resource.revision, deliveryMode: 'brokered',
            providerModelSelection: { agentTargetKey: target, modelId, application: applications[0],
              executionMachineId: hub.target.machineId } }],
        }),
      });
      expect(selfBinding.status, 'Explicit own-Account binding reaches the broker self-custody guard').toBe(200);
      const self = await fetchJson<unknown>(`${fixture.server.baseUrl}${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, resourceId, expectedResourceRevision: resource.revision, modelId,
          sourceRevision: projectedResources[0]!.providerModels[0]!.sourceRevision,
          initiatorMachineId: hub.target.machineId, consumer: { kind: 'session', sessionId: ownerControl.sessionId },
          application: applications[0] }),
      });
      expect(ProviderBrokerOpenResponseV1Schema.parse(self.data)).toMatchObject({ ok: false, reasonCode: 'resource_unavailable' });
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const stop of [() => fixture?.stop(), () => postgres?.stop()]) {
      try { await stop(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const summary = primaryFailure instanceof Error ? primaryFailure.message : 'Journey cleanup failed';
      throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], summary);
    }
  }
}, 0);
