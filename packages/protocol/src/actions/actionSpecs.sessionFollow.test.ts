import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '../sessions/follow/actionTransport.js';
import { resolveFollowDeliveryV1, type FollowPolicyV1 } from '../sessions/follow/sessionFollowPolicyV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

describe('Follow Action contracts', () => {
  it('returns typed unsupported for the declared reverse-list direction without an authorized reader', async () => {
    // The current real transport projection has no reverse HTTP route. The
    // dispatcher must settle this declaration before attempting that adapter.
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      sessionFollowAction: async ({ actionId, input }) => resolveSessionFollowActionRequest(actionId, input),
    } as Pick<ActionExecutorDeps, 'sessionFollowAction' | 'isActionApprovalRequired'> as ActionExecutorDeps);
    await expect(executor.execute('follow.list', { direction: 'followers', source: { kind: 'session', sessionId: 'source' } },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('returns typed unsupported when the canonical HTTP adapter cannot serve a declared source kind', async () => {
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      sessionFollowAction: async ({ actionId, input }) => resolveSessionFollowActionRequest(actionId, input),
    } as Pick<ActionExecutorDeps, 'sessionFollowAction' | 'isActionApprovalRequired'> as ActionExecutorDeps);
    await expect(executor.execute('follow.get', { receiver: { kind: 'account' }, source: { kind: 'discussion', discussionId: 'thread' } },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('authors private rules through the generic family without exposing ciphertext or enrollment authority', () => {
    const source = { kind: 'rule', ruleId: 'payments' } as const;
    const ruleDefinition = { v: 1, enabled: true, filter: {
      show: 'sessions', startedBy: ['you'], scope: 'all_accessible', attention: 'any',
      homeServerIds: ['home'], audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, source: 'all',
      projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] },
    } };
    const spec = getActionSpec('follow.set');
    const authoring = { receiver: { kind: 'account' }, source, ruleDefinition,
      policy: { preset: 'important' }, expectedVersion: -1 };
    expect(spec.inputSchema.safeParse(authoring).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...authoring, content: { t: 'plain', v: ruleDefinition } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...authoring, receiver: { kind: 'account', accountId: 'other' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...authoring, enrolledSessionIds: ['source'] }).success).toBe(false);
    expect(spec.safetyForInput?.(authoring)).toBe('safe');
    expect(spec.safetyForInput?.({ ...authoring, receiver: { kind: 'session', sessionId: 'coordinator' } })).toBe('danger');
    for (const id of ['follow.get', 'follow.set', 'follow.remove', 'follow.list', 'follow.preview', 'follow.preferences.get', 'follow.preferences.set'] as const) {
      expect(getActionSpec(id).surfaces).toMatchObject({ ui: true, voice: true, cli: true, mcp: true, agent: true });
    }
  });
  it('rejects source projections belonging to a different destination or source', () => {
    const source = {
      sourceSessionId: 'source',
      destinationSessionId: 'other',
      policy: { preset: 'important' },
      deliveryState: 'eligible',
      hasPendingUpdates: false,
    };
    const receiver = { kind: 'session', sessionId: 'destination' } as const;
    expect(() => parseSessionFollowActionResponse('follow.list', { direction: 'following', receiver }, { follows: [], rules: [], coverage: 'complete', sources: [source] })).toThrow('session_follow_response_target_mismatch');
    expect(() => parseSessionFollowActionResponse('follow.set', { receiver, source: { kind: 'session', sessionId: 'source' }, policy: source.policy }, { changed: true, source })).toThrow('session_follow_response_target_mismatch');
  });
  it('requires the result variant selected by the exact Follow relation, including absent results', () => {
    const rule = { receiver: { kind: 'account' }, source: { kind: 'rule', ruleId: 'payments' } } as const;
    expect(() => parseSessionFollowActionResponse('follow.get', rule, { source: null })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.get', rule, { follow: null })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.remove', { ...rule, expectedVersion: 0 }, { changed: true })).toThrow();
    expect(parseSessionFollowActionResponse('follow.get', rule, { rule: null })).toEqual({ rule: null });
    const session = { receiver: { kind: 'session', sessionId: 'destination' }, source: { kind: 'session', sessionId: 'source' } } as const;
    expect(() => parseSessionFollowActionResponse('follow.get', session, { rule: null })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.get', session, { sources: [{
      destinationSessionId: 'other', sourceSessionId: 'unrelated', policy: { preset: 'important' },
      deliveryState: 'eligible', hasPendingUpdates: false,
    }] })).toThrow('session_follow_response_target_mismatch');
    expect(parseSessionFollowActionResponse('follow.get', session, { sources: [] })).toEqual({ source: null });
  });
  it('keeps every Follow operation at Account placement with shared approval and generated surfaces', () => {
    const expected = [
      ['follow.get', 'safe', 'required'],
      ['follow.set', 'danger', 'optional'],
      ['follow.remove', 'danger', 'optional'],
      ['follow.preferences.get', 'safe', 'required'],
      ['follow.preferences.set', 'safe', 'optional'],
      ['follow.list', 'safe', 'none'],
      ['follow.preview', 'safe', 'none'],
    ] as const;
    for (const [id, safety, result] of expected) {
      const spec = getActionSpec(id);
      expect(spec.executionPlacement).toBe('account');
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(spec.safety).toBe(safety);
      expect(spec.approval.result).toBe(result);
      if (result === 'optional') expect(spec.approval.flow).toBe('deferred');
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, mcp: true, agent: true });
      expect(spec.cli?.commands.some((command) => command.visibility === 'canonical')).toBe(true);
    }
  });
  it('projects required on/off CLI preferences into complete Boolean replacements', () => {
    const spec = getActionSpec('follow.preferences.set');
    const flags = { assigned: 'on', direct: 'off', team: 'on', group: 'off' };
    expect(spec.cli?.inputSchema?.safeParse(flags).success).toBe(true);
    expect(spec.cli?.inputSchema?.safeParse({ assigned: 'on' }).success).toBe(false);
    expect(spec.cli?.bindInput?.(flags, { actionId: spec.id, invocationId: 'test' })).toEqual({ assigned: true, direct: false, team: true, group: false });
    expect(spec.cli?.bindInput?.({ ...flags, managerPolicy: { preset: 'quiet' }, runReportPolicy: { preset: 'everything' } },
      { actionId: spec.id, invocationId: 'test' })).toEqual({ assigned: true, direct: false, team: true, group: false,
      managerPolicy: { preset: 'quiet' }, runReportPolicy: { preset: 'everything' } });
  });

  it('exposes strict Account preference replacement without a Session placement', () => {
    const get = getActionSpec('follow.preferences.get');
    const set = getActionSpec('follow.preferences.set');
    expect(get.inputSchema.safeParse({ sessionId: 'wrong-scope' }).success).toBe(false);
    expect(set.inputSchema.safeParse({ autoFollowAssigned: true }).success).toBe(false);
    expect(set.executionPlacement).toBe('account');
    expect(set.serverTransport).toEqual({ method: 'PUT', path: '/v2/account/session-follow-preferences' });
  });
  it('carries creation policies through the existing preference Action without changing relationship defaults', () => {
    const input = { assigned: true, direct: false, team: false, group: false,
      managerPolicy: { preset: 'quiet' }, runReportPolicy: { preset: 'everything' },
      discussionReceivePolicy: { preset: 'custom', events: { message: { delivery: 'quiet' } } } };
    const spec = getActionSpec('follow.preferences.set');
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(resolveSessionFollowActionRequest('follow.preferences.set', input)).toEqual({
      method: 'PUT', path: '/v2/account/session-follow-preferences', body: input,
    });
    expect(parseSessionFollowActionResponse('follow.preferences.set', input, input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, managerPolicy: { preset: 'quiet', accountId: 'other' } }).success).toBe(false);
  });
  it('carries one explicit Session policy through Action HTTP and source reads without a mode decision', () => {
    const spec = getActionSpec('follow.set');
    const policy = { preset: 'custom', events: {
      update_posted: { delivery: 'quiet' }, needs_you: { decision: { delivery: 'interrupt' } },
    } } satisfies FollowPolicyV1;
    const pair = { destinationSessionId: 'dest/id', sourceSessionId: 'src/id' };
    const receiver = { kind: 'session', sessionId: pair.destinationSessionId } as const;
    const selection = { receiver, source: { kind: 'session', sessionId: pair.sourceSessionId } };
    const input = spec.inputSchema.parse({ ...selection, policy });
    expect(resolveSessionFollowActionRequest('follow.set', input)).toEqual({
      method: 'PUT', path: '/v2/sessions/dest%2Fid/follows/sessions/src%2Fid', body: { policy },
    });
    const committed = parseSessionFollowActionResponse('follow.set', input, {
      changed: true, source: { ...pair, policy, deliveryState: 'eligible', hasPendingUpdates: false },
    });
    const read = parseSessionFollowActionResponse('follow.list', { direction: 'following', receiver }, {
      sources: ['source' in committed ? committed.source : null], follows: [], rules: [], coverage: 'complete',
    });
    expect(read.sources[0]?.policy).toEqual(policy);
    const policies = [read.sources[0]!.policy];
    expect(resolveFollowDeliveryV1({ policies, event: { kind: 'update_posted' } }).session).toEqual({ nextTurn: true, wake: false });
    expect(resolveFollowDeliveryV1({ policies, event: { kind: 'needs_you', type: 'decision' } }).session).toEqual({ nextTurn: false, wake: true });
    expect(spec.inputSchema.safeParse(selection).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...selection, mode: 'next_turn' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...selection, policy, mode: 'wake_on_human_change' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...selection, policy: { ...policy, receiverSessionId: 'other' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...selection, policy: { preset: 'custom', events: { update_posted: { delivery: 'quiet', wake: true } } } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...selection, policy, executionAccountId: 'other' }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ arbitrary: true }).success).toBe(false);
  });
});
