import { describe, expect, it } from 'vitest';

import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import {
  getActionSpec,
  isInternalActionId,
  isPluginProvenanceOnlyActionId,
  isPluginSurfaceExcludedActionId,
  listActionSpecs,
} from './actionSpecs.js';
import {
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
} from './actionApprovalPolicy.js';
import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  setActionApprovalOverride,
} from './actionSettings.js';
import { getDefaultActionToolExposureMode } from './actionSurfaceAvailability.js';
import { SESSION_BOARD_ACTION_IDS_V1 } from '../sessions/board/actionIds.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/board/actions.js';

describe('Session Board Action catalog rows', () => {
  it('publishes the four Board intents through the canonical Action id registry', () => {
    for (const actionId of SESSION_BOARD_ACTION_IDS_V1) {
      expect(ActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
      expect(ACTION_IDS).toContain(actionId);
    }
    expect(listActionSpecs().filter((spec) => spec.id.startsWith('session.board.')).map((spec) => spec.id).sort())
      .toEqual([...SESSION_BOARD_ACTION_IDS_V1].sort());
    // No Board message Action exists; interactive views reuse the canonical Session message Action.
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('board.'))).toBe(false);
  });

  it('binds each row to the Board schemas rather than a second Board input vocabulary', () => {
    for (const actionId of SESSION_BOARD_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema, actionId).toBe(SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[actionId]);
      expect(spec.outputSchema, actionId).toBe(SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1[actionId]);
      expect(spec.requiredAuthority, actionId).toBe('account_automation');
      expect(spec.executionPlacement, actionId).toBe('session');
      expect(spec.contextualDefaults, actionId).toEqual({ sessionId: 'current_session' });
      expect(isInternalActionId(actionId), actionId).toBe(false);
      expect(isPluginProvenanceOnlyActionId(actionId), actionId).toBe(false);
      expect(isPluginSurfaceExcludedActionId(actionId), actionId).toBe(false);
    }
  });

  it('advertises only the surfaces whose Board authority and policy path this lane declares', () => {
    for (const actionId of SESSION_BOARD_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces, actionId).toEqual({
        ui: true,
        voice: false,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        api: true,
        plugin: true,
      });
      expect(spec.bindings?.mcpToolName, actionId).toBeTruthy();
      // Native Agents receive the same canonical Action tools as MCP; exact-Home
      // feature admission and shared Action settings still gate advertisement.
      expect(getDefaultActionToolExposureMode(spec, 'agent'), actionId).toBe('direct');
    }
  });

  it('classifies the read and the consequential shared writes distinctly', () => {
    expect(getActionSpec('session.board.get').safety).toBe('safe');
    expect(getActionSpec('session.board.get').sideEffectClass).toBe('read');
    expect(getActionSpec('session.board.get').approval).toEqual({ result: 'required' });

    for (const actionId of ['session.board.item.upsert', 'session.board.layout.update'] as const) {
      expect(getActionSpec(actionId).safety, actionId).toBe('danger');
      expect(getActionSpec(actionId).sideEffectClass, actionId).toBe('write');
      expect(getActionSpec(actionId).approval, actionId).toEqual({ result: 'optional', flow: 'deferred' });
    }

    expect(getActionSpec('session.board.item.remove').safety).toBe('danger');
    expect(getActionSpec('session.board.item.remove').sideEffectClass).toBe('danger');
    expect(getActionSpec('session.board.item.remove').approval).toEqual({ result: 'optional', flow: 'deferred' });
  });

  it('derives shared-write approval defaults from safety and keeps them user-overridable', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('session.board.get')).toBe(false);
    for (const actionId of ['session.board.item.upsert', 'session.board.layout.update', 'session.board.item.remove'] as const) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId).toBe(true);
      const inherited = ActionsSettingsV1Schema.parse({ v: 1 });
      expect(isApprovalRequiredByActionsSettings(actionId, inherited, { surface: 'agent' }), actionId).toBe(true);
      const waived = setActionApprovalOverride({ settings: inherited, actionId, surface: 'agent', approvalRequired: false });
      expect(isApprovalRequiredByActionsSettings(actionId, waived, { surface: 'agent' }), actionId).toBe(false);
    }

    const inherit = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', inherit, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', inherit, { surface: 'ui' })).toBe(true);

    const skippedUi = setActionApprovalOverride({
      settings: inherit,
      actionId: 'session.board.item.remove',
      surface: 'ui',
      approvalRequired: false,
    });
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', skippedUi, { surface: 'ui' })).toBe(false);

    const restoredUi = setActionApprovalOverride({
      settings: skippedUi,
      actionId: 'session.board.item.remove',
      surface: 'ui',
      approvalRequired: null,
    });
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', restoredUi, { surface: 'ui' })).toBe(true);

    // Skip and require are edited through the shared Actions settings owner, not a Board preference.
    const skipped = setActionApprovalOverride({
      settings: inherit,
      actionId: 'session.board.item.remove',
      surface: 'agent',
      approvalRequired: false,
    });
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', skipped, { surface: 'agent' })).toBe(false);

    const restored = setActionApprovalOverride({
      settings: skipped,
      actionId: 'session.board.item.remove',
      surface: 'agent',
      approvalRequired: null,
    });
    expect(isApprovalRequiredByActionsSettings('session.board.item.remove', restored, { surface: 'agent' })).toBe(true);

    const required = setActionApprovalOverride({
      settings: inherit,
      actionId: 'session.board.item.upsert',
      surface: 'ui',
      approvalRequired: true,
    });
    expect(isApprovalRequiredByActionsSettings('session.board.item.upsert', required, { surface: 'ui' })).toBe(true);

    // Skipping confirmation never re-enables a disabled Action or a disabled surface.
    const disabledBase = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.board.item.remove': { enabled: false },
        'session.board.item.upsert': { disabledSurfaces: ['mcp'] },
      },
    });
    const disabled = setActionApprovalOverride({
      settings: setActionApprovalOverride({
        settings: disabledBase,
        actionId: 'session.board.item.remove',
        surface: 'agent',
        approvalRequired: false,
      }),
      actionId: 'session.board.item.upsert',
      surface: 'mcp',
      approvalRequired: false,
    });
    expect(isActionEnabledByActionsSettings('session.board.item.remove', disabled, { surface: 'agent' })).toBe(false);
    expect(isActionEnabledByActionsSettings('session.board.item.upsert', disabled, { surface: 'mcp' })).toBe(false);
    expect(isActionEnabledByActionsSettings('session.board.item.upsert', disabled, { surface: 'ui' })).toBe(true);
  });
});
