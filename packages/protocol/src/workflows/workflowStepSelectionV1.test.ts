import { describe, expect, it } from 'vitest';

import * as selectionOwner from './workflowStepSelectionV1.js';

const agent = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const otherAgent = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const model = { v: 1 as const, ref: { agentTargetKey: 'happier.agent.claude/claude', providerConnectionId: null, modelId: 'model' }, updatedAt: 0 };

describe('workflow step selection', () => {
  it('projects unresolved role fields for authoring without weakening admission or inventing an Agent', () => {
    const defaults = { agentTarget: agent, modelSelection: model, permissionMode: 'read-only' as const,
      executionTarget: { kind: 'session' as const } };
    const step = { engine: { role: 'scout' }, conversation: { kind: 'from_step' as const,
      producer: { blockId: 'prior', scope: { kind: 'current' as const } } } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step, purpose: 'authoring' }).selection)
      .toEqual({ permissionMode: 'read-only', conversation: step.conversation });
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step })).toThrow(/target_unavailable/);
  });
  it('exports the pure selection owner', () => {
    expect(selectionOwner).toHaveProperty('resolveWorkflowStepSelectionV1');
  });

  it('inherits per field, preserves explicit null and never mutates its inputs', () => {
    const defaults = { agentTarget: agent, profileId: 'default-profile', permissionMode: 'default' as const, modelSelection: model };
    const step = { profileId: null, permissionMode: 'read-only' as const };
    const before = structuredClone({ defaults, step });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step }).selection).toEqual({
      ...defaults, profileId: null, permissionMode: 'read-only',
    });
    expect({ defaults, step }).toEqual(before);
  });

  it('chooses an engine arm atomically while non-engine fields beat the resolved role', () => {
    const resolvedRole = {
      roleId: 'workflow-reviewer', name: 'Reviewer', instructions: 'Review the work.',
      engine: { agentTargetKey: 'happier.agent.codex/codex' }, enabled: true,
      runsAs: { kind: 'background_run' as const, intent: 'review' },
      profileId: 'role-profile', workspaceWrites: 'deny' as const, secondOpinion: 'off' as const,
    };
    const defaults = { engine: { agentTarget: agent, modelSelection: model }, profileId: 'workflow-profile' };
    // A settings-owned role must not collide with ORC's built-in reviewer.
    const roleSelection = { settingsRoles: { 'workflow-reviewer': resolvedRole } };
    const resolved = selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step: { engine: { role: 'workflow-reviewer' } }, roleSelection });
    expect(resolved.selection).toEqual({ agentTarget: otherAgent, profileId: 'workflow-profile' });
    expect(resolved.role).toEqual(resolvedRole);
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step: { engine: { agentTarget: otherAgent } } }).selection)
      .toEqual({ agentTarget: otherAgent, profileId: 'workflow-profile' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { role: 'workflow-reviewer' } }, roleSelection }).selection.profileId)
      .toBe('role-profile');
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { role: 'workflow-reviewer' } } }))
      .toThrow(/role_target_unavailable/);
  });

  it('preserves the existing flat selection contract during consumer migration', () => {
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { agentTarget: agent, modelSelection: model }, step: { modelSelection: null } }).selection)
      .toEqual({ agentTarget: agent, modelSelection: null });
  });

  it('inherits unset optional fields', () => {
    const defaults = { agentTarget: agent, profileId: 'profile' };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step: { agentTarget: undefined, profileId: undefined } }).selection)
      .toEqual(defaults);
  });

  it('resolves a bound Session without a run default', () => {
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { conversation: { kind: 'origin_session' } } }).executionTarget)
      .toEqual({ kind: 'session' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { conversation: { kind: 'existing_session', sessionId: 'session' } } }).executionTarget)
      .toEqual({ kind: 'session' });
  });

  it('resolves targets from explicit step, conversation, role, then run default', () => {
    const resolvedRole = {
      roleId: 'workflow-reviewer', name: 'Reviewer', instructions: '', engine: { agentTargetKey: 'happier.agent.claude/claude' }, enabled: true,
      runsAs: { kind: 'background_run' as const, intent: 'review' }, workspaceWrites: 'deny' as const, secondOpinion: 'off' as const,
    };
    const defaults = { engine: { role: 'workflow-reviewer' } };
    const base = { defaults, roleSelection: { settingsRoles: { 'workflow-reviewer': resolvedRole } }, runExecutionTarget: { kind: 'session' as const } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1(base).executionTarget).toEqual({ kind: 'detached_run' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ ...base, step: { conversation: { kind: 'origin_session' } } }).executionTarget)
      .toEqual({ kind: 'session' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ ...base, step: { executionTarget: { kind: 'session' } } }).executionTarget)
      .toEqual({ kind: 'session' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, runExecutionTarget: { kind: 'detached_run' } }).executionTarget)
      .toEqual({ kind: 'detached_run' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } }, producerExecutionTarget: { kind: 'detached_run' }, runExecutionTarget: { kind: 'session' } }).executionTarget)
      .toEqual({ kind: 'detached_run' });
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { executionTarget: { kind: 'detached_run' }, conversation: { kind: 'existing_session', sessionId: 's' } }, runExecutionTarget: { kind: 'session' } }))
      .toThrow(/invalid_input/);
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ ...base, step: { conversation: { kind: 'shared_run' } } }))
      .toThrow(/invalid_input/);
  });

  it('preserves explicit non-engine clears and does not merge model or effort across engine arms', () => {
    const defaults = { engine: { agentTarget: agent, modelSelection: model, effort: 'high' }, profileId: 'p', terminal: { mode: 'plain' as const } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step: { engine: { agentTarget: otherAgent }, terminal: null } }).selection)
      .toEqual({ agentTarget: otherAgent, profileId: 'p', terminal: null });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { engine: { agentTarget: otherAgent, effort: 'low' } } }).selection)
      .toEqual({ agentTarget: otherAgent, sessionConfigOptionOverrides: { v: 1, updatedAt: 0, overrides: { reasoning_effort: { value: 'low', updatedAt: 0 } } } });
  });

  it('resolves explicit and conversation targets without a role and reports typed contradictions', () => {
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { executionTarget: { kind: 'detached_run' } }, runExecutionTarget: { kind: 'session' } }).executionTarget)
      .toEqual({ kind: 'detached_run' });
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { conversation: { kind: 'origin_session' } }, runExecutionTarget: { kind: 'detached_run' } }).executionTarget)
      .toEqual({ kind: 'session' });
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { executionTarget: { kind: 'session' }, conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } }, producerExecutionTarget: { kind: 'detached_run' }, runExecutionTarget: { kind: 'session' } }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('refuses an unresolved from-step target instead of choosing a different class', () => {
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults: {}, step: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } }, runExecutionTarget: { kind: 'session' } }))
      .toThrow(/invalid_input/);
  });
});
