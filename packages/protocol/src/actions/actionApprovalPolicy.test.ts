import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from './actionIds.js';
import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import type { ActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import {
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
  resolveActionApprovalRouting,
} from './actionApprovalPolicy.js';

const EMPTY_SETTINGS: ActionsSettingsV1 = { v: 1, actions: {} as any };
type ApprovalContext = Pick<ActionExecutorContext, 'surface'>;

function approvalContext(surface: unknown): ApprovalContext {
  // Boundary-defensive fixture: persisted or legacy hosts can pass surfaces outside the current union.
  return { surface } as unknown as ApprovalContext;
}

async function loadRoutingResolver() {
  const module = await import('./actionApprovalPolicy.js') as Record<string, unknown>;
  const resolver = module.resolveActionApprovalRouting;
  expect(resolver).toEqual(expect.any(Function));
  if (typeof resolver !== 'function') return null;
  return resolver as (args: unknown) => unknown;
}

describe('isApprovalRequiredByActionsSettings', () => {
  it('returns true when the action override requires approvals for the given surface', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'review.start': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'mcp' } as any)).toBe(false);
  });

  it('allows requiring approvals for session.title.set when configured', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'session.title.set': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli', 'mcp'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'mcp' } as any)).toBe(true);
  });

  it('returns a non-required routing decision when settings do not require the surface', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'session.list': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(resolveActionApprovalRouting({
      actionId: 'session.list' as any,
      spec: getActionSpec('session.list'),
      settings,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: false,
      flow: 'blocking',
      result: 'required',
    });
  });

  it('routes required-result read actions as blocking when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.list' as any,
      spec: getActionSpec('session.list'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'blocking',
      result: 'required',
    });
  });

  it('routes no-result mutation actions as deferred when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.title.set' as any,
      spec: getActionSpec('session.title.set'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'deferred',
      result: 'none',
    });
  });

  it('routes optional-result actions through their explicit flow', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.message.send' as any,
      spec: getActionSpec('session.message.send'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'deferred',
      result: 'optional',
    });
  });

  it('never requires approval for approval decision actions', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'approval.request.decide' as any,
      spec: getActionSpec('approval.request.decide'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: false,
      flow: 'deferred',
      result: 'none',
    });
  });
});

