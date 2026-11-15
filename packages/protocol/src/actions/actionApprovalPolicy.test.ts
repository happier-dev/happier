import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from './actionIds.js';
import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import {
  normalizeActionsSettingsV1,
  setScopedActionApprovalPreference,
  type ActionsSettingsV1,
} from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { FILESYSTEM_ACTION_IDS } from './filesystemActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionIds.js';
import { MCP_SERVER_ACTION_SPECS_V1 } from './specs/mcpServers.js';
import {
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
  resolveActionApprovalRouting,
} from './actionApprovalPolicy.js';

const EMPTY_SETTINGS: ActionsSettingsV1 = { v: 1, actions: {} as any };

function expectOwnUiReview(
  decision: ReturnType<typeof resolveActionApprovalRouting>,
  confirmationRequired: boolean,
  message?: string,
): void {
  expect(decision.required, message).toBe(false);
  expect(decision.uiConfirmationRequired === true, message).toBe(confirmationRequired);
}

it('routes a host-prepared review through the same own-UI disposition while retaining input acquisition', () => {
  const actionId = 'workspace.sync.relationship.replace';
  const own = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
  const args = { actionId, spec: getActionSpec(actionId), context: own,
    settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } }) } as const;
  expect(resolveActionApprovalRouting({ ...args, reviewRequired: true }))
    .toMatchObject({ required: false, uiConfirmationRequired: true });
  expect(resolveActionApprovalRouting({ ...args, reviewRequired: true, reviewAdmitted: true }))
    .toMatchObject({ required: false });
  expect(resolveActionApprovalRouting({ ...args, inputRequired: true }))
    .toMatchObject({ required: true, inputRequired: true });
  expect(resolveActionApprovalRouting({ ...args, reviewRequired: true,
    context: { ...own, surface: 'agent', authority: 'account_automation' } })).toMatchObject({ required: true });
});

it('uses the selected contributed identity for Settings Ask, waiver and declaration defaults', () => {
  const actionId = 'action.invoke';
  const profileActionId = 'acme.notes/actions/save-note';
  const args = { actionId, profileActionId, spec: getActionSpec(actionId),
    context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } },
    defaultSafety: 'safe', defaultConfirmation: false } as const;
  expect(resolveActionApprovalRouting({ ...args,
    settings: normalizeActionsSettingsV1({ v: 1, actions: { [profileActionId]: { approvalRequiredSurfaces: ['agent'] } } }) }).required).toBe(true);
  expect(resolveActionApprovalRouting({ ...args, defaultConfirmation: true,
    settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [profileActionId]: ['agent'] } }) }).required).toBe(false);
  expect(resolveActionApprovalRouting({ ...args, defaultConfirmation: true,
    settings: normalizeActionsSettingsV1({ v: 1 }) }).required).toBe(true);
});

it.each([false, true])('honors a contributed UI confirmation exemption with explicit Ask=%s', ask => {
  const actionId = 'action.invoke';
  const profileActionId = 'acme.notes/actions/save-note';
  const decision = resolveActionApprovalRouting({ actionId, profileActionId, spec: getActionSpec(actionId),
    context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
    defaultSafety: 'danger', defaultConfirmation: false, defaultUiConfirmation: false,
    settings: normalizeActionsSettingsV1({ v: 1,
      ...(ask ? { actions: { [profileActionId]: { approvalRequiredSurfaces: ['ui'] } } } : {}) }) });
  expectOwnUiReview(decision, ask);
});

it.each(['deployments.bindings.set', 'deployments.teardown'] as const)(
  'uses the person\'s own UI admission for %s while keeping automation and other callers on Ask', actionId => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui', 'agent'] },
    } });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      ...(actionId === 'deployments.teardown' ? { presentUserConfirmation: { actionId } } : {}),
    } as const;
    const args = { actionId, spec: getActionSpec(actionId), settings, context };
    expect(resolveActionApprovalRouting(args).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args,
      context: { ...context, approvalProfileId: 'builtin:read-propose' },
    }).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args,
      context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } },
    }).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args,
      context: { surface: 'ui', authority: 'present_user', actionCaller: {
        kind: 'session', sessionId: 'requesting-session', starterDepth: 0, turnDepth: 0,
      } },
    }).required).toBe(true);
  },
);

it.each(['ui', 'cli'] as const)(
  'answers %s Ask with the person’s UI press or an admitted exact confirmation', surface => {
    const actionId = 'registries.sources.delete';
    const args = {
      actionId,
      spec: getActionSpec(actionId),
      input: { sourceId: 'registry-source' },
      settings: normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
      }),
      context: { surface, authority: 'present_user', actionCaller: { kind: 'host' } },
    } as const;

    expect(resolveActionApprovalRouting(args).required).toBe(surface !== 'ui');
    // A caller-authored default marker is not the executor's admitted exact decision.
    expect(resolveActionApprovalRouting({
      ...args, context: { ...args.context, presentUserConfirmation: { actionId } },
    }).required).toBe(surface !== 'ui');
    expect(resolveActionApprovalRouting({ ...args, reviewAdmitted: true })).toMatchObject({
      required: false,
    });
    const profileRequired = {
      ...args, context: { ...args.context, approvalProfileId: 'builtin:read-propose' },
    };
    expect(resolveActionApprovalRouting(profileRequired).required).toBe(surface !== 'ui');
    expect(resolveActionApprovalRouting({ ...profileRequired, reviewAdmitted: true })).toMatchObject({
      required: false,
      profile: { status: 'available', effectiveId: 'builtin:read-propose' },
    });
  },
);

it('shares agent default Ask with external MCP at the policy floor and keeps surface waivers configurable (PARITY F-A)', () => {
  // Owner 2026-10-12/29: one default for agent/MCP, including incumbent MCP Actions.
  for (const actionId of ACTION_IDS.filter(id => getActionSpec(id).surfaces.mcp && getActionSpec(id).surfaces.agent)) {
    const agentAsk = isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'agent', authority: 'account_automation' });
    if (!agentAsk) continue;
    expect.soft(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'mcp', authority: 'account_automation' }), actionId).toBe(true);
  }
  for (const actionId of ['computer.targets.list', 'links.openExternal'] as const) {
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['mcp'] } });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, { surface: 'mcp' }), actionId).toBe(false);
    const required = normalizeActionsSettingsV1({ ...waived, actions: { [actionId]: { approvalRequiredSurfaces: ['mcp'] } } });
    expect(isApprovalRequiredByActionsSettings(actionId, required, { surface: 'mcp' }), actionId).toBe(true);
  }
});

it.each(['ui', 'cli', 'agent', 'mcp', 'rpc', 'api', 'plugin', 'voice'] as const)(
  'returns durable approval custody instead of retaining a %s invocation', surface => {
    const actionId = 'session.status.get';
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      requiredByPolicy: true, context: { surface } }).flow).toBe('deferred');
  },
);
it('retains CLI live-only results on the original approval waiter', () => {
  const actionId = 'connectedServices.authentication.beginConnect';
  expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
    requiredByPolicy: true, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } }))
    .toMatchObject({ required: true, flow: 'blocking' });
});

// Approved FIN 03 §5.4/§5.7 exception; every other danger row retains its floor.
const DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL =
  'session.trigger.remove' satisfies ActionId;
type ApprovalContext = Pick<ActionExecutorContext, 'surface'>;

function approvalContext(surface: unknown): ApprovalContext {
  // Boundary-defensive fixture: persisted or legacy hosts can pass surfaces outside the current union.
  return { surface } as unknown as ApprovalContext;
}

async function loadRoutingResolver() {
  const module = (await import('./actionApprovalPolicy.js')) as Record<
    string,
    unknown
  >;
  const resolver = module.resolveActionApprovalRouting;
  expect(resolver).toEqual(expect.any(Function));
  if (typeof resolver !== 'function') return null;
  return resolver as (args: unknown) => unknown;
}

