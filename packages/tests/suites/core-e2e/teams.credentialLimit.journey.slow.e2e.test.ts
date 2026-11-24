import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { TeamCredentialSourceCandidateListOutputV1Schema } from '@happier-dev/protocol/teams/credentials/sourceCandidatesV1';
import { TeamCredentialResourceSummaryV1Schema, teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { ProviderBrokerOpenResponseV1Schema, ProviderBrokerRequestAdmissionResponseV1Schema,
  PROVIDER_BROKER_OPEN_HTTP_PATH_V1, PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readCurrentContributionRegistry } from '../../../../apps/cli/src/agent/catalog/snapshot';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '../../../../apps/cli/src/providers/broker/applicationProjection';
import { readSessionTeamCredentialResourceCatalog } from '../../../../apps/cli/src/session/services/sessionTeamCredentialCatalog';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';

it('TH.J3 keeps the admitted Team broker job across a limit edit, refuses its next request at the ceiling, and ends it on membership removal', async () => {
  const testDir = createRunDirs({ runLabel: 'team-credential-limit' }).testDir(randomUUID());
  const nativeDir = join(testDir, 'native');
  await mkdir(nativeDir, { recursive: true });
  // Only the third-party native catalog and Agent processes are deterministic.
  // All sharing, Session creation, broker signing/admission and withdrawal use
  // the real CLI executor, Home, PostgreSQL and enrolled daemons.
  const musePath = join(nativeDir, 'muse');
  const recording = await readMuseLoginRecording();
  await writeFile(musePath, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.4.15'); process.exit(0); }
process.env.MUSE_TEST_RECORDING = ${JSON.stringify(JSON.stringify(recording))};
process.env.MUSE_TEST_SCHEMA = '{}';
${MUSE_MSP_PLAYBACK_SCRIPT}
`, { mode: 0o755 });
  const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'credential-limit',
    captureEnvironmentKeys: [], logFullStdin: true });
  const postgres = await startDatabaseWorkbenchPostgres();
  let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  try {
    fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', serverEnv: {
      DATABASE_URL: postgres.homeDatabaseUrl,
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
    } });
    const owner = await fixture.createAccount('limit-owner');
    const member = await fixture.createAccount('limit-member');
    const nativeEnv = { HAPPIER_MUSE_PATH: musePath, MUSE_INSTALL_DIR: nativeDir,
      PATH: [nativeDir, process.env.PATH].filter(Boolean).join(delimiter),
      HAPPIER_CLAUDE_PATH: agent.executablePath, META_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
    for (const account of [owner, member]) await upsertEncryptedAccountSettingsV2({ baseUrl: fixture.server.baseUrl,
      token: account.auth.token, secret: account.auth.accountSigningSeed,
      settings: { claudeUnifiedTerminalEnabled: false, claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] } });
    const hub = await fixture.enrollDaemon(owner, { env: nativeEnv });
    const worker = await fixture.enrollDaemon(member, { env: nativeEnv });
    const control = await fixture.assertKnownGoodSessionControl(member, worker);
    const prompt = 'Confirm the credential-limit journey reaches its enrolled Agent.';
    expect(await member.execute('session.message.send', { sessionId: control.sessionId, message: prompt }))
      .toMatchObject({ ok: true });
    await waitForFakeClaudeUserText(agent.logPath, text => text.includes(prompt), { invocationId: 'credential-limit' });
    console.info('TH.J3 known-good CLI/Home/PostgreSQL/daemon/Agent control passed');
    const act = async (account: typeof owner, actionId: ActionId, input: unknown) => {
      const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId } });
      if (!result.ok) throw new Error(`${actionId} refused (${result.errorCode}); cause=${JSON.stringify(result.failureCause)}`);
      return result.result;
    };
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    const ownerId = await fetchAccountId(fixture.server.baseUrl, owner.credentials.token);
    const memberId = await fetchAccountId(fixture.server.baseUrl, member.credentials.token);
    const teamId = TeamSummaryV1Schema.parse(await act(owner, 'teams.create', { v: 1,
      name: 'Credential limit journey', requestKey: randomUUID(), initialOwnerAccountId: ownerId })).id;
    const membership = TeamMembershipV1Schema.parse(await act(owner, 'teams.members.add', { v: 1, teamId, accountId: memberId,
      role: 'member', historyAccess: 'all_existing' }));
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const ref = { service, accountId: randomUUID() };
    const metadata = { displayName: 'Synthetic journey Muse', providerIdentity: { accountId: ref.accountId } };
    const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'api-key',
      payload: { v: 1, values: { credentialMode: 'manual', inferenceKey: 'synthetic-limit-journey-key' } }, metadata, now: Date.now() });
    const imported = await fetchJson<unknown>(`${fixture.server.baseUrl}/v4/connect/qualified/credential`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref, authenticationModeId: 'api-key',
        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
          material: { type: 'dataKey', machineKey: owner.auth.accountMachineKey }, payload, randomBytes }),
        metadata, expectedCredentialRevision: null })),
    });
    expect(imported.status).toBe(200);
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(imported.data);
    const candidate = TeamCredentialSourceCandidateListOutputV1Schema.parse(await act(owner, 'teams.credentials.sources.list', { teamId }))
      .candidates.find(row => row.source.kind === 'connected_account' && row.source.target.account.accountId === ref.accountId);
    if (!candidate) throw new Error('Imported Muse source is absent from real custodian discovery');
    const resourceId = randomUUID();
    const labelKey = new Uint8Array(randomBytes(32));
    const displayName = sealPrivateLabelV1({ mode: 'e2ee', binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId),
      value: 'Journey credential', dataKey: labelKey, randomBytes,
      recipients: [{ accountId: ownerId, account: owner }, { accountId: memberId, account: member }].map(({ accountId, account }) => ({
        accountId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey, randomBytes }),
      })) });
    const resource = TeamCredentialResourceSummaryV1Schema.parse(await act(owner, 'teams.credentials.create', {
      teamId, resourceId, displayName, source: candidate.source, deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'personal_allowed', brokerPlacement: { kind: 'machine', machineId: hub.target.machineId },
      requestPolicy: null, allMembersAllowedRoutes: ['brokered'], groupGrants: [], memberGrants: [],
      usageLimits: [{ subjectKind: 'each_member', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '2', enabled: true }],
    }));
    const registry = readCurrentContributionRegistry();
    const applications = projectAgentProviderBrokerApplications({ registry, agentTargetKey: 'agent:happier.agent.claude/claude',
      acceptedProtocols: ['anthropic'] }).filter(application =>
      resolveManagedProviderBrokerPurpose({ registry, application, service })?.purpose === 'meta-upstream');
    expect(applications).not.toHaveLength(0);
    const resources = await readSessionTeamCredentialResourceCatalog({ applications, teamIds: [teamId], resourceId,
      executionMachineId: worker.target.machineId,
      homeDomainAction: request => act(member, request.actionId, request.input) });
    const model = resources.flatMap(row => row.providerModels).find(row => row.availability === 'available');
    if (!model) throw new Error(`Real recipient catalog has no available Team model: ${JSON.stringify(resources.map(row => row.readiness))}`);
    const { kind: _kind, ...teamModelRef } = model.selection;
    const spawned = SessionSpawnNewActionResultV1Schema.parse(await act(member, 'session.spawn_new', {
      executionTarget: worker.target, directory: { kind: 'path', path: worker.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      modelSelection: { v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...teamModelRef } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
      capabilitySelection: { mcp: { managedServersEnabled: false, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [] } },
    }));
    expect(spawned.type).toBe('success');
    if (spawned.type !== 'success') throw new Error('The real Team-model Session failed to start');
    const post = async (token: string, path: string, body: unknown) => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.data;
    };
    const openRequest = { v: 1, resourceId, expectedResourceRevision: resource.revision, modelId: model.selection.modelId,
      sourceRevision: model.sourceRevision, initiatorMachineId: worker.target.machineId,
      consumer: { kind: 'session', sessionId: spawned.sessionId }, application: model.application };
    const opened = ProviderBrokerOpenResponseV1Schema.parse(await post(member.credentials.token, PROVIDER_BROKER_OPEN_HTTP_PATH_V1, openRequest));
    expect(opened.ok, 'The same real broker fixture must admit before its refusal counts').toBe(true);
    if (!opened.ok) throw new Error(`Broker open refused (${opened.reasonCode})`);
    const admit = async () => ProviderBrokerRequestAdmissionResponseV1Schema.parse(await post(owner.credentials.token,
      PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1, { v: 1, authority: opened.authority,
        expectedResourceRevision: resource.revision, requestId: randomUUID(),
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1({ kind: 'connected_account', service, connectedAccountId: ref.accountId }),
        requestFacts: { generation: false, routeKind: 'anthropic_messages', modelId: model.selection.modelId, reasoningEffort: null } }));
    expect(await admit()).toMatchObject({ ok: true });
    await act(owner, 'teams.credentials.limits.upsert', { resourceId, expectedRevision: resource.revision,
      limit: { subjectKind: 'each_member', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '1', enabled: true } });
    expect(ProviderBrokerOpenResponseV1Schema.parse(await post(member.credentials.token, PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
      { ...openRequest, refreshAuthority: opened.authority }))).toMatchObject({ ok: true });
    // Editing the same limit retains the request already recorded in its window.
    // The next request must expose usage refusal rather than stale authority.
    expect(await admit()).toMatchObject({ ok: false, reasonCode: 'team_credential_usage_limit' });
    await act(owner, 'teams.members.remove', { v: 1, teamId, membershipId: membership.id });
    expect(await admit()).toMatchObject({ ok: false, reasonCode: 'operation_not_current' });
  } finally {
    try { await fixture?.stop(); } finally { await postgres.stop(); }
  }
}, 0);