describe('agent-initiated dangerous-action approval default (FINALIZATION-PLAN §4.2/§12.8/Δ1)', () => {
  it('requires approval for the dangerous subset when initiated through the agent surface, with no persisted settings', () => {
    for (const actionId of AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, approvalContext('agent')),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, approvalContext('session_agent')),
      ).toBe(true);
    }
  });

  it('fails closed for danger + agent-surfaced actions when the surface is missing or ambiguous', () => {
    const actionId = 'browser.automation.click';
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces.agent).toBe(true);

    for (const context of [
      undefined,
      null,
      approvalContext(null),
      approvalContext('session_agent'),
    ] as const) {
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
      ).toBe(true);
      expect(resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context,
      }).required).toBe(true);
    }
  });

  it('keeps the agent danger floor when a host passes a malformed settings object', () => {
    const actionId = 'browser.automation.click';
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces.agent).toBe(true);

    // Boundary-defensive fixture: legacy hosts can still cast partially parsed settings.
    const settingsWithoutActions = { v: 1 } as unknown as ActionsSettingsV1;

    expect(
      isApprovalRequiredByActionsSettings(actionId, settingsWithoutActions, approvalContext('agent')),
    ).toBe(true);
  });

  it('honors persisted approval overrides for legacy ambiguous surface strings', () => {
    const actionId = 'browser.automation.snapshot' satisfies ActionId;
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(false);

    const settings = {
      v: 1,
      actions: {
        [actionId]: {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['session_agent'],
        },
      },
    } as unknown as ActionsSettingsV1;

    expect(
      isApprovalRequiredByActionsSettings(actionId, settings, approvalContext('session_agent')),
    ).toBe(true);
  });

  it('never prompts user-initiated (ui) or other surfaces for the dangerous subset by default', () => {
    for (const actionId of AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS) {
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'ui' } as any)).toBe(false);
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'mcp' } as any)).toBe(false);
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'cli' } as any)).toBe(false);
    }
  });

  it('floors the egress-bearing annotation captures but not the non-egress annotation edits', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.captureRegion' as any)).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.captureElement' as any)).toBe(true);
    // start/cancel + comment/stroke/style intent are local UI-state edits with no page egress.
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.start' as any)).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.cancel' as any)).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.attachComment' as any)).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.attachStroke' as any)).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.attachStyleIntent' as any)).toBe(false);
  });

  it('floors browser attach actions that egress captured context or recordings to the composer/agent turn', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.attachToComposer' as any)).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.attachToAgentTurn' as any)).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.recording.attachToComposer' as any)).toBe(true);

    expect(
      isApprovalRequiredByActionsSettings('browser.context.attachToComposer' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('browser.context.attachToAgentTurn' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('browser.recording.attachToComposer' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
  });

  it('keeps browser attach actions unprompted by default for user-initiated UI invocations', () => {
    expect(
      isApprovalRequiredByActionsSettings('browser.context.attachToComposer' as any, EMPTY_SETTINGS, { surface: 'ui' } as any),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings('browser.context.attachToAgentTurn' as any, EMPTY_SETTINGS, { surface: 'ui' } as any),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings('browser.recording.attachToComposer' as any, EMPTY_SETTINGS, { surface: 'ui' } as any),
    ).toBe(false);
  });

  it('does not require approval for read-only non-egress runtime actions on the agent surface', () => {
    // Read-only browser verbs (no navigation/input/mutation/egress) stay un-floored for the agent.
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.automation.snapshot' as any)).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings('browser.automation.snapshot' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.view.focus' as any)).toBe(false);
  });

  it('routes the agent dangerous default as a blocking approval through resolveActionApprovalRouting', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      settings: EMPTY_SETTINGS,
      context: { surface: 'agent' } as any,
    });
    expect(decision.required).toBe(true);
    expect(decision.flow).toBe('blocking');
    expect(decision.result).toBe('required');
  });

  it('keeps user-initiated devtools eval un-prompted through resolveActionApprovalRouting', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui' } as any,
    });
    expect(decision.required).toBe(false);
  });

  it('fails safe to the agent danger floor when the approval signal is unwired (no requiredByPolicy, no settings)', () => {
    // Simulates a host that never wired `isActionApprovalRequired` AND passed no settings.
    // The resolver must NOT fall open to "no approval" for the dangerous agent-initiated subset.
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      context: { surface: 'agent' } as any,
    });
    expect(decision.required).toBe(true);
    expect(decision.flow).toBe('blocking');
    expect(decision.result).toBe('required');
  });

  it('does not require approval for read-only actions when the signal is unwired', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.automation.snapshot' as any,
      spec: getActionSpec('browser.automation.snapshot' as any),
      context: { surface: 'agent' } as any,
    });
    expect(decision.required).toBe(false);
  });

  it('does not fail safe on non-agent surfaces when the signal is unwired', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      context: { surface: 'ui' } as any,
    });
    expect(decision.required).toBe(false);
  });

  it('honors an explicit requiredByPolicy=false even for the dangerous agent subset (wired host owns the decision)', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      requiredByPolicy: false,
      context: { surface: 'agent' } as any,
    });
    expect(decision.required).toBe(false);
  });

  it('preserves additive persisted approval-required surfaces alongside the agent default', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'browser.diagnostics.eval': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['ui'],
        },
      } as any,
    };
    // Persisted override adds `ui`; the agent default still holds on `agent`.
    expect(isApprovalRequiredByActionsSettings('browser.diagnostics.eval' as any, settings, { surface: 'ui' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('browser.diagnostics.eval' as any, settings, { surface: 'agent' } as any)).toBe(true);
  });
});

