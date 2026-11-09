import { describe, expect, it } from 'vitest';

import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import {
  PUBLIC_ACTION_IDS,
  PublicActionIdSchema,
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
import { DISCUSSION_ACTION_IDS_V1 } from '../discussions/actionIds.js';
import {
  DISCUSSION_ACTION_INPUT_SCHEMAS_V1,
  DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1,
} from '../discussions/actions.js';
import { DISCUSSION_HTTP_PATHS_V1 } from '../discussions/api.js';
import { canRequestPresentUserApprovalForActionInputV1, resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';

const READ_ACTION_IDS = [
  'discussion.list',
  'discussion.get',
  'discussion.read',
] as const;

const ACCESS_WRITE_ACTION_IDS = [
  'discussion.invite', 'discussion.participant.remove', 'discussion.participant.policy.set', 'discussion.owner.transfer',
  'discussion.access.grants.set', 'discussion.access.grants.remove',
] as const;

const MANAGEMENT_ACTION_IDS = [
  'discussion.second_opinion.start',
  'discussion.create',
  'discussion.rename',
  'discussion.archive',
  'discussion.restore',
  'discussion.read_state.set',
  'discussion.leave',
  'discussion.owner.transfer',
] as const;

describe('Home Discussion Action catalog rows', () => {
  it('admits a mounted Discussion host read through the canonical plugin caller policy', () => {
    expect(getActionSpec('discussion.get').pluginCallerPolicy).toEqual({ kind: 'caller' });
  });
  it('publishes resource settings through the same family with strict override and inherited reset semantics', () => {
    const get = getActionSpec(ActionIdSchema.parse('discussion.settings.get'));
    const set = getActionSpec(ActionIdSchema.parse('discussion.settings.set'));
    expect(get.serverTransport).toEqual({ method: 'GET', path: '/v1/discussions/:discussionId/settings' });
    expect(set.serverTransport).toEqual({ method: 'PUT', path: '/v1/discussions/:discussionId/settings' });
    for (const settings of [{}, { coordination: { autonomousCheckIn: { afterTurns: null } } },
      { coordination: { autonomousCheckIn: { afterTurns: 7 } } }]) {
      expect(set.inputSchema.safeParse({ discussionId: 'discussion', settings }).success).toBe(true);
      expect(set.outputSchema?.safeParse({ discussionId: 'discussion', settings }).success).toBe(true);
    }
    expect(set.inputSchema.safeParse({ discussionId: 'discussion', settings: {
      coordination: { autonomousCheckIn: { afterTurns: 0 } },
    } }).success).toBe(false);
    expect(set.inputSchema.safeParse({ discussionId: 'discussion', settings: { counter: 1 } }).success).toBe(false);
    for (const spec of [get, set]) {
      expect(spec.executionPlacement).toBe('account');
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, mcp: true, agent: true, voice: true, plugin: true });
      expect(spec.bindings?.mcpToolName).toBe(spec.id.replaceAll('.', '_'));
      expect(spec.bindings?.voiceClientToolName).toBe(spec.id.replaceAll('.', '_'));
      for (const surface of ['mcp', 'voice'] as const) {
        expect(spec.inputSchema.safeParse(JSON.parse(spec.examples?.[surface]?.argsExample ?? '{}')).success).toBe(true);
      }
    }
    expect(isAgentInitiatedApprovalRequiredByDefault(set.id)).toBe(true);
  });
  it('exposes read-only candidate discovery through the same CLI, MCP, Voice and generated SDK catalog', () => {
    const spec = getActionSpec(ActionIdSchema.parse('discussion.candidates.list'));
    expect(spec.safety).toBe('safe');
    expect(spec.sideEffectClass).toBe('read');
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.executionPlacement).toBe('account');
    expect(spec.bindings).toMatchObject({ mcpToolName: 'discussion_candidates_list', voiceClientToolName: 'discussion_candidates_list' });
    expect(spec.cli?.commands).toContainEqual({ path: ['discussions', 'candidates', 'list'], positionals: [], visibility: 'canonical' });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice', 'plugin'] as const) expect(spec.surfaces[surface], surface).toBe(true);
    expect(PUBLIC_ACTION_IDS).toContain(spec.id);
    expect(spec.inputSchema.safeParse({ source: 'people', query: 'bob', accountId: 'another-account' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ source: 'sessions', query: 'plaintext metadata search' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ source: 'models', options: [], start: true }).success).toBe(false);
  });
  it('routes a closed participant policy change with explicit watch-cost approval', () => {
    const spec = getActionSpec(ActionIdSchema.parse('discussion.participant.policy.set'));
    expect(spec.serverTransport).toEqual({ method: 'PUT', path: '/v1/discussions/:discussionId/participants/policy' });
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion', participant: { kind: 'session', sessionId: 'agent' }, answerPolicy: 'watches_and_speaks_up' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion', participant: { kind: 'account', accountId: 'person' }, answerPolicy: 'reads_only' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion', participant: { kind: 'session', sessionId: 'agent' }, answerPolicy: 'reads_only', reviewed: true }).success).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault(spec.id)).toBe(true);
  });
  it('keeps pass a safe typed operation on the current Session obligation with no authored correlation', () => {
    const spec = getActionSpec('discussion.pass');
    expect(spec.executionPlacement).toBe('session');
    expect(spec.safety).toBe('safe');
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion-1' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion-1', requestLocalId: 'another-input' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ discussionId: 'discussion-1', text: 'An authored substitute reply' }).success).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('discussion.pass')).toBe(false);
    expect(spec.outputSchema?.safeParse({ v: 1, ok: true, progress: { v: 1, mode: 'return',
      disposition: 'return_pending', acceptedTurnId: 'turn-1', outcome: { kind: 'pass' },
      discussion: { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: 'participant' },
    } }).success).toBe(true);
  });
  it('publishes Home-owned Discussion Actions without retired Session-owned IDs', () => {
    expect(ActionIdSchema.safeParse('discussion.create').success).toBe(true);
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('session.discussion.'))).toBe(false);
    const actionId = ActionIdSchema.parse('discussion.create');
    const spec = getActionSpec(actionId);
    expect(spec.executionPlacement).toBe('account');
    expect(spec.contextualDefaults).toBeUndefined();
    expect(spec.serverTransport).toEqual({ method: 'POST', path: '/v1/discussions' });
    expect(spec.inputSchema.safeParse({
      title: 'Independent question',
      creationLocalId: 'create-retry',
      firstMessage: { localId: 'first-message-retry', content: { v: 1, parts: [{ t: 'text', text: 'Who can help?' }] } },
    }).success).toBe(true);
  });

  it('keeps Home input closed and separates creation from first-message retry identity', () => {
    const spec = getActionSpec('discussion.create');
    const input = {
      title: 'Independent question',
      creationLocalId: 'create-retry',
      firstMessage: { localId: 'first-message-retry', content: { v: 1, parts: [{ t: 'text', text: 'Who can help?' }] } },
    };
    expect(spec.inputSchema.safeParse({ ...input, sessionId: 'parent-session' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, creationLocalId: 'first-message-retry' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, participants: [{ kind: 'account', accountId: 'invited' }] }).success).toBe(true);
  });

  it('keeps self-leave closed to another principal and access changes under shared approval', () => {
    const leave = getActionSpec(ActionIdSchema.parse('discussion.leave'));
    expect(leave.inputSchema.safeParse({ discussionId: 'discussion-1' }).success).toBe(true);
    expect(leave.inputSchema.safeParse({ discussionId: 'discussion-1', accountId: 'other' }).success).toBe(false);
    expect(leave.requiredAuthority).toBe('present_user');
    expect(leave.safety).toBe('safe');
    for (const actionId of ACCESS_WRITE_ACTION_IDS) {
      const spec = getActionSpec(ActionIdSchema.parse(actionId));
      expect(spec.safety, actionId).toBe('danger');
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId).toBe(true);
      expect(spec.surfaces.voice, actionId).toBe(true);
      expect(spec.bindings?.voiceClientToolName, actionId).toBe(actionId.replaceAll('.', '_'));
    }
  });

  it('publishes discussion intents through the canonical Action id registry', () => {
    for (const actionId of DISCUSSION_ACTION_IDS_V1) {
      expect(ActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
      expect(ACTION_IDS).toContain(actionId);
    }
    expect(
      listActionSpecs()
        .filter((spec) => spec.id.startsWith('discussion.'))
        .map((spec) => spec.id)
        .sort(),
    ).toEqual([...DISCUSSION_ACTION_IDS_V1].sort());
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('session.discussion.'))).toBe(false);
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('conversation.'))).toBe(false);
  });

  it('binds each row to the discussion schemas rather than a second input vocabulary', () => {
    for (const actionId of DISCUSSION_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema, actionId).toBe(DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId]);
      expect(spec.outputSchema, actionId).toBe(DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1[actionId]);
      expect(spec.requiredAuthority, actionId).toBe(
        MANAGEMENT_ACTION_IDS.some(id => id === actionId) ? 'present_user' : 'account_automation',
      );
      expect(spec.executionPlacement, actionId).toBe(actionId === 'discussion.pass' ? 'session' : 'account');
      expect(spec.originalExecution?.accountRoot, actionId).toBe(actionId === 'discussion.pass' ? undefined : 'allowed');
      expect(spec.contextualDefaults, actionId).toBeUndefined();
      expect(spec.surfaces.voice, actionId).toBe(true);
      expect(isInternalActionId(actionId), actionId).toBe(false);
      expect(isPluginProvenanceOnlyActionId(actionId), actionId).toBe(false);
      expect(isPluginSurfaceExcludedActionId(actionId), actionId).toBe(false);
    }
  });

  it('exposes management to Agent and MCP through present-user approval', () => {
    for (const actionId of READ_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.agent, actionId).toBe(true);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(spec.surfaces.ui, actionId).toBe(true);
      expect(spec.surfaces.cli, actionId).toBe(true);
      expect(spec.sideEffectClass, actionId).toBe('read');
    }

    // An Agent may deliberately author a discussion message on behalf of its
    // authenticated execution Account.
    const post = getActionSpec('discussion.post');
    expect(post.surfaces.agent).toBe(true);
    expect(post.surfaces.mcp).toBe(true);
    expect(post.sideEffectClass).toBe('danger');

    for (const actionId of MANAGEMENT_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.agent, actionId).toBe(true);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(spec.surfaces.ui, actionId).toBe(true);
      expect(spec.surfaces.cli, actionId).toBe(true);
      expect(spec.requiredAuthority, actionId).toBe('present_user');
      expect(canRequestPresentUserApprovalForActionInputV1(spec), actionId).toBe(true);
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }), actionId)
          .toEqual({ ok: true });
        expect(isApprovalRequiredByActionsSettings(actionId, ActionsSettingsV1Schema.parse({ v: 1 }),
          { surface, authority: 'account_automation' }), actionId).toBe(true);
      }
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
        surface: 'api', hasExternalCredential: true }), actionId)
        .toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(spec.surfaces.plugin, actionId).toBe(true);
      expect(PUBLIC_ACTION_IDS, actionId).not.toContain(actionId);
      expect(PublicActionIdSchema.safeParse(actionId).success, actionId).toBe(false);
    }
  });

  it('makes an Agent-initiated post dangerous by default and user-overridable through the shared policy', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('discussion.post')).toBe(true);
    for (const actionId of READ_ACTION_IDS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId).toBe(false);
    }

    const inherit = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    expect(isApprovalRequiredByActionsSettings('discussion.post', inherit, { surface: 'agent' })).toBe(true);

    // The explicit user waiver is resolved by the shared Actions settings owner,
    // never by a discussion-only bypass.
    const waived = setActionApprovalOverride({
      settings: inherit,
      actionId: 'discussion.post',
      surface: 'agent',
      approvalRequired: false,
    });
    expect(isApprovalRequiredByActionsSettings('discussion.post', waived, { surface: 'agent' })).toBe(false);

    const restored = setActionApprovalOverride({
      settings: waived,
      actionId: 'discussion.post',
      surface: 'agent',
      approvalRequired: null,
    });
    expect(isApprovalRequiredByActionsSettings('discussion.post', restored, { surface: 'agent' })).toBe(true);

    // Waiving confirmation never re-enables a disabled Action or a disabled surface.
    const disabled = setActionApprovalOverride({
      settings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: { 'discussion.post': { enabled: false } },
      }),
      actionId: 'discussion.post',
      surface: 'agent',
      approvalRequired: false,
    });
    expect(isActionEnabledByActionsSettings('discussion.post', disabled, { surface: 'agent' })).toBe(false);
  });

  it('declares the first-class resource transport for every mutating intent', () => {
    expect(getActionSpec('discussion.create').serverTransport)
      .toEqual({ method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.collection });
    expect(getActionSpec('discussion.post').serverTransport)
      .toEqual({ method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.messages });
    expect(getActionSpec('discussion.rename').serverTransport)
      .toEqual({ method: 'PATCH', path: DISCUSSION_HTTP_PATHS_V1.discussion });
    expect(getActionSpec('discussion.archive').serverTransport)
      .toEqual({ method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.archive });
    expect(getActionSpec('discussion.restore').serverTransport)
      .toEqual({ method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.restore });
    expect(getActionSpec('discussion.read_state.set').serverTransport)
      .toEqual({ method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.read });
  });
});
