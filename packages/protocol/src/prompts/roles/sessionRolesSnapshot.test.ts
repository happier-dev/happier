import { describe, expect, it } from 'vitest';
import { SessionRolesV1Schema, SessionRolesConfigurationSetRpcV1Schema, snapshotSessionRolesAtSpawnV1, readSessionRolesV1, readSessionRoleIdV1, readSessionAnswersWorkerQuestionsV1, writeSessionRoleIdV1ToMetadata, writeSessionRoleConfigurationV1ToMetadata } from './sessionRolesSnapshot.js';
import { resolveRoleSelectionV1 } from './resolveRoleSelectionV1.js';
import type { ResolvedRolesSnapshotV1 } from './rolesV1.js';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from './roleActionsV1.js';
import { renderSessionRoleBlockV1 } from './renderSessionRoleBlockV1.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

describe('session role instruction blocks', () => {
  it('teaches send, both ask modes, exact answer/pass and selector inspection with executable Action examples', () => {
    for (const context of [
      { role: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' } },
      { worker: { leadSessionId: 'lead', taskBoundary: 'Review the parser' } },
    ]) {
      const rendered = renderSessionRoleBlockV1(context);
      const examples = [...rendered.matchAll(/^(session\.(?:message\.(?:send|reply)|targets\.resolve)) (\{.*\})$/gm)]
        .map((match) => ({ id: match[1], input: JSON.parse(match[2]) as Record<string, unknown> }));
      expect(examples.filter(example => example.id === 'session.message.send').map(example => example.input.reply))
        .toEqual(['none', 'wait', 'return']);
      expect(examples.filter(example => example.id === 'session.message.reply').map(example => example.input.reply))
        .toEqual([{ kind: 'answer', message: expect.any(String) }, { kind: 'pass' }]);
      expect(examples.find(example => example.id === 'session.targets.resolve')?.input)
        .toMatchObject({ actionId: 'session.message.send', target: { selector: 'workers' } });
      for (const example of examples) {
        const spec = getActionSpec(example.id);
        expect(spec.surfaces.agent, example.id).toBe(true);
        expect(spec.inputSchema.safeParse(example.input).success, JSON.stringify(example)).toBe(true);
      }
    }
  });

  it('admits a sparse role or worker-question preference intent and rejects empty or unknown configuration writes', () => {
    const schema = RoleActionInputSchemasV1['session.role.set'];
    for (const input of [
      { sessionId: 'manager', roleId: 'orchestrator' },
      { sessionId: 'manager', answersWorkerQuestions: false },
      { sessionId: 'manager', roleId: 'builder', answersWorkerQuestions: true },
    ]) expect(schema.safeParse(input)).toEqual({ success: true, data: input });
    for (const input of [
      { sessionId: 'manager' }, { sessionId: 'manager', roleId: '' },
      { sessionId: 'manager', answersWorkerQuestions: null }, { sessionId: 'manager', answersWorkerQuestions: 'false' },
      { sessionId: 'manager', answersWorkerQuestions: false, configuration: {} },
    ]) expect(schema.safeParse(input).success).toBe(false);
  });
  it('projects role and Notes for Voice without coding delegation or private references', () => {
    const rendered = renderSessionRoleBlockV1({
      modality: 'voice',
      role: { ...BUILT_IN_ROLES_V1.orchestrator, roleId: 'orchestrator',
        instructions: 'Help the user choose the next task.', workspaceWrites: 'deny',
        profileId: 'private-profile', profileUnavailable: true },
      availableRoles: [{ ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' }],
      notes: 'Keep the conversation focused on the launch.',
      worker: { leadSessionId: 'private-lead', taskBoundary: 'Discuss the launch only' },
    });
    expect(rendered).toContain('Help the user choose the next task.');
    expect(rendered).toContain('Keep the conversation focused on the launch.');
    expect(rendered).toContain('Discuss the launch only');
    expect(rendered).toContain('do not change the workspace');
    for (const operational of ['action.spec', 'session.spawn_new', 'execution.run.start',
      'session.update.post', 'prompt_doc', 'private-profile', 'private-memory',
      'private-lead', 'role_id=', 'native subagent']) {
      expect(rendered).not.toContain(operational);
    }
  });

  it('keeps Notes-only Voice guidance and frozen-step suppression at the same formatter', () => {
    expect(renderSessionRoleBlockV1({ modality: 'voice', notes: 'Ask about today’s goal.' }))
      .toContain('Ask about today’s goal.');
    expect(renderSessionRoleBlockV1({ modality: 'voice', notes: 'Frozen notes', originKind: 'run_step' }))
      .toBe('');
  });

  it('renders current instructions and second-opinion policy, with FIN owning frozen workflow-step delivery', () => {
    const context = { role: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder',
      instructions: 'IMPLEMENT_CURRENT_BRIEF', secondOpinion: 'encouraged' as const }, source: 'dispatch' as const };
    const rendered = renderSessionRoleBlockV1(context);
    expect(rendered).toContain('IMPLEMENT_CURRENT_BRIEF');
    expect(rendered).toContain('Consider a second opinion');
    expect(renderSessionRoleBlockV1({ ...context, role: { ...context.role, instructions: 'UPDATED_BRIEF' } }))
      .toContain('UPDATED_BRIEF');
    expect(renderSessionRoleBlockV1({ ...context, originKind: 'run_step' })).toBe('');
    expect(renderSessionRoleBlockV1({ ...context, originKind: 'run_step', source: 'workflow_step' }))
      .toContain('IMPLEMENT_CURRENT_BRIEF');
  });

  it('advertises every enabled role through its Action without a second depth decision', () => {
    const roles = Object.fromEntries(Object.entries(BUILT_IN_ROLES_V1).map(([roleId, role]) => [roleId, { ...role, roleId }]));
    const rendered = renderSessionRoleBlockV1({ role: roles.orchestrator,
      availableRoles: [...Object.values(roles), { ...roles.builder, roleId: 'disabled-builder', enabled: false }] });
    expect(rendered).toContain('Open a pull request');
    expect(rendered).toContain("Never approve your own request; approval decisions follow the Action's policy.");
    expect(rendered).toContain('session.spawn_new');
    expect(rendered).toContain('execution.run.start');
    expect(rendered).toContain('"roleId":"builder"');
    expect(rendered).toContain('"roleId":"reviewer"');
    expect(rendered).not.toContain('disabled-builder');
  });

  it('uses the resolved delegation trait for custom roles and explicit Orchestrator overrides', () => {
    const availableRoles = [{ ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' }];
    for (const [roleId, canDelegateToOtherRoles] of [['custom-lead', true], ['orchestrator', false]] as const) {
      const resolved = resolveRoleSelectionV1({ roleId,
        settingsRoles: { [roleId]: { ...BUILT_IN_ROLES_V1.builder, canDelegateToOtherRoles: true } },
        settingsOverrides: { [roleId]: { roleId, canDelegateToOtherRoles } },
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error('Expected available role');
      const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles: { [roleId]: resolved.selection } });
      const stored = readSessionRolesV1({ work: { sessionRolesV1: JSON.parse(JSON.stringify(snapshot)) } });
      expect(stored?.sessionRoles[roleId]?.canDelegateToOtherRoles).toBe(canDelegateToOtherRoles);
      const rendered = renderSessionRoleBlockV1({ role: stored!.sessionRoles[roleId], availableRoles });
      expect(rendered.includes('Available roles')).toBe(canDelegateToOtherRoles);
      expect(rendered.includes('"roleId":"builder"')).toBe(canDelegateToOtherRoles);
    }
  });

  it('renders the worker boundary without a selected role or legacy memory write guidance', () => {
    const rendered = renderSessionRoleBlockV1({ worker: {
      leadSessionId: 'lead-1', taskBoundary: 'Only implement the assigned parser',
    } });
    expect(rendered).toContain('lead-1');
    expect(rendered).toContain('session.update.post');
    expect(rendered).toContain('Only implement the assigned parser');
    expect(rendered).not.toContain('prompt_doc.update');
    expect(rendered).toContain("Never approve your own request; approval decisions follow the Action's policy.");
  });
});

describe('session role spawn snapshot', () => {
  const roles: ResolvedRolesSnapshotV1 = { builder: { roleId: 'builder', name: 'Lead Builder', instructions: 'Lead private role instructions', engine: { agentTargetKey: 'agent:codex', modelId: 'lead-model', effort: 'high' }, runsAs: { kind: 'session' }, profileId: 'lead-profile', workspaceWrites: 'deny', secondOpinion: 'encouraged', enabled: true } };

  it('uses the draft worker publication Action for a frozen workflow step', () => {
    expect(renderSessionRoleBlockV1({ source: 'workflow_step', originKind: 'run_step',
      worker: { leadSessionId: 'lead', taskBoundary: 'Frozen step brief' } }))
      .toContain('session.worker.publish_draft');
  });

  it('copies complete roles to a cross-owner child that has no source settings or grants', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Agreed boundary' });
    expect(snapshot).toEqual({ inheritedFrom: 'lead', overrides: {}, sessionRoles: roles, notes: 'Agreed boundary' });
    expect(snapshot.sessionRoles).not.toBe(roles);
    expect(snapshot.sessionRoles.builder).not.toBe(roles.builder);
    expect(resolveRoleSelectionV1({ roleId: 'builder', sessionRoles: snapshot })).toEqual({ ok: true, selection: { ...roles.builder, changedAt: 'session' } });
  });

  it('never copies lead Session context to same-Account workers and validates metadata', () => {
    const lead = { leadSessionId: 'lead', roles, memoryDocRef: { kind: 'doc', artifactId: 'memory' }, sameAccount: true };
    const snapshot = snapshotSessionRolesAtSpawnV1(lead);
    expect(snapshot).not.toHaveProperty('memoryDocRef');
    expect(readSessionRolesV1({ work: { sessionRolesV1: snapshot } })).toEqual(snapshot);
    expect(readSessionRolesV1({ work: { sessionRolesV1: { ...snapshot, projectOverrides: {} } } })).toEqual(snapshot);
  });

  it('keeps stored role context while dropping additive fields recursively', () => {
    const snapshot = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Keep notes' }), roleId: 'builder',
      overrides: { builder: { roleId: 'builder', instructionsOverride: 'Session instructions' } } };
    const stored = { ...snapshot, future: true,
      overrides: { builder: { ...snapshot.overrides.builder, future: true } },
      sessionRoles: { builder: { ...roles.builder, future: true,
        engine: { ...roles.builder.engine, future: true }, runsAs: { kind: 'session', future: true } } },
    };
    const metadata = { work: { sessionRolesV1: stored } };
    expect(readSessionRolesV1(metadata)).toEqual(snapshot);
    expect(readSessionRoleIdV1(metadata)).toBe('builder');
    expect(writeSessionRoleIdV1ToMetadata(metadata, 'reviewer').work.sessionRolesV1).toEqual({ ...snapshot, roleId: 'reviewer' });
    const { roleId: _roleId, ...configuration } = snapshot;
    expect(writeSessionRoleConfigurationV1ToMetadata(metadata, configuration).work.sessionRolesV1).toEqual(snapshot);
    expect(SessionRolesV1Schema.safeParse(stored).success).toBe(false);
    expect(SessionRolesConfigurationSetRpcV1Schema.safeParse({ sessionId: 'session', configuration: stored }).success).toBe(false);
    const invalidConfiguration = { ...configuration, future: true };
    expect(() => writeSessionRoleConfigurationV1ToMetadata(metadata, invalidConfiguration)).toThrow();
  });

  it('still refuses missing or invalid known fields in stored snapshots', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles });
    for (const stored of [
      { ...snapshot, notes: undefined, future: true },
      { ...snapshot, sessionRoles: { builder: { ...roles.builder, enabled: 'yes', future: true } } },
    ]) expect(readSessionRolesV1({ work: { sessionRolesV1: stored } })).toBeNull();
  });

  it('rejects legacy role memory pointers on new configuration writes', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles });
    expect(SessionRolesV1Schema.safeParse({ ...snapshot, memoryDocRef: { kind: 'doc', artifactId: 'private-memory' } }).success).toBe(false);
  });

  it('retains the current role inside the session roles owner without requiring it on old snapshots', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles });
    expect(readSessionRolesV1({ work: { sessionRolesV1: { ...snapshot, roleId: 'builder' } } })?.roleId).toBe('builder');
    expect(readSessionRolesV1({ work: { sessionRolesV1: snapshot } })).toEqual(snapshot);
    expect(readSessionRoleIdV1({ work: { sessionRolesV1: { ...snapshot, roleId: 'builder' } } })).toBe('builder');
    expect(readSessionRoleIdV1({ work: { roleId: 'builder', sessionRolesV1: snapshot } })).toBeNull();
  });

  it('retains an explicit manager question preference through stored reads, role selection and configuration copies', () => {
    const snapshot = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles }),
      roleId: 'builder', answersWorkerQuestions: false };
    const metadata = { work: { sessionRolesV1: snapshot } };
    expect(readSessionRolesV1(JSON.parse(JSON.stringify(metadata)))).toEqual(snapshot);
    const selected = writeSessionRoleIdV1ToMetadata(metadata, 'reviewer');
    expect(readSessionRolesV1(selected)).toMatchObject({ roleId: 'reviewer', answersWorkerQuestions: false });
    const copied = writeSessionRoleConfigurationV1ToMetadata(selected, {
      overrides: {}, sessionRoles: roles, notes: 'Updated role configuration',
    });
    expect(readSessionRolesV1(copied)).toMatchObject({
      roleId: 'reviewer', notes: 'Updated role configuration', answersWorkerQuestions: false,
    });
    const enabled = writeSessionRoleConfigurationV1ToMetadata(copied, {
      overrides: {}, sessionRoles: roles, notes: '', answersWorkerQuestions: true,
    });
    expect(readSessionRolesV1(enabled)).toMatchObject({ answersWorkerQuestions: true });
  });

  it('defaults manager answers on independently for new sessions and refuses malformed retained settings', () => {
    expect(readSessionAnswersWorkerQuestionsV1({})).toBe(true);
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles });
    expect(readSessionAnswersWorkerQuestionsV1({ work: { sessionRolesV1: snapshot } })).toBe(true);
    for (const answersWorkerQuestions of [false, true, 'false', null]) {
      const metadata = { work: { sessionRolesV1: { ...snapshot, answersWorkerQuestions } } };
      expect(readSessionAnswersWorkerQuestionsV1(metadata)).toBe(answersWorkerQuestions === true);
    }
    expect(readSessionAnswersWorkerQuestionsV1({ work: { sessionRolesV1: { answersWorkerQuestions: true } } })).toBe(false);
  });

  it('clears only the current role and never silently replaces malformed role-owner content', () => {
    const snapshot = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Keep notes' }), roleId: 'builder' };
    expect(writeSessionRoleIdV1ToMetadata({ work: { other: 'keep', sessionRolesV1: snapshot } }, null)).toEqual({ work: { other: 'keep', sessionRolesV1: { inheritedFrom: 'lead', overrides: {}, sessionRoles: roles, notes: 'Keep notes' } } });
    expect(() => writeSessionRoleIdV1ToMetadata({ work: { sessionRolesV1: { notes: 'Do not lose' } } }, 'builder')).toThrow();
  });

  it('publishes grouping provenance for shared, view-only and migrated roles', () => {
    const role = { ...roles.builder };
    const { roleId: _roleId, ...artifact } = role;
    const result = { items: [{ roleId: 'shared-builder', role: artifact, shared: true, viewOnly: true, migratedFromV0_2: false }], diagnostics: [] };
    expect(RoleActionOutputSchemasV1['roles.list'].safeParse(result).success).toBe(true);
  });
});