describe('agent approval floor is derived from the danger SSOT (CON-1..3/6)', () => {
  // The agent-browser consent hole: every mutating/navigating browser verb surfaced on the agent
  // must reach human consent before MANAGED-CHROMIUM makes the daemon sidecar reachable headless.
  const FLOORED_BROWSER_NAV_INPUT_VERBS = [
    // browser_control navigation + lifecycle
    'browser.navigate',
    'browser.reload',
    'browser.goBack',
    'browser.goForward',
    'browser.stop',
    'browser.session.create',
    'browser.session.close',
    'browser.view.open',
    'browser.view.close',
    // browser_automation navigation + input + mutation
    'browser.automation.navigate',
    'browser.automation.reload',
    'browser.automation.goBack',
    'browser.automation.goForward',
    'browser.automation.click',
    'browser.automation.tap',
    'browser.automation.type',
    'browser.automation.press',
    'browser.automation.scroll',
    'browser.automation.hover',
    'browser.automation.focus',
    'browser.automation.select',
    'browser.automation.setValue',
  ] as const;

  // Read-only verbs (no navigation/input/mutation/egress) stay agent-allowed without consent.
  const UNFLOORED_READONLY_VERBS = [
    'browser.automation.status',
    'browser.automation.snapshot',
    'browser.automation.semanticSnapshot',
    'browser.automation.queryElements',
    'browser.automation.waitFor',
    'browser.automation.timeline.get',
    'browser.automation.cancelActive',
    'browser.view.focus',
    'browser.target.set',
  ] as const;

  it('floors every mutating/navigating browser verb on the agent surface (CON-2)', () => {
    for (const actionId of FLOORED_BROWSER_NAV_INPUT_VERBS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId as any)).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
      ).toBe(true);
      // The danger classification is the single source: each floored verb is `safety: 'danger'`.
      expect(getActionSpec(actionId as any).safety).toBe('danger');
    }
  });

  it('keeps read-only browser verbs un-floored on the agent surface (CON-2)', () => {
    for (const actionId of UNFLOORED_READONLY_VERBS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId as any)).toBe(false);
      expect(
        isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
      ).toBe(false);
      expect(getActionSpec(actionId as any).safety).toBe('safe');
    }
  });

  it('floors launcher.start, which is danger + agent (CON-3)', () => {
    expect(getActionSpec('localServices.launcher.start' as any).safety).toBe('danger');
    expect(isAgentInitiatedApprovalRequiredByDefault('localServices.launcher.start' as any)).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('localServices.launcher.start' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
  });

  it('floors publicPreview.create so the client acknowledgement is not the only gate (L3-3)', () => {
    expect(getActionSpec('localServices.publicPreview.create' as any).safety).toBe('danger');
    expect(isAgentInitiatedApprovalRequiredByDefault('localServices.publicPreview.create' as any)).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('localServices.publicPreview.create' as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('localServices.publicPreview.create' as any, EMPTY_SETTINGS, { surface: 'ui' } as any),
    ).toBe(false);
  });

  it('floors prompt_doc.update, the live QA dangerous agent fixture (LIVE-1)', () => {
    const spec = getActionSpec('prompt_doc.update');
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces.agent).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('prompt_doc.update')).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('prompt_doc.update', EMPTY_SETTINGS, { surface: 'agent' } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('prompt_doc.update', EMPTY_SETTINGS, { surface: 'ui' } as any),
    ).toBe(false);
    expect(resolveActionApprovalRouting({
      actionId: 'prompt_doc.update',
      spec,
      settings: EMPTY_SETTINGS,
      context: { surface: 'agent' } as any,
    }).required).toBe(true);
  });

  it('SUBSET invariant: every danger ∩ agent action is floored (CON-1/6, never equality)', () => {
    const dangerAgentIds = ACTION_IDS.filter((id) => {
      const spec = getActionSpec(id);
      return spec.safety === 'danger' && spec.surfaces.agent === true;
    });
    expect(dangerAgentIds.length).toBeGreaterThan(0);
    for (const id of dangerAgentIds) {
      expect(isAgentInitiatedApprovalRequiredByDefault(id)).toBe(true);
    }
    // The floor legitimately exceeds {danger ∩ agent} via the non-danger egress floor
    // (context captures + copyUrl). Assert at least one such non-danger egress id is floored so the
    // invariant is a strict subset (⊊), never equality.
    const nonDangerFloored = AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS.filter(
      (id) => getActionSpec(id).safety !== 'danger',
    );
    expect(nonDangerFloored.length).toBeGreaterThan(0);
  });

  it('floors the non-danger egress-sensitive leaves (context captures + public preview reads)', () => {
    for (const id of [
      'browser.context.capturePage',
      'browser.context.captureScreenshot',
      'browser.context.captureSelectedElement',
      'browser.context.captureNetworkSummary',
      'browser.context.captureConsoleSummary',
      'browser.context.annotation.captureRegion',
      'browser.context.annotation.captureElement',
      'localServices.publicPreview.status',
      'localServices.publicPreview.copyUrl',
    ]) {
      expect(getActionSpec(id as any).safety).toBe('safe');
      expect(isAgentInitiatedApprovalRequiredByDefault(id as any)).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(id as any, EMPTY_SETTINGS, { surface: 'agent' } as any),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(id as any, EMPTY_SETTINGS, { surface: 'ui' } as any),
      ).toBe(false);
    }
  });

  it('user-initiated (ui) browser navigation never prompts even though floored for agents', () => {
    for (const actionId of FLOORED_BROWSER_NAV_INPUT_VERBS) {
      expect(isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, { surface: 'ui' } as any)).toBe(false);
    }
  });
});