describe('isApprovalRequiredByActionsSettings', () => {
  it('keeps safe Voice Settings writes behind an answer while safe reads remain direct', () => {
    const actionId = 'settings.set';
    const spec = getActionSpec(actionId);
    const input = { anchor: 'voiceConversations.audibleWaitingCue', value: true };
    const context = { surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings: EMPTY_SETTINGS }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, input, context: { ...context,
      authority: 'present_user', presentUserConfirmation: { actionId } }, settings: EMPTY_SETTINGS }).required).toBe(false);
    // Agent-initiated write while the person is present: no completed confirmation, so it still Asks.
    expect(resolveActionApprovalRouting({ actionId, spec, input, context: { ...context,
      authority: 'present_user' }, settings: EMPTY_SETTINGS }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: 'settings.get', spec: getActionSpec('settings.get'),
      input: { anchor: input.anchor }, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'session.attention.set', spec: getActionSpec('session.attention.set'),
      input: { sessionId: 'own-session', state: 'read' }, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['voice'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings: waived }).required).toBe(false);
  });
  it('consumes completed Voice software confirmation while preserving Require and non-human Ask', () => {
    const actionId = 'machines.setup.apply';
    const spec = getActionSpec(actionId);
    const context = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      presentUserConfirmation: { actionId } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    const required = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['voice'] },
    } });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: required }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context, presentUserConfirmation: undefined },
      settings: EMPTY_SETTINGS }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context,
      presentUserConfirmation: { actionId: 'machines.setup.plan' } }, settings: EMPTY_SETTINGS }).required).toBe(true);
    for (const surface of ['agent', 'mcp', 'plugin'] as const) {
      expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context, surface },
        settings: EMPTY_SETTINGS }).required, surface).toBe(true);
    }
    expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context, authority: 'account_automation' },
      settings: EMPTY_SETTINGS }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context,
      actionCaller: { kind: 'plugin', pluginId: 'fixture.plugin', contributionLocalId: 'setup' } },
      settings: EMPTY_SETTINGS }).required).toBe(true);
  });

  it.each(['agent', 'mcp'] as const)('keeps a Session-origin %s approval decision on Ask by default; only a saved waiver allows it', surface => {
    const actionId = 'approval.request.decide';
    const context = { surface, authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 } } as const;
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context)).toBe(true);
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(false);
    const required = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
      approvalWaivedSurfaces: { [actionId]: [surface] } });
    expect(isApprovalRequiredByActionsSettings(actionId, required, context)).toBe(true);
  });

  it.each([
    ['voiceConversations.provider', JSON.stringify({ providerId: 'local_conversation', optionId: 'local' })],
    ['voiceConversations.agentSource', 'session'],
    ['voiceConversations.permissionIntent', 'read-only'],
    ['voiceConversations.chatModelId', 'claude-haiku-4-5'],
  ])('keeps reversible Voice preference %s direct on the default CLI surface', (anchor, value) => {
    // Owner ruling 2026-10-29: CLI asks only for consequential Actions.
    expect(isApprovalRequiredByActionsSettings('settings.set', EMPTY_SETTINGS,
      { surface: 'cli', authority: 'present_user' }, undefined, undefined,
      { anchor, value, expectedSettingsVersion: 8135 })).toBe(false);
  });

  it('applies the CLI surface default (direct Voice settings write) while the agent surface defaults to Ask', () => {
    const input = { anchor: 'voiceConversations.agentSource', value: 'session', expectedSettingsVersion: 8135 };
    // Surface-keyed: any CLI caller, whatever its authority.
    for (const authority of ['present_user', 'account_automation'] as const) {
      expect(isApprovalRequiredByActionsSettings('settings.set', EMPTY_SETTINGS,
        { surface: 'cli', authority }, undefined, undefined, input), authority).toBe(false);
    }
    // Consequential (permission-changing) settings keep their Ask on the CLI surface.
    expect(isApprovalRequiredByActionsSettings('settings.set', EMPTY_SETTINGS, { surface: 'cli' }, undefined, undefined,
      { anchor: 'actions.promptDocAgentEdits', value: 'allowed' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings('settings.set', EMPTY_SETTINGS,
      { surface: 'agent', authority: 'account_automation' }, undefined, undefined, input)).toBe(true);
  });

  it.each(['scm.diffSummary.result.clear', 'scm.stash.drop'] as const)(
    'admits a direct irreversible %s press while honoring UI Require and Waive', actionId => {
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    const require = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: require }).required).toBe(false);
    const waive = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: waive }).required).toBe(false);
  });

  it('admits direct process Kill and retains configurable automated confirmation (FX-KILL)', () => {
    const actionId = 'machines.processes.kill';
    const spec = getActionSpec(actionId);
    const host = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    for (const context of [host, { surface: 'agent', authority: 'account_automation' },
      { surface: 'mcp', authority: 'account_automation' }, { surface: 'cli', authority: 'present_user' }] as const) {
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required, context.surface).toBe(context.surface !== 'ui');
      }
      const allowed = normalizeActionsSettingsV1({ v: 1, actions: {},
        approvalWaivedSurfaces: { [actionId]: [context.surface] } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: allowed }).required, context.surface).toBe(false);
      const ask = normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: [context.surface] },
      } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: ask }).required, context.surface).toBe(context.surface !== 'ui');
    }
    expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
      context: { ...host, presentUserConfirmation: { actionId } } }).required).toBe(false);
  });

  it('keeps non-Kill reversible danger direct for the person while retaining agent review (FX-KILL / UI-17)', () => {
    const actionId = 'browser.reload';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(spec.safety).toBe('danger');
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
  });

  it('reviews receiver-prepared rollouts by default and retains one completed review or an explicit waiver', () => {
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    for (const actionId of ['deployments.deploy', 'deployments.promote', 'deployments.rollback'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }),
        actionId !== 'deployments.rollback');
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context,
        settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } }) }), false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS,
        defaultUiConfirmation: true }), true);
      const reviewed = { ...context, presentUserConfirmation: { actionId } };
      expect(resolveActionApprovalRouting({ actionId, spec, context: reviewed, settings: EMPTY_SETTINGS,
        defaultUiConfirmation: true }).required).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context: reviewed, settings: EMPTY_SETTINGS,
        defaultUiConfirmation: true }), false);
      const stricter = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context: reviewed, settings: stricter }), true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context: reviewed, settings: stricter, reviewAdmitted: true }), false);
      for (const surface of ['agent', 'api'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context, surface,
        authority: 'account_automation' }, settings: EMPTY_SETTINGS }).required).toBe(true);
      }
    }
    const actionId = 'scm.worktree.remove';
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context,
      presentUserConfirmation: { actionId } }, settings: EMPTY_SETTINGS }).required).toBe(false);
  });
  it('never evaluates a UI confirmation waiver for an Agent request', () => {
    const actionId = 'boards.apply';
    const input = { get intent(): never { throw new Error('Agent approval read UI-only input'); } };
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input,
      settings: EMPTY_SETTINGS, context: { surface: 'agent', authority: 'account_automation' },
    }).required).toBe(true);
  });

  it.each(['session.board.item.upsert', 'session.board.layout.update'] as const)('defaults reversible %s to Allow on each exposed surface while preserving explicit Ask and waive', actionId => {
    const spec = getActionSpec(actionId);
    for (const surface of ['ui', 'voice', 'agent', 'mcp', 'cli', 'api'] as const) {
      if (!spec.surfaces[surface]) continue;
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required, surface).toBe(false);
      const ask = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: ask }).required, surface).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings: waived }).required, surface).toBe(false);
    }
  });

  it.each(['session', 'plugin'] as const)('does not grant direct UI admission to a %s caller claiming present-user authority', kind => {
    const actionId = 'session.access.grant.set';
    const actionCaller = kind === 'session'
      ? { kind, sessionId: 'session', starterDepth: 0, turnDepth: 0 }
      : { kind, pluginId: 'external-plugin' };
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: EMPTY_SETTINGS,
      context: { surface: 'ui', authority: 'present_user', actionCaller },
    }).required).toBe(true);
  });

  it('preserves Agent Ask first for every Action declaring direct or input-specific UI confirmation', () => {
    const ids = ACTION_IDS.filter(id => {
      const policy = getActionSpec(id).approvalPolicy;
      return policy?.uiConfirmation === 'direct' || policy?.uiConfirmationForInput !== undefined;
    });
    expect(ids).toContain('session.board.item.upsert');
    expect(ids).toContain('session.access.grant.set');
    for (const actionId of ids) {
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['agent'] },
      } });
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings,
        context: { surface: 'agent', authority: 'account_automation', actionCaller: {
        kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0,
        } }, defaultUiConfirmation: false,
      }).required, actionId).toBe(true);
    }
  });

  it.each([...ACTION_IDS.filter(id => id.startsWith('browser.') && id !== 'browser.recording.discard'),
    'artifact.export', 'account.public_profile.resume', 'account.public_profile.refresh'] as const)(
    'admits the present user’s reversible %s through the shared UI admission, retaining automation floors (UI-17)', actionId => {
    const spec = getActionSpec(actionId);
    const input = actionId === 'artifact.export' ? { artifactId: 'binary', destination: 'client' } : undefined;
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    for (const settings of [undefined, EMPTY_SETTINGS]) {
      expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(false);
    }
    const settings = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(false);
    const agent = { surface: 'agent', authority: 'account_automation' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, input, context: agent, settings: EMPTY_SETTINGS }).required)
      .toBe(isAgentInitiatedApprovalRequiredByDefault(actionId));
    expect(resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface: 'ui', authority: 'account_automation' }, settings: EMPTY_SETTINGS }).required)
      .toBe(spec.safety === 'danger');
    expect(resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'plugin', pluginId: 'external-plugin' } },
      settings: EMPTY_SETTINGS }).required).toBe(spec.safety === 'danger');
    expect(resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface: 'ui', authority: 'present_user' }, settings: EMPTY_SETTINGS }).required)
      .toBe(false);
  });

  it.each([
    'browser.recording.discard', 'home.governance.claim', 'teams.archive',
    'usage.sources.history.delete', 'teams.members.remove', 'teams.members.leave', 'teams.directory.sources.remove',
    'identity.providers.secret.replace', 'identity.providers.remove',
    'teams.identity.connections.remove', 'home.identity.connections.remove',
    'session.board.item.remove', 'artifact.public_link.revoke', 'session.public_link.remove',
    'machines.remove', 'connectedServices.pools.delete', 'connectedServices.quota.reset',
    'teams.members.history.prepare',
    'home.accounts.signOutEverywhere', 'home.public_profiles.handle_reclaim', 'reviews.comments.claimPublicationDispatch',
    'account.public_profile.publish', 'account.public_profile.unpublish',
    'session.pending.resetStart.cancel', 'session.pending.sendAsNew', 'session.tags.delete',
    'discussion.owner.transfer', 'discussion.access.grants.remove',
    'localServices.publicPreview.revoke', 'localServices.actions.terminateDetected', 'scm.worktree.remove',
    'secrets.delete', 'plugins.npm_registry_profiles.remove', 'plugins.account.hosting.remove', 'projects.sources.delete',
    'roles.delete', 'roles.override.reset', 'relay.runtime.personal_home.claim', 'account.credentials.forgetAll',
    'projects.workspace.forget', 'plugin.webhook.endpoint.revoke', 'account.password.remove', 'scm.diffSummary.result.delete',
  ] as const)('does not repeat the host’s completed irreversible %s confirmation (UI-17)', actionId => {
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      presentUserConfirmation: { actionId } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
  });

  it('keeps host-proved exposure confirmation authoritative over reversible UI defaults (UI-17)', () => {
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expectOwnUiReview(resolveActionApprovalRouting({ actionId: 'browser.reload', spec: getActionSpec('browser.reload'), context,
      settings: EMPTY_SETTINGS, defaultUiConfirmation: true }), true);
  });

  it.each([
    'projects.trust.revoke', 'friends.remove', 'daemon.filesystem.transfer.cancel', 'launch_profiles.publish',
    'session.pending.resetStart.set', 'follow.remove', 'session.delivery.mute.remove',
    'sessions.external.operation.discard', 'plugins.permissions.grants.revoke', 'ui.voice_global.reset',
  ] as const)('keeps the host’s recoverable %s intent direct under Account Ask (UI-17)', actionId => {
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(false);
  });

  it('consumes the existing exact worktree-removal confirmation instead of asking twice (UI-17)', () => {
    const actionId = 'scm.worktree.remove';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId } } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(false);
  });

  it.each([
    'machines.metadata.update',
    'machines.resources.policy.set',
    'machines.guard.sessionCeiling.set',
    'machines.storage.protected.remove',
  ] as const)('asks agents for machine metadata updates and %s by default and honors each caller approval setting (AGW-2/R41)', (actionId) => {
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe('safe');
    for (const surface of ['agent', 'mcp', 'plugin'] as const) {
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS, context }).required, surface).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(resolveActionApprovalRouting({ actionId, spec, settings: waived, context }).required, surface).toBe(false);
    }
    for (const surface of ['ui', 'cli'] as const) {
      const context = { surface, authority: 'present_user' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS, context }).required, surface).toBe(false);
      const ask = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, settings: ask, context }).required, surface).toBe(surface !== 'ui');
    }
  });

  it('admits ad-hoc project Run directly only for the present UI user while automated approval remains authoritative', () => {
    const actionId = 'projects.compute.exec';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS, context }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context }).required).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
    for (const surface of ['agent', 'mcp', 'cli', 'ui', 'plugin'] as const) {
      const automation = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
      context: automation }).required, surface).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, context: automation }).required, surface).toBe(true);
      const waived = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(resolveActionApprovalRouting({ actionId, spec, settings: waived,
      context: automation }).required, surface).toBe(false);
    }
    expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS }).required).toBe(true);
    const explicitAsk = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(resolveActionApprovalRouting({ actionId, spec, settings: explicitAsk, context }).required).toBe(false);
    const explicitNever = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, settings: explicitNever, context }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'projects.script.run',
      spec: getActionSpec('projects.script.run'), settings: EMPTY_SETTINGS, context }).required).toBe(false);
  });

  it.each(['workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.run_now'] as const)(
    'admits reversible %s directly for the present UI user while automation and explicit Ask retain approval',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS, context }).required).toBe(false);
      for (const surface of ['agent', 'cli', 'mcp', 'ui'] as const) {
      expect(resolveActionApprovalRouting({ actionId, spec, settings: EMPTY_SETTINGS,
      context: { surface, authority: 'account_automation' } }).required, surface).toBe(true);
      }
      const settings = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, settings, context }).required).toBe(false);
    },
  );

  it('admits direct Habit removals while retaining irreversible presentation metadata', () => {
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const actionId = 'workflow.trigger.remove';
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({ actionId, spec, context,
      input: { automationId: 'habit', triggerId: 'schedule' } }).required).toBe(false);
    for (const id of ['workflow.trigger.remove', 'workflow.run.delete', 'workflow.definition.delete', 'artifact.delete'] as const) {
      const deletion = getActionSpec(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec: deletion, context,
      input: { automationId: 'habit' } }).required, id).toBe(false);
      expect(deletion.irreversible, id).toBe(true);
      expect(deletion.confirmVerb, id).toEqual({ key: 'common.delete', fallback: 'Delete' });
    }
  });

  it('leaves mounted Workflow Discard to the editor confirmation while automation still requires approval', () => {
    const actionId = 'workflow.authoring.draft.discard';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context }).required).toBe(false);
    for (const surface of ['agent', 'mcp', 'ui'] as const) {
      expect(resolveActionApprovalRouting({ actionId, spec,
      context: { surface, authority: 'account_automation' } }).required).toBe(true);
    }
    expect(resolveActionApprovalRouting({ actionId, spec, context,
      settings: normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(false);
  });

  it('uses personal Settings declarations for set/reset defaults without weakening security or configured Ask', () => {
    for (const actionId of ['settings.set', 'settings.reset'] as const) {
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      for (const anchor of ['session.list.density', 'session.list.statusWords', 'appearance.navigationPlacements']) {
      const input = { anchor, value: 'narrow' };
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context, undefined, undefined, input), `${actionId} ${anchor} ${surface}`).toBe(false);
      const ask = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
      expect(isApprovalRequiredByActionsSettings(actionId, ask, context, undefined, undefined, input)).toBe(true);
      }
      for (const anchor of ['actions.createSession.allowEnvironmentVariables', 'transcript.agentHtmlNetworkPolicy', 'voiceConversations.edit', 'unknown.preference']) {
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context, undefined, undefined, { anchor, value: true, agentSafety: 'safe' })).toBe(true);
      }
      }
    }
    expect(isApprovalRequiredByActionsSettings('session.stop', EMPTY_SETTINGS, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings('session.archive', EMPTY_SETTINGS, { surface: 'agent' })).toBe(false);
  });

  it('keeps Voice operations direct by default and honors native UI Ask while retaining Agent danger', () => {
    const input = { anchor: 'voicePrivacy.forgetVoiceAgentMemory' };
    const ui = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(isApprovalRequiredByActionsSettings('settings.invoke', EMPTY_SETTINGS, ui, undefined, undefined, input)).toBe(false);
    const explicitAsk = normalizeActionsSettingsV1({ v: 1,
      actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } },
    });
    expect(isApprovalRequiredByActionsSettings('settings.invoke', explicitAsk, ui, undefined, undefined, input)).toBe(true);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId: 'settings.invoke', spec: getActionSpec('settings.invoke'),
      settings: explicitAsk, context: ui, input }), true);
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(isApprovalRequiredByActionsSettings('settings.invoke', EMPTY_SETTINGS,
        { surface, authority: 'account_automation' }, undefined, undefined, input)).toBe(true);
    }
    expect(isApprovalRequiredByActionsSettings('settings.invoke', EMPTY_SETTINGS,
      { surface: 'ui', authority: 'account_automation' }, undefined, undefined, input)).toBe(true);
    for (const anchor of ['appearance.atmospherePictureRemove', 'voicePrivacy.unregisteredOperation']) {
      expect(isApprovalRequiredByActionsSettings('settings.invoke', EMPTY_SETTINGS, ui, undefined, undefined, { anchor })).toBe(false);
    }
    for (const anchor of ['voiceAdvanced.removeSpeechModel', 'voiceConversations.testTts', 'voicePrivacy.diagnosticsEnabled']) {
      expect(isApprovalRequiredByActionsSettings('settings.invoke', EMPTY_SETTINGS, ui, undefined, undefined, { anchor })).toBe(false);
    }
  });

  it.each(['usage.recap.deliver', 'usage.recap.private.deliver'] as const)('admits explicit %s gestures directly while automation asks and surface overrides still govern', actionId => {
    expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: 'ui', authority: 'present_user' })).toBe(false);
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface, authority: 'account_automation' })).toBe(true);
      expect(isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        actions: {}, approvalWaivedSurfaces: { [actionId]: [surface] } }), { surface, authority: 'account_automation' })).toBe(false);
    }
    const explicitAsk = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    const ui = { surface: 'ui', authority: 'present_user' } as const;
    expect(isApprovalRequiredByActionsSettings(actionId, explicitAsk, ui)).toBe(true);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: explicitAsk, context: ui }), true);
  });
  it.each(['daemon.filesystem.download', 'daemon.filesystem.upload'] as const)(
    'admits %s directly only for the present UI user',
    (actionId) => {
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
          surface: 'ui',
          authority: 'present_user',
        }),
      ).toBe(false);
      for (const surface of ['agent', 'mcp', 'cli', 'rpc'] as const) {
        expect(
          isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
            surface,
            authority: 'present_user',
          }),
          surface,
        ).toBe(true);
      }
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
          surface: 'ui',
          authority: 'account_automation',
        }),
      ).toBe(true);
      const explicitAsk = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, explicitAsk, {
          surface: 'ui',
          authority: 'present_user',
        }),
      ).toBe(true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: explicitAsk,
        context: { surface: 'ui', authority: 'present_user' } }), true);
    },
  );

  it('admits comparison Discard directly and retains HEAD, mixed and automated confirmation', () => {
    const actionId = 'scm.change.discard';
    const spec = getActionSpec(actionId);
    const comparison = {
      path: 'src/app.ts',
      kind: 'comparison',
      against: { source: { kind: 'workingTree' } },
      changeKeys: ['key'],
      includeUndo: true,
    };
    const head = { path: 'a', kind: 'modified' };
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      for (const entry of [comparison, head]) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input: { entries: [entry] },
            context: { surface, authority: 'account_automation' },
          }).required,
        ).toBe(true);
      }
    }
    for (const [entries, required] of [
      [[comparison], false],
      [[head], true],
      [[comparison, head], true],
    ] as const) {
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input: { entries },
        context: { surface: 'ui', authority: 'present_user' },
      }), required);
    }
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        input: { entries: [comparison] },
        context: { surface: 'rpc', authority: 'account_automation' },
      }).required,
    ).toBe(false);
  });
  it('retains durable publication claim approval and its declared irreversible UI confirmation', () => {
    const actionId = 'reviews.comments.claimPublicationDispatch';
    const spec = getActionSpec(actionId);
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context: { surface: 'plugin', authority: 'account_automation' },
      }),
    ).toEqual({ required: true, flow: 'deferred', result: 'required' });

    // Durable result requirements do not create private live custody.
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context: { surface: 'ui', authority: 'present_user' },
      }),
    ).toMatchObject({ required: false, uiConfirmationRequired: true });
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['plugin'] },
    });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: waived,
        context: { surface: 'plugin', authority: 'account_automation' },
      }).required,
    ).toBe(false);
  });

  it.each([
    'reviews.comments.transition',
    'reviews.comments.bulkTransition',
    'reviews.comments.edit',
    'reviews.comments.reply',
  ] as const)(
    'admits reversible %s directly on UI while honoring Settings confirmation',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expect(
          resolveActionApprovalRouting({ actionId, spec, context, settings })
            .required,
        ).toBe(false);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings,
            context: { surface: 'agent', authority: 'account_automation' },
          }).required,
        ).toBe(true);
      }
      const ask = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        resolveActionApprovalRouting({ actionId, spec, context, settings: ask })
          .required,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          actionId: 'reviews.comments.redact',
          spec: getActionSpec('reviews.comments.redact'),
          context,
        }).required,
      ).toBe(false);
    },
  );

  it.each([
    'projects.service.placement.set',
    'projects.worker.preferences.set',
    'projects.worker.preferences.reset',
    'machines.worker.policy.set',
    'session.checkpoint',
    'session.connected_services_auth.set',
    'session.pending.action.set',
    'prompt_doc.create',
    'roles.create',
    'roles.update',
    'roles.override.set',
    'daemon.filesystem.createDirectory',
    'daemon.filesystem.rename',
    'daemon.filesystem.writeFile',
    'settings.set',
    'settings.reset',
    'ui.voice_global.start',
    'ui.voice_global.recover',
    'ui.voice_global.set_muted',
    'ui.voice_global.hold_begin',
    'ui.voice_global.brief.request',
    'ui.voice_global.brief.retry',
    'ui.voice_global.dictation.start',
    'connectedServices.subscription.price.set',
    'connectedServices.accounts.default.set',
    'connectedServices.accounts.purposeDefault.set',
    'connectedServices.purposes.default.set',
    'connectedServices.pools.create',
    'connectedServices.pools.patch',
    'connectedServices.pools.members.add',
    'connectedServices.pools.members.patch',
    'connectedServices.pools.members.remove',
    'connectedServices.pools.switchNow',
    'connectedServices.pools.reorder',
    'connectedServices.pools.default.set',
    'usage.coach.apply',
    'usage.coach.undo',
    'usage.sources.stop',
    'usage.sources.root.set',
    'widgets.item.add',
    'widgets.item.move',
    'widgets.item.rename',
    'widgets.item.size.set',
    'widgets.item.frame.set',
    'widgets.item.inputs.set',
    'widgets.item.inputs.reset',
    'widgets.group.add',
    'widgets.group.create',
    'widgets.group.set',
    'widgets.group.inputs.set',
    'widgets.group.ungroup',
    'widgets.area.layout.create',
    'widgets.area.layout.rename',
    'widgets.area.layout.reorder',
    'widgets.area.layout.reset',
    'widgets.area.layout.undo',
    'widgets.definition.saveFromSession',
    'widgets.fragment.update',
    'artifact.create',
    'artifact.publish_from_file',
    'artifact.access.grants.set',
    'artifact.access.grants.remove',
    'artifact.public_link.list',
    'mcp.servers.create',
    'mcp.servers.update',
    'mcp.servers.tools.set',
    'mcp.servers.duplicate',
    'mcp.servers.import',
    'mcp.servers.test',
    'mcp.servers.signIn.start',
    'mcp.found.adopt',
    'mcp.rules.set',
    'skills.rules.set',
    'registries.sources.token.set',
    'registries.sources.update',
    'session.capabilities.set',
    'skills.create',
    'skills.update',
    'skills.duplicate',
    'skills.install',
    'skills.found.adopt',
    'prompt_registry.install',
    'skills.updates.apply',
    'skills.machine.install',
    'agents.acp.backends.upsert',
    'registries.sources.create',
    'secrets.create',
    'secrets.update',
    'machines.agents.signIn.start',
    'machines.agents.signIn.restart',
    'machines.agents.signIn.cancel',
    'machines.agents.install.cancel',
    'connectedServices.authentication.beginConnect',
    'connectedServices.authentication.beginReconnect',
    'connectedServices.authentication.continueConnect',
    'connectedServices.authentication.submitManual',
    'connectedServices.authentication.completeOAuth',
    'connectedServices.authentication.pollDevice',
    'connectedServices.authentication.resumeDevice',
    'connectedServices.authentication.reconcile',
    'connectedServices.authentication.cancel',
    'machines.daemon.stop',
    'machines.replacement.set',
    'machines.replacement.clear',
    'machines.managed.acquire',
    'machines.managed.power.set',
    'machines.managed.retention.update',
    'machines.managed.controller.update',
    'machines.managed.setup.skip',
    'machines.presets.create',
    'machines.presets.update',
    'machines.presets.archive',
    'machines.presets.restore',
    'machines.access.grant.remove',
    'machines.access.leave',
    'scm.change.include',
    'scm.change.exclude',
    'scm.commit.create',
    'scm.commit.backout',
    'scm.branch.create',
    'scm.branch.checkout',
    'scm.remote.fetch',
    'scm.remote.pull',
    'scm.remote.push',
    'scm.repository.removeIndexLock',
    'scm.stash.create',
    'scm.stash.apply',
    'scm.stash.pop',
    'scm.commit.undoLast',
    'scm.branch.operation.continue',
    'scm.remote.add',
    'scm.remote.setUrl',
    'scm.remote.remove',
    'scm.remote.publish',
    'scm.worktree.create',
    'scm.pullRequest.openOrReuse',
    'scm.repository.init',
    'scm.hostingRepository.publish',
    'account.name.set',
    'account.username.set',
    'discussion.post',
    'session.access.grant.set',
    'session.access.grant.remove',
    'session.access.context.set',
    'session.public_link.create',
    'artifact.public_link.create',
    'session.manager.set',
    'session.responsibility.set',
    'home.runtime.restart',
    'relay.runtime.restart',
    'remote_hosts.relay.restart',
    'plugins.settings.set',
    'plugins.settings.secret.bind',
    'plugins.settings.secret.unbind',
    'teams.restore',
    'teams.members.suspend',
    'teams.members.reactivate',
    'teams.members.management.set',
    'teams.groups.archive',
    'teams.invitations.create',
    'teams.invitations.reissue',
    'teams.invitations.accept',
    'teams.externalGroupBindings.set',
    'teams.externalGroupBindings.remove',
    'teams.directory.sources.create',
    'teams.directory.sources.pause',
    'home.accounts.role.set',
    'home.accounts.disable',
    'home.accounts.enable',
    'identity.githubApps.remove',
    'teams.policy.set',
    'teams.members.add',
    'teams.members.role.set',
    'teams.groups.members.add',
    'teams.groups.restore',
    'teams.directory.sources.sync',
    'teams.directory.sources.resume',
    'teams.credentials.limits.upsert',
    'teams.credentials.limits.delete',
    'teams.credentials.test',
    'teams.credentials.externalKeys.authorize',
    'teams.identity.connections.enable',
    'teams.identity.connections.disable',
    'teams.identity.connections.test.start',
    'teams.identity.connections.test.consume',
    'home.identity.connections.enable',
    'home.identity.connections.disable',
    'home.identity.connections.test.start',
    'home.identity.connections.test.consume',
    'home.mailDelivery.test',
    'home.search.rebuild',
    // A person's own Service Start: reversible, and the Services page owns the designed setup/copy review.
    'localServices.launcher.start',
    'identity.providers.create',
    'identity.providers.update',
    'identity.providers.validate',
    'identity.providers.test.start',
    'identity.providers.test.consume',
    'identity.providers.enable',
    'identity.providers.disable',
    'identity.githubApps.create',
    'identity.githubApps.manifestSetup.start',
    'identity.githubApps.verifyInstallation',
  ] as const)(
    'applies declared direct %s only for the present user on UI',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expect(
          resolveActionApprovalRouting({ actionId, spec, settings, context })
            .required,
        ).toBe(false);
        for (const surface of ['agent', 'cli', 'mcp'] as const) {
          if (!spec.surfaces[surface]) continue;
          expect(
            resolveActionApprovalRouting({
              actionId,
              spec,
              settings,
              context: { ...context, surface },
            }).required,
            surface,
          ).toBe(true);
        }
        for (const ambiguous of [
          undefined,
          null,
          approvalContext('session_agent'),
        ]) {
          expect(
            resolveActionApprovalRouting({
              actionId,
              spec,
              settings,
              context: ambiguous,
            }).required,
            'ambiguous',
          ).toBe(true);
        }
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings,
            context: { surface: 'ui', authority: 'account_automation' },
          }).required,
        ).toBe(true);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings,
            context: { surface: 'ui' },
          }).required,
        ).toBe(true);
      }
      const ask = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({ actionId, spec, context, settings: ask })
          .required,
      ).toBe(false);
    },
  );

  it.each([
    'mcp.servers.delete',
    'registries.sources.delete',
    'skills.delete',
    'skills.machine.uninstall',
    'usage.sources.history.delete',
    'widgets.item.remove',
    'widgets.definition.delete',
    'widgets.fragment.delete',
    'widgets.area.layout.delete',
    'widgets.item.network.set',
    'session.board.item.remove',
    'artifact.delete',
    'artifact.public_link.revoke',
    'plugins.settings.reset',
    'plugins.settings.secret.delete',
    'machines.agents.install',
    'machines.agents.uninstall',
    'agents.acp.backends.installFromRegistry',
    'agents.acp.backends.delete',
    'teams.credentials.externalKeys.create',
    'teams.members.history.prepare',
    'identity.providers.secret.replace',
    'home.governance.claim',
    'machines.remove',
    'machines.managed.delete',
    'machines.managed.rebuild',
    'machines.managed.cancel',
    'machines.managed.retire',
    'machines.setup.apply',
    'machines.access.grant.set',
    'machines.access.prepareKeys',
    'machines.pools.delete',
    'scm.change.discard',
    'connectedServices.accounts.revoke',
    'connectedServices.pools.delete',
    'connectedServices.configuration.replace',
    'connectedServices.quota.reset',
  ] as const)('does not repeat the completed local confirmation for %s', (actionId) => {
    const spec = getActionSpec(actionId);
    for (const settings of [undefined, EMPTY_SETTINGS]) {
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings,
          context: { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId } },
        }).required,
      ).toBe(false);
    }
  });

  it('lets the present user retry a reversible managed-machine install directly while retaining the agent floor', () => {
    const actionId = 'machines.managed.bootstrap.retry';
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({
      actionId,
      spec,
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui', authority: 'present_user' },
    }).required).toBe(false);
    expect(resolveActionApprovalRouting({
      actionId,
      spec,
      settings: EMPTY_SETTINGS,
      context: { surface: 'agent', authority: 'account_automation' },
    }).required).toBe(true);
  });

  it.each([
    'teams.archive',
    'teams.members.remove',
    'teams.members.leave',
    'teams.invitations.revoke',
    'teams.groups.members.remove',
    'teams.credentials.delete',
    'teams.credentials.externalKeys.revoke',
    'teams.credentials.externalKeys.revokeAll',
    'teams.identity.connections.remove',
    'home.identity.connections.remove',
    'teams.directory.sources.remove',
    'identity.providers.remove',
    'session.public_link.remove',
    'home.accounts.delete',
    'home.accounts.signOutEverywhere',
    'home.public_profiles.handle_reclaim',
  ] as const)(
    'keeps destructive %s confirmation user-changeable on every exposed surface',
    (actionId) => {
      const spec = getActionSpec(actionId);
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        if (!spec.surfaces[surface]) continue;
        const context = {
          surface,
          authority: surface === 'ui' ? 'present_user' : 'account_automation',
        } as const;
        for (const settings of [undefined, EMPTY_SETTINGS]) {
          expect(
            resolveActionApprovalRouting({ actionId, spec, context, settings })
              .required,
            surface,
          ).toBe(surface !== 'ui');
          if (surface === 'ui') expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, settings }), true);
        }
        const waived = normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            context,
            settings: waived,
          }).required,
          surface,
        ).toBe(false);
        if (surface === 'ui') expectOwnUiReview(resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          settings: waived,
        }), false);
        const ask = normalizeActionsSettingsV1({
          ...waived,
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            context,
            settings: ask,
          }).required,
          surface,
        ).toBe(surface !== 'ui');
      }
    },
  );

  it.each([
    [
      { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222232', name: 'Work' } } },
      false,
    ],
    [
      {
        intent: {
          kind: 'update',
          boardId: 'board-1',
          patch: { name: 'Renamed' },
        },
      },
      false,
    ],
    [{ intent: { kind: 'add_items', boardId: 'board-1', refs: [] } }, false],
    [
      {
        intent: {
          kind: 'remove_item',
          boardId: 'board-1',
          ref: {
            kind: 'session',
            qualifiedId: { serverId: 'home-1', id: 'session-1' },
          },
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'set_positions',
          boardId: 'board-1',
          positionsByItemRef: {},
        },
      },
      false,
    ],
    [{ intent: { kind: 'delete', boardId: 'board-1' } }, true],
    // A person's own Board widget edits are as reversible as the same edit through widgets.item.*, which admits them directly.
    [
      {
        intent: {
          kind: 'widget_add',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
          instance: {
            v: 1,
            id: 'widget-1',
            definition: { kind: 'builtin', id: 'changes' },
            bindings: {},
          },
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'widget_remove',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'widget_move',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
          toIndex: 0,
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'widget_size',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
          size: 'wide',
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'widget_inputs_reset',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
        },
      },
      false,
    ],
    [
      {
        intent: {
          kind: 'widget_network',
          boardId: 'board-1',
          ref: {
            surface: {
              serverId: 'home-1',
              accountId: 'account-1',
              owner: { kind: 'workBoard', boardId: 'board-1' },
            },
            instanceId: 'widget-1',
          },
          network: { network: 'open' },
        },
      },
      true,
    ],
    [{ intent: { kind: 'delete' } }, true],
    [undefined, true],
  ] as const)(
    'confirms the Board intent consequence through shared policy: %j',
    (input, expected) => {
      const actionId = 'boards.apply';
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      if (input?.intent.kind.startsWith('widget_'))
        expect(spec.inputSchema.safeParse(input).success).toBe(true);
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context,
            settings,
          }).required,
        ).toBe(false);
        for (const surface of ['agent', 'mcp', 'cli'] as const) {
          expect(
            resolveActionApprovalRouting({
              actionId,
              spec,
              input,
              settings,
              context: { surface, authority: 'account_automation' },
            }).required,
            surface,
          ).toBe(true);
        }
      }
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: waived,
        }).required,
      ).toBe(false);
      const ask = normalizeActionsSettingsV1({
        ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: ask,
        }).required,
      ).toBe(false);
    },
  );

  it.each([
    [
      { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: 'Studio' } },
      false,
    ],
    [
      { expectedRevision: 2, values: { HAPPIER_HOME_DISPLAY_NAME: null } },
      false,
    ],
    [
      {
        expectedRevision: 2,
        values: {
          HAPPIER_HOME_DISPLAY_NAME: 'Studio',
          HAPPIER_PUBLIC_SERVER_URL: 'https://home.test',
        },
      },
      false,
    ],
    [
      {
        expectedRevision: 2,
        values: { HAPPIER_PUBLIC_SERVER_URL: 'https://home.test' },
      },
      false,
    ],
    [
      {
        expectedRevision: 2,
        values: { HAPPIER_HOME_DISPLAY_NAME: 'Studio' },
        secrets: {},
      },
      false,
    ],
    [
      {
        expectedRevision: 2,
        values: {},
        secrets: { SMTP_PASSWORD: { replace: 'new-secret' } },
      },
      true,
    ],
    [
      {
        expectedRevision: 2,
        values: {},
        secrets: { SMTP_PASSWORD: { clear: true } },
      },
      true,
    ],
    [{ expectedRevision: 2, values: {}, discardPendingRestart: true }, true],
    [{ expectedRevision: 2, values: {} }, true],
    [
      { expectedRevision: 2, values: { HAPPIER_HOME_DISPLAY_NAME: false } },
      true,
    ],
    [
      {
        expectedRevision: 2,
        values: { HAPPIER_HOME_DISPLAY_NAME: ['Studio'] },
      },
      true,
    ],
    [{ values: { HAPPIER_HOME_DISPLAY_NAME: 'Studio' } }, true],
    [
      {
        expectedRevision: 2,
        values: { HAPPIER_HOME_DISPLAY_NAME: 'Studio' },
        unknown: true,
      },
      true,
    ],
    [null, true],
    [undefined, true],
  ] as const)(
    'FA-4 admits reversible Home setting writes directly: %j',
    (input, required) => {
      const actionId = 'home.settings.set';
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expectOwnUiReview(resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          settings,
          input,
        }), required);
      }
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        if (!spec.surfaces[surface]) continue;
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context: { surface, authority: 'account_automation' },
          }).required,
        ).toBe(true);
      }
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: normalizeActionsSettingsV1({
          v: 1,
          actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
        }),
      }), true);
    },
  );

  it('FA-4 admits valid Home policy presses while retaining malformed-input review', () => {
    const actionId = 'home.policy.set';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const authentication = {
      expectedRevision: 6,
      authenticationPolicy: {
        v: 1,
        enabledMethodIds: ['key_challenge'],
        permittedAccountModes: ['e2ee'],
        admission: 'closed',
        signInService: null,
      },
    };
    for (const settings of [undefined, EMPTY_SETTINGS]) {
      for (const input of [
        authentication,
        { ...authentication, confirmWidening: true },
        { ...authentication, teamCreationPolicy: 'self_service' },
        { ...authentication, teamsVisibleToMembers: false },
        { expectedRevision: 6, teamProviderPolicy: null },
        { expectedRevision: 6, identityNetworkPolicy: null },
      ]) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            context,
            settings,
            input,
          }).required,
        ).toBe(false);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            settings,
            context: { surface: 'agent', authority: 'account_automation' },
          }).required,
        ).toBe(true);
      }
      for (const input of [
        undefined,
        null,
        { expectedRevision: 6 },
        { ...authentication, teamCreationPolicy: 'all_members' },
        { ...authentication, authenticationPolicy: { v: 2 } },
        { ...authentication, unknown: true },
      ])
        expectOwnUiReview(resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          settings,
          input,
        }), true, JSON.stringify(input));
    }
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        input: authentication,
        settings: normalizeActionsSettingsV1({
          v: 1,
          actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
        }),
      }).required,
    ).toBe(false);
  });

  it.each([
    'teams.identity.workos.adminPortalLink.create',
    'home.identity.workos.adminPortalLink.create',
  ] as const)(
    'FA-4 retains confirmation for unreviewed directory setup at %s',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      const base = {
        v: 1,
        connectionId: 'connection-1',
        ...(actionId.startsWith('teams.') ? { teamId: 'team-1' } : {}),
      };
      for (const input of [undefined, null, { ...base, intent: 'dsync' }]) {
        expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, input }), true);
      }
      for (const input of [
        { ...base, intent: 'sso' },
        { ...base, intent: 'dsync', directorySourceId: 'source-1' },
      ]) {
        expect(
          resolveActionApprovalRouting({ actionId, spec, context, input })
            .required,
        ).toBe(false);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context: { surface: 'agent', authority: 'account_automation' },
          }).required,
        ).toBe(true);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            context,
            input,
            settings: normalizeActionsSettingsV1({
              v: 1,
              actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
            }),
          }).required,
        ).toBe(false);
      }
    },
  );

  it('FA-4 keeps an Agent request to set the person’s name behind approval', () => {
    const actionId = 'account.name.set';
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        input: { name: 'Ada' },
        context: { surface: 'agent', authority: 'account_automation' },
        settings: EMPTY_SETTINGS,
      }).required,
    ).toBe(true);
  });

  it('admits reachability enable directly and confirms permanent identity retirement', () => {
    const actionId = 'home.reachability.iroh.set';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const input of [
      undefined,
      null,
      { mode: 'other' },
      { mode: 'enabled', unknown: true },
    ]) {
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, input }), true);
    }
    for (const mode of ['enabled', 'disabled'] as const) {
      const input = { mode };
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, input }), mode === 'disabled');
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context: { surface: 'agent', authority: 'account_automation' },
        }).required,
      ).toBe(true);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          input,
          settings: waived,
        }).required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        input,
        settings: waived,
      }), false);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          input,
          settings: normalizeActionsSettingsV1({
            ...waived,
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
          }),
        }).required,
      ).toBe(false);
    }
  });

  it.each([undefined, false, true])(
    'admits recoverable Trash movement directly unless emptyAfter=%s deletes it',
    (emptyAfter) => {
      const actionId = 'machines.storage.trash.move';
      const spec = getActionSpec(actionId);
      const input = {
        machineId: 'machine-1',
        items: [
          {
            ref: {
              itemId: 'cache-1',
              path: '/tmp/cache',
              identity: { dev: '1', ino: '2', kind: 'directory' },
              collectedAt: 0,
              collectedBy: { accountId: 'account-1', kind: 'person' },
            },
            expect: 'review-1',
            claimedVerdict: 'safe',
          },
        ],
        ...(emptyAfter === undefined ? {} : { emptyAfter }),
      };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      for (const settings of [undefined, EMPTY_SETTINGS]) {
        expectOwnUiReview(resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings,
        }), emptyAfter === true);
        for (const surface of ['agent', 'mcp', 'cli'] as const) {
          expect(
            resolveActionApprovalRouting({
              actionId,
              spec,
              input,
              settings,
              context: { surface, authority: 'account_automation' },
            }).required,
            surface,
          ).toBe(true);
        }
      }
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: waived,
        }).required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: waived,
      }), false);
      const ask = normalizeActionsSettingsV1({
        ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: ask,
        }).required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: ask,
      }), true);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input: { machineId: 'machine-1', items: [] },
        context,
      }), true);
    },
  );

  it('admits the person’s Team policy edit under Account Ask', () => {
    const actionId = 'teams.policy.set';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        settings: EMPTY_SETTINGS,
      }).required,
    ).toBe(false);
    const settings = normalizeActionsSettingsV1({
      v: 1,
      actions: {
        [actionId]: { approvalRequiredSurfaces: ['ui'] },
      },
    });
    expect(
      resolveActionApprovalRouting({ actionId, spec, context, settings })
        .required,
    ).toBe(false);
  });

  it('FA-4 retains Agent approval for a now-direct Team policy edit', () => {
    const actionId = 'teams.policy.set';
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings: EMPTY_SETTINGS,
        context: { surface: 'agent', authority: 'account_automation' },
      }).required,
    ).toBe(true);
  });

  it('admits reversible credential policy edits after the editor owns material-disclosure review', () => {
    const audience = {
      allMembersAllowedRoutes: null,
      groupGrants: [],
      memberGrants: [],
    };
    const create = {
      teamId: 'team-1',
      resourceId: 'resource-1',
      displayName: 'Shared',
      source: {
        v: 1,
        kind: 'provider_connection',
        connectionId: 'connection-1',
        connectionSecurityFingerprint: 'connection-security:v1:test',
        credentialSlotId: 'apiKey',
      },
      deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'team_context_required',
      brokerPlacement: { kind: 'machine', machineId: 'machine-1' },
      requestPolicy: null,
      ...audience,
      usageLimits: [],
    };
    const ref = { resourceId: 'resource-1', expectedRevision: 1 };
    const replacement = {
      enabled: true,
      displayName: 'Shared',
      sessionUsePolicy: 'team_context_required',
      requestPolicy: null,
      ...audience,
      usageLimitDelta: { upserts: [], deleteIds: [] },
    };
    const cases = [
      ['teams.credentials.create', create, false],
      ['teams.credentials.create', { ...create, deliveryPolicy: { preferredAllowedModes: ['vendor-native', 'brokered'] } }, true],
      ['teams.credentials.update', { ...ref, deliveryPolicy: { preferredAllowedModes: ['vendor-native', 'brokered'] } }, true],
      ['teams.credentials.update', { ...ref, replacement: { custodian: {
        source: { ...create.source, connectionId: 'replacement-key' },
        deliveryPolicy: { preferredAllowedModes: ['vendor-native'] }, brokerPlacement: null,
      } } }, true],
      ['teams.credentials.audience.set', { ...ref, ...audience, allMembersAllowedRoutes: ['vendor-native'] }, true],
      ['teams.credentials.update', { ...ref, replacement: {
        memberGrants: [{ teamMembershipId: 'member-1', allowedRoutes: ['vendor-native'] }],
      } }, true],
      [
        'teams.credentials.create',
        { ...create, allMembersAllowedRoutes: ['direct'] },
        false,
      ],
      [
        'teams.credentials.create',
        {
          ...create,
          memberGrants: [
            { teamMembershipId: 'member-1', allowedRoutes: ['brokered'] },
          ],
        },
        false,
      ],
      [
        'teams.credentials.update',
        { ...ref, displayName: 'Renamed', enabled: false },
        false,
      ],
      ['teams.credentials.update', { ...ref, replacement }, false],
      [
        'teams.credentials.update',
        {
          ...ref,
          replacement: { ...replacement, allMembersAllowedRoutes: ['brokered'] },
        },
        false,
      ],
      [
        'teams.credentials.update',
        { ...ref, deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] } },
        false,
      ],
      ['teams.credentials.audience.set', { ...ref, ...audience }, false],
      [
        'teams.credentials.audience.set',
        {
          ...ref,
          ...audience,
          groupGrants: [{ teamGroupId: 'group-1', allowedRoutes: ['direct'] }],
        },
        false,
      ],
    ] as const;
    for (const [actionId, input, required] of cases) {
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema.safeParse(input).success, actionId).toBe(true);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        input,
        settings: EMPTY_SETTINGS,
      }), required, JSON.stringify(input));
      const approvalScope = { kind: 'machine', machineId: 'execution-machine' } as const;
      const reviewed = { ...context, presentUserConfirmation: { actionId } };
      expect(resolveActionApprovalRouting({ actionId, spec, input, context: reviewed,
        settings: EMPTY_SETTINGS }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec, input, context: reviewed,
        settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
      }).required).toBe(false);
      if (required) {
        for (const unreviewed of [
          { ...reviewed, authority: 'account_automation' as const },
          { ...reviewed, actionCaller: { kind: 'plugin' as const, pluginId: 'example.plugin' } },
        ]) {
          expect(resolveActionApprovalRouting({ actionId, spec, input, context: unreviewed,
            settings: EMPTY_SETTINGS }).required).toBe(true);
        }
      }
      for (const surface of ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const) {
        const invocation = { surface, authority: 'present_user' } as const;
        const globalWaiver = normalizeActionsSettingsV1({ v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        const scopedWaiver = setScopedActionApprovalPreference({
          settings: EMPTY_SETTINGS, actionId, scope: approvalScope, surface, mode: 'waived',
        });
        for (const settings of [globalWaiver, scopedWaiver]) {
          expect(isApprovalRequiredByActionsSettings(actionId, settings, invocation,
            undefined, undefined, input, undefined, undefined, undefined, approvalScope),
          // No non-waivable floor (owner ruling 2026-10-29): the user's waiver wins.
          `${actionId}:${surface}:settings`).toBe(false);
          expect(resolveActionApprovalRouting({ actionId, spec, input, context: invocation,
            settings, approvalScope, requiredByPolicy: false,
          }).required, `${actionId}:${surface}:routing`).toBe(false);
          if (surface === 'ui') expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, input, context: invocation,
            settings, approvalScope, requiredByPolicy: false,
          }), false);
          // The existing admitted approval replay context, never an input flag,
          // still executes the exact action after a person approves it.
          expect(resolveActionApprovalRouting({ actionId, spec, input,
            context: { ...invocation, bypassApprovals: true }, settings,
          }).required).toBe(false);
        }
      }
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context: { surface: 'agent', authority: 'account_automation' },
        }).required,
      ).toBe(true);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        input,
        settings: normalizeActionsSettingsV1({
          v: 1,
          actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
        }),
      }), true);
      for (const malformed of [undefined, null, { ...input, unknown: true }]) {
        expectOwnUiReview(resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          input: malformed,
        }), true);
      }
    }
  });

  it('FA-4 confirms GitHub App secret replacement while ordinary edits stay direct', () => {
    const actionId = 'identity.githubApps.update';
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const base = {
      owner: { kind: 'home' },
      registrationId: 'app-1',
      expectedRevision: 1,
    };
    for (const [patch, required] of [
      [{ githubAppSlug: 'renamed' }, false],
      [{ secrets: {} }, false],
      [{ secrets: { privateKey: 'replacement' } }, true],
      [{ secrets: { clientSecret: null } }, true],
    ] as const) {
      const input = { ...base, patch };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, input }), required);
    }
    for (const input of [
      undefined,
      null,
      { ...base, patch: { unknown: true } },
    ]) {
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, context, input }), true);
    }
  });

  it('asks by default for automated "Until it changes" setup trust, and a waiver on that surface runs it', () => {
    const actionId = 'projects.prepare';
    const spec = getActionSpec(actionId);
    const input = { consentScope: 'untilChanged', heldOperationId: 'operation', expectedEffectDigest: 'digest' };
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
      const defaults = normalizeActionsSettingsV1({ v: 1 });
      expect(isApprovalRequiredByActionsSettings(actionId, defaults, context, undefined, undefined, input), surface).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, input, settings: defaults, context }), surface)
        .toMatchObject({ required: true, flow: 'deferred' });
      expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required, surface).toBe(true);
      // Owner ruling 2026-10-29: no non-waivable floor; the user's waiver is the decision.
      const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(resolveActionApprovalRouting({ actionId, spec, input, settings: waived, context }).required, surface).toBe(false);
    }
    // A CLI setup-trust request also asks by default.
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings: normalizeActionsSettingsV1({ v: 1 }),
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(true);
  });

  it('requires the first plugin Install & Trust disclosure and retains automation approval', () => {
    const actionId = 'plugins.install';
    const spec = getActionSpec(actionId);
    const context = {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    } as const;
    expectOwnUiReview(resolveActionApprovalRouting({
      actionId,
      spec,
      settings: EMPTY_SETTINGS,
      context,
    }), true);
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context: { ...context, presentUserConfirmation: { actionId } },
      }).required,
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({
      actionId,
      spec,
      context,
      settings: normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      }),
    }), true);
    for (const surface of ['agent', 'cli', 'mcp', 'plugin'] as const) {
      const automation = { surface, authority: 'account_automation' } as const;
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: EMPTY_SETTINGS,
          context: automation,
        }).required,
        surface,
      ).toBe(true);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context: automation,
          settings: normalizeActionsSettingsV1({
            v: 1,
            approvalWaivedSurfaces: { [actionId]: [surface] },
          }),
        }).required,
        surface,
      ).toBe(false);
    }
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
  });
  it('defaults declared dangerous registry writes to approval and honors surface waivers', () => {
    for (const [id, surface, required] of [
      ['registries.sources.create', 'ui', false],
      ['registries.sources.delete', 'ui', false],
      ['registries.sources.create', 'agent', true],
      ['registries.sources.delete', 'cli', true],
    ] as const) {
      const spec = getActionSpec(id);
      const context = {
        surface,
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      } as const;
      expect(
        resolveActionApprovalRouting({
          actionId: id,
          spec,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
      ).toBe(required);
      expect(
        resolveActionApprovalRouting({
          actionId: id,
          spec,
          settings: normalizeActionsSettingsV1({
            v: 1,
            approvalWaivedSurfaces: { [id]: [surface] },
          }),
          context,
        }).required,
      ).toBe(false);
    }
  });
  it('uses declared dangerous skill defaults and caller approval waivers', () => {
    for (const [id, surface, expected] of [
      ['skills.update', 'ui', false],
      ['skills.delete', 'ui', false],
      ['skills.install', 'agent', true],
      ['skills.create', 'cli', true],
    ] as const) {
      const spec = getActionSpec(id),
        context = {
          surface,
          authority: 'present_user',
          actionCaller: { kind: 'host' },
        } as const;
      expect(
        resolveActionApprovalRouting({
          actionId: id,
          spec,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
      ).toBe(expected);
      expect(
        resolveActionApprovalRouting({
          actionId: id,
          spec,
          settings: normalizeActionsSettingsV1({
            v: 1,
            approvalWaivedSurfaces: { [id]: [surface] },
          }),
          context,
        }).required,
      ).toBe(false);
    }
  });
  it('defaults dangerous MCP writes to approval outside declared present-user direct UI intents', () => {
    const toolSet = getActionSpec('mcp.servers.tools.set');
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      const context = {
        surface,
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      } as const;
      expect(
        resolveActionApprovalRouting({
          actionId: toolSet.id,
          spec: toolSet,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
      ).toBe(surface !== 'ui');
    }
    const context = {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    } as const;
    for (const declaration of MCP_SERVER_ACTION_SPECS_V1) {
      if (declaration.sideEffectClass === 'read') continue;
      const spec = getActionSpec(declaration.id);
      expect(
        resolveActionApprovalRouting({
          actionId: spec.id,
          spec,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
        spec.id,
      ).toBe(false);
    }
    for (const id of [
      'mcp.servers.create',
      'mcp.servers.update',
      'mcp.servers.import',
      'mcp.found.adopt',
    ] as const) {
      const spec = getActionSpec(id);
      for (const surface of ['agent', 'cli', 'mcp'] as const)
        expect(
          resolveActionApprovalRouting({
            actionId: id,
            spec,
            settings: EMPTY_SETTINGS,
            context: {
              surface,
              authority: 'present_user',
              actionCaller: { kind: 'host' },
            },
          }).required,
        ).toBe(true);
    }
    for (const id of ['mcp.servers.import', 'mcp.found.adopt'] as const) {
      const spec = getActionSpec(id);
      expect(spec.approvalInputCustody).toBe('live_only');
      expect(
        JSON.stringify(
          spec.projectObservationInput?.({
            source: { kind: 'paste', text: 'private-value' },
            values: { API_KEY: { t: 'literal', v: 'private-value' } },
          }),
        ),
      ).not.toContain('private-value');
    }
  });

  it('keeps Fork B Project, service, worker, shell and child-machine approval defaults user-changeable', () => {
    const actions = ACTION_IDS.filter(
      (id) =>
        id.startsWith('localServices.') ||
        id.startsWith('projects.worker.') ||
        id.startsWith('projects.service.') ||
        id.startsWith('projects.execution.output.') ||
        id.startsWith('machines.worker.') ||
        id.startsWith('session.terminals.') ||
        id.startsWith('machines.terminal.') ||
        id.startsWith('machines.managed.') ||
        [
          'projects.open',
          'projects.inspect',
          'projects.manifest.update',
          'projects.trust.list',
          'projects.trust.revoke',
          'projects.prepare',
          'projects.script.run',
          'projects.compute.exec',
          'wait',
          'action.operations.list',
          'action.operations.get',
          'action.operations.cancel',
          'machines.managed.acquire',
          'machines.managed.rebuild',
          'machines.managed.power.set',
          'workspace.sync.relationship.create',
        ].includes(id),
    );
    for (const actionId of actions) {
      const spec = getActionSpec(actionId);
      for (const surface of [
        'ui',
        'cli',
        'agent',
        'mcp',
        'voice',
        'rpc',
        'api',
        'plugin',
      ] as const) {
        if (!spec.surfaces[surface]) continue;
        const context = { surface, authority: 'account_automation' } as const;
        const waived = normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: waived,
            context,
          }).required,
          `${actionId}/${surface}`,
        ).toBe(false);
        const required = normalizeActionsSettingsV1({
          ...waived,
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: required,
            context,
          }).required,
          `${actionId}/${surface}`,
        ).toBe(true);
      }
    }
  });
  it('allows explicit policy waivers for every configuration parity Action while explicit requirements still win', () => {
    const actions = [
      'plugins.execution_origin.list',
      'plugins.execution_origin.set',
      'plugins.execution_origin.clear',
      'diagnostics.diagnosis.run',
      'diagnostics.daemons.check',
      'diagnostics.status.get',
      'clipboard.write',
      'updates.get',
      'machines.cli.update',
      'updates.check',
      'updates.batch.start',
      'updates.batch.stop',
      'session.draft.open',
      'session.draft.delete',
      'account.signOut',
      'account.credentials.forgetAll',
      'account.delete',
      'bugreport.submit',
      'settings.get',
      'settings.set',
      'plugins.settings.list',
      'plugins.settings.get',
      'plugins.settings.set',
      'plugins.settings.reset',
      'plugins.settings.secret.status',
      'plugins.settings.secret.bind',
      'plugins.settings.secret.unbind',
      'plugins.settings.secret.delete',
      'app.updates.get',
      'app.updates.check',
      'app.updates.update',
      'app.updates.retry',
      'app.updates.restart',
      'app.updates.skip',
      'machines.agents.install',
      'machines.capabilities.install',
      'launch_profiles.enabled.set',
      'launch_profiles.favorite.set',
      'launch_profiles.save',
      'launch_profiles.delete',
      'artifact.folders.create',
      'artifact.folders.rename',
      'artifact.folders.move',
      'artifact.folders.delete',
      'connectedServices.accounts.revoke',
      'connectedServices.pools.delete',
      'relay.runtime.open_path',
    ] as const satisfies readonly ActionId[];
    for (const actionId of actions) {
      const spec = getActionSpec(actionId);
      for (const surface of ['ui', 'agent', 'mcp'] as const) {
        if (!spec.surfaces[surface]) continue;
        const context = {
          surface,
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
        } as const;
        const waived = normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: waived,
            context,
          }).required,
          `${actionId} on ${surface}`,
        ).toBe(false);
        const required = normalizeActionsSettingsV1({
          ...waived,
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: required,
            context,
          }).required,
        ).toBe(true);
      }
    }
  });

  it.each([
    'account.delete',
    'launch_profiles.delete',
    'session.draft.delete',
  ] as const)(
    'retains declared Account, profile and saved-draft deletion confirmation: %s',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      } as const;
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context,
      }), true, actionId);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          settings: normalizeActionsSettingsV1({
            v: 1,
            approvalWaivedSurfaces: { [actionId]: ['ui'] },
          }),
        }).required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        context,
        settings: normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: ['ui'] },
        }),
      }), false);
    },
  );

  it('keeps Fork D confirmation defaults user-waivable on every automation surface', () => {
    for (const actionId of [
      'notifications.desktop.permission.request',
      'notifications.push.permission.request',
      'browser.automation.cancelActive',
      'computer.target.close',
      'plugin.webhook.delivery.replay',
      'plugin.webhook.delivery.discard',
    ] as const) {
      const spec = getActionSpec(actionId);
      for (const surface of ['agent', 'mcp', 'plugin', 'api'] as const) {
        const context = { surface, authority: 'account_automation' } as const;
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: EMPTY_SETTINGS,
            context,
          }).required,
          `${actionId}:${surface}`,
        ).toBe(true);
        const settings = normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        expect(
          resolveActionApprovalRouting({ actionId, spec, settings, context })
            .required,
          `${actionId}:${surface}`,
        ).toBe(false);
        const required = normalizeActionsSettingsV1({
          ...settings,
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: required,
            context,
          }).required,
          `${actionId}:${surface}`,
        ).toBe(true);
      }
    }
    for (const actionId of [
      'plugin.webhook.delivery.replay',
      'plugin.webhook.delivery.discard',
    ] as const) {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context,
      }), true);
      const settings = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({ actionId, spec, settings, context })
          .required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, settings, context }), false);
    }
    const actionId = 'session.view.toolCalls.set';
    const spec = getActionSpec(actionId);
    const context = { surface: 'cli', authority: 'present_user' } as const;
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: EMPTY_SETTINGS,
        context,
      }).required,
    ).toBe(false);
    const settings = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['cli'] },
    });
    expect(
      resolveActionApprovalRouting({ actionId, spec, settings, context })
        .required,
    ).toBe(false);
    const required = normalizeActionsSettingsV1({
      ...settings,
      actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } },
    });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: required,
        context,
      }).required,
    ).toBe(true);
  });
  it('applies the declared MCP safety to the present user, CLI and Agents', () => {
    for (const actionId of ACTION_IDS.filter((id) =>
      id.startsWith('mcp.servers.'),
    )) {
      const spec = getActionSpec(actionId);
      const danger = spec.safety === 'danger';
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: EMPTY_SETTINGS,
          context: {
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
          },
        }).required,
        actionId,
      ).toBe(false);
      for (const surface of ['agent', 'cli', 'mcp'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: EMPTY_SETTINGS,
            context: { surface, authority: 'account_automation' },
          }).required,
          `${actionId}:${surface}`,
        ).toBe(danger);
      }
    }
  });
  it.each(['mcp.rules.set', 'skills.rules.set'] as const)(
    'applies %s directly on UI and asks automation unless waived',
    (actionId) => {
      const spec = getActionSpec(actionId);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: EMPTY_SETTINGS,
          context: {
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
          },
        }).required,
      ).toBe(false);
      for (const surface of ['agent', 'cli', 'mcp'] as const) {
        const context = { surface, authority: 'account_automation' } as const;
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: EMPTY_SETTINGS,
            context,
          }).required,
        ).toBe(true);
        const waived = normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [actionId]: [surface] },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: waived,
            context,
          }).required,
        ).toBe(false);
      }
    },
  );
  it('keeps dangerous widget edits configurable while reversible UI defaults are direct', () => {
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const confirmedByDefault = new Set<ActionId>([
      'widgets.definition.update', 'widgets.definition.delete', 'widgets.fragment.delete',
      'widgets.snapshot.post', 'widgets.item.remove', 'widgets.item.network.set', 'widgets.area.layout.delete',
    ]);
    for (const actionId of ACTION_IDS.filter(
      (id) =>
        id.startsWith('widgets.') && getActionSpec(id).safety === 'danger',
    )) {
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
        actionId,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: EMPTY_SETTINGS, context }), confirmedByDefault.has(actionId));
      const settings = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, settings, context),
        actionId,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings, context }), false);
      expect(
        isApprovalRequiredByActionsSettings(actionId, settings, {
          surface: 'agent',
        }),
        actionId,
      ).toBe(true);
    }
  });
  it('confirms force-with-lease while ordinary push stays direct and the summary names the replacement', () => {
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const lease = {
      cwd: '/repo',
      remote: 'origin',
      branch: 'main',
      pushMode: 'force_with_lease',
      expectedRemoteOid: 'abcdef0123456789abcdef0123456789abcdef01',
    };
    const ordinary = { cwd: '/repo', remote: 'origin', branch: 'main' };
    expect(
      isApprovalRequiredByActionsSettings(
        'scm.remote.push',
        EMPTY_SETTINGS,
        context,
        undefined,
        undefined,
        lease,
      ),
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId: 'scm.remote.push', spec: getActionSpec('scm.remote.push'), settings: EMPTY_SETTINGS, context, input: lease }), true);
    expect(
      isApprovalRequiredByActionsSettings(
        'scm.remote.push',
        EMPTY_SETTINGS,
        context,
        undefined,
        undefined,
        ordinary,
      ),
    ).toBe(false);
    // The caller already recorded the person's answer to this exact press, and an explicit Allowed still wins.
    expect(
      isApprovalRequiredByActionsSettings(
        'scm.remote.push',
        EMPTY_SETTINGS,
        {
          ...context,
          presentUserConfirmation: { actionId: 'scm.remote.push' },
        },
        undefined,
        undefined,
        lease,
      ),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings(
        'scm.remote.push',
        normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { 'scm.remote.push': ['ui'] },
        }),
        context,
        undefined,
        undefined,
        lease,
      ),
    ).toBe(false);
    const summary = (input: unknown) =>
      getActionSpec('scm.remote.push').approvalPresentation?.summary(input) ??
      '';
    expect(summary(lease)).toContain('origin/main');
    expect(summary(lease)).toContain('abcdef0');
    expect(summary(ordinary)).toBe('Push your commits to origin/main.');
  });
  it('resolves legacy-conversion approval defaults and waivers without granting execution consent', () => {
    const actionId = 'workflow.trigger.update' as const;
    const spec = getActionSpec(actionId);
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      const settings = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: [surface] },
      });
      const args = {
        actionId,
        spec,
        settings,
        context: { surface, authority: 'account_automation' as const },
        input: { confirmLegacyConversion: true },
      };
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          EMPTY_SETTINGS,
          args.context,
          undefined,
          undefined,
          args.input,
        ),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          settings,
          args.context,
          undefined,
          undefined,
          args.input,
        ),
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({ ...args, requiredByPolicy: false }),
      ).toMatchObject({ required: false });
      if (surface !== 'agent') {
        expect(
          resolveActionApprovalRouting({
            ...args,
            requiredByPolicy: false,
            input: { confirmLegacyConversion: false },
          }).required,
        ).toBe(false);
      }
    }
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        requiredByPolicy: false,
        input: { confirmLegacyConversion: true },
        context: {
          surface: 'ui',
          authority: 'present_user',
          actionCaller: { kind: 'host' },
        },
      }).required,
    ).toBe(false);
  });
  it('defaults Teams parity requests to approval and honors requester surface waivers', () => {
    for (const actionId of [
      'teams.invitations.create',
      'teams.invitations.reissue',
      'teams.credentials.test',
      'teams.directory.sources.remove',
      'teams.directory.sources.remove.preview',
    ] as const) {
      const settings = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: [] } },
        approvalWaivedSurfaces: { [actionId]: ['agent', 'mcp'] },
      });
      for (const surface of ['agent', 'mcp'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec: getActionSpec(actionId),
            settings: EMPTY_SETTINGS,
            context: { surface, authority: 'account_automation' },
          }).required,
        ).toBe(true);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec: getActionSpec(actionId),
            settings,
            requiredByPolicy: false,
            context: { surface, authority: 'account_automation' },
          }),
          `${actionId}:${surface}`,
        ).toMatchObject({ required: false, result: 'required' });
      }
    }
  });
  it('retains Account service replacement review and Agent Ask without a separate prompt', () => {
    const actionId = 'connectedServices.configuration.replace' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(
      isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: EMPTY_SETTINGS, context }), true);
    expect(
      isApprovalRequiredByActionsSettings(
        'connectedServices.configuration.get',
        EMPTY_SETTINGS,
        context,
      ),
    ).toBe(false);
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(
      false,
    );
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: waived, context }), false);
    expect(
      isApprovalRequiredByActionsSettings(actionId, waived, {
        surface: 'agent',
      }),
    ).toBe(true);
  });
  it('admits direct notification endpoint edits through the canonical surface policy', () => {
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const actionId of NOTIFICATION_CONFIGURATION_ACTION_IDS) {
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
        actionId,
      ).toBe(false);
    }
    const actionId = 'notifications.webhooks.signingSecret.clear' as const;
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(
      false,
    );
    expect(
      isApprovalRequiredByActionsSettings(actionId, waived, {
        surface: 'agent',
      }),
    ).toBe(true);
    const required = normalizeActionsSettingsV1({
      ...waived,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    });
    expect(
      isApprovalRequiredByActionsSettings(actionId, required, context),
    ).toBe(true);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: required, context }), true);
  });
  it('retains the declared UI clear-index confirmation and the automated approval default', () => {
    const actionId = 'memory.clear_index' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(
      isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings: EMPTY_SETTINGS, context }), true);
    const settings = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(
      isApprovalRequiredByActionsSettings(actionId, settings, context),
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings, context }), false);
    expect(
      isApprovalRequiredByActionsSettings(actionId, settings, {
        surface: 'agent',
      }),
    ).toBe(true);
  });
  it('keeps semantic filesystem RPC effects Ask-first without changing the general internal RPC exemption', () => {
    const context = {
      surface: 'rpc',
      authority: 'account_automation',
    } as const;
    const readActions: ReadonlySet<ActionId> = new Set([
      'daemon.filesystem.readFile',
      'daemon.filesystem.listDirectory',
      'daemon.filesystem.getDirectoryTree',
    ]);
    for (const actionId of FILESYSTEM_ACTION_IDS.filter(
      (id) => !readActions.has(id),
    )) {
      const args = {
        actionId,
        spec: getActionSpec(actionId),
        context,
        settings: EMPTY_SETTINGS,
      };
      expect(resolveActionApprovalRouting(args).required, actionId).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
        actionId,
      ).toBe(true);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['rpc'] },
      });
      expect(
        resolveActionApprovalRouting({ ...args, settings: waived }).required,
        actionId,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          ...args,
          settings: waived,
          context: { surface: 'agent', authority: 'account_automation' },
        }).required,
        actionId,
      ).toBe(true);
      const required = normalizeActionsSettingsV1({
        ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: ['rpc'] } },
      });
      expect(
        resolveActionApprovalRouting({ ...args, settings: required }).required,
        actionId,
      ).toBe(true);
    }
    expect(
      resolveActionApprovalRouting({
        actionId: 'artifact.delete',
        spec: getActionSpec('artifact.delete'),
        context,
        settings: EMPTY_SETTINGS,
      }).required,
    ).toBe(false);
    for (const actionId of readActions) {
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          context,
          settings: EMPTY_SETTINGS,
        }).required,
        actionId,
      ).toBe(false);
    }
  });

  // Owner ruling 2026-11-07 "Agent actions": the person's own app press is the consent,
  // including after Home admits that exact press and relays it to the Machine executor.
  it.each(['daemon.filesystem.writeFile', 'browser.view.open', 'browser.extensions.install'] as const)(
    'keeps Home-admitted present-user %s direct under Account Ask while other origins still ask', actionId => {
    type Authorization = NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>;
    const homeAdmission = (binding: Record<string, unknown> = {}) => ({ token: 'home-issued', binding: {
      accountId: 'account', custodianAccountId: 'account', serverIdentityId: 'srv', machineId: 'machine', installationId: 'installation',
      actionId, requestId: 'request', requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
      authentication: { kind: 'account', tokenEpoch: 1 }, ...binding } }) as unknown as Authorization;
    const machineContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: 'machine' }, externalActionExecutionAuthorization: homeAdmission() } as const;
    const route = (context: Parameters<typeof resolveActionApprovalRouting>[0]['context'], settings = EMPTY_SETTINGS, routedActionId: ActionId = actionId) =>
      resolveActionApprovalRouting({ actionId: routedActionId, spec: getActionSpec(routedActionId), input: {}, context, settings }).required;

    expect(route(machineContext)).toBe(false);
    expect(route({ ...machineContext, authority: 'account_automation' })).toBe(true);
    expect(route({ ...machineContext, actionCaller: { kind: 'session', sessionId: 'session' } })).toBe(true);
    expect(route({ ...machineContext, surface: 'agent' })).toBe(true);
    expect(route({ ...machineContext, externalActionExecutionAuthorization: homeAdmission({ authentication: { kind: 'terminal', tokenEpoch: 1 } }) })).toBe(true);
    expect(route({ ...machineContext, externalActionExecutionAuthorization: homeAdmission({ sessionActionOrigin: { sessionId: 'session' } }) })).toBe(true);
    expect(route({ ...machineContext, externalActionExecutionAuthorization: homeAdmission({ workflowActionOrigin: { runId: 'run' } }) })).toBe(true);
    expect(route({ ...machineContext, externalActionExecutionAuthorization: homeAdmission({ actionId: 'scm.commit.create' }) })).toBe(true);
    expect(route({ ...machineContext, externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: null } } as never)).toBe(true);
    expect(route(machineContext, normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }))).toBe(false);
    // An undeclared UI confirmation no longer inherits the agent danger floor.
    expect(route({ ...machineContext, externalActionExecutionAuthorization: homeAdmission({ actionId: 'scm.branch.rebase' }) },
      EMPTY_SETTINGS, 'scm.branch.rebase')).toBe(false);
    // The Home hop preserves both the designed policy review and the destructive
    // Account deletion confirmation, rather than treating every UI effect as direct.
    for (const confirmedAction of ['machines.managed.cancel', 'account.delete'] as const) {
      expectOwnUiReview(resolveActionApprovalRouting({ actionId: confirmedAction, spec: getActionSpec(confirmedAction), input: {},
        context: { ...machineContext, externalActionExecutionAuthorization: homeAdmission({ actionId: confirmedAction }) },
        settings: EMPTY_SETTINGS }), true);
    }
  });

  it('keeps saved UI Ask out of headless surfaces while retaining their own explicit Ask', () => {
    const actionId = 'machines.services.logs.read';
    const spec = getActionSpec(actionId);
    const uiAsk = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    for (const surface of ['cli', 'api', 'rpc', 'agent', 'mcp'] as const) {
      const context = { surface, authority: surface === 'cli' || surface === 'api'
        ? 'present_user' as const : 'account_automation' as const,
        actionCaller: { kind: 'host' as const } };
      const baseline = resolveActionApprovalRouting({ actionId, spec, context, settings: EMPTY_SETTINGS });
      const configured = resolveActionApprovalRouting({ actionId, spec, context, settings: uiAsk });
      expect(configured, surface).toEqual(baseline);
      expect(configured.uiConfirmationRequired, surface).toBeUndefined();
      const ownAsk = normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: [surface] },
      } });
      const asked = resolveActionApprovalRouting({ actionId, spec, context, settings: ownAsk });
      expect(asked.required, surface).toBe(true);
      expect(asked.uiConfirmationRequired, surface).toBeUndefined();
    }
  });

  it('retains declared managed-creation cancellation confirmation and the automated default', () => {
    const actionId = 'machines.managed.cancel' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const args = {
      actionId,
      spec: getActionSpec(actionId),
      input: {
        homeId: 'home',
        managedId: 'waiting',
        expectedIntentRevision: 0,
      },
      context,
    };
    expect(resolveActionApprovalRouting(args)).toMatchObject({
      required: false,
      uiConfirmationRequired: true,
    });
    const settings = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(resolveActionApprovalRouting({ ...args, settings }).required).toBe(
      false,
    );
    expectOwnUiReview(resolveActionApprovalRouting({ ...args, settings }), false);
    expect(
      resolveActionApprovalRouting({
        ...args,
        settings,
        context: { surface: 'agent', authority: 'account_automation' },
      }).required,
    ).toBe(true);
  });
  it('keeps contextual UI consequences confirmed while a direct press answers Account Ask', () => {
    const actionId = 'artifact.update' as const;
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
    };
    const args = {
      actionId,
      spec: getActionSpec(actionId),
      context,
      settings: EMPTY_SETTINGS,
    };
    // The key-holding host classifies the admitted document from current exposure;
    // the policy must not assume that this UI already presented a separate review.
    expect(
      resolveActionApprovalRouting({ ...args, defaultSafety: 'danger' }),
    ).toMatchObject({
      required: false,
      uiConfirmationRequired: true,
      flow: 'blocking',
    });
    expect(
      resolveActionApprovalRouting({ ...args, defaultSafety: 'safe' }).required,
    ).toBe(false);
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(
      resolveActionApprovalRouting({
        ...args,
        defaultSafety: 'danger',
        settings: waived,
      }).required,
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({
      ...args,
      defaultSafety: 'danger',
      settings: waived,
    }), false);
    const required = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expectOwnUiReview(resolveActionApprovalRouting({
      ...args,
      defaultSafety: 'safe',
      settings: required,
    }), true);
    // A direct press does not add a second card from the declaration alone.
    expect(resolveActionApprovalRouting(args).required).toBe(false);
  });
  it('admits direct notice and document edits while honoring explicit Ask on UI and automation', () => {
    const actionId = 'artifact.update' as const;
    const spec = getActionSpec(actionId);
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
    };
    const base = {
      artifactId: 'notice-1',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      body: '{}',
    };
    const notice = {
      v: 1,
      kind: 'account_notice.v1',
      title: 'Review updated',
      status: 'open',
    };
    for (const header of [
      { ...notice, readAt: 1 },
      { ...notice, status: 'dismissed' },
      { v: 1, kind: 'usage_notice.v1', title: 'Usage', status: 'dismissed' },
    ]) {
      const input = { ...base, header };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          input,
          settings: EMPTY_SETTINGS,
        }).required,
      ).toBe(false);
      // Agents and automation keep the declared danger floor.
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          settings: EMPTY_SETTINGS,
          context: { surface: 'agent', authority: 'account_automation' },
        }).required,
      ).toBe(true);
    }
    for (const input of [
      undefined,
      { ...base, header: { kind: 'document.v1', title: 'Notes' } },
    ]) {
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context,
          input,
          settings: EMPTY_SETTINGS,
        }).required,
      ).toBe(false);
    }
    const required = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    });
    expectOwnUiReview(resolveActionApprovalRouting({
      actionId,
      spec,
      context,
      settings: required,
      input: { ...base, header: { ...notice, readAt: 1 } },
    }), true);
    expect(resolveActionApprovalRouting({ actionId, spec, settings: required,
      context: { surface: 'agent', authority: 'account_automation' },
      input: { ...base, header: { ...notice, readAt: 1 } } }).required).toBe(true);
  });
  it('returns durable approvals for CLI, Agent and MCP callers', () => {
    for (const actionId of [
      'connectedServices.pools.create',
      'artifact.update',
    ] as const) {
      const spec = getActionSpec(actionId);
      for (const authority of ['present_user', 'account_automation'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: EMPTY_SETTINGS,
            context: { surface: 'cli', authority },
          }),
        ).toEqual({ required: true, flow: 'deferred', result: 'required' });
      }
      for (const surface of ['agent', 'mcp'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            settings: EMPTY_SETTINGS,
            context: { surface, authority: 'account_automation' },
          }),
        ).toEqual({ required: true, flow: 'deferred', result: 'required' });
      }
    }
  });

  it('returns a managed-machine Ask for an automation-narrowed UI Account carrier', () => {
    const actionId = 'machines.managed.acquire' as const;
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings: EMPTY_SETTINGS,
        context: { surface: 'ui', authority: 'account_automation' },
      }),
    ).toEqual({ required: true, flow: 'deferred', result: 'required' });
    const liveOnlyActionId = 'account.apiTokens.create' as const;
    expect(
      resolveActionApprovalRouting({
        actionId: liveOnlyActionId,
        spec: getActionSpec(liveOnlyActionId),
        requiredByPolicy: true,
        context: { surface: 'ui', authority: 'account_automation' },
      }),
    ).toEqual({ required: true, flow: 'deferred', result: 'required' });
  });

  it('keeps the current managed Power Ask on a retained host operation while ordinary CLI remains deferred', () => {
    const actionId = 'machines.managed.power.set' as const;
    const args = {
      actionId,
      spec: getActionSpec(actionId),
      settings: EMPTY_SETTINGS,
      input: {
        homeId: 'home',
        managedId: 'managed',
        intent: 'stop',
        when: 'now',
        expectedRevision: 2,
      },
      context: {
        surface: 'cli',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      } as const,
    };
    expect(resolveActionApprovalRouting(args)).toMatchObject({
      required: true,
      flow: 'deferred',
    });
    // This flag is supplied by the executor's private actual-operation port,
    // not by Action input, requester context or an approval bypass.
    const retained = { ...args, retainHostOperationApproval: true };
    expect(resolveActionApprovalRouting(retained)).toMatchObject({
      required: true,
      flow: 'blocking',
    });
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['cli'] },
    });
    expect(
      resolveActionApprovalRouting({ ...retained, settings: waived }).required,
    ).toBe(false);
  });

  it('keeps personal Machine reads direct and preserves automated exact-daemon replay custody', () => {
    const actionId = 'workspace.files.replace.preview' as const;
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse({ machineId: 'machine', rootPath: '/repo', query: 'old', replacement: 'new' });
    const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      retainHostOperationApproval: true, context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
    })).toMatchObject({ required: false });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      retainHostOperationApproval: true, context: { surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' } },
    })).toMatchObject({ required: true, flow: 'deferred', result: 'required' });
  });

  it('keeps personal logs direct while retaining automated Resource approval custody', () => {
    const actionId = 'machines.services.logs.read' as const;
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse({ serverId: 'home', machineId: 'machine', serviceId: 'service' });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      machineServiceLogsResource: { expectedGeneration: 'generation', sourceRevision: 'source' } };
    const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      retainHostOperationApproval: true, context,
    })).toMatchObject({ required: false });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      context: { ...context, machineServiceLogsResource: undefined },
    })).toMatchObject({ required: false });
    const automated = { ...context, authority: 'account_automation' as const };
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      retainHostOperationApproval: true, context: automated,
    })).toMatchObject({ required: true, flow: 'blocking', result: 'required' });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings,
      context: { ...automated, machineServiceLogsResource: undefined },
    })).toMatchObject({ required: true, flow: 'deferred', result: 'required' });
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, settings: waived,
      retainHostOperationApproval: true, context,
    }).required).toBe(false);
  });

  it('keeps personal plugin Settings direct and automated field approval on its live owner', () => {
    const actionId = 'plugins.settings.set';
    const spec = getActionSpec(actionId);
    const settings = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    });
    const context = {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      isPluginSettingsIntentCurrent: () => true,
    } as const;
    expect(
      resolveActionApprovalRouting({ actionId, spec, settings, context }),
    ).toMatchObject({ required: false });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings,
        context: { ...context, actionCaller: undefined },
      }),
    ).toMatchObject({ required: false });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings,
        context: { ...context, authority: 'account_automation' },
      }),
    ).toMatchObject({ required: true, flow: 'blocking' });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings,
        context: { surface: 'ui', authority: 'present_user' },
      }),
    ).toMatchObject({ required: false });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings,
        context: { ...context, surface: 'cli' },
      }),
    ).toMatchObject({ required: true, flow: 'deferred' });
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec,
        settings: waived,
        context,
      }),
    ).toMatchObject({ required: false });
  });

  it('requires agent, MCP and plugin permission-answer approval by default and honors explicit waivers', () => {
    const actionId = 'session.permission.respond';
    for (const surface of ['agent', 'mcp', 'plugin'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          context,
        }).required,
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
      ).toBe(true);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: [surface] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, waived, context),
      ).toBe(false);
      const required = normalizeActionsSettingsV1({
        ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, required, context),
      ).toBe(true);
    }
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
        surface: 'ui',
        authority: 'present_user',
      }),
    ).toBe(false);
  });
  it('keeps declared dangerous widget and Board edits configurable, with contextual Home safety', () => {
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
    };
    const shared = {
      serverId: 'home',
      accountId: 'account',
      owner: { kind: 'sessionBoard', sessionId: 'shared' },
    } as const;
    const personal = { ...shared, owner: { kind: 'home' } } as const;
    const edits = [
      { actionId: 'session.board.layout.update', input: {}, required: false },
      { actionId: 'session.board.item.upsert', input: {}, required: false },
      { actionId: 'widgets.definition.update', input: {}, required: true },
      { actionId: 'widgets.definition.delete', input: {}, required: true },
      { actionId: 'widgets.snapshot.post', input: {}, required: true },
      {
        actionId: 'widgets.item.remove',
        input: { ref: { surface: personal, instanceId: 'group' } },
        required: false,
      },
      {
        actionId: 'widgets.item.remove',
        required: false,
        input: {
          ref: {
            surface: {
              ...personal,
              owner: { kind: 'corePage', pageId: 'usage', area: 'main' },
            },
            instanceId: 'group',
          },
        },
      },
      {
        actionId: 'home.hub.layout.update',
        input: { intent: { kind: 'remove', instanceId: 'group' } },
        required: false,
      },
      {
        actionId: 'home.hub.layout.update',
        input: { intent: { kind: 'widget_remove', instanceId: 'copy' } },
        required: false,
      },
      {
        actionId: 'widgets.item.frame.set',
        input: { ref: { surface: shared, instanceId: 'copy' } },
        required: false,
      },
      {
        actionId: 'widgets.item.move',
        required: true,
        input: {
          ref: { surface: personal, instanceId: 'copy' },
          to: { surface: shared, index: 0 },
        },
      },
    ] as const;
    for (const edit of edits) {
      const args = {
        ...edit,
        spec: getActionSpec(edit.actionId),
        context,
        settings: normalizeActionsSettingsV1({ v: 1 }),
      };
      expect.soft(resolveActionApprovalRouting(args).required, edit.actionId).toBe(false);
      expect.soft(resolveActionApprovalRouting(args).uiConfirmationRequired === true, edit.actionId)
        .toBe(edit.required);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [edit.actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({ ...args, settings: waived }).required,
        edit.actionId,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({ ...args, settings: waived }), false);
    }
    for (const owner of [
      { kind: 'home' },
      { kind: 'companion', sessionId: 'shared' },
    ] as const) {
      const args = {
        actionId: 'widgets.item.frame.set',
        spec: getActionSpec('widgets.item.frame.set'),
        input: { ref: { surface: { ...shared, owner }, instanceId: 'copy' } },
        context,
        settings: normalizeActionsSettingsV1({ v: 1 }),
      } as const;
      expect(resolveActionApprovalRouting(args).required).toBe(false);
      // The person’s reversible presentation edit also answers Account Ask.
      expect(
        resolveActionApprovalRouting({ ...args, defaultSafety: 'safe' })
          .required,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          ...args,
          defaultSafety: 'safe',
          settings: normalizeActionsSettingsV1({
            v: 1,
            actions: {
              'widgets.item.frame.set': { approvalRequiredSurfaces: ['ui'] },
            },
          }),
        }).required,
      ).toBe(false);
    }
    expect(
      resolveActionApprovalRouting({
        actionId: 'home.hub.layout.update',
        spec: getActionSpec('home.hub.layout.update'),
        input: {
          intent: {
            kind: 'widget_remove',
            instanceId: 'copy',
            expectedInstance: {
              v: 1,
              id: 'copy',
              definition: { kind: 'builtin', id: 'changes' },
              bindings: {},
            },
          },
        },
        context,
        settings: normalizeActionsSettingsV1({ v: 1 }),
      }).required,
    ).toBe(false);
  });

  it('admits personal Companion placement while retaining shared Board approval and explicit Ask', () => {
    const actionId = 'widgets.item.add';
    const spec = getActionSpec(actionId);
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    const instance = {
      v: 1, id: 'pr-glance',
      definition: { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'session-pull-request' } },
      bindings: {},
    };
    const surface = {
      serverId: 'home', accountId: 'account',
      owner: { kind: 'companion', sessionId: 'session' },
    };
    const input = { surface, instance };
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings: EMPTY_SETTINGS }).required).toBe(false);
    for (const owner of [{ kind: 'sessionBoard', sessionId: 'session' }, { kind: 'home' }]) {
      expect(resolveActionApprovalRouting({
        actionId, spec, input: { surface: { ...surface, owner }, instance }, context, settings: EMPTY_SETTINGS,
      }).required).toBe(true);
    }
    expect(resolveActionApprovalRouting({
      actionId, spec, input: { surface: { owner: { kind: 'companion' } }, instance }, context, settings: EMPTY_SETTINGS,
    }).required).toBe(true);
    const settings = normalizeActionsSettingsV1({
      v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
    });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(true);
  });

  it.each(['widgets.item.add', 'widgets.item.remove'] as const)(
    'admits a person’s reversible plugin-area %s while preserving automation approval and explicit Ask',
    (actionId) => {
      const surface = {
        serverId: 'home',
        accountId: 'account',
        owner: {
          kind: 'pluginArea',
          pluginId: 'example',
          pageId: 'overview',
          area: 'pinned',
        },
      } as const;
      const input =
        actionId === 'widgets.item.add'
          ? {
              surface,
              instance: {
                v: 1,
                id: 'copy',
                definition: { kind: 'builtin', id: 'session_summary' },
                bindings: {},
              },
            }
          : { ref: { surface, instanceId: 'copy' } };
      const spec = getActionSpec(actionId);
      const context = {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      } as const;
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: EMPTY_SETTINGS,
        }).required,
      ).toBe(false);
      const settings = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings,
        }).required,
      ).toBe(false);
      for (const surface of ['plugin', 'agent'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context: { surface, authority: 'account_automation' },
            settings: EMPTY_SETTINGS,
          }).required,
        ).toBe(true);
      }
    },
  );

  it('admits direct source disclosure and Stop presses while retaining automation Ask', () => {
    const actionId = 'usage.sources.consent.set' as const;
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const enabled of [true, false]) {
      const input = {
        serverId: 'home',
        machineId: 'machine',
        sourceId: 'source',
        enabled,
      };
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: EMPTY_SETTINGS,
        }).required,
      ).toBe(false);
      for (const surface of ['agent', 'cli', 'mcp'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context: { ...context, surface },
            settings: EMPTY_SETTINGS,
          }).required,
        ).toBe(true);
      }
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: normalizeActionsSettingsV1({
            v: 1,
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
          }),
        }).required,
      ).toBe(false);
    }
  });

  it('admits reversible widget definition names and content directly while network changes confirm', () => {
    const actionId = 'widgets.definition.update' as const;
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const [patch, required] of [
      [{ name: 'Renamed' }, false],
      [{ networkOverride: { network: 'open' } }, true],
      [
        {
          body: {
            kind: 'declarative',
            document: {
              version: 1,
              root: { kind: 'text', text: 'New content' },
            },
          },
        },
        false,
      ],
    ] as const) {
      const input = {
        account: { serverId: 'home', accountId: 'account' },
        artifactId: 'widget',
        patch,
      };
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: EMPTY_SETTINGS,
      }), required);
      for (const surface of ['agent', 'mcp'] as const) {
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec,
            input,
            context: { surface, authority: 'account_automation' },
            settings: EMPTY_SETTINGS,
          }).required,
        ).toBe(true);
      }
      const ask = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: ask,
      }), true);
    }
  });

  it('resolves admitted audience widening through the same configurable confirmation owner', () => {
    const actionId = 'widgets.item.move' as const;
    const args = {
      actionId,
      spec: getActionSpec(actionId),
      context: { surface: 'ui', authority: 'present_user' },
      defaultUiConfirmation: true,
    } as const;
    expectOwnUiReview(resolveActionApprovalRouting(args), true);
    expectOwnUiReview(resolveActionApprovalRouting({ ...args, settings: EMPTY_SETTINGS }), true);
    expect(
      resolveActionApprovalRouting({
        ...args,
        context: { ...args.context, presentUserConfirmation: { actionId } },
      }).required,
    ).toBe(false);
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(
      resolveActionApprovalRouting({ ...args, settings: waived }).required,
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ ...args, settings: waived }), false);
    const ask = normalizeActionsSettingsV1({
      ...waived,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    });
    expect(
      resolveActionApprovalRouting({ ...args, settings: ask }).required,
    ).toBe(false);
    expectOwnUiReview(resolveActionApprovalRouting({ ...args, settings: ask }), true);
  });

  it('keeps widget exposure review native while retaining automated approval', () => {
    const actionId = 'widgets.item.move' as const;
    const spec = getActionSpec(actionId);
    const scope = { serverId: 'home', accountId: 'account' };
    const shared = {
      ...scope,
      owner: { kind: 'sessionBoard', sessionId: 'shared' },
    } as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const [source, destination, required] of [
      [{ ...scope, owner: { kind: 'home' } }, shared, true],
      [
        shared,
        {
          ...scope,
          owner: { kind: 'sessionBoard', sessionId: 'another-session' },
        },
        true,
      ],
      [shared, shared, false],
      [shared, { ...scope, owner: { kind: 'home' } }, false],
    ] as const) {
      const input = {
        ref: { surface: source, instanceId: 'copy' },
        to: { surface: destination, index: 0 },
      };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: EMPTY_SETTINGS,
      }), required);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context: { surface: 'mcp', authority: 'account_automation' },
          settings: EMPTY_SETTINGS,
        }).required,
      ).toBe(true);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          input,
          context,
          settings: waived,
        }).required,
      ).toBe(false);
      expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec,
        input,
        context,
        settings: waived,
      }), false);
    }
  });

  it('resolves contributed manifest defaults, waivers, and Ask-first through the same settings owner', () => {
    const actionId = 'acme.alpha/actions/run' as const;
    const context = { surface: 'agent' as const };
    expect(
      isApprovalRequiredByActionsSettings(
        actionId,
        EMPTY_SETTINGS,
        context,
        undefined,
        true,
      ),
    ).toBe(true);
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect(
      isApprovalRequiredByActionsSettings(
        actionId,
        waived,
        context,
        undefined,
        true,
      ),
    ).toBe(false);
    const required = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect(
      isApprovalRequiredByActionsSettings(
        actionId,
        required,
        context,
        undefined,
        false,
      ),
    ).toBe(true);
  });
  it('defaults fresh-folder consent on Agent/MCP through settings without flooring ordinary session open', () => {
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      const args = {
        actionId: 'session.open' as const,
        spec: getActionSpec('session.open'),
        context,
        settings: normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { 'session.open': [surface] },
        }),
        requiredByPolicy: false,
        input: { sessionId: 's1', approvedNewDirectoryCreation: true },
      };
      expect(
        resolveActionApprovalRouting({
          ...args,
          settings: EMPTY_SETTINGS,
          requiredByPolicy: undefined,
        }),
      ).toMatchObject({ required: true, flow: 'deferred' });
      expect(
        resolveActionApprovalRouting({
          ...args,
          settings: undefined,
          requiredByPolicy: undefined,
          defaultSafety: 'safe',
        }).required,
      ).toBe(true);
      expect(resolveActionApprovalRouting(args).required).toBe(false);
      expect(
        resolveActionApprovalRouting({
          ...args,
          input: { sessionId: 's1', approvedNewDirectoryCreation: false },
        }).required,
      ).toBe(false);
    }
  });
  it('defaults safe controller transitions and window enumeration to approval but honors per-action waivers', () => {
    for (const actionId of [
      'browser.control.takeControl',
      'browser.control.handBack',
      'computer.targets.list',
      'computer.target.select',
      'computer.control.interrupt',
      'computer.control.handBack',
      'computer.permissions.openSettings',
    ] as const) {
      const context = {
        surface: 'agent' as const,
        authority: 'account_automation' as const,
      };
      expect(getActionSpec(actionId).surfaces.agent, actionId).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
        actionId,
      ).toBe(true);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['agent'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, waived, context),
        actionId,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          settings: waived,
          context: { ...context, bypassApprovals: true },
          requiredByPolicy: false,
        }).required,
        actionId,
      ).toBe(false);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
          surface: 'ui',
          authority: 'present_user',
        }),
        actionId,
      ).toBe(false);
    }
  });
  it('defaults Workflow trigger writes to approval and honors Agent/MCP waivers and explicit requirements', () => {
    for (const actionId of [
      'workflow.trigger.add',
      'workflow.trigger.update',
      'workflow.trigger.remove',
    ] as const) {
      for (const surface of ['agent', 'mcp'] as const) {
        const settings = normalizeActionsSettingsV1({
          v: 1,
          actions: {},
          approvalWaivedSurfaces: { [actionId]: [surface, 'ui'] },
        });
        const context = { surface, authority: 'account_automation' as const };
        expect(
          isApprovalRequiredByActionsSettings(
            actionId,
            EMPTY_SETTINGS,
            context,
          ),
          actionId,
        ).toBe(true);
        expect
          .soft(
            isApprovalRequiredByActionsSettings(actionId, settings, context),
            actionId,
          )
          .toBe(false);
        expect
          .soft(
            resolveActionApprovalRouting({
              actionId,
              spec: getActionSpec(actionId),
              settings,
              context,
              requiredByPolicy: false,
            }).required,
            actionId,
          )
          .toBe(false);
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec: getActionSpec(actionId),
            settings,
            context,
          }).required,
        ).toBe(false);
        const required = normalizeActionsSettingsV1({
          ...settings,
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        });
        expect(
          resolveActionApprovalRouting({
            actionId,
            spec: getActionSpec(actionId),
            settings: required,
            context,
          }).required,
        ).toBe(true);
        expect(
          isApprovalRequiredByActionsSettings(actionId, settings, {
            surface: 'ui',
            authority: 'present_user',
          }),
          actionId,
        ).toBe(false);
      }
    }
    expect(
      resolveActionApprovalRouting({
        actionId: 'workflow.trigger.list',
        spec: getActionSpec('workflow.trigger.list'),
        context: { surface: 'agent' },
        requiredByPolicy: false,
      }).required,
    ).toBe(false);
  });
  it('keeps scoped Session trigger removal out of the advertised default while preserving confirmation authority', () => {
    const actionId = DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL;
    const spec = getActionSpec(actionId);
    const context = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
    };
    // Own/led Session admission belongs to the trigger owner; this owner decides
    // the approval default for a scoped removal after that policy (FIN 03 §5.4).
    expect(spec.safety).toBe('danger');
    expect
      .soft(isAgentInitiatedApprovalRequiredByDefault(actionId))
      .toBe(false);
    expect
      .soft(AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS)
      .not.toContain(actionId);
    expect
      .soft(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
      )
      .toBe(false);
    expect
      .soft(resolveActionApprovalRouting({ actionId, spec, context }).required)
      .toBe(false);

    for (const ambiguousContext of [
      undefined,
      null,
      approvalContext('session_agent'),
    ] as const) {
      expect
        .soft(
          isApprovalRequiredByActionsSettings(
            actionId,
            EMPTY_SETTINGS,
            ambiguousContext,
          ),
        )
        .toBe(true);
      expect
        .soft(
          resolveActionApprovalRouting({
            actionId,
            spec,
            context: ambiguousContext,
          }).required,
        )
        .toBe(true);
    }

    const required = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect
      .soft(isApprovalRequiredByActionsSettings(actionId, required, context))
      .toBe(true);
    expect
      .soft(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: required,
          context,
        }).required,
      )
      .toBe(true);
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
        expect(
          isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
            surface,
            authority: 'account_automation',
          }),
          `${actionId}:${surface}`,
        ).toBe(true);
      }

      const waived = normalizeActionsSettingsV1({
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { [actionId]: ['plugin'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, waived, {
          surface: 'plugin',
          authority: 'account_automation',
        }),
      ).toBe(false);

      const required = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['plugin'] } },
        approvalWaivedSurfaces: { [actionId]: ['plugin'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, required, {
          surface: 'plugin',
          authority: 'account_automation',
        }),
      ).toBe(true);
    }
  });

  it.each(['browser.automation.click', 'browser.sandbox.install'] as const)(
    'honors an explicit waiver, require wins, and reset restores the dangerous default for %s',
    (actionId) => {
      const settings = normalizeActionsSettingsV1({
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { [actionId]: ['agent'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, settings, {
          surface: 'agent',
        }),
      ).toBe(false);
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          settings,
          approvalContext('unknown'),
        ),
      ).toBe(true);
      const required = normalizeActionsSettingsV1({
        v: 1,
        actions: {
          [actionId]: { approvalRequiredSurfaces: ['agent'] },
        },
        approvalWaivedSurfaces: { [actionId]: ['agent'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, required, {
          surface: 'agent',
        }),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
          surface: 'agent',
        }),
      ).toBe(true);
      const malformed = normalizeActionsSettingsV1({
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { [actionId]: 'agent' },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, malformed, {
          surface: 'agent',
        }),
      ).toBe(true);
    },
  );

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

    expect(
      isApprovalRequiredByActionsSettings('review.start' as any, settings, {
        surface: 'cli',
      } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('review.start' as any, settings, {
        surface: 'mcp',
      } as any),
    ).toBe(false);
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

    expect(
      isApprovalRequiredByActionsSettings(
        'session.title.set' as any,
        settings,
        { surface: 'cli' } as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'session.title.set' as any,
        settings,
        { surface: 'mcp' } as any,
      ),
    ).toBe(true);
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

    expect(
      isApprovalRequiredByActionsSettings(actionId, settings, {
        surface: 'cli',
      } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(actionId, settings, {
        surface: 'mcp',
      } as any),
    ).toBe(false);
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

    expect(
      resolveActionApprovalRouting({
        actionId: 'session.list' as any,
        spec: getActionSpec('session.list'),
        settings,
        context: { surface: 'mcp' } as any,
      }),
    ).toEqual({
      required: false,
      flow: 'blocking',
      result: 'required',
    });
  });

  it('routes durable required-result reads as deferred when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(
      resolveActionApprovalRouting({
        actionId: 'session.list' as any,
        spec: getActionSpec('session.list'),
        requiredByPolicy: true,
        context: { surface: 'mcp' } as any,
      }),
    ).toEqual({
      required: true,
      flow: 'deferred',
      result: 'required',
    });
  });

  it('routes no-result mutation actions as deferred when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(
      resolveActionApprovalRouting({
        actionId: 'session.title.set' as any,
        spec: getActionSpec('session.title.set'),
        requiredByPolicy: true,
        context: { surface: 'mcp' } as any,
      }),
    ).toEqual({
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
    expect(decision).toEqual({
      required: true,
      flow: 'deferred',
      result: 'required',
    });
  });

  it('requires confirmation for an irreversible unreviewed Home claim by default', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'home.governance.claim',
      spec: getActionSpec('home.governance.claim'),
      settings: EMPTY_SETTINGS,
      context: { surface: 'ui', authority: 'present_user' } as any,
    });
    expectOwnUiReview(decision, true);
  });

  it.each([
    'localServices.actions.stopManaged',
    'localServices.actions.restartManaged',
    'localServices.actions.terminateDetected',
    'projects.trust.revoke',
  ] as const)(
    'admits the present-user UI press while retaining explicit Ask: %s',
    (actionId) => {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user' } as const;
      expect(spec.safety).toBe('danger');
      expect(spec.safetyForInput).toBeUndefined();
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({ actionId, spec, context }).required,
      ).toBe(false);

      const completed = { ...context, presentUserConfirmation: { actionId } };
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          EMPTY_SETTINGS,
          completed,
        ),
      ).toBe(false);
      expect(
        isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
          ...context,
          presentUserConfirmation: { actionId: 'account.password.remove' },
        }),
      ).toBe(false);
      const waived = normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, waived, context),
      ).toBe(false);
      const required = normalizeActionsSettingsV1({
        ...waived,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, required, completed),
      ).toBe(true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, settings: required, context }), true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, settings: required, context: completed }), true);
      expectOwnUiReview(resolveActionApprovalRouting({ actionId, spec, settings: required, context: completed,
        reviewAdmitted: true }), false);
    },
  );

  // The 2026-10-15 owner ruling makes reversible present-user UI edits direct;
  // Account Ask is answered by that UI admission; the Agent floor is unchanged.
  it('admits assignment directly for the present user while retaining the Agent floor', () => {
    const actionId = 'session.responsibility.set' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(
      isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, context),
    ).toBe(false);
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings: EMPTY_SETTINGS,
        context,
      }),
    ).toMatchObject({ required: false, flow: 'deferred' });
    // An unwired host applies the same default.
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        context,
      }).required,
    ).toBe(false);

    const waived = normalizeActionsSettingsV1({
      v: 1,
      actions: {},
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
    });
    expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(
      false,
    );
    // The waiver is surface-exact: the Agent default is untouched.
    expect(
      isApprovalRequiredByActionsSettings(actionId, waived, {
        surface: 'agent',
        authority: 'account_automation',
      }),
    ).toBe(true);
  });

  it.each(['cli', 'ui'] as const)(
    'consumes exact completed %s confirmation while preserving explicit require and waiver settings',
    (surface) => {
      const actionId = 'account.password.change' as const;
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          settings: EMPTY_SETTINGS,
          defaultSafety: 'danger',
          context: { surface, authority: 'present_user' },
        }).required,
      ).toBe(surface !== 'ui');
      if (surface === 'ui') expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings: EMPTY_SETTINGS,
        defaultSafety: 'danger',
        context: { surface, authority: 'present_user' },
      }), true);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          settings: EMPTY_SETTINGS,
          defaultSafety: 'danger',
          context: {
            surface,
            authority: 'present_user',
            presentUserConfirmation: { actionId },
          },
        }).required,
      ).toBe(false);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          settings: EMPTY_SETTINGS,
          defaultSafety: 'danger',
          context: {
            surface,
            authority: 'present_user',
            presentUserConfirmation: { actionId: 'account.password.remove' },
          },
        }).required,
      ).toBe(surface !== 'ui');
      if (surface === 'ui') expectOwnUiReview(resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings: EMPTY_SETTINGS,
        defaultSafety: 'danger',
        context: {
          surface,
          authority: 'present_user',
          presentUserConfirmation: { actionId: 'account.password.remove' },
        },
      }), true);
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec: getActionSpec(actionId),
          settings: EMPTY_SETTINGS,
          defaultSafety: 'danger',
          context: {
            surface,
            authority: 'account_automation',
            presentUserConfirmation: { actionId },
          },
        }).required,
      ).toBe(true);

      const required = normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: [surface] } },
        approvalWaivedSurfaces: { [actionId]: [surface] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, required, {
          surface,
          authority: 'present_user',
          presentUserConfirmation: { actionId },
        }),
      ).toBe(true);
      if (surface === 'ui') {
        const args = { actionId, spec: getActionSpec(actionId), settings: required,
          context: { surface, authority: 'present_user', presentUserConfirmation: { actionId } } } as const;
        expectOwnUiReview(resolveActionApprovalRouting(args), true);
        expectOwnUiReview(resolveActionApprovalRouting({ ...args, reviewAdmitted: true }), false);
      }

      const waived = normalizeActionsSettingsV1({
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { [actionId]: [surface] },
      });
      expect(
        isApprovalRequiredByActionsSettings(actionId, waived, {
          surface,
          authority: 'account_automation',
        }),
      ).toBe(false);
    },
  );

  it('uses native confirmation for the person’s explicit UI Ask while retaining other callers’ custody', () => {
    const settings = normalizeActionsSettingsV1({
      v: 1,
      actions: {
        'teams.invitations.create': { approvalRequiredSurfaces: ['ui'] },
      },
    });
    expect(
      isApprovalRequiredByActionsSettings(
        'teams.invitations.create' as any,
        settings,
        { surface: 'ui', authority: 'present_user' } as any,
      ),
    ).toBe(true);
    expect(
      resolveActionApprovalRouting({
        actionId: 'teams.invitations.create' as any,
        spec: getActionSpec('teams.invitations.create'),
        settings,
        context: { surface: 'ui', authority: 'present_user' } as any,
      }),
    ).toMatchObject({ required: false, uiConfirmationRequired: true });

    // Original people retain live custody; durable automated requests give
    // the deciding person the fresh bearer (docs/actions.md, approval custody).
    expect(
      resolveActionApprovalRouting({
        actionId: 'teams.invitations.create' as any,
        spec: getActionSpec('teams.invitations.create'),
        requiredByPolicy: true,
        context: { surface: 'cli', authority: 'present_user' } as any,
      }),
    ).toEqual({ required: true, flow: 'blocking', result: 'required' });
    for (const surface of ['agent', 'mcp'] as const) {
      expect(
        resolveActionApprovalRouting({
          actionId: 'teams.invitations.create',
          spec: getActionSpec('teams.invitations.create'),
          requiredByPolicy: true,
          context: { surface, authority: 'account_automation' },
        }),
      ).toEqual({ required: true, flow: 'deferred', result: 'required' });
    }
    expect(
      resolveActionApprovalRouting({
        actionId: 'teams.invitations.create' as any,
        spec: getActionSpec('teams.invitations.create'),
        requiredByPolicy: true,
        context: { surface: 'api', authority: 'account_automation' } as any,
      }),
    ).toEqual({ required: true, flow: 'deferred', result: 'required' });
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
  ] as const)(
    'routes result-bearing Home mutation %s through its declared UI custody',
    (actionId) => {
      const spec = getActionSpec(actionId);
      expect(spec.approval).toEqual({ result: 'required' });
      const uiConfirmationRequired = actionId === 'home.accounts.delete' || actionId === 'home.policy.set';
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          context: { surface: 'ui', authority: 'present_user' },
        }),
      ).toEqual({ required: false, ...(uiConfirmationRequired ? { uiConfirmationRequired: true } : {}), flow: 'blocking', result: 'required' });
    },
  );

  it('routes optional-result actions through their explicit flow', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(
      resolveActionApprovalRouting({
        actionId: 'session.message.send' as any,
        spec: getActionSpec('session.message.send'),
        requiredByPolicy: true,
        context: { surface: 'mcp' } as any,
      }),
    ).toEqual({
      required: true,
      flow: 'deferred',
      result: 'optional',
    });
  });

  it('never requires approval for approval decision actions', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(
      resolveActionApprovalRouting({
        actionId: 'approval.request.decide' as any,
        spec: getActionSpec('approval.request.decide'),
        requiredByPolicy: true,
        context: { surface: 'mcp' } as any,
      }),
    ).toEqual({
      required: false,
      flow: 'deferred',
      result: 'none',
    });
  });

  it('does not recursively require approval while creating an approval request', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;

    expect(
      resolveActionApprovalRouting({
        actionId: 'approval.request.create',
        spec: getActionSpec('approval.request.create'),
        requiredByPolicy: true,
        context: { surface: 'agent' } as any,
      }).required,
    ).toBe(false);
  });
});

