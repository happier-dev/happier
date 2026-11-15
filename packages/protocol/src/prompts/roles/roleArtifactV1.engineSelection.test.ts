import { describe, expect, it } from 'vitest';

import { readRoleEngineModelRefV1, RoleEngineV1Schema, roleEngineToSessionSelectionV1, sessionSelectionToRoleEngineV1 } from './roleArtifactV1.js';

const codex = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
const codexKey = 'agent:happier.agent.codex/codex';

describe('role engine ⇄ Session authoring selection', () => {
  it('reads stored role engines, including retained backend keys, as the canonical selection', () => {
    expect(roleEngineToSessionSelectionV1({ agentTargetKey: 'backend:codex', modelId: 'gpt-5.5', effort: 'high' })).toEqual({
      agentTarget: codex,
      modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: codexKey, providerConnectionId: null, modelId: 'gpt-5.5' } },
      sessionConfigOptionOverrides: { v: 1, updatedAt: 0, overrides: { reasoning_effort: { value: 'high', updatedAt: 0 } } },
    });
    expect(roleEngineToSessionSelectionV1({ agentTargetKey: codexKey })).toEqual({ agentTarget: codex, modelSelection: null,
      sessionConfigOptionOverrides: null });
    expect(roleEngineToSessionSelectionV1(undefined)).toEqual({});
  });

  it('writes the canonical role engine from a picker selection; no Agent means none', () => {
    expect(sessionSelectionToRoleEngineV1({ agentTarget: codex,
      modelSelection: { v: 1, updatedAt: 9, ref: { agentTargetKey: codexKey, providerConnectionId: null, modelId: 'gpt-5.5' } },
      sessionConfigOptionOverrides: { v: 1, updatedAt: 9, overrides: { reasoning_effort: { value: 'low', updatedAt: 9 }, other: { value: true, updatedAt: 9 } } },
    })).toEqual({ agentTargetKey: codexKey, modelId: 'gpt-5.5', effort: 'low' });
    expect(sessionSelectionToRoleEngineV1({ agentTarget: codex, modelSelection: null })).toEqual({ agentTargetKey: codexKey });
    expect(sessionSelectionToRoleEngineV1({})).toBeUndefined();
  });

  it('keeps a Provider-connected model\'s connection through the role engine both ways', () => {
    const connected = { agentTargetKey: codexKey, providerConnectionId: 'conn-team', modelId: 'muse-spark' };
    const engine = sessionSelectionToRoleEngineV1({ agentTarget: codex, modelSelection: { v: 1, updatedAt: 3, ref: connected } });
    expect(engine).toEqual({ agentTargetKey: codexKey, modelId: 'muse-spark', providerConnectionId: 'conn-team' });
    expect(RoleEngineV1Schema.parse(engine)).toEqual(engine);
    expect(roleEngineToSessionSelectionV1(engine).modelSelection?.ref).toEqual(connected);
  });

  it('resolves a role engine\'s model ref: its own connection, else the same Agent\'s inherited one, else native', () => {
    const inherited = { agentTargetKey: codexKey, providerConnectionId: 'conn-parent', modelId: 'x' };
    expect(readRoleEngineModelRefV1({ agentTargetKey: codexKey, modelId: 'm', providerConnectionId: 'conn-role' }, inherited))
      .toEqual({ agentTargetKey: codexKey, providerConnectionId: 'conn-role', modelId: 'm' });
    expect(readRoleEngineModelRefV1({ agentTargetKey: codexKey, modelId: 'm' }, inherited))
      .toEqual({ agentTargetKey: codexKey, providerConnectionId: 'conn-parent', modelId: 'm' });
    expect(readRoleEngineModelRefV1({ agentTargetKey: codexKey, modelId: 'm' }, { ...inherited, agentTargetKey: 'agent:happier.agent.claude/claude' }))
      .toEqual({ agentTargetKey: codexKey, providerConnectionId: null, modelId: 'm' });
    expect(readRoleEngineModelRefV1({ agentTargetKey: codexKey }, inherited)).toBeUndefined();
  });
});
