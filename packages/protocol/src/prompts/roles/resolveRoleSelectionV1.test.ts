import { describe, expect, it } from 'vitest';
import { RoleArtifactV1Schema, type RoleArtifactV1 } from './roleArtifactV1.js';
import { WorkflowRoleV1Schema } from './rolesV1.js';
import { resolveRoleSelectionV1, readSessionWorkspaceWritesV1 } from './resolveRoleSelectionV1.js';

const role: RoleArtifactV1 = { name: 'UI work', instructions: 'Settings instructions', engine: { agentTargetKey: 'agent:claude', modelId: 'settings-model' }, runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true };

describe('resolveRoleSelectionV1', () => {
  it('admits known selected sources but refuses unknown origins from a partial inventory', () => {
    const roleSourceInventory = { status: 'partial' as const, entries: [], diagnostics: [{ source: 'legacy-guidance' as const, reason: 'unavailable' as const }] };
    expect(resolveRoleSelectionV1({ roleId: 'builder', roleSourceInventory, defaultEngine: { agentTargetKey: 'agent:codex' } })).toMatchObject({ ok: true });
    expect(resolveRoleSelectionV1({ roleId: 'unknown', roleSourceInventory, settingsRoles: { unknown: role }, defaultEngine: { agentTargetKey: 'agent:codex' } })).toEqual({ ok: false, refusal: { code: 'role_source_incomplete', roleId: 'unknown' } });
    expect(resolveRoleSelectionV1({ roleId: 'ui', roleSourceInventory, sessionRoles: { sessionRoles: { ui: { ...role, roleId: 'ui' } }, overrides: {}, notes: '' } })).toMatchObject({ ok: true, selection: { instructions: role.instructions } });
    expect(resolveRoleSelectionV1({ roleId: 'ui', roleSourceInventory: { ...roleSourceInventory, entries: [{ roleId: 'ui', role: { ...role, enabled: false }, shared: false, viewOnly: false, migratedFromV0_2: false }] } })).toEqual({ ok: false, refusal: { code: 'role_target_unavailable', roleId: 'ui' } });
  });
  it('reads the current workspace policy through the role owner and fails closed for unavailable or malformed roles', () => {
    const metadata = (roleId: string) => ({ work: { sessionRolesV1: { roleId, overrides: {}, sessionRoles: {}, notes: '' } } });
    expect(readSessionWorkspaceWritesV1(metadata('orchestrator'))).toBe('deny');
    expect(readSessionWorkspaceWritesV1(metadata('builder'))).toBe('allow');
    expect(readSessionWorkspaceWritesV1(metadata('builder'), { settingsOverrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } })).toBe('deny');
    expect(readSessionWorkspaceWritesV1(metadata('missing'))).toBe('deny');
    expect(readSessionWorkspaceWritesV1({ work: { sessionRolesV1: { roleId: 'builder', notes: '' } } })).toBe('deny');
    expect(readSessionWorkspaceWritesV1({ work: { roleId: 'orchestrator' } })).toBeUndefined();
  });
  it('resolves each role field independently across all four layers', () => {
    const result = resolveRoleSelectionV1({
      roleId: 'ui', settingsRoles: { ui: role },
      settingsOverrides: { ui: { roleId: 'ui', workspaceWrites: 'deny', instructionsOverride: 'Settings override' } },
      sessionRoles: { overrides: { ui: { roleId: 'ui', engine: { agentTargetKey: 'agent:codex', modelId: 'session-model' }, secondOpinion: 'encouraged' } }, sessionRoles: {}, notes: '' },
      workflowRoles: [{ roleId: 'ui', name: 'Pinned UI', instructions: 'Pinned instructions', runsAs: { kind: 'session' }, profileId: 'pinned-profile' }],
      runOverrides: [{ roleId: 'ui', workspaceWrites: 'allow' }, { roleId: 'unrelated', engine: { agentTargetKey: 'agent:wrong' } }],
    });
    expect(result).toEqual({ ok: true, selection: { ...role, name: 'Pinned UI', instructions: 'Pinned instructions', engine: { agentTargetKey: 'agent:codex', modelId: 'session-model' }, profileId: 'pinned-profile', workspaceWrites: 'allow', secondOpinion: 'encouraged', roleId: 'ui', changedAt: 'run' } });
    expect(resolveRoleSelectionV1({ roleId: 'ui', settingsRoles: { ui: role }, workflowRoles: [{ roleId: 'ui', engine: { agentTargetKey: 'agent:pin' } }], runOverrides: [{ roleId: 'ui', engine: { agentTargetKey: 'agent:run' } }] })).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: 'agent:run' }, instructions: role.instructions } });
  });

  it('runs a portable full workflow role and preserves its unavailable profile reference', () => {
    const pinned = WorkflowRoleV1Schema.parse({ roleId: 'portable', name: 'Portable', instructions: 'Portable instructions', runsAs: { kind: 'background_run', intent: 'plan' }, profileId: 'lead-only-profile', engine: { agentTargetKey: 'agent:codex' }, workspaceWrites: 'deny' });
    expect(resolveRoleSelectionV1({ roleId: 'portable', workflowRoles: [pinned], availableProfileIds: [] })).toEqual({ ok: true, selection: { roleId: 'portable', name: 'Portable', instructions: 'Portable instructions', runsAs: { kind: 'background_run', intent: 'plan' }, engine: { agentTargetKey: 'agent:codex' }, profileId: 'lead-only-profile', profileUnavailable: true, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true, changedAt: 'workflow' } });
  });

  it('applies local overrides to shared Artifact and read-only plugin sources', () => {
    expect(resolveRoleSelectionV1({ roleId: 'shared', settingsRoles: { shared: role }, settingsOverrides: { shared: { roleId: 'shared', instructionsOverride: 'Local' } } })).toMatchObject({ ok: true, selection: { instructions: 'Local', changedAt: 'settings' } });
    expect(resolveRoleSelectionV1({ roleId: 'plugin:acme/reviewer', pluginRoles: [{ pluginId: 'acme', localId: 'reviewer', role }], settingsOverrides: { 'plugin:acme/reviewer': { roleId: 'plugin:acme/reviewer', instructionsOverride: 'Reader guidance', engine: { agentTargetKey: 'agent:codex' } } } })).toMatchObject({ ok: true, selection: { name: role.name, instructions: 'Reader guidance', engine: { agentTargetKey: 'agent:codex' }, changedAt: 'settings' } });
    expect(role.instructions).toBe('Settings instructions');
  });

  it('distinguishes unknown/disabled roles from unavailable engines', () => {
    expect(resolveRoleSelectionV1({ roleId: 'unknown' })).toEqual({ ok: false, refusal: { code: 'role_target_unavailable', roleId: 'unknown' } });
    expect(resolveRoleSelectionV1({ roleId: 'disabled', settingsRoles: { disabled: { ...role, enabled: false } } })).toEqual({ ok: false, refusal: { code: 'role_target_unavailable', roleId: 'disabled' } });
    expect(resolveRoleSelectionV1({ roleId: 'ui', settingsRoles: { ui: role }, availableAgentTargetKeys: ['agent:codex'] })).toEqual({ ok: false, refusal: { code: 'target_unavailable', roleId: 'ui', agentTargetKey: 'agent:claude' } });
    expect(resolveRoleSelectionV1({ roleId: 'builder', defaultEngine: { agentTargetKey: 'agent:codex' }, availableAgentTargetKeys: ['agent:codex'] })).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: 'agent:codex' } } });
    expect(resolveRoleSelectionV1({ roleId: 'builder', availableAgentTargetKeys: [] })).toEqual({ ok: false, refusal: { code: 'target_unavailable', roleId: 'builder' } });
  });

  it('falls through unset fields without letting another role id override the selection', () => {
    expect(resolveRoleSelectionV1({
      roleId: 'ui', settingsRoles: { ui: role },
      settingsOverrides: { ui: { roleId: 'another-role', instructionsOverride: 'Wrong role' } },
      sessionRoles: { overrides: { ui: { roleId: 'ui', profileId: 'session-profile' } }, sessionRoles: {}, notes: '' },
      workflowRoles: [{ roleId: 'unrelated', engine: { agentTargetKey: 'agent:wrong' } }],
      runOverrides: [{ roleId: 'ui', engine: undefined }],
      availableProfileIds: ['session-profile'],
    })).toEqual({ ok: true, selection: { ...role, roleId: 'ui', profileId: 'session-profile', changedAt: 'session' } });
  });

  it('treats an inherited full snapshot as the session source and applies its local override', () => {
    expect(resolveRoleSelectionV1({
      roleId: 'ui', settingsRoles: { ui: role },
      sessionRoles: { overrides: { ui: { roleId: 'ui', instructionsOverride: '' } }, sessionRoles: { ui: { ...role, roleId: 'ui', name: 'Inherited UI', workspaceWrites: 'deny' } }, notes: '' },
      workflowRoles: [{ roleId: 'ui', secondOpinion: 'encouraged' }],
    })).toEqual({ ok: true, selection: { ...role, roleId: 'ui', name: 'Inherited UI', instructions: '', workspaceWrites: 'deny', secondOpinion: 'encouraged', changedAt: 'workflow' } });
  });

  it('rejects unknown executable fields recursively', () => {
    expect(RoleArtifactV1Schema.safeParse({ ...role, projectOverrides: {} }).success).toBe(false);
    expect(RoleArtifactV1Schema.safeParse({ ...role, engine: { ...role.engine, credential: 'secret' } }).success).toBe(false);
    expect(RoleArtifactV1Schema.safeParse({ ...role, runsAs: { kind: 'session', intent: 'plan' } }).success).toBe(false);
  });
});
