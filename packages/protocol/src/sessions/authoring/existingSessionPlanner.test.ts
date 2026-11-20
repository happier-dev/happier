import { SESSION_CONFIG_OPTION_SET_ACTION_ID_V1 } from '../../actions/actionIds.js';
import { describe, expect, it } from 'vitest';
import { buildConfiguredAcpAgentSelectionV1 } from '../../agents/executionTargetV1.js';
import { formatLegacyConfiguredAcpAgentId } from '../../backends/targets/compat/customAcp.js';
import {
  buildExistingSessionAgentTransitionActionInput, buildExistingSessionCapabilitiesActionInput,
  buildExistingSessionConfigOptionActionInput, buildExistingSessionConnectedServicesAuthActionInput,
  buildExistingSessionMessageActionInput, buildExistingSessionModeActionInput,
  buildExistingSessionModelActionInput, buildExistingSessionPermissionModeActionInput,
} from './existingSessionActionInputs.js';
import { planExistingSessionChanges } from './existingSessionPlanner.js';

const targets = [
  { address: { serverId: 'home-a', sessionId: 's1' }, agentId: 'happier.agent.claude/claude', machineId: 'm1' },
  { address: { serverId: 'home-a', sessionId: 's2' }, agentId: 'happier.agent.codex/codex', machineId: 'm1' },
  { address: { serverId: 'home-b', sessionId: 's1' }, agentId: 'happier.agent.gemini/gemini', machineId: 'm2' },
];

