import { describe, expect, it } from 'vitest';

import * as selectionOwner from './workflowStepSelectionV1.js';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '../agents/executionTargetV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV2Schema } from '../connect/connectedServiceBindings.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

const agent = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const otherAgent = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const model = { v: 1 as const, ref: { agentTargetKey: 'happier.agent.claude/claude', providerConnectionId: null, modelId: 'model' }, updatedAt: 0 };

describe('workflow step selection', () => {
  it.each(['profile', 'connected'] as const)('omits absent inherited fields when only %s is supplied to a stored selection', field => {
    const connectedServices = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
      'external.auth/subscription': { source: 'connected', selection: 'profile', profileId: 'origin-account' },
    } });
    const { selection } = selectionOwner.resolveWorkflowStepSelectionV1({
      defaults: { engine: { agentTarget: agent } },
      roleSelection: { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(agent) },
        ...(field === 'profile' ? { defaultProfileId: 'origin-launch' } : { defaultConnectedServices: connectedServices }),
      },
    });
    expect(() => StrictJsonValueSchema.parse(selection)).not.toThrow();
    expect(selection).not.toHaveProperty(field === 'profile' ? 'connectedServices' : 'profileId');
    expect(selection).toMatchObject(field === 'profile' ? { profileId: 'origin-launch' } : { connectedServices });
  });

  it('accepts the full admitted parent binding shape and refuses direct Team custody with a typed error', () => {
    const brokered = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
      'external.auth/subscription': { source: 'team_resource', resourceId: 'team-pool', deliveryMode: 'brokered' },
    } });
    const roleSelection = { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(agent) },
      defaultConnectedServices: brokered };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: agent } }, roleSelection })
      .selection.connectedServices).toEqual(brokered);
    const direct = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
      'external.auth/subscription': { source: 'team_resource', resourceId: 'team-pool', deliveryMode: 'direct',
        disclosedMember: { service: { pluginId: 'external.auth', localId: 'subscription' }, accountId: 'member' } },
    } });
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: agent } },
      roleSelection: { ...roleSelection, defaultConnectedServices: direct } }))
      .toThrow(expect.objectContaining({ code: 'execution_run_child_choice_required', name: 'WorkflowStepSelectionErrorV1',
        refusal: { code: 'execution_run_child_choice_required' } }));
  });
  it('resolves a strict input-bound engine without mutating the supplied input', () => {
    const inputs = { choice: { engine: { agentTarget: otherAgent, modelSelection: null } } };
    const before = structuredClone(inputs);
    const defaults = { engine: { agentTarget: agent, modelSelection: model }, permissionMode: 'read-only' as const };
    const step = { engine: { kind: 'input' as const, name: 'choice', path: ['engine'] } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step, inputs }).selection)
      .toEqual({ agentTarget: otherAgent, modelSelection: null, permissionMode: 'read-only' });
    expect(inputs).toEqual(before);
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step, inputs: {} }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
  it('inherits the origin binding for its Agent across role and literal engines and preserves authored overrides', () => {
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'external.auth/subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'origin-profile' },
    } };
    const roleSelection = { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(agent) },
      defaultProfileId: 'origin-launch',
      defaultConnectedServices: connectedServices,
      availableAgentTargetKeys: [buildBackendTargetKeyV2(agent), buildBackendTargetKeyV2(otherAgent)] };
    const defaults = { engine: { role: 'judge' } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, roleSelection }).selection.connectedServices)
      .toEqual(connectedServices);
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, roleSelection }).selection.profileId)
      .toBe('origin-launch');
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, roleSelection, step: { profileId: null } }).selection.profileId)
      .toBeNull();
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, roleSelection, step: { connectedServices: null } }).selection.connectedServices)
      .toBeNull();
    const explicit = { v: 2 as const, bindingsByServiceId: { 'external.auth/subscription': { source: 'native' as const } } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, roleSelection, step: { connectedServices: explicit } }).selection.connectedServices)
      .toEqual(explicit);
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { role: 'second_opinion' } }, roleSelection }).selection.connectedServices)
      .toBeUndefined();
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: agent, modelSelection: model } }, roleSelection }).selection.connectedServices)
      .toEqual(connectedServices);
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: otherAgent } }, roleSelection }).selection.connectedServices)
      .toBeUndefined();
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: otherAgent } }, roleSelection }).selection.profileId)
      .toBeUndefined();
  });
  it.each([
    { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-bot' },
    { kind: 'agent' as const, identity: { pluginId: 'external.review', localId: 'assistant' } },
  ])('preserves the full explicit role engine target $identity.pluginId', (target) => {
    const agentTargetKey = buildBackendTargetKeyV2(target);
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'external.auth/subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'external-origin' },
    } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget: target } },
      roleSelection: { defaultEngine: { agentTargetKey }, defaultConnectedServices: connectedServices } }).selection.connectedServices)
      .toEqual(connectedServices);
    const resolved = selectionOwner.resolveWorkflowStepSelectionV1({ defaults: { engine: { role: 'workflow-reviewer' } },
      roleSelection: { settingsRoles: { 'workflow-reviewer': {
        roleId: 'workflow-reviewer', name: 'Reviewer', instructions: 'Review the work.',
        engine: { agentTargetKey, modelId: 'review-model' }, enabled: true,
        runsAs: { kind: 'background_run', intent: 'review' }, workspaceWrites: 'deny', secondOpinion: 'off',
      } } } });
    expect(resolved.selection.agentTarget).toEqual(target);
    expect(AgentExecutionTargetV1Schema.parse(resolved.selection.agentTarget)).toEqual(target);
    expect(resolved.selection.modelSelection?.ref.agentTargetKey).toBe(agentTargetKey);
  });

  it('projects unresolved role fields for authoring without weakening admission or inventing an Agent', () => {
    const defaults = { agentTarget: agent, modelSelection: model, permissionMode: 'read-only' as const,
      executionTarget: { kind: 'session' as const } };
    const step = { engine: { role: 'scout' }, conversation: { kind: 'from_step' as const,
      producer: { blockId: 'prior', scope: { kind: 'current' as const } } } };
    expect(selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step, purpose: 'authoring' }).selection)
      .toEqual({ permissionMode: 'read-only', conversation: step.conversation });
    expect(() => selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step })).toThrow(/target_unavailable/);
  });
  it('inherits per field, preserves explicit null and never mutates its inputs', () => {
    const defaults = { agentTarget: agent, profileId: 'default-profile', permissionMode: 'default' as const, modelSelection: model };
    const step = { profileId: null, connectedServices: null, permissionMode: 'read-only' as const };
    const before = structuredClone({ defaults, step });
    const { selection } = selectionOwner.resolveWorkflowStepSelectionV1({ defaults, step });
    expect(StrictJsonValueSchema.parse(selection)).toEqual({
      ...defaults, profileId: null, connectedServices: null, permissionMode: 'read-only',
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
