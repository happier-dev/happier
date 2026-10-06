import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from './actionIds.js';
import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import { normalizeActionsSettingsV1, type ActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import {
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
  resolveActionApprovalRouting,
} from './actionApprovalPolicy.js';

const EMPTY_SETTINGS: ActionsSettingsV1 = { v: 1, actions: {} as any };
// Approved FIN 03 §5.4/§5.7 exception; every other danger row retains its floor.
const DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL = 'session.trigger.remove' satisfies ActionId;
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
  it('returns durable CLI approvals while keeping Agent and MCP decision waiters blocking', () => {
    for (const actionId of ['connectedServices.pools.create', 'artifact.update'] as const) {
      const spec = getActionSpec(actionId);
      for (const authority of ['present_user', 'account_automation'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
          context: { surface: 'cli', authority } })).toEqual({ required: true, flow: 'deferred', result: 'required' });
      }
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
          context: { surface, authority: 'account_automation' } })).toEqual({ required: true, flow: 'blocking', result: 'required' });
      }
    }
  });

  it('requires agent and MCP permission-answer approval by default and honors explicit waivers', () => {
    const actionId = 'session.permission.respond';
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context }).required).toBe(true);
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context)).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(false);
      const required = normalizeActionsSettingsV1({ ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
      });
      expect(isApprovalRequiredByActionsSettings(actionId, required, context)).toBe(true);
    }
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'ui', authority: 'present_user' })).toBe(false);
  });
  it('keeps consequential widget and shared Board UI edits in the configurable policy without flooring personal Home or Companion edits', () => {
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    const shared = { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
    const personal = { ...shared, owner: { kind: 'home' } } as const;
    const edits = [
      { actionId: 'session.board.layout.update', input: {} },
      { actionId: 'session.board.item.upsert', input: {} },
      { actionId: 'widgets.definition.update', input: {} },
      { actionId: 'widgets.definition.delete', input: {} },
      { actionId: 'widgets.snapshot.post', input: {} },
      { actionId: 'widgets.instance.frame.set', input: { ref: { surface: shared, instanceId: 'copy' } } },
      { actionId: 'widgets.instance.move', input: { ref: { surface: personal, instanceId: 'copy' }, to: { surface: shared, index: 0 } } },
    ] as const;
    for (const edit of edits) {
      const args = { ...edit, spec: getActionSpec(edit.actionId), context, settings: normalizeActionsSettingsV1({ v: 1 }) };
      expect.soft(resolveActionApprovalRouting(args).required, edit.actionId).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [edit.actionId]: ['ui'] } });
      expect(resolveActionApprovalRouting({ ...args, settings: waived }).required, edit.actionId).toBe(false);
    }
    for (const owner of [{ kind: 'home' }, { kind: 'companion', sessionId: 'shared' }] as const) {
      expect(resolveActionApprovalRouting({ actionId: 'widgets.instance.frame.set', spec: getActionSpec('widgets.instance.frame.set'),
        input: { ref: { surface: { ...shared, owner }, instanceId: 'copy' } }, context,
        defaultSafety: 'safe', settings: normalizeActionsSettingsV1({ v: 1 }),
      }).required).toBe(false);
    }
  });

  it('resolves contributed manifest defaults, waivers, and Ask-first through the same settings owner', () => {
    const actionId = 'acme.alpha/actions/run' as const;
    const context = { surface: 'agent' as const };
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context, undefined, true)).toBe(true);
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context, undefined, true)).toBe(false);
    const required = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, required, context, undefined, false)).toBe(true);
  });
  it('keeps fresh-folder consent mandatory on agent and MCP without flooring ordinary session open', () => {
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      const args = {
        actionId: 'session.open' as const, spec: getActionSpec('session.open'), context,
        settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.open': [surface] } }),
        requiredByPolicy: false, input: { sessionId: 's1', approvedNewDirectoryCreation: true },
      };
      expect(resolveActionApprovalRouting(args)).toMatchObject({ required: true, flow: 'deferred' });
      expect(resolveActionApprovalRouting({ ...args, input: { sessionId: 's1', approvedNewDirectoryCreation: false } }).required).toBe(false);
    }
  });
  it('defaults safe controller transitions and window enumeration to approval but honors per-action waivers', () => {
    for (const actionId of ['browser.control.takeControl', 'browser.control.handBack', 'computer.targets.list',
      'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack',
      'computer.permissions.openSettings'] as const) {
      const context = { surface: 'agent' as const, authority: 'account_automation' as const };
      expect(getActionSpec(actionId).surfaces.agent, actionId).toBe(true);
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context), actionId).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
      expect(isApprovalRequiredByActionsSettings(actionId, waived, context), actionId).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: waived,
        context: { ...context, bypassApprovals: true }, requiredByPolicy: false }).required, actionId).toBe(false);
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS,
        { surface: 'ui', authority: 'present_user' }), actionId).toBe(false);
    }
  });
  it('never waives agent workflow trigger writes, including an explicit host policy false', () => {
    for (const actionId of ['workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove'] as const) {
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
        approvalWaivedSurfaces: { [actionId]: ['agent', 'ui'] } });
      const context = { surface: 'agent' as const, authority: 'account_automation' as const };
      expect.soft(isApprovalRequiredByActionsSettings(actionId, settings, context), actionId).toBe(true);
      expect.soft(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings, context,
        requiredByPolicy: false }).required, actionId).toBe(true);
      expect(isApprovalRequiredByActionsSettings(actionId, settings,
        { surface: 'ui', authority: 'present_user' }), actionId).toBe(false);
    }
    expect(resolveActionApprovalRouting({ actionId: 'workflow.trigger.list', spec: getActionSpec('workflow.trigger.list'),
      context: { surface: 'agent' }, requiredByPolicy: false }).required).toBe(false);
  });
  it('keeps scoped Session trigger removal out of the advertised default while preserving confirmation authority', () => {
    const actionId = DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL;
    const spec = getActionSpec(actionId);
    const context = { surface: 'agent' as const, authority: 'account_automation' as const };
    // Own/led Session admission belongs to the trigger owner; this owner decides
    // the approval default for a scoped removal after that policy (FIN 03 §5.4).
    expect(spec.safety).toBe('danger');
    expect.soft(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(false);
    expect.soft(AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS).not.toContain(actionId);
    expect.soft(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context)).toBe(false);
    expect.soft(resolveActionApprovalRouting({ actionId, spec, context }).required).toBe(false);

    for (const ambiguousContext of [undefined, null, approvalContext('session_agent')] as const) {
      expect.soft(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, ambiguousContext)).toBe(true);
      expect.soft(resolveActionApprovalRouting({ actionId, spec, context: ambiguousContext }).required).toBe(true);
    }

    const required = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect.soft(isApprovalRequiredByActionsSettings(actionId, required, context)).toBe(true);
    expect.soft(resolveActionApprovalRouting({ actionId, spec, settings: required, context }).required).toBe(true);
  });
  it('defaults the five identity test and Admin Portal Actions to approval while honoring waiver and require', () => {
    const actionIds = [
      'identity.providers.test.start',
      'identity.providers.test.consume',
      'teams.identity.connections.test.start',
      'teams.identity.connections.test.consume',
      'teams.identity.workos.adminPortalLink.create',
    ] as const;

    for (const actionId of actionIds) {
      const spec = getActionSpec(actionId);
      expect(spec.safety, actionId).toBe('danger');
      for (const surface of ['ui', 'cli', 'agent', 'api', 'plugin'] as const) {
        if (!spec.surfaces[surface]) continue;
        expect(isApprovalRequiredByActionsSettings(
          actionId,
          EMPTY_SETTINGS,
          { surface, authority: 'account_automation' },
        ), `${actionId}:${surface}`).toBe(true);
      }

      const waived = normalizeActionsSettingsV1({
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { [actionId]: ['plugin'] },
      });
      expect(isApprovalRequiredByActionsSettings(
        actionId,
        waived,
        { surface: 'plugin', authority: 'account_automation' },
      )).toBe(false);

      const required = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['plugin'] } },
        approvalWaivedSurfaces: { [actionId]: ['plugin'] },
      });
      expect(isApprovalRequiredByActionsSettings(
        actionId,
        required,
        { surface: 'plugin', authority: 'account_automation' },
      )).toBe(true);
    }
  });

  it.each(['browser.automation.click', 'browser.sandbox.install'] as const)('honors an explicit waiver, require wins, and reset restores the dangerous default for %s', (actionId) => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(actionId, settings, approvalContext('unknown'))).toBe(true);
    const required = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['agent'] },
    }, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(isApprovalRequiredByActionsSettings(actionId, required, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'agent' })).toBe(true);
    const malformed = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: 'agent' },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, malformed, { surface: 'agent' })).toBe(true);
  });

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

  it('uses the exact canonical contributed-Action id for settings-required approval', () => {
    const actionId = 'acme.notes/actions/save-note' as const;
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        [actionId]: {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'mcp' } as any)).toBe(false);
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

  it('routes indirect Team danger mutations through deferred approval on UI surface', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'teams.groups.members.add' as any,
      spec: getActionSpec('teams.groups.members.add'),
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui', authority: 'account_automation' } as any,
    });
    expect(decision).toEqual({ required: true, flow: 'deferred', result: 'required' });
  });

  it('executes dangerous UI actions directly for a present user by default', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'teams.invitations.create' as any,
      spec: getActionSpec('teams.invitations.create'),
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui', authority: 'present_user' } as any,
    });
    expect(decision.required).toBe(false);
  });

  // teams-lane-04/11-responsible-assignment.md:340 — assignment confirmation is
  // required by default and waivable in the canonical Actions policy; the mounted
  // picker has no direct confirmation host, so the present-user UI default must
  // not be suppressed for it.
  it('requires assignment confirmation by default on the present-user UI and honors a ui waiver', () => {
    const actionId = 'session.responsibility.set' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context)).toBe(true);
    expect(resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      context,
    })).toMatchObject({ required: true, flow: 'deferred' });
    // An unwired host applies the same default.
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context }).required).toBe(true);

    const waived = normalizeActionsSettingsV1({
      v: 1,
      actions: {},
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(false);
    // The waiver is surface-exact: the Agent default is untouched.
    expect(isApprovalRequiredByActionsSettings(actionId, waived, { surface: 'agent', authority: 'account_automation' })).toBe(true);
  });

  it('consumes exact completed CLI confirmation while preserving explicit require and waiver settings', () => {
    const actionId = 'account.password.change' as const;
    expect(resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      context: { surface: 'cli', authority: 'present_user' } as any,
    }).required).toBe(true);
    expect(resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      context: {
        surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId },
      } as any,
    }).required).toBe(false);
    expect(resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      context: {
        surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'account.password.remove' },
      } as any,
    }).required).toBe(true);

    const required = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } },
      approvalWaivedSurfaces: { [actionId]: ['cli'] },
    });
    expect(isApprovalRequiredByActionsSettings(
      actionId,
      required,
      {
        surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId },
      } as any,
    )).toBe(true);

    const waived = normalizeActionsSettingsV1({
      v: 1,
      actions: {},
      approvalWaivedSurfaces: { [actionId]: ['cli'] },
    });
    expect(isApprovalRequiredByActionsSettings(
      actionId,
      waived,
      { surface: 'cli', authority: 'account_automation' } as any,
    )).toBe(false);
  });

  it('still honors an explicit UI approval requirement for a present user', () => {
    const settings = normalizeActionsSettingsV1({
      v: 1,
      actions: {
        'teams.invitations.create': { approvalRequiredSurfaces: ['ui'] },
      },
    });
    expect(isApprovalRequiredByActionsSettings(
      'teams.invitations.create' as any,
      settings,
      { surface: 'ui', authority: 'present_user' } as any,
    )).toBe(true);
    expect(resolveActionApprovalRouting({
      actionId: 'teams.invitations.create' as any,
      spec: getActionSpec('teams.invitations.create'),
      settings,
      context: { surface: 'ui', authority: 'present_user' } as any,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });

    // One-time invitation bearers have live-only result custody: the exact
    // mounted present-user invocation waits, while the Artifact retains only
    // the safe observation projection. Other admitted callers retain the same
    // blocking result contract.
    expect(resolveActionApprovalRouting({
      actionId: 'teams.invitations.create' as any,
      spec: getActionSpec('teams.invitations.create'),
      requiredByPolicy: true,
      context: { surface: 'cli', authority: 'present_user' } as any,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });
    expect(resolveActionApprovalRouting({
      actionId: 'teams.invitations.create' as any,
      spec: getActionSpec('teams.invitations.create'),
      requiredByPolicy: true,
      context: { surface: 'agent', authority: 'account_automation' } as any,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });
    expect(resolveActionApprovalRouting({
      actionId: 'teams.invitations.create' as any,
      spec: getActionSpec('teams.invitations.create'),
      requiredByPolicy: true,
      context: { surface: 'api', authority: 'account_automation' } as any,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });
  });

  it.each([
    'home.accounts.role.set',
    'home.accounts.disable',
    'home.accounts.enable',
    'home.accounts.delete',
    'home.policy.set',
    'teams.create',
    'teams.logo.set',
    'teams.logo.remove',
    'teams.groups.create',
    'teams.groups.update',
    'teams.invitations.create',
    'teams.invitations.reissue',
  ] as const)('routes result-bearing Home mutation %s through its declared UI custody', (actionId) => {
    const spec = getActionSpec(actionId);
    expect(spec.approval).toEqual({ result: 'required' });
    const expectedFlow = actionId === 'teams.invitations.create'
      || actionId === 'teams.invitations.reissue'
      ? 'blocking'
      : 'deferred';
    expect(resolveActionApprovalRouting({
      actionId,
      spec,
      requiredByPolicy: true,
      context: { surface: 'ui', authority: 'present_user' },
    })).toEqual({ required: true, flow: expectedFlow, result: 'required' });
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

  it('does not recursively require approval while creating an approval request', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;

    expect(resolveActionApprovalRouting({
      actionId: 'approval.request.create',
      spec: getActionSpec('approval.request.create'),
      requiredByPolicy: true,
      context: { surface: 'agent' } as any,
    }).required).toBe(false);
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

  it('requires confirmation for dangerous actions on every exposed user surface by default', () => {
    for (const actionId of AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      if (spec.safety !== 'danger') continue;
      for (const surface of ['ui', 'mcp', 'cli', 'agent', 'api', 'plugin', 'voice'] as const) {
        if (spec.surfaces[surface] !== true) continue;
        expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface })).toBe(true);
      }
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

  it('routes user-initiated devtools eval through the default confirmation floor', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui' } as any,
    });
    expect(decision.required).toBe(true);
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

  it('keeps the dangerous default when the signal is unwired on a user surface', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      context: { surface: 'ui' } as any,
    });
    expect(decision.required).toBe(true);
  });

  it('keeps live-only custody on the exact invocation when a user requires confirmation on a present-user surface', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'account.password.enroll': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['ui'],
        },
      } as any,
    };
    const context = { surface: 'ui', authority: 'present_user' } as any;

    // Input custody is the sibling of result custody: neither may be handed to a
    // durable Artifact, so the admitted invocation stays the blocking waiter.
    expect(resolveActionApprovalRouting({
      actionId: 'account.password.enroll' as any,
      spec: getActionSpec('account.password.enroll' as any),
      settings,
      context,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });
    expect(resolveActionApprovalRouting({
      actionId: 'teams.identity.workos.adminPortalLink.create' as any,
      spec: getActionSpec('teams.identity.workos.adminPortalLink.create' as any),
      requiredByPolicy: true,
      context,
    })).toEqual({ required: true, flow: 'blocking', result: 'required' });
  });

  it('keeps every show-once bearer creation on its live invocation', () => {
    // One rule for the same concept: the Account API token and the Team
    // external key both return a plaintext bearer exactly once, so neither may
    // hand it to a durable Artifact continuation.
    for (const actionId of ['account.apiTokens.create', 'teams.credentials.externalKeys.create'] as const) {
      expect(getActionSpec(actionId).approvalResultCustody, actionId).toBe('live_only');
      expect(resolveActionApprovalRouting({
        actionId: actionId as any,
        spec: getActionSpec(actionId),
        requiredByPolicy: true,
        context: { surface: 'ui', authority: 'present_user' } as any,
      }), actionId).toEqual({ required: true, flow: 'blocking', result: 'required' });
    }
  });

  it('keeps the Team identity connection test on the durable mounted continuation', () => {
    // L03/06 §16: Team identity tests consume approved results through the
    // mounted completion callback; only the WorkOS Portal link is live-only.
    for (const context of [
      { surface: 'ui', authority: 'present_user' },
      { surface: 'api', authority: 'account_automation' },
    ] as const) {
      expect(resolveActionApprovalRouting({
        actionId: 'teams.identity.connections.test.start' as any,
        spec: getActionSpec('teams.identity.connections.test.start' as any),
        requiredByPolicy: true,
        context: context as any,
      })).toEqual({ required: true, flow: 'deferred', result: 'required' });
    }
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
    // browser_control navigation + view mutation
    'browser.navigate',
    'browser.reload',
    'browser.goBack',
    'browser.goForward',
    'browser.stop',
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
    'browser.automation.upload',
    'browser.automation.drag',
  ] as const;

  // Read-only verbs (no navigation/input/mutation/egress) stay agent-allowed without consent.
  const UNFLOORED_READONLY_VERBS = [
    'browser.automation.status',
    'browser.automation.snapshot',
    'browser.automation.semanticSnapshot',
    'browser.automation.queryElements',
    'browser.automation.waitFor',
    'browser.automation.timeline.get',
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

  it('keeps cancellation out of the danger floor while reserving takeover for a present user', () => {
    const cancel = getActionSpec('browser.automation.cancelActive');

    expect(cancel.safety).toBe('safe');
    expect(isAgentInitiatedApprovalRequiredByDefault(cancel.id)).toBe(false);
    expect(cancel.requiredAuthority).toBe('present_user');
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
    ).toBe(true);
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
    ).toBe(true);
    expect(resolveActionApprovalRouting({
      actionId: 'prompt_doc.update',
      spec,
      settings: EMPTY_SETTINGS,
      context: { surface: 'agent' } as any,
    }).required).toBe(true);
  });

  it('SUBSET invariant: every danger ∩ agent action except approved scoped removal is floored (CON-1/6, never equality)', () => {
    const dangerAgentIds = ACTION_IDS.filter((id) => {
      const spec = getActionSpec(id);
      return spec.safety === 'danger' && spec.surfaces.agent === true
        && id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL;
    });
    expect(dangerAgentIds.length).toBeGreaterThan(0);
    for (const id of dangerAgentIds) {
      expect(isAgentInitiatedApprovalRequiredByDefault(id)).toBe(true);
    }
    // The floor exceeds the non-exempt danger ∩ agent subset via the non-danger egress floor
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

  it('user-initiated (ui) browser navigation uses the dangerous default', () => {
    for (const actionId of FLOORED_BROWSER_NAV_INPUT_VERBS) {
      expect(isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, { surface: 'ui' } as any)).toBe(true);
    }
  });
});

