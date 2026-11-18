import { describe, expect, it } from 'vitest';
import { buildConfiguredAcpAgentSelectionV1 } from '../../agents/executionTargetV1.js';
import { planExistingSessionChanges, filterExistingSessionStageTargets } from './existingSessionPlanner.js';

const targets = [
  { address: { serverId: 'home-a', sessionId: 's1' }, agentId: 'happier.agent.claude/claude', machineId: 'm1' },
  { address: { serverId: 'home-a', sessionId: 's2' }, agentId: 'happier.agent.codex/codex', machineId: 'm1' },
  { address: { serverId: 'home-b', sessionId: 's1' }, agentId: 'happier.agent.gemini/gemini', machineId: 'm2' },
];

describe('existing Session change planner', () => {
  it('sends without transitioning the current configured engine and addresses other engines by definition', () => {
    const selected = buildConfiguredAcpAgentSelectionV1('review-bot');
    const other = buildConfiguredAcpAgentSelectionV1('build-bot');
    const current = { ...targets[0], agentId: selected.agentId, agentTarget: selected.agentTarget };
    const switching = { ...targets[1], agentId: other.agentId, agentTarget: other.agentTarget };
    expect(planExistingSessionChanges({ agentTarget: selected.agentTarget }, [current, switching, targets[2]], 'hello')).toEqual({
      skippedTargets: [], unsupportedFields: [], stages: [
        { actionId: 'session.agent.transition', targets: [switching.address], input: {
          expectedCurrentAgentId: 'acp:build-bot', selection: { v: 1, agentId: 'acp:review-bot' },
        } },
        { actionId: 'session.agent.transition', targets: [targets[2].address], input: {
          expectedCurrentAgentId: targets[2].agentId, selection: { v: 1, agentId: 'acp:review-bot' },
        } },
        { actionId: 'session.message.send', targets: [current.address, switching.address, targets[2].address], input: { message: 'hello' } },
      ],
    });
    expect(planExistingSessionChanges({ agentTarget: selected.agentTarget }, [current]).stages).toEqual([]);
  });

  it('identifies the exact configured source when switching back to a bundled engine', () => {
    const current = buildConfiguredAcpAgentSelectionV1('review-bot');
    const plan = planExistingSessionChanges({ agentTarget: { kind: 'agent',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    } }, [{ ...targets[0], agentId: current.agentId, agentTarget: current.agentTarget }]);
    expect(plan.stages).toMatchObject([{ actionId: 'session.agent.transition', input: {
      expectedCurrentAgentId: 'acp:review-bot', selection: { agentId: 'happier.agent.codex/codex' },
    } }]);
  });

  it('groups message overrides without losing model-provider identity or cross-Home addresses', () => {
    const plan = planExistingSessionChanges({ permissionMode: 'read-only', modelSelection: {
      v: 1, updatedAt: 1, ref: { agentTargetKey: 'claude', providerConnectionId: 'provider', modelId: 'model' },
    } }, targets, 'hello');
    expect(plan.stages).toEqual([{ actionId: 'session.message.send', input: {
      message: 'hello', permissionModeOverride: 'read-only', modelOverride: 'model', providerConnectionId: 'provider',
    }, targets: targets.map(t => t.address) }]);
  });

  it('orders mode/config before account auth, capabilities and message; groups auth by Agent and Machine', () => {
    const plan = planExistingSessionChanges({ acpSessionModeId: 'plan', sessionConfigOptionOverrides: {
      v: 1, updatedAt: 1, overrides: { effort: { value: 'high', updatedAt: 1 } },
    }, connectedServices: { v: 2, bindingsByServiceId: {} }, capabilityDeltas: [{ kind: 'skill', id: 'skill', state: 'on' }] }, targets, 'hello');
    expect(plan.stages.map(s => s.actionId)).toEqual([
      'session.mode.set', 'session.config_option.set',
      'session.connected_services_auth.set', 'session.connected_services_auth.set', 'session.connected_services_auth.set',
      'session.capabilities.set', 'session.message.send',
    ]);
    expect(plan.stages.filter(s => s.actionId === 'session.connected_services_auth.set').map(s => [s.input.agentId, s.input.machineId]))
      .toEqual(targets.map(target => [target.agentId, target.machineId]));
  });

  it('supports settings only, clears model explicitly, and reports unsupported authoring fields', () => {
    const plan = planExistingSessionChanges({ permissionMode: 'default', modelSelection: null, transcriptStorage: 'direct' }, targets);
    expect(plan.stages.map(s => s.actionId)).toEqual(['session.permission_mode.set', 'session.model.set']);
    expect(plan.stages[1].input).toMatchObject({ modelId: 'default', providerConnectionId: null });
    expect(plan.unsupportedFields).toEqual([{ field: 'transcriptStorage', reason: 'new_sessions_only' }]);
    expect(planExistingSessionChanges({}, targets).stages).toEqual([]);
  });

  it('excludes failures from later stages using the full Session address', () => {
    const stage = planExistingSessionChanges({}, targets, 'hello').stages[0];
    const next = filterExistingSessionStageTargets(stage, [{ ...targets[0].address, actionId: 'session.message.send', ok: false }, { ...targets[2].address, actionId: 'session.message.send', ok: true }]);
    expect(next.targets).toEqual([targets[1].address, targets[2].address]);
    expect(stage.targets).toHaveLength(3);
  });

  it('drops domain-rejected and partially-applied transitions even when Action transport succeeded', () => {
    const stage = planExistingSessionChanges({}, targets, 'hello').stages[0];
    expect(filterExistingSessionStageTargets(stage, [
      { ...targets[0].address, actionId: 'session.agent.transition', ok: true, result: { type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' } },
      { ...targets[1].address, actionId: 'session.agent.transition', ok: true, result: { type: 'partially_applied', localId: 'transition', applied: 'source_stopped', code: 'context_unavailable' } },
      { ...targets[2].address, actionId: 'session.agent.transition', ok: true, result: { type: 'accepted', localId: 'transition' } },
    ]).targets).toEqual([targets[2].address]);
  });

  it('enables a Skill and disables an MCP server on both targets without writing their other overrides', () => {
    const selected = [
      { ...targets[0], capabilitySelection: { skills: { v: 1 as const, forceIncludeSkillIds: ['other-skill'], forceExcludeSkillIds: ['review'], excludeNativeSkillNames: [] } } },
      { ...targets[1], capabilitySelection: { mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['linear', 'other-server'], forceExcludeServerIds: [] } } },
    ];
    const plan = planExistingSessionChanges({ capabilityDeltas: [
      { kind: 'skill', id: 'review', state: 'on' },
      { kind: 'mcp_server', id: 'linear', state: 'off' },
    ] }, selected);
    expect(plan.stages).toEqual([
      { actionId: 'session.capabilities.set', input: { kind: 'skill', id: 'review', state: 'on' }, targets: selected.map(target => target.address) },
      { actionId: 'session.capabilities.set', input: { kind: 'mcp_server', id: 'linear', state: 'off' }, targets: selected.map(target => target.address) },
    ]);
  });

  it('switches mixed Agents without delivering until account auth and capabilities have applied', () => {
    const plan = planExistingSessionChanges({ agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, capabilityDeltas: [{ kind: 'skill', id: 'skill', state: 'on' }],
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'happier.agent.codex/codex', modelId: 'model', providerConnectionId: 'provider' } },
    }, targets, 'hello');
    expect(plan.stages.map(stage => stage.actionId)).toEqual([
      'session.agent.transition', 'session.agent.transition',
      'session.connected_services_auth.set', 'session.connected_services_auth.set',
      'session.capabilities.set', 'session.message.send',
    ]);
    const transitions = plan.stages.filter(stage => stage.actionId === 'session.agent.transition');
    expect(transitions.map(stage => stage.input.expectedCurrentAgentId)).toEqual([targets[0].agentId, targets[2].agentId]);
    expect(transitions.every(stage => !('input' in stage.input))).toBe(true);
    expect(transitions[0].input.selection).toEqual({ v: 1, agentId: 'happier.agent.codex/codex',
      modelSelection: { agentTargetKey: 'happier.agent.codex/codex', modelId: 'model', providerConnectionId: 'provider' } });
    expect(plan.stages.filter(stage => stage.actionId === 'session.connected_services_auth.set').map(stage => stage.input.agentId))
      .toEqual(['happier.agent.codex/codex', 'happier.agent.codex/codex']);
  });

  it('uses the message owner clear operand for an explicit null model selection', () => {
    const plan = planExistingSessionChanges({ modelSelection: null }, targets, 'hello');
    expect(plan.stages[0].input).toEqual({ message: 'hello', modelOverride: null, providerConnectionId: null });
  });

  it('applies mode/config through the transition selection for switched targets and Actions for unchanged targets', () => {
    const unchanged = targets[1];
    const config = { v: 1 as const, updatedAt: 1, overrides: { effort: { value: 'high', updatedAt: 1 } } };
    const plan = planExistingSessionChanges({ agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      acpSessionModeId: 'plan', sessionConfigOptionOverrides: config,
    }, [unchanged, targets[0], targets[2]]);
    expect(plan.stages.map(stage => stage.actionId)).toEqual(['session.mode.set', 'session.config_option.set', 'session.agent.transition', 'session.agent.transition']);
    expect(plan.stages[0].targets).toEqual([unchanged.address]);
    expect(plan.stages[2].input.selection).toMatchObject({ acpSessionModeId: 'plan', sessionConfigOptionOverrides: config });
    expect(plan.stages.some(stage => stage.actionId === 'session.message.send')).toBe(false);
  });
});