describe('existing Session change planner', () => {
  it('adds only the target selector to the same operands as single-Session authoring', () => {
    const current = { ...targets[0]!, availableModeIds: ['code'],
      sessionConfigOptionOverrides: { v: 1 as const, updatedAt: 1, overrides: { effort: { value: 'high', updatedAt: 1 } } } };
    const { sessionId, serverId } = current.address;
    const bindings = { v: 2 as const, bindingsByServiceId: {} };
    const skill = { kind: 'skill', id: 'review', state: 'off' } as const;
    const mcp = { kind: 'mcp', id: 'checks', state: 'on' } as const;
    const plan = planExistingSessionChanges({ acpSessionModeId: 'default', sessionConfigOptionOverrides: null,
      connectedServices: bindings, capabilityDeltas: [skill, mcp], permissionMode: 'read-only',
      modelSelection: null }, [current], 'hello', 'original-input');
    expect(plan.stages.map(stage => ({ ...stage.input, sessionId }))).toEqual([
      buildExistingSessionModeActionInput({ sessionId, modeId: 'default', availableModeIds: ['code'] }),
      buildExistingSessionConfigOptionActionInput({ sessionId, configId: 'effort', valueId: null }),
      buildExistingSessionConnectedServicesAuthActionInput({ sessionId, serverId, machineId: current.machineId, agentId: current.agentId, bindings }),
      buildExistingSessionCapabilitiesActionInput({ sessionId, ...skill }),
      buildExistingSessionCapabilitiesActionInput({ sessionId, ...mcp }),
      buildExistingSessionPermissionModeActionInput({ sessionId, permissionMode: 'read-only' }),
      buildExistingSessionModelActionInput({ sessionId, modelId: 'default', providerConnectionId: null }),
      buildExistingSessionMessageActionInput({ sessionId, message: 'hello', localId: 'original-input', permissionModeOverride: 'read-only',
        modelOverride: null, providerConnectionId: null }),
    ]);
    const engine = buildConfiguredAcpAgentSelectionV1('review-bot');
    const switchPlan = planExistingSessionChanges({ agentTarget: engine.agentTarget }, [current]);
    expect(switchPlan.stages.map(stage => ({ ...stage.input, sessionId }))).toEqual([
      buildExistingSessionAgentTransitionActionInput({ sessionId, expectedCurrentAgentId: current.agentId,
        selection: { v: 1, agentId: formatLegacyConfiguredAcpAgentId('review-bot') } }),
    ]);
  });

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
    const addresses = targets.map(t => t.address);
    expect(plan.stages).toEqual([
      { actionId: 'session.permission_mode.set', input: { permissionMode: 'read-only' }, targets: addresses },
      { actionId: 'session.model.set', input: { modelId: 'model', providerConnectionId: 'provider' }, targets: addresses },
      { actionId: 'session.message.send', input: {
        message: 'hello', permissionModeOverride: 'read-only', modelOverride: 'model', providerConnectionId: 'provider',
      }, targets: addresses },
    ]);
  });

  it('orders mode/config before account auth, capabilities and message; groups auth by Agent and Machine', () => {
    const plan = planExistingSessionChanges({ acpSessionModeId: 'plan', sessionConfigOptionOverrides: {
      v: 1, updatedAt: 1, overrides: { effort: { value: 'high', updatedAt: 1 } },
    }, connectedServices: { v: 2, bindingsByServiceId: {} }, capabilityDeltas: [{ kind: 'skill', id: 'skill', state: 'on' }] }, targets, 'hello');
    expect(plan.stages.map(s => s.actionId)).toEqual([
      'session.mode.set', SESSION_CONFIG_OPTION_SET_ACTION_ID_V1,
      'session.connected_services_auth.set', 'session.connected_services_auth.set', 'session.connected_services_auth.set',
      'session.capabilities.set', 'session.message.send',
    ]);
    expect(plan.stages.filter(s => s.actionId === 'session.connected_services_auth.set').map(s => s.input))
      .toEqual(targets.map(target => expect.objectContaining({ machineId: target.machineId,
        routing: expect.objectContaining({ agentId: target.agentId }) })));
  });

  it('supports settings only, clears model explicitly, and reports unsupported authoring fields', () => {
    const plan = planExistingSessionChanges({ permissionMode: 'default', modelSelection: null, transcriptStorage: 'direct' }, targets);
    expect(plan.stages.map(s => s.actionId)).toEqual(['session.permission_mode.set', 'session.model.set']);
    expect(plan.stages[1].input).toMatchObject({ modelId: 'default', providerConnectionId: null });
    expect(plan.unsupportedFields).toEqual([{ field: 'transcriptStorage', reason: 'new_sessions_only' }]);
    expect(planExistingSessionChanges({}, targets).stages).toEqual([]);
  });

  it('enables a Skill and disables an MCP server on both targets without writing their other overrides', () => {
    const selected = targets.slice(0, 2);
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
      permissionMode: 'read-only',
      connectedServices: { v: 2, bindingsByServiceId: {} }, capabilityDeltas: [{ kind: 'skill', id: 'skill', state: 'on' }],
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'happier.agent.codex/codex', modelId: 'model', providerConnectionId: 'provider' } },
    }, targets, 'hello');
    expect(plan.stages.map(stage => stage.actionId)).toEqual([
      'session.agent.transition', 'session.agent.transition',
      'session.connected_services_auth.set', 'session.connected_services_auth.set',
      'session.capabilities.set', 'session.permission_mode.set', 'session.model.set', 'session.message.send',
    ]);
    const transitions = plan.stages.filter(stage => stage.actionId === 'session.agent.transition');
    expect(transitions.map(stage => stage.input.expectedCurrentAgentId)).toEqual([targets[0].agentId, targets[2].agentId]);
    expect(transitions.every(stage => !('input' in stage.input))).toBe(true);
    expect(transitions[0].input.selection).toEqual({ v: 1, agentId: 'happier.agent.codex/codex',
      modelSelection: { agentTargetKey: 'happier.agent.codex/codex', modelId: 'model', providerConnectionId: 'provider' } });
    expect(plan.stages.filter(stage => stage.actionId === 'session.connected_services_auth.set').map(stage => stage.input))
      .toEqual(['m1', 'm2'].map(machineId => expect.objectContaining({ machineId,
        routing: expect.objectContaining({ agentId: 'happier.agent.codex/codex' }) })));
    expect(plan.stages.find(stage => stage.actionId === 'session.permission_mode.set')).toMatchObject({
      input: { permissionMode: 'read-only' }, targets: targets.map(target => target.address),
    });
    expect(plan.stages.find(stage => stage.actionId === 'session.model.set')).toMatchObject({
      input: { modelId: 'model', providerConnectionId: 'provider' }, targets: [targets[1].address],
    });
  });

  it('uses the message owner clear operand for an explicit null model selection', () => {
    const plan = planExistingSessionChanges({ modelSelection: null }, targets, 'hello');
    expect(plan.stages.at(-1)?.input).toEqual({ message: 'hello', modelOverride: null, providerConnectionId: null });
  });

  it('applies mode/config through the transition selection for switched targets and Actions for unchanged targets', () => {
    const unchanged = targets[1];
    const config = { v: 1 as const, updatedAt: 1, overrides: { effort: { value: 'high', updatedAt: 1 } } };
    const plan = planExistingSessionChanges({ agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      acpSessionModeId: 'plan', sessionConfigOptionOverrides: config,
    }, [unchanged, targets[0], targets[2]]);
    expect(plan.stages.map(stage => stage.actionId)).toEqual(['session.mode.set', SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, 'session.agent.transition', 'session.agent.transition']);
    expect(plan.stages[0].targets).toEqual([unchanged.address]);
    expect(plan.stages[2].input.selection).toMatchObject({ acpSessionModeId: 'plan', sessionConfigOptionOverrides: config });
    expect(plan.stages.some(stage => stage.actionId === 'session.message.send')).toBe(false);
  });
});