describe('agent-initiated dangerous-action approval default (FINALIZATION-PLAN §4.2/§12.8/Δ1)', () => {
  it('requires approval for the dangerous subset when initiated through the agent surface, with no persisted settings', () => {
    for (const actionId of AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId)).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          EMPTY_SETTINGS,
          approvalContext('agent'),
        ),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(
          actionId,
          EMPTY_SETTINGS,
          approvalContext('session_agent'),
        ),
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
      expect(
        resolveActionApprovalRouting({
          actionId,
          spec,
          settings: EMPTY_SETTINGS,
          context,
        }).required,
      ).toBe(true);
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
      isApprovalRequiredByActionsSettings(
        actionId,
        settingsWithoutActions,
        approvalContext('agent'),
      ),
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
      isApprovalRequiredByActionsSettings(
        actionId,
        settings,
        approvalContext('session_agent'),
      ),
    ).toBe(true);
  });

  it('requires confirmation for dangerous actions on every exposed user surface by default', () => {
    for (const actionId of AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      if (spec.safety !== 'danger') continue;
      for (const surface of [
        'ui',
        'mcp',
        'cli',
        'agent',
        'api',
        'plugin',
        'voice',
      ] as const) {
        if (spec.surfaces[surface] !== true) continue;
        const operationOwnsConfirmation =
          spec.approvalPolicy?.scopeAdmissionOwnsConfirmation === true &&
          !spec.approvalPolicy.requiredSurfaces?.includes(surface);
        expect(
          isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, {
            surface,
          }),
          `${actionId}:${surface}`,
        ).toBe(!operationOwnsConfirmation);
      }
    }
  });

  it('requires approval for annotation attachment, not local lifecycle and comment edits', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.attachDraft')).toBe(true);
    for (const id of ['browser.context.annotation.start', 'browser.context.annotation.cancel', 'browser.context.annotation.setDraftComment'] as const) {
      expect(isAgentInitiatedApprovalRequiredByDefault(id)).toBe(false);
    }
  });

  it('floors browser attach actions that egress captured context or recordings to the composer/agent turn', () => {
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'browser.context.attachToComposer' as any,
      ),
    ).toBe(true);
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'browser.context.attachToAgentTurn' as any,
      ),
    ).toBe(true);
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'browser.recording.attachToComposer' as any,
      ),
    ).toBe(true);

    expect(
      isApprovalRequiredByActionsSettings(
        'browser.context.attachToComposer' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.context.attachToAgentTurn' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.recording.attachToComposer' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
  });

  it('keeps browser attach actions unprompted by default for user-initiated UI invocations', () => {
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.context.attachToComposer' as any,
        EMPTY_SETTINGS,
        { surface: 'ui' } as any,
      ),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.context.attachToAgentTurn' as any,
        EMPTY_SETTINGS,
        { surface: 'ui' } as any,
      ),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.recording.attachToComposer' as any,
        EMPTY_SETTINGS,
        { surface: 'ui' } as any,
      ),
    ).toBe(false);
  });

  it('does not require approval for read-only non-egress runtime actions on the agent surface', () => {
    // Read-only browser verbs (no navigation/input/mutation/egress) stay un-floored for the agent.
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'browser.automation.snapshot' as any,
      ),
    ).toBe(false);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.automation.snapshot' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(false);
    expect(
      isAgentInitiatedApprovalRequiredByDefault('browser.view.focus' as any),
    ).toBe(false);
  });

  it('routes the agent dangerous default as a durable approval through resolveActionApprovalRouting', () => {
    const decision = resolveActionApprovalRouting({
      actionId: 'browser.diagnostics.eval' as any,
      spec: getActionSpec('browser.diagnostics.eval' as any),
      settings: EMPTY_SETTINGS,
      context: { surface: 'agent' } as any,
    });
    expect(decision.required).toBe(true);
    expect(decision.flow).toBe('deferred');
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
    expect(decision.flow).toBe('deferred');
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

  it('keeps the person’s UI admission direct and retains explicitly required live-only custody', () => {
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
    expect(
      resolveActionApprovalRouting({
        actionId: 'account.password.enroll' as any,
        spec: getActionSpec('account.password.enroll' as any),
        settings,
        context,
      }),
    ).toMatchObject({ required: false });
    expect(
      resolveActionApprovalRouting({
        actionId: 'teams.identity.workos.adminPortalLink.create' as any,
        spec: getActionSpec(
          'teams.identity.workos.adminPortalLink.create' as any,
        ),
        requiredByPolicy: true,
        context,
      }),
    ).toEqual({ required: false, uiConfirmationRequired: true, flow: 'blocking', result: 'required' });
  });

  it('keeps every show-once bearer creation on its live invocation', () => {
    // One rule for the same concept: the Account API token and the Team
    // external key both return a plaintext bearer exactly once, so neither may
    // hand it to a durable Artifact continuation.
    for (const actionId of [
      'account.apiTokens.create',
      'teams.credentials.externalKeys.create',
    ] as const) {
      expect(getActionSpec(actionId).approvalResultCustody, actionId).toBe(
        'live_only',
      );
      expect(
        resolveActionApprovalRouting({
          actionId: actionId as any,
          spec: getActionSpec(actionId),
          context: { surface: 'ui', authority: 'present_user' } as any,
        }),
        actionId,
      ).toEqual({ required: false, flow: 'blocking', result: 'required' });
    }
  });
  it('keeps MCP OAuth start approval on the live human continuation', () => {
    const actionId = 'mcp.servers.signIn.start';
    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        requiredByPolicy: true,
        context: { surface: 'cli', authority: 'present_user' },
      }),
    ).toEqual({ required: true, flow: 'blocking', result: 'required' });
  });

  it('keeps the Team identity test direct for the person and deferred for automation', () => {
    for (const context of [
      { surface: 'ui', authority: 'present_user' },
      { surface: 'api', authority: 'account_automation' },
    ] as const) {
      expect(
        resolveActionApprovalRouting({
          actionId: 'teams.identity.connections.test.start' as any,
          spec: getActionSpec('teams.identity.connections.test.start' as any),
          ...(context.surface === 'api' ? { requiredByPolicy: true } : {}),
          context: context as any,
        }),
      ).toEqual(context.surface === 'ui'
        ? { required: false, flow: 'blocking', result: 'required' }
        : { required: true, flow: 'deferred', result: 'required' });
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
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.diagnostics.eval' as any,
        settings,
        { surface: 'ui' } as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'browser.diagnostics.eval' as any,
        settings,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
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
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId as any)).toBe(
        true,
      );
      expect(
        isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, {
          surface: 'agent',
        } as any),
      ).toBe(true);
      // The danger classification is the single source: each floored verb is `safety: 'danger'`.
      expect(getActionSpec(actionId as any).safety).toBe('danger');
    }
  });

  it('keeps read-only browser verbs un-floored on the agent surface (CON-2)', () => {
    for (const actionId of UNFLOORED_READONLY_VERBS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId as any)).toBe(
        false,
      );
      expect(
        isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, {
          surface: 'agent',
        } as any),
      ).toBe(false);
      expect(getActionSpec(actionId as any).safety).toBe('safe');
    }
  });

  it('keeps cancellation safe while declaring its configurable automation approval default', () => {
    const cancel = getActionSpec('browser.automation.cancelActive');

    expect(cancel.safety).toBe('safe');
    expect(isAgentInitiatedApprovalRequiredByDefault(cancel.id)).toBe(true);
    expect(cancel.requiredAuthority).toBe('account_automation');
  });

  it('floors launcher.start, which is danger + agent (CON-3)', () => {
    expect(getActionSpec('localServices.launcher.start' as any).safety).toBe(
      'danger',
    );
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'localServices.launcher.start' as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'localServices.launcher.start' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
  });

  it('floors publicPreview.create so the client acknowledgement is not the only gate (L3-3)', () => {
    expect(
      getActionSpec('localServices.publicPreview.create' as any).safety,
    ).toBe('danger');
    expect(
      isAgentInitiatedApprovalRequiredByDefault(
        'localServices.publicPreview.create' as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'localServices.publicPreview.create' as any,
        EMPTY_SETTINGS,
        { surface: 'agent' } as any,
      ),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings(
        'localServices.publicPreview.create' as any,
        EMPTY_SETTINGS,
        { surface: 'ui' } as any,
      ),
    ).toBe(true);
  });

  it('floors prompt_doc.update, the live QA dangerous agent fixture (LIVE-1)', () => {
    const spec = getActionSpec('prompt_doc.update');
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces.agent).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('prompt_doc.update')).toBe(
      true,
    );
    expect(
      isApprovalRequiredByActionsSettings('prompt_doc.update', EMPTY_SETTINGS, {
        surface: 'agent',
      } as any),
    ).toBe(true);
    expect(
      isApprovalRequiredByActionsSettings('prompt_doc.update', EMPTY_SETTINGS, {
        surface: 'ui',
      } as any),
    ).toBe(true);
    expect(
      resolveActionApprovalRouting({
        actionId: 'prompt_doc.update',
        spec,
        settings: EMPTY_SETTINGS,
        context: { surface: 'agent' } as any,
      }).required,
    ).toBe(true);
  });

  it('SUBSET invariant: every danger ∩ agent action except approved scoped removal is floored (CON-1/6, never equality)', () => {
    const dangerAgentIds = ACTION_IDS.filter((id) => {
      const spec = getActionSpec(id);
      return (
        spec.safety === 'danger' &&
        spec.surfaces.agent === true &&
        id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL
      );
    });
    expect(dangerAgentIds.length).toBeGreaterThan(0);
    for (const id of dangerAgentIds) {
      expect(isAgentInitiatedApprovalRequiredByDefault(id)).toBe(true);
    }
    // The floor exceeds the non-exempt danger ∩ agent subset via the non-danger egress floor
    // (context captures + copyUrl). Assert at least one such non-danger egress id is floored so the
    // invariant is a strict subset (⊊), never equality.
    const nonDangerFloored =
      AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS.filter(
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
      'localServices.publicPreview.status',
      'localServices.publicPreview.copyUrl',
    ]) {
      expect(getActionSpec(id as any).safety).toBe('safe');
      expect(isAgentInitiatedApprovalRequiredByDefault(id as any)).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(id as any, EMPTY_SETTINGS, {
          surface: 'agent',
        } as any),
      ).toBe(true);
      expect(
        isApprovalRequiredByActionsSettings(id as any, EMPTY_SETTINGS, {
          surface: 'ui',
        } as any),
      ).toBe(false);
    }
  });

  it('user-initiated (ui) browser navigation uses the dangerous default', () => {
    for (const actionId of FLOORED_BROWSER_NAV_INPUT_VERBS) {
      expect(
        isApprovalRequiredByActionsSettings(actionId as any, EMPTY_SETTINGS, {
          surface: 'ui',
        } as any),
      ).toBe(true);
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

  function safetyForDefaultInput(actionId: ActionId) {
    const spec = getActionSpec(actionId);
    return spec.safetyForInput?.(undefined) ?? spec.safety;
  }

  it('measures a non-empty plugin surface with a real danger population', () => {
    expect(pluginSurfacedActionIds.length).toBeGreaterThan(0);
    expect(
      pluginSurfacedActionIds.filter(
        (id) => getActionSpec(id).safety === 'danger',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('routes dangerous plugin Actions, human mutations and host capture viewing through approval by default', () => {
    const promptedOnPluginSurface = pluginSurfacedActionIds.filter((id) =>
      routingRequired(id, 'plugin'),
    );

    expect(promptedOnPluginSurface).toEqual(
      pluginSurfacedActionIds.filter(
        (id) =>
          (safetyForDefaultInput(id) === 'danger' ||
            id === 'capture.view' ||
            getActionSpec(id).approvalPolicy?.requiredSurfaces?.includes(
              'plugin',
            ) ||
            (getActionSpec(id).requiredAuthority === 'present_user' &&
              id !== 'session.permission.respond')) &&
          !id.startsWith('approval.request.') &&
          id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL,
      ),
    );
  });

  it('keeps ordinary safe plugin Actions unprompted while host viewing requires consent', () => {
    const safePluginActionIds = pluginSurfacedActionIds.filter(
      (id) =>
        safetyForDefaultInput(id) !== 'danger' &&
        id !== 'capture.view' &&
        !getActionSpec(id).approvalPolicy?.requiredSurfaces?.includes(
          'plugin',
        ) &&
        getActionSpec(id).requiredAuthority !== 'present_user',
    );

    for (const actionId of safePluginActionIds) {
      expect(routingRequired(actionId, 'plugin')).toBe(false);
    }
  });

  it('prompts the same non-exempt danger-class rows on the agent surface', () => {
    const dangerAgentAndPluginActionIds = pluginSurfacedActionIds.filter(
      (id) => {
        const spec = getActionSpec(id);
        return (
          spec.safety === 'danger' &&
          spec.surfaces.agent === true &&
          id !== DIRECT_SCOPED_SESSION_TRIGGER_REMOVAL &&
          // Approval requests are intentionally unprompted, so a request cannot
          // recursively create another request before the existing flow decides it.
          spec.approvalPolicy?.control !== true
        );
      },
    );

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

    expect(
      resolveActionApprovalRouting({
        actionId,
        spec: getActionSpec(actionId),
        settings,
        context: approvalContext('plugin'),
      }).required,
    ).toBe(true);
  });
});