/**
 * §4.1 — the ratified approval posture for the Plugin surface.
 *
 * `surfaces.plugin` is a user-configurable surface. Dangerous plugin-surfaced
 * invocations therefore use the same default confirmation floor as UI, CLI,
 * MCP, API, voice and Agent invocations.
 *
 * These are measured from the evaluated registry, never grepped: a later change
 * that flips whole records rather than the plugin row must fail here.
 */
describe('plugin-surface approval posture (§4.1)', () => {
  const pluginSurfacedActionIds: readonly ActionId[] = ACTION_IDS.filter(
    (id) => getActionSpec(id).surfaces.plugin === true,
  );

  function routingRequired(actionId: ActionId, surface: string): boolean {
    return resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      context: approvalContext(surface),
    }).required;
  }

  it('measures a non-empty plugin surface with a real danger population', () => {
    expect(pluginSurfacedActionIds.length).toBeGreaterThan(0);
    expect(
      pluginSurfacedActionIds.filter((id) => getActionSpec(id).safety === 'danger').length,
    ).toBeGreaterThan(0);
  });

  it('routes dangerous plugin Actions and host capture viewing through approval by default', () => {
    const promptedOnPluginSurface = pluginSurfacedActionIds
      .filter((id) => routingRequired(id, 'plugin'));

    expect(promptedOnPluginSurface).toEqual(
      pluginSurfacedActionIds.filter((id) => (getActionSpec(id).safety === 'danger' || id === 'capture.view')
        && !id.startsWith('approval.request.')
        && id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL),
    );
  });

  it('keeps ordinary safe plugin Actions unprompted while host viewing requires consent', () => {
    const safePluginActionIds = pluginSurfacedActionIds
      .filter((id) => getActionSpec(id).safety !== 'danger' && id !== 'capture.view');

    for (const actionId of safePluginActionIds) {
      expect(routingRequired(actionId, 'plugin')).toBe(false);
    }
  });

  it('prompts the same non-exempt danger-class rows on the agent surface', () => {
    const dangerAgentAndPluginActionIds = pluginSurfacedActionIds.filter((id) => {
      const spec = getActionSpec(id);
      return spec.safety === 'danger'
        && spec.surfaces.agent === true
        && id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL
        // Approval requests are intentionally unprompted, so a request cannot
        // recursively create another request before the existing flow decides it.
        && id !== 'approval.request.create';
    });

    expect(dangerAgentAndPluginActionIds.length).toBeGreaterThan(0);
    for (const actionId of dangerAgentAndPluginActionIds) {
      expect(routingRequired(actionId, 'agent'), actionId).toBe(true);
    }
  });

  it('honors a persisted approvalRequiredSurfaces override for the plugin surface', () => {
    const actionId = pluginSurfacedActionIds.find(
      (id) => getActionSpec(id).safety === 'danger',
    );
    expect(actionId).toBeDefined();
    if (!actionId) return;

    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        [actionId]: {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['plugin'],
        },
      } as any,
    };

    expect(resolveActionApprovalRouting({
      actionId,
      spec: getActionSpec(actionId),
      settings,
      context: approvalContext('plugin'),
    }).required).toBe(true);
  });
});
