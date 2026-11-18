import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRecord } from '@happier-dev/protocol/common/records';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ProjectSessionDefaultsContextSelectionV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsSelectionV1';
import { HomeGovernanceProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { BotTemplateDraftResultV1Schema, BotTemplateInstantiateResultV1Schema, BotTemplateReleaseResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunStartResultV1Schema, WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { AccountApiTokensCreateActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { prepareCliPrivateLabel } from '../../../../apps/cli/src/api/privateLabels';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { dispatchOriginalAccountAction } from '../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from '../../../../apps/cli/src/mcp/runtime/sessionMcpLocalClient';
import { readRetainedExecutionRunRecord } from '../../../../apps/cli/src/daemon/executionRunRegistry.testkit';
import { reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSessionDefaultsGetOutputV1Schema } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { resolveProfiledActionsSettingsV1, type ApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';

const entries = ['ui', 'cli', 'action', 'workflow', 'daemon-credential', 'pat', 'mcp', 'voice', 'template', 'detached'] as const;
const contexts = ['personal', 'team', 'project-defaults', 'signed-home', 'read-only-member'] as const;
const homeDefaultsPath = getActionSpec('home.governance.get').serverTransport?.path;
const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const projectAgentKey = 'agent:happier.agent.claude/claude';
const projectModel = { source: 'native' as const, agentTargetKey: projectAgentKey, modelId: 'matrix-project-model' };
const features = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_BOTS__ENABLED: '1' };

/** One canonical server/Postgres/daemon fixture; setup is shared for cost and
 * correctness, while each cell retains its own result after setup succeeds. */
describe('TS.F.spawnMatrix: creation entry × defaults context', () => {
  let fixture: TeamSetupFFixture;
  type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  type Machine = Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  type Actor = {
    account: Account;
    machine: Machine;
    controlSessionId: string;
    agentLogPath: string;
    pat?: string;
    templateSource?: { kind: 'artifact'; serverId: string; artifactId: string };
    mcp?: Awaited<ReturnType<typeof connectSessionMcpClient>>;
  };
  let owner: Actor;
  let reader: Actor;
  let projectProfile: string;
  let personalProfile: string;
  let homeProfile: string;
  let teamProfile: string;
  let derivedProfile: ApprovalProfileV1;
  let personalProject: NonNullable<ProjectSessionDefaultsContextSelectionV1['projectRef']>;
  let teamSource: NonNullable<ProjectSessionDefaultsContextSelectionV1['sourceRef']>;
  let sharedSource: NonNullable<ProjectSessionDefaultsContextSelectionV1['sourceRef']>;

  beforeAll(async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ts-spawn-matrix-'));
    fixture = await startTeamSetupFFixture({ testDir,
      dbProvider: 'postgres', observeActionRequests: true, serverEnv: features });
    const ownerAccount = await fixture.createAccount('matrix-owner');
    expect((await fixture.claimHomeOwner(ownerAccount)).result.status).toBe('claimed');

    async function enroll(account: Account): Promise<Actor> {
      const agent = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, account.name), invocationId: account.name,
        captureEnvironmentKeys: [], logFullStdin: false });
      const machine = await fixture.enrollDaemon(account, { env: { ...features, HAPPIER_CLAUDE_PATH: agent.executablePath } });
      const control = await fixture.assertKnownGoodSessionControl(account, machine);
      expect(control.metadata.approvalProfileId ?? null).toBeNull();
      return { account, machine, controlSessionId: control.sessionId, agentLogPath: agent.logPath };
    }
    owner = await enroll(ownerAccount);
    reader = await enroll(await fixture.createAccount('matrix-reader'));
    const { account: member } = owner;
    const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
    const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl, accountSecret: member.auth.accountSigningSeed });
    try {
      const context = { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: ui.serverId, serverIdentityId: fixture.serverId };
      async function profile(name: string, waive = false) {
        const created = await ui.executeConfirmed('actions.policy.set', { profileChange: { kind: 'create', profile: { name,
          ...(waive ? { approvalWaivedSurfaces: { 'session.message.send': ['api'] } } : {}) } } },
        { ...context, actionRequestId: randomUUID() });
        if (!created.ok) throw new Error(`Matrix profile ${name}: ${created.errorCode}`);
        const result = ActionPolicyOutputSchemas['actions.policy.set'].parse(created.result);
        if (!('profileChange' in result) || result.profileChange.kind !== 'create') throw new Error('Missing profile identity');
        return result.profileChange.id;
      }
      projectProfile = await profile('Project derived', true);
      personalProfile = await profile('Personal override');
      homeProfile = await profile('Home fallback');
      teamProfile = await profile('Team fallback');
      const catalog = await ui.executeConfirmed('actions.policy.get', { profiles: true }, { ...context, actionRequestId: randomUUID() });
      if (!catalog.ok) throw new Error(`Profile catalog: ${catalog.errorCode}`);
      const opened = ActionPolicyOutputSchemas['actions.policy.get'].parse(catalog.result);
      if (!('profiles' in opened)) throw new Error('Profile catalog omitted profiles');
      const selected = opened.profiles.find(row => row.id === projectProfile);
      if (!selected) throw new Error('Project profile is unreadable');
      derivedProfile = selected.profile;
      expect(await ui.executeConfirmed('actions.policy.set', { actionId: 'session.spawn_new', audience: 'api', mode: 'allowed' },
        { ...context, actionRequestId: randomUUID() })).toMatchObject({ ok: true });
    } catch (error) {
      throw new Error('Matrix failed to seed the owner approval profiles', { cause: error });
    } finally { await ui.close(); }
    const governance = await member.execute('home.governance.get', {});
    if (!governance.ok) throw new Error(`Matrix Home policy read: ${governance.errorCode}`);
    const { policy } = HomeGovernanceProjectionV1Schema.parse(governance.result);
    expect(await member.executeReviewed('home.policy.set', { expectedRevision: policy.revision,
      sessionDefaults: { approvalProfileId: homeProfile } })).toMatchObject({ ok: true });

    const teamResult = await member.executeReviewed('teams.create', { v: 1, name: 'Matrix Team', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(member.credentials.token) });
    if (!teamResult.ok) throw new Error(`Matrix Team: ${teamResult.errorCode}`);
    const teamId = TeamSummaryV1Schema.parse(teamResult.result).id;
    expect(await member.executeReviewed('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(reader.account.credentials.token), role: 'member', historyAccess: 'all_existing',
    })).toMatchObject({ ok: true });
    for (const artifactId of [homeProfile, teamProfile, projectProfile]) {
      expect(await member.executeReviewed('artifact.access.grants.set', { artifactId,
        principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    }
    expect(await member.executeReviewed('teams.policy.set', { v: 1, teamId,
      managedDefaults: { team: { approvalProfileId: teamProfile }, groups: {} } })).toMatchObject({ ok: true });
    expect(await reader.account.executeAsPerson('actions.policy.set', {
      actionId: 'session.spawn_new', audience: 'api', mode: 'allowed',
    })).toMatchObject({ ok: true });

    personalProject = { serverId: fixture.serverId, projectKey: 'matrix-personal' };
    expect(await member.executeReviewed('projects.organization.update', {
      projectRef: personalProject, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: 'absent', defaults: { approvalProfileId: personalProfile } },
    })).toMatchObject({ ok: true });
    async function createSource(name: string, ownedByTeam: boolean) {
      const created = await member.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
        name, requestKey: randomUUID(), ...(ownedByTeam ? { owner: { kind: 'team', teamId } } : {}) });
      if (!created.ok) throw new Error(`Matrix Source: ${created.errorCode}`);
      const source = ProjectSourcesReadOutputV1Schema.parse(created.result);
      if (!source.ok) throw new Error(`Matrix Source: ${source.error}`);
      return source.source;
    }
    // The Team Source selects Team context without a Project defaults leaf.
    teamSource = { serverId: fixture.serverId, sourceId: (await createSource('Team fallback', true)).id };
    const project = await createSource('Shared Project', false);
    sharedSource = { serverId: fixture.serverId, sourceId: project.id };
    expect(await member.executeReviewed('projects.sources.update', { ...sharedSource,
      expectedRevision: project.revision, patch: {
        audience: [{ principal: { kind: 'team', teamId }, level: 'view' }],
        sessionDefaults: { expectedRevision: 'absent', defaults: {
          approvalProfileId: projectProfile,
          permissionModeByAgentTargetKey: { [projectAgentKey]: 'read-only' },
          modelByAgentTargetKey: { [projectAgentKey]: { v: 2, updatedAt: 1, ref: projectModel } },
        } },
      },
    })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await reader.account.execute('projects.sessionDefaults.get', { sourceRef: sharedSource }))
      .toMatchObject({ ok: true, result: { canManageSource: false, sourceDefaultsRow: {
        defaults: { approvalProfileId: projectProfile },
      } } });
  }, 0);

  afterAll(async () => {
    try { await Promise.all([owner?.mcp?.close(), reader?.mcp?.close()]); } finally { await fixture?.stop(); }
  }, 0);

  async function submitUiNewSession(member: Account, machine: Machine, input: SessionSpawnNewInputV2) {
    const { submitUiSessionSpawnNew } = await import('@happier-tests/ui-action-client');
    return submitUiSessionSpawnNew({ serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl, accountSecret: member.auth.accountSigningSeed,
      input, machineHomeDir: machine.homeDir, userAttemptId: randomUUID() });
  }

  async function prepareTemplate(actor: Actor) {
    if (actor.templateSource) return actor.templateSource;
    const drafted = await actor.account.executeReviewed('template.draft', {
      sourceSessionRef: { serverId: fixture.serverId, sessionId: actor.controlSessionId },
      content: { v: 1, identity: { name: 'Matrix Bot', description: '' }, instructions: { markdown: 'Help with coding.' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
    if (!drafted.ok) throw new Error(`Matrix template draft: ${drafted.errorCode}`);
    const draft = BotTemplateDraftResultV1Schema.parse(drafted.result);
    const released = await actor.account.executeReviewed('template.release', { draftArtifactId: draft.draftArtifactId,
      expectedRevision: draft.revision, version: '1.0.0', changelog: '' });
    if (!released.ok) throw new Error(`Matrix template release: ${released.errorCode}`);
    actor.templateSource = { kind: 'artifact', serverId: fixture.serverId,
      artifactId: BotTemplateReleaseResultV1Schema.parse(released.result).artifactId };
    return actor.templateSource;
  }

  async function preparePat(actor: Actor) {
    if (actor.pat) return actor.pat;
    const { account } = actor;
    const tokenId = randomUUID();
    const label = await prepareCliPrivateLabel({ endpoint: fixture.server.baseUrl, token: account.credentials.token,
      accountId: readAccountIdFromToken(account.credentials.token), accountMode: 'e2ee',
      recipientCensusPath: '/v1/account/private-labels/recipient-census',
      binding: { entity: 'account_api_token', field: 'label', id: tokenId }, value: 'Matrix PAT' });
    const token = await account.executeAsPerson('account.apiTokens.create', { tokenId, label, grant: API_TOKEN_FULL_GRANT_V1 });
    if (!token.ok) throw new Error(`Matrix PAT: ${token.errorCode}`);
    actor.pat = AccountApiTokensCreateActionOutputV1Schema.parse(token.result).token;
    return actor.pat;
  }

  it('skips an unreadable Source with a typed note and retains personal defaults', async () => {
    const unreadable = await owner.account.execute('projects.sessionDefaults.get', {
      projectRef: personalProject, sourceRef: { serverId: fixture.serverId, sourceId: randomUUID() } });
    if (!unreadable.ok) throw new Error(`Optional unreadable defaults refused creation context: ${unreadable.errorCode}`);
    expect(ProjectSessionDefaultsGetOutputV1Schema.parse(unreadable.result)).toMatchObject({
      context: { personalProjectDefaults: { approvalProfileId: personalProfile } }, source: null,
      unavailableDefaults: [{ ok: false, errorCode: 'source_unavailable', effectAttempted: false }],
    });
  }, 0);

  it.each(entries.flatMap(entry => contexts.map(context => ({ entry, context }))))('$entry × $context', async ({ entry, context }) => {
    const actor = context === 'signed-home' || context === 'read-only-member' ? reader : owner;
    const { account: member, machine } = actor;
    const templateSource = entry === 'template' ? await prepareTemplate(actor) : undefined;
    const pat = entry === 'pat' ? await preparePat(actor) : undefined;
    if (entry === 'mcp' && !actor.mcp) {
      const invocation = await waitForFakeClaudeInvocation(actor.agentLogPath, row => row.mode === 'sdk'
        && row.cwd === machine.workspaceDir && typeof row.sessionMcpContextFile === 'string');
      if (typeof invocation.sessionMcpContextFile !== 'string') throw new Error('Control omitted MCP context');
      actor.mcp = await connectSessionMcpClient(await readSessionMcpContextFromEnvironment({
        HAPPIER_SESSION_MCP_CONTEXT_FILE: invocation.sessionMcpContextFile,
      }));
      expect(await member.executeAsPerson('actions.policy.set', {
        actionId: 'session.spawn_new', audience: 'mcp', mode: 'allowed',
      })).toMatchObject({ ok: true });
    }
    const projectContext: ProjectSessionDefaultsContextSelectionV1 | undefined = context === 'personal'
      ? { projectRef: personalProject } : context === 'team' ? { sourceRef: teamSource }
        : context === 'signed-home' ? undefined : { sourceRef: sharedSource };
    const selectedProject = projectContext ? { projectContext } : {};
    const input = { executionTarget: machine.target, agentTarget,
      directory: { kind: 'path' as const, path: machine.workspaceDir }, terminal: { mode: 'plain' as const }, ...selectedProject };
    fixture.takeRequestObservations();
    const expectedProfile = {
      personal: entry === 'pat' ? homeProfile : personalProfile,
      team: teamProfile,
      'project-defaults': projectProfile,
      'signed-home': entry === 'pat' ? null : homeProfile,
      'read-only-member': projectProfile,
    }[context];
    const expectedDerived = context === 'team' || context === 'project-defaults' || context === 'read-only-member';
    function assertRequestCustody() {
      const sawSignedHomeRead = fixture.requestProxy?.entries().some(request => request.path === homeDefaultsPath
        && request.statusCode === 200 && Boolean(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]));
      if (context === 'signed-home' && (entry === 'action' || entry === 'daemon-credential')) {
        expect(sawSignedHomeRead).toBe(true);
      }
      if (context === 'signed-home' && entry === 'pat') expect(sawSignedHomeRead).toBe(false);
      const requests = fixture.takeRequestObservations();
      if (entry === 'pat') expect(requests.filter(request => request.path.startsWith(PROJECT_ACCOUNT_ROWS_ROUTE_V1))).toEqual([]);
    }
    function assertTightenOnly(metadata: Readonly<{ approvalProfileTeamOrGroupDerived?: unknown }>) {
      if (context !== 'project-defaults') return;
      const base = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'session.message.send': { approvalRequiredSurfaces: ['api'] },
      } });
      const boundProfile = { profile: derivedProfile, resolution: { status: 'available' as const, requestedId: projectProfile } };
      const effective = resolveProfiledActionsSettingsV1(base, projectProfile, { boundProfile,
        approvalProfileTeamOrGroupDerived: metadata.approvalProfileTeamOrGroupDerived === true }).settings;
      expect(effective.actions['session.message.send']?.approvalRequiredSurfaces).toContain('api');
      expect(effective.approvalWaivedSurfaces?.['session.message.send']).toBeUndefined();
      // Sensitivity control: accepting that same profile really would waive it.
      expect(resolveProfiledActionsSettingsV1(base, projectProfile, { boundProfile }).settings
        .approvalWaivedSurfaces?.['session.message.send']).toContain('api');
    }
    let sessionId: string;
    if (entry === 'cli') {
      const args = ['--backend', projectAgentKey,
        ...(projectContext ? ['--project-context-json', JSON.stringify(projectContext)] : [])];
      const result = await fixture.createSessionFromArgv(machine, args, `${entry}-${context}`);
      expect(result).toMatchObject({ ok: true });
      if (!isRecord(result.data) || !isRecord(result.data.session) || typeof result.data.session.id !== 'string') throw new Error('CLI omitted Session');
      sessionId = result.data.session.id;
    } else if (entry === 'workflow') {
      const created = await member.executeReviewed('workflow.definition.create', { definitionId: randomUUID(), metadata: { title: `Matrix ${context}` },
        definition: { version: 1, defaults: { agentTarget, ...selectedProject, terminal: { mode: 'plain' } }, blocks: [{ kind: 'step', id: 'spawn', inputMode: 'none',
          document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } });
      if (!created.ok) throw new Error(`Workflow save: ${created.errorCode}`);
      const saved = WorkflowDefinitionCreateResultV1Schema.parse(created.result);
      const started = await member.executeReviewed('workflow.run.start', { runId: randomUUID(),
        source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision }, executionTarget: { kind: 'session' } },
      { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
      if (!started.ok) throw new Error(`Workflow start: ${started.errorCode}`);
      const run = WorkflowRunStartResultV1Schema.parse(started.result).run;
      expect(await member.execute('workflow.run.wait', { runId: run.id, conditions: ['terminal'] })).toMatchObject({ ok: true, result: { observation: 'terminal' } });
      const listed = await member.execute('workflow.run.invocations.list', { runId: run.id, includeContent: true });
      if (!listed.ok) throw new Error(`Workflow invocations: ${listed.errorCode}`);
      const execution = WorkflowInvocationListResultV1Schema.parse(listed.result).invocationDetails?.find(row => row.progress.blockKind === 'step')?.progress.execution;
      if (execution?.kind !== 'session' && execution?.kind !== 'session_ready') throw new Error('Workflow omitted Session');
      sessionId = execution.sessionId;
    } else if (entry === 'detached') {
      const result = await member.executeAsPerson('execution.run.start', { sessionId: null, intent: 'agent', backendTarget: agentTarget,
        instructions: 'Reply ready.', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', cwd: machine.workspaceDir, ...selectedProject, waitForCompletion: true },
      { executionRunTargetMachineId: machine.target.machineId,
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
      if (!result.ok) throw new Error(`Detached start: ${result.errorCode}`);
      const run = ExecutionRunStartResponseSchema.parse(result.result);
      expect(run.wait).toMatchObject({ ok: true, status: 'succeeded' });
      const previousHome = process.env.HAPPIER_HOME_DIR;
      const previousVariant = process.env.HAPPIER_VARIANT;
      try {
        process.env.HAPPIER_HOME_DIR = machine.homeDir;
        process.env.HAPPIER_VARIANT = 'dev';
        reloadConfiguration();
        const captured = await readRetainedExecutionRunRecord(run.runId);
        expect(captured?.state).toMatchObject({ approvalProfileId: expectedProfile,
          approvalProfileTeamOrGroupDerived: expectedDerived });
        if (!captured) throw new Error('Detached record missing');
        assertTightenOnly(captured.state);
      } finally {
        if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHome;
        if (previousVariant === undefined) delete process.env.HAPPIER_VARIANT;
        else process.env.HAPPIER_VARIANT = previousVariant;
        reloadConfiguration();
      }
      assertRequestCustody();
      return;
    } else {
      const result = entry === 'voice' ? JSON.parse(await member.executeViaVoiceSpawn(input)) as unknown
        : entry === 'mcp' ? await (async () => {
          if (!actor.mcp) throw new Error('MCP was not connected');
          const response = await actor.mcp.client.callTool({ name: 'action_execute', arguments: { actionId: 'session.spawn_new', input } });
          expect(response.isError).not.toBe(true);
          const content = response.content.find(block => block.type === 'text');
          if (!content || content.type !== 'text') throw new Error('MCP omitted result');
          return { ok: true, result: JSON.parse(content.text) as unknown };
        })()
        : entry === 'ui' ? await submitUiNewSession(member, machine, input)
        : entry === 'daemon-credential' ? await dispatchOriginalAccountAction({
          actionId: 'session.spawn_new', input, requestId: randomUUID(),
          target: { kind: 'machine', machineId: machine.target.machineId },
          credentials: member.credentials, serverHttpBaseUrl: fixture.actionServerApiUrl, serverIdentityId: fixture.serverId,
        })
        : entry === 'template' ? await member.executeReviewed('template.instantiate', {
          source: templateSource, expectedVersion: '1.0.0', creation: { ...input, creationKey: randomUUID() } })
        : entry === 'pat' ? await (async () => {
          const response = await fetchJson<unknown>(`${fixture.server.baseUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}session.spawn_new`, {
            method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: machine.target.machineId }, input }) });
          expect(response.status).toBe(200);
          return ExternalActionResponseEnvelopeV1Schema.parse(response.data).execution;
        })() : await member.executeAsPerson('session.spawn_new', input);
      expect(result).toMatchObject({ ok: true, result: { type: 'success' } });
      if (!isRecord(result) || result.ok !== true) throw new Error('Spawn refused');
      const resultSchema = entry === 'template' ? BotTemplateInstantiateResultV1Schema : SessionSpawnNewActionResultV1Schema;
      const created = resultSchema.parse(result.result);
      if (created.type !== 'success') throw new Error('Spawn did not settle');
      sessionId = created.sessionId;
    }
    // PAT has no private requester box and therefore cannot read For me.
    const metadata = await member.readSessionMetadata(sessionId);
    expect(metadata.machineId).toBe(machine.target.machineId);
    expect(metadata.approvalProfileId ?? null).toBe(expectedProfile);
    expect(metadata.approvalProfileTeamOrGroupDerived ?? false).toBe(expectedDerived);
    if (context === 'project-defaults' || context === 'read-only-member') {
      expect(metadata).toMatchObject({ permissionMode: 'read-only',
        modelSelectionIntentV2: { v: 2, ref: projectModel } });
    }
    assertTightenOnly(metadata);
    assertRequestCustody();
  }, 0);
});
