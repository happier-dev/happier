import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema,
  WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readRetainedExecutionRunRecord } from '../../../../apps/cli/src/daemon/executionRunRegistry';
import { reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { isRecord } from '@happier-dev/protocol/common/records';

async function createApprovalProfile(member: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>, name: string) {
  const created = await member.executeAsPerson('actions.policy.set', {
    profileChange: { kind: 'create', profile: { name } },
  });
  if (!created.ok) throw new Error(`Profile fixture creation refused (${created.errorCode})`);
  const result = ActionPolicyOutputSchemas['actions.policy.set'].parse(created.result);
  if (!('profileChange' in result) || result.profileChange.kind !== 'create') {
    throw new Error('Profile fixture creation did not return its Artifact identity');
  }
  return result.profileChange.id;
}

describe('Team setup F: every launcher captures Session defaults', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('TS.F.allLaunchers captures a Machine approval default at creation and preserves existing Sessions after edits', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-f-launchers-'));
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true, advertiseRequestObservationEndpoint: true });
    const member = await fixture.createAccount('member');
    const machine = await fixture.enrollDaemon(member);
    const control = await fixture.assertKnownGoodSessionControl(member, machine);
    expect(control.metadata.machineId).toBe(machine.target.machineId);
    expect(control.metadata.approvalProfileId ?? null).toBeNull();
    // A saved sandbox choice must reach its placement owner. Replacing the
    // authored placement with a bare Machine would silently start directly.
    expect(await member.execute('session.spawn_new', {
      executionTarget: machine.target,
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' },
      sessionPlacement: { kind: 'machine', target: machine.target, projectFiles: { kind: 'copy_once' },
        configuredSandbox: { kind: 'sandbox', configuredSandboxId: 'not-configured', lifecycle: 'fresh',
          provisioner: { pluginId: 'happier.provisioner.local', localId: 'local' }, presetId: 'not-configured' } },
    })).toMatchObject({ ok: false, errorCode: 'target_unavailable', effectAttempted: false,
      details: { reason: 'machine_isolation_sandbox_unavailable' } });
    const firstProfile = await createApprovalProfile(member, 'F first');
    const secondProfile = await createApprovalProfile(member, 'F second');
    const changeMachineDefault = async (id: string | null) => {
      const changed = await member.executeAsPerson('actions.policy.set', { profileChange: {
        kind: 'machine_default', machineId: machine.target.machineId, id,
      } });
      if (!changed.ok) throw new Error(`Machine default fixture write refused (${changed.errorCode})`);
    };
    const create = async (surface: 'cli' | 'ui', approvalProfileId?: string | null,
      projectContext?: Readonly<{ projectRef?: { serverId: string; projectKey: string }; sourceRef?: { serverId: string; sourceId: string } }>) => {
      const input = {
        executionTarget: machine.target,
        directory: { kind: 'path' as const, path: machine.workspaceDir },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        terminal: { mode: 'plain' as const },
        ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
        ...(projectContext ? { projectContext } : {}),
      };
      const result = surface === 'ui' ? await member.executeAsPerson('session.spawn_new', input)
        : await member.executeReviewed('session.spawn_new', input, { surface });
      if (!result.ok) throw new Error(`Session creation refused (${result.errorCode})`);
      const created = SessionSpawnNewActionResultV1Schema.parse(result.result);
      expect(created.type).toBe('success');
      if (created.type !== 'success') throw new Error(`Session creation did not settle (${created.type === 'error' ? created.code : created.outcome})`);
      return { sessionId: created.sessionId, metadata: await member.readSessionMetadata(created.sessionId) };
    };

    await changeMachineDefault(firstProfile);
    const first = await create('cli');
    expect(first.metadata.approvalProfileId).toBe(firstProfile);
    expect(first.metadata.approvalProfileTeamOrGroupDerived).toBe(false);
    await changeMachineDefault(secondProfile);
    expect((await member.readSessionMetadata(first.sessionId)).approvalProfileId).toBe(firstProfile);
    expect(resolveSessionApprovalProfileReferenceV1(first.metadata)).toBe(firstProfile);
    expect((await create('ui')).metadata.approvalProfileId).toBe(secondProfile);
    expect((await create('cli', firstProfile)).metadata.approvalProfileId).toBe(firstProfile);
    const accountSettings = await create('ui', null);
    expect(accountSettings.metadata.approvalProfileId).toBeNull();
    expect(accountSettings.metadata.approvalProfileTeamOrGroupDerived).toBe(false);
    expect(resolveSessionApprovalProfileReferenceV1(accountSettings.metadata)).toBeNull();

    const createdSource = await member.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'Account Project defaults', requestKey: 'f-launcher-source' });
    if (!createdSource.ok) throw new Error(`Project Source creation refused (${createdSource.errorCode})`);
    const source = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
    if (!source.ok) throw new Error(`Project Source creation refused (${source.error})`);
    const sourceDefaults = await member.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
      sourceId: source.source.id, expectedRevision: source.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: { approvalProfileId: firstProfile,
        defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionModeByAgentTargetKey: { 'agent:happier.agent.claude/claude': 'read-only' },
        modelByAgentTargetKey: { 'agent:happier.agent.claude/claude': { v: 2, updatedAt: 1,
          ref: { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'f-source-model' } } },
        placement: { kind: 'machine', target: machine.target } } } } });
    expect(sourceDefaults).toMatchObject({ ok: true, result: { ok: true } });
    const openedProject = await member.executeAsPerson('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
    if (!openedProject.ok) throw new Error(`F Project open refused (${openedProject.errorCode})`);
    const project = OpenProjectResultV1Schema.parse(openedProject.result);
    if (project.kind !== 'opened' || !project.facts?.projectKey) throw new Error('F Project omitted its canonical key');
    const projectContext = { projectRef: { serverId: fixture.serverId, projectKey: project.facts.projectKey },
      sourceRef: { serverId: fixture.serverId, sourceId: source.source.id } };
    const fromSource = await create('cli', undefined, projectContext);
    expect(fromSource.metadata).toMatchObject({ approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: true });
    fixture.takeRequestObservations();
    const inheritedTargetResult = await member.executeReviewed('session.spawn_new', {
      projectContext, directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' },
    });
    expect(inheritedTargetResult).toMatchObject({ ok: true, result: { type: 'success' } });
    if (!inheritedTargetResult.ok) throw new Error(`Selected Project launch refused (${inheritedTargetResult.errorCode})`);
    const inheritedTarget = SessionSpawnNewActionResultV1Schema.parse(inheritedTargetResult.result);
    if (inheritedTarget.type !== 'success') throw new Error('Selected Project launch did not settle');
    expect(await member.readSessionMetadata(inheritedTarget.sessionId)).toMatchObject({
      machineId: machine.target.machineId, approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: true,
      permissionMode: 'read-only',
      modelSelectionIntentV2: { v: 2, ref: { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude',
        modelId: 'f-source-model' } },
    });
    const creationRequests = fixture.takeRequestObservations();
    expect(creationRequests.filter(request => request.method === 'GET'
      && request.path.startsWith(`/v1/projects/sources/${encodeURIComponent(source.source.id)}?`))).toHaveLength(1);
    const argvCreated = await fixture.createSessionFromArgv(machine,
      ['--project-context-json', JSON.stringify(projectContext)], 'project-defaults-argv');
    expect(argvCreated).toMatchObject({ ok: true, kind: 'session_create', data: { session: { id: expect.any(String) } } });
    if (!argvCreated.data || typeof argvCreated.data !== 'object' || !('session' in argvCreated.data)
      || !argvCreated.data.session || typeof argvCreated.data.session !== 'object'
      || !('id' in argvCreated.data.session) || typeof argvCreated.data.session.id !== 'string') {
      throw new Error('CLI Session creation did not return a Session identity');
    }
    expect(await member.readSessionMetadata(argvCreated.data.session.id)).toMatchObject({
      machineId: machine.target.machineId, approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: true,
      permissionMode: 'read-only',
      modelSelectionIntentV2: { v: 2, ref: { source: 'native', modelId: 'f-source-model' } },
    });
    const voice: unknown = JSON.parse(await member.executeViaVoiceSpawn({ projectContext,
      directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' } }));
    expect(voice).toMatchObject({ ok: true, result: { type: 'success' } });
    if (!isRecord(voice) || voice.ok !== true) throw new Error('Voice Project creation refused');
    const voiceSession = SessionSpawnNewActionResultV1Schema.parse(voice.result);
    if (voiceSession.type !== 'success') throw new Error('Voice Project creation did not settle');
    expect(await member.readSessionMetadata(voiceSession.sessionId)).toMatchObject({
      machineId: machine.target.machineId, approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: true,
      permissionMode: 'read-only',
      modelSelectionIntentV2: { v: 2, ref: { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude',
        modelId: 'f-source-model' } },
    });
    const savedPersonal = await member.executeReviewed('projects.organization.update', {
      projectRef: projectContext.projectRef, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: 'absent', defaults: { approvalProfileId: secondProfile } },
    });
    expect(savedPersonal).toMatchObject({ ok: true });
    expect((await create('ui', undefined, projectContext)).metadata).toMatchObject({
      approvalProfileId: secondProfile, approvalProfileTeamOrGroupDerived: false });
    expect((await create('cli', firstProfile, projectContext)).metadata).toMatchObject({
      approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: false });
    expect((await member.readSessionMetadata(fromSource.sessionId))).toMatchObject({
      approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: true });
    const parentId = fromSource.sessionId;
    expect(await member.execute('session.message.send', {
      sessionId: parentId, message: 'Establish the applied Project model for an attached Run.',
    })).toMatchObject({ ok: true, result: { status: 'accepted' } });
    await fixture.assertSessionAgentOutput(member, parentId);
    fixture.takeRequestObservations();
    const localInputId = randomUUID();
    const child = await member.executeAsPerson('execution.run.start', {
      sessionId: parentId, intent: 'agent',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      instructions: 'Reply ready.', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'request_response', localInputId,
    });
    if (!child.ok) throw new Error(`Attached Run start refused (${child.errorCode})`);
    const { runId } = ExecutionRunStartResponseSchema.parse(child.result);
    const observed = await member.executeAsPerson('execution.run.get', { sessionId: parentId, runId, waitForInputId: localInputId });
    if (!observed.ok) throw new Error(`Attached Run observation refused (${observed.errorCode})`);
    // The fake native Agent reports its applied model after the first turn.
    // The launch intent above still records the distinct Project model.
    const { run: attachedRun } = ExecutionRunGetResponseSchema.parse(observed.result);
    expect(attachedRun, attachedRun.error?.code).toMatchObject({
      resolvedSelection: { source: 'inherited', modelId: 'fake-claude' },
      // Attached output stays in the Session transcript; this receipt witnesses the native turn.
      inputTurns: { last: { inputIds: [localInputId], state: 'completed' } },
    });
    expect(await member.executeAsPerson('execution.run.stop', { sessionId: parentId, runId })).toMatchObject({ ok: true });
    expect(fixture.takeRequestObservations().filter(request => request.method === 'GET'
      && request.path.startsWith(`/v1/projects/sources/${encodeURIComponent(source.source.id)}?`))).toHaveLength(0);
    const inheritedStored = await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, fromSource.sessionId);
    expect(await member.executeAsPerson('session.approval_profile.set', { sessionId: fromSource.sessionId,
      serverId: fixture.serverId, expectedMetadataRevision: inheritedStored.metadataVersion,
      approvalProfileId: firstProfile })).toMatchObject({ ok: true });
    expect(await member.readSessionMetadata(fromSource.sessionId)).toMatchObject({
      approvalProfileId: firstProfile, approvalProfileTeamOrGroupDerived: false });
  // Server and daemon owners bound their lifecycle waits; resource admission
  // may remain queued without a competing whole-journey cutoff.
  }, 0);
  it('TS.F.detachedRun captures Source approval defaults once and keeps them when resuming', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-f-run-'));
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true, advertiseRequestObservationEndpoint: true });
    const member = await fixture.createAccount('run-member');
    const machine = await fixture.enrollDaemon(member);
    await fixture.assertKnownGoodSessionControl(member, machine);
    const profiles = [await createApprovalProfile(member, 'F Run first'),
      await createApprovalProfile(member, 'F Run second')] as const;
    const created = await member.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'Run defaults', requestKey: 'f-run-source' });
    if (!created.ok) throw new Error(`Run Source creation refused (${created.errorCode})`);
    let source = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!source.ok) throw new Error(`Run Source creation refused (${source.error})`);
    const sourceId = source.source.id;
    const takeSourceReads = () => fixture!.takeRequestObservations().filter(request => request.method === 'GET'
      && request.path.startsWith(`/v1/projects/sources/${encodeURIComponent(sourceId)}?`));
    const sourceModel = { source: 'native' as const, agentTargetKey: 'agent:happier.agent.claude/claude',
      modelId: 'f-detached-source-model' };
    const setSourceDefault = async (approvalProfileId: string) => {
      if (!source.ok) throw new Error('Run Source is unavailable');
      const changed = await member.executeReviewed('projects.sources.update', { serverId: fixture!.serverId, sourceId,
        expectedRevision: source.source.revision, patch: { sessionDefaults: {
          expectedRevision: source.sessionDefaults?.revision ?? 'absent', defaults: { approvalProfileId,
            modelByAgentTargetKey: { [sourceModel.agentTargetKey]: { v: 2, updatedAt: 1, ref: sourceModel } },
          },
        } } });
      if (!changed.ok) throw new Error(`Run Source update refused (${changed.errorCode})`);
      source = ProjectSourcesReadOutputV1Schema.parse(changed.result);
      if (!source.ok) throw new Error(`Run Source update refused (${source.error})`);
    };
    const projectContext = { sourceRef: { serverId: fixture.serverId, sourceId } };
    const context = { executionRunTargetMachineId: machine.target.machineId,
      externalActionTarget: { kind: 'machine' as const, machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const observeCompletedInput = async (runId: string, inputId: string) => {
      const opened = await member.executeAsPerson('execution.run.get', { sessionId: null, runId, waitForInputId: inputId }, context);
      if (!opened.ok) throw new Error(`Detached Run observation refused (${opened.errorCode})`);
      const { run } = ExecutionRunGetResponseSchema.parse(opened.result);
      expect(run.inputTurns?.last).toMatchObject({ inputIds: [inputId], state: 'completed',
        result: { kind: 'text', value: expect.stringContaining('FAKE_CLAUDE_OK_') } });
    };
    const stop = async (runId: string) => {
      expect(await member.executeAsPerson('execution.run.stop', { sessionId: null, runId }, context)).toMatchObject({ ok: true });
    };
    const start = async (approvalProfileId?: null) => {
      const localInputId = randomUUID();
      const result = await member.executeAsPerson('execution.run.start', { sessionId: null, intent: 'agent',
        backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        instructions: 'Reply ready.', permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'request_response', cwd: machine.workspaceDir, projectContext,
        localInputId, ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
      }, context);
      if (!result.ok) throw new Error(`Detached Run start refused (${result.errorCode})`);
      const { runId } = ExecutionRunStartResponseSchema.parse(result.result);
      // An interactive Run can finish a turn while remaining available for more input.
      await observeCompletedInput(runId, localInputId);
      await stop(runId);
      return runId;
    };
    const readCaptured = async (runId: string) => {
      // The real local persistence owner opens the daemon's sealed record.
      // Select its Home through the same environment adapter as the daemon.
      const previousHome = process.env.HAPPIER_HOME_DIR;
      const previousVariant = process.env.HAPPIER_VARIANT;
      try {
        process.env.HAPPIER_HOME_DIR = machine.homeDir;
        process.env.HAPPIER_VARIANT = 'dev';
        reloadConfiguration();
        const record = await readRetainedExecutionRunRecord(runId);
        if (!record) throw new Error('Detached Run retained record is missing');
        return record.state;
      } finally {
        if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHome;
        if (previousVariant === undefined) delete process.env.HAPPIER_VARIANT;
        else process.env.HAPPIER_VARIANT = previousVariant;
        reloadConfiguration();
      }
    };
    await setSourceDefault(profiles[0]);
    fixture.takeRequestObservations();
    const first = await start();
    expect(await readCaptured(first)).toMatchObject({ approvalProfileId: profiles[0],
      approvalProfileTeamOrGroupDerived: true, launch: { modelId: sourceModel.modelId } });
    expect(takeSourceReads()).toHaveLength(1);
    await setSourceDefault(profiles[1]);
    fixture.takeRequestObservations();
    const resumedInputId = randomUUID();
    expect(await member.executeAsPerson('execution.run.send', { sessionId: null, runId: first,
      message: 'Reply ready again.', resume: true, delivery: 'prompt', localInputId: resumedInputId }, context)).toMatchObject({ ok: true });
    await observeCompletedInput(first, resumedInputId);
    await stop(first);
    expect(await readCaptured(first)).toMatchObject({ approvalProfileId: profiles[0],
      approvalProfileTeamOrGroupDerived: true, launch: { modelId: sourceModel.modelId } });
    expect(takeSourceReads()).toHaveLength(0);
    expect(await readCaptured(await start())).toMatchObject({ approvalProfileId: profiles[1], approvalProfileTeamOrGroupDerived: true });
    expect(takeSourceReads()).toHaveLength(1);
    expect(await readCaptured(await start(null))).toMatchObject({ approvalProfileId: null, approvalProfileTeamOrGroupDerived: false });
  }, 0);
  it('TS.F.workflow captures Source defaults through a saved Workflow Session launch', async () => {
    const features = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' };
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-f-workflow-')),
      serverEnv: features });
    const member = await fixture.createAccount('workflow-member');
    const machine = await fixture.enrollDaemon(member, { env: features });
    await fixture.assertKnownGoodSessionControl(member, machine);
    const profiles = [await createApprovalProfile(member, 'F Workflow first'),
      await createApprovalProfile(member, 'F Workflow second')] as const;
    const createdSource = await member.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'Workflow Project defaults', requestKey: 'f-workflow-source' });
    if (!createdSource.ok) throw new Error(`Workflow Source creation refused (${createdSource.errorCode})`);
    let source = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
    if (!source.ok) throw new Error(`Workflow Source creation refused (${source.error})`);
    let defaultsRevision: number | 'absent' = 'absent';
    const setSourceDefault = async (approvalProfileId: string) => {
      if (!source.ok) throw new Error('Workflow Source is unavailable');
      const updated = await member.executeReviewed('projects.sources.update', { serverId: fixture!.serverId,
        sourceId: source.source.id, expectedRevision: source.source.revision,
        patch: { sessionDefaults: { expectedRevision: defaultsRevision, defaults: { approvalProfileId } } } });
      if (!updated.ok) throw new Error(`Workflow Source update refused (${updated.errorCode})`);
      source = ProjectSourcesReadOutputV1Schema.parse(updated.result);
      if (!source.ok) throw new Error(`Workflow Source update refused (${source.error})`);
      defaultsRevision = source.sessionDefaults?.revision ?? 'absent';
    };
    const projectContext = { sourceRef: { serverId: fixture.serverId, sourceId: source.source.id } };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const authored = await member.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Project defaults Session' }, definition: { version: 1,
        defaults: { agentTarget, projectContext, conversation: { kind: 'fresh' }, permissionMode: 'read-only', modelSelection: null,
          connectedServices: null, terminal: { mode: 'plain' } },
        blocks: [{ kind: 'step', id: 'create-session', inputMode: 'none',
          document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
      } });
    if (!authored.ok) throw new Error(`Workflow save refused (${authored.errorCode})`);
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(authored.result);
    expect(saved.definition.defaults).toMatchObject({ agentTarget, projectContext });
    const start = async () => {
      const started = await member.executeAsPerson('workflow.run.start', { runId: randomUUID(),
        source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
        executionTarget: { kind: 'session' } }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
      if (!started.ok) throw new Error(`Workflow start refused (${started.errorCode})`);
      const run = WorkflowRunStartResultV1Schema.parse(started.result).run;
      expect(run.machineId).toBe(machine.target.machineId);
      expect(await member.execute('workflow.run.wait', { runId: run.id, conditions: ['terminal'] }))
        .toMatchObject({ ok: true, result: { observation: 'terminal' } });
      const listed = await member.execute('workflow.run.invocations.list', { runId: run.id, includeContent: true });
      if (!listed.ok) throw new Error(`Workflow invocations unavailable (${listed.errorCode})`);
      const details = WorkflowInvocationListResultV1Schema.parse(listed.result).invocationDetails;
      const execution = details?.find(row => row.progress.blockKind === 'step')?.progress.execution;
      if (execution?.kind !== 'session' && execution?.kind !== 'session_ready') throw new Error('Workflow Session correspondence is missing');
      return { sessionId: execution.sessionId, metadata: await member.readSessionMetadata(execution.sessionId) };
    };
    await setSourceDefault(profiles[0]);
    const first = await start();
    expect(first.metadata).toMatchObject({ machineId: machine.target.machineId,
      approvalProfileId: profiles[0], approvalProfileTeamOrGroupDerived: true });
    await setSourceDefault(profiles[1]);
    expect(await member.readSessionMetadata(first.sessionId)).toMatchObject({
      approvalProfileId: profiles[0], approvalProfileTeamOrGroupDerived: true });
    expect((await start()).metadata).toMatchObject({ machineId: machine.target.machineId,
      approvalProfileId: profiles[1], approvalProfileTeamOrGroupDerived: true });
  }, 0);
});
