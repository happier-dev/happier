import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { listActionSpecs } from './actionSpecs.js';
import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';
import { SessionAgentTransitionRequestV1Schema } from '../sessions/agentTransition.js';

describe('same-Session Agent continuation Actions', () => {
  it('makes inspection and switching discoverable without substituting replay or Session creation', () => {
    for (const id of ['session.continuation.inspect', 'session.agent.transition']) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      expect(getActionRequiredServerFeatureId(id)).toBe('sessions.agentSwitching');
      const spec = listActionSpecs().find(row => row.id === id);
      expect(spec?.surfaces).toMatchObject({ ui: true, agent: true, mcp: true });
      expect(searchSerializedActionSpecsForSurface({
        query: id, surface: 'agent', isActionEnabled: candidate => candidate === id,
      }).map(row => row.id)).toContain(id);
    }
  });

  it('requires approval for a switch and keeps input and authority envelopes closed', () => {
    const transition = listActionSpecs().find(row => row.id === 'session.agent.transition');
    expect(transition?.safety).toBe('danger');
    expect(transition?.approval.result).toBe('required');
    expect(transition).toBeDefined();
    if (!transition) return;
    expect(resolveActionApprovalRouting({ actionId: transition.id, spec: transition,
      context: { surface: 'agent', authority: 'account_automation' },
    }).required).toBe(true);
    const input = {
      sessionId: 'session-1', expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'codex', modelId: 'target-model', sessionConfigOptionOverrides: {
        v: 1, updatedAt: 1, overrides: { reasoning: { updatedAt: 1, value: 'high' } },
      } },
      input: { text: 'Continue with the image', localId: 'first-input', meta: { displayText: 'Continue', permissionMode: 'default' } },
    };
    expect(SessionAgentTransitionRequestV1Schema.safeParse({ v: 1, ...input }).success).toBe(true);
    expect(transition?.inputSchema.safeParse(input).success).toBe(true);
    const { input: _firstInput, ...settingsOnly } = input;
    expect(transition?.inputSchema.safeParse(settingsOnly).success).toBe(true);
    for (const authority of [
      { callerPermissionMode: 'yolo' }, { inputAdmission: { producer: 'ui' } },
      { machineId: 'unrelated-machine' }, { causalPermissionAuthority: { admittedPermissionCeiling: 'yolo' } },
    ]) expect(transition?.inputSchema.safeParse({ ...input, ...authority }).success).toBe(false);
  });
});
