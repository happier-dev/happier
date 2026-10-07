import { describe, expect, it } from 'vitest';
import { SessionRolesV1Schema, SessionRolesConfigurationSetRpcV1Schema, snapshotSessionRolesAtSpawnV1, readSessionRolesV1, readSessionRoleIdV1, writeSessionRoleIdV1ToMetadata, writeSessionRoleConfigurationV1ToMetadata } from './sessionRolesSnapshot.js';
import { resolveRoleSelectionV1 } from './resolveRoleSelectionV1.js';
import type { ResolvedRolesSnapshotV1 } from './rolesV1.js';
import { RoleActionOutputSchemasV1 } from './roleActionsV1.js';
import { renderSessionRoleBlockV1 } from './renderSessionRoleBlockV1.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';

describe('session role instruction blocks', () => {
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
    expect(rendered).toContain('session.spawn_new');
    expect(rendered).toContain('execution.run.start');
    expect(rendered).toContain('"roleId":"builder"');
    expect(rendered).toContain('"roleId":"reviewer"');
    expect(rendered).not.toContain('disabled-builder');
  });

  it('renders the worker boundary with its lead and admitted memory reference without a selected role', () => {
    const rendered = renderSessionRoleBlockV1({ worker: {
      leadSessionId: 'lead-1', taskBoundary: 'Only implement the assigned parser',
      memoryDocRef: { kind: 'doc', artifactId: 'memory-1' },
    } });
    expect(rendered).toContain('lead-1');
    expect(rendered).toContain('session.worker.publish');
    expect(rendered).toContain('Only implement the assigned parser');
    expect(rendered).toContain('memory-1');
    expect(rendered).toContain('cannot approve');
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
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Agreed boundary', memoryDocRef: { kind: 'doc', artifactId: 'private-memory' }, sameAccount: false });
    expect(snapshot).toEqual({ inheritedFrom: 'lead', overrides: {}, sessionRoles: roles, notes: 'Agreed boundary' });
    expect(snapshot.sessionRoles).not.toBe(roles);
    expect(snapshot.sessionRoles.builder).not.toBe(roles.builder);
    expect(resolveRoleSelectionV1({ roleId: 'builder', sessionRoles: snapshot })).toEqual({ ok: true, selection: { ...roles.builder, changedAt: 'session' } });
  });

  it('retains memory only for same-Account workers and validates metadata', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, memoryDocRef: { kind: 'doc', artifactId: 'memory' }, sameAccount: true });
    expect(snapshot.memoryDocRef).toEqual({ kind: 'doc', artifactId: 'memory' });
    expect(readSessionRolesV1({ work: { sessionRolesV1: snapshot } })).toEqual(snapshot);
    expect(readSessionRolesV1({ work: { sessionRolesV1: { ...snapshot, projectOverrides: {} } } })).toEqual(snapshot);
  });

  it('keeps stored role context while dropping additive fields recursively', () => {
    const snapshot = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Keep notes',
      memoryDocRef: { kind: 'doc', artifactId: 'memory' }, sameAccount: true }), roleId: 'builder',
      overrides: { builder: { roleId: 'builder', instructionsOverride: 'Session instructions' } } };
    const stored = { ...snapshot, future: true,
      memoryDocRef: { ...snapshot.memoryDocRef, future: true },
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
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, sameAccount: true });
    for (const stored of [
      { ...snapshot, notes: undefined, future: true },
      { ...snapshot, memoryDocRef: { kind: 'doc', future: true } },
      { ...snapshot, sessionRoles: { builder: { ...roles.builder, enabled: 'yes', future: true } } },
    ]) expect(readSessionRolesV1({ work: { sessionRolesV1: stored } })).toBeNull();
  });

  it('renders only the memory reference admitted into the worker snapshot', () => {
    const render = (sameAccount: boolean) => {
      const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles,
        memoryDocRef: { kind: 'doc', artifactId: 'account-private-memory' }, sameAccount });
      return renderSessionRoleBlockV1({ worker: { leadSessionId: 'lead', taskBoundary: 'Implement the brief',
        ...(snapshot.memoryDocRef ? { memoryDocRef: snapshot.memoryDocRef } : {}) } });
    };
    expect(render(true)).toContain('account-private-memory');
    expect(render(false)).not.toContain('account-private-memory');
  });

  it('retains the current role inside the session roles owner without requiring it on old snapshots', () => {
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, sameAccount: true });
    expect(readSessionRolesV1({ work: { sessionRolesV1: { ...snapshot, roleId: 'builder' } } })?.roleId).toBe('builder');
    expect(readSessionRolesV1({ work: { sessionRolesV1: snapshot } })).toEqual(snapshot);
    expect(readSessionRoleIdV1({ work: { sessionRolesV1: { ...snapshot, roleId: 'builder' } } })).toBe('builder');
    expect(readSessionRoleIdV1({ work: { roleId: 'builder', sessionRolesV1: snapshot } })).toBeNull();
  });

  it('clears only the current role and never silently replaces malformed role-owner content', () => {
    const snapshot = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles, notes: 'Keep notes', sameAccount: true }), roleId: 'builder' };
    expect(writeSessionRoleIdV1ToMetadata({ work: { other: 'keep', sessionRolesV1: snapshot } }, null)).toEqual({ work: { other: 'keep', sessionRolesV1: { inheritedFrom: 'lead', overrides: {}, sessionRoles: roles, notes: 'Keep notes' } } });
    expect(() => writeSessionRoleIdV1ToMetadata({ work: { sessionRolesV1: { notes: 'Do not lose' } } }, 'builder')).toThrow();
  });

  it('publishes grouping provenance for shared, view-only and migrated roles', () => {
    const role = { ...roles.builder };
    const { roleId: _roleId, ...artifact } = role;
    const result = { items: [{ roleId: 'shared-builder', role: artifact, shared: true, viewOnly: true, migratedFromV0_2: false }] };
    expect(RoleActionOutputSchemasV1['roles.list'].safeParse(result).success).toBe(true);
  });
});
