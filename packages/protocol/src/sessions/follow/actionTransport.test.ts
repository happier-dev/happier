import { describe, expect, it } from 'vitest';

import { normalizeSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { isSessionFollowActionHttpRequestV1, parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from './actionTransport.js';
import { sealSessionFollowRuleContentV1 } from './sessionFollowRuleContentCodecV1.js';
import { pageFollowListV1 } from './sessionFollowListV1.js';

describe('signed Follow HTTP purposes', () => {
  it('selects source kinds through following transport and binds them to the signed purpose', () => {
    for (const receiver of [{ kind: 'account' }, { kind: 'session', sessionId: 'receiver' }] as const) {
      const input = { direction: 'following' as const, receiver, sourceKinds: ['execution_run', 'workflow_run'], limit: 1 };
      const request = resolveSessionFollowActionRequest('follow.list', input);
      expect(resolveSessionFollowActionRequest('follow.list', { ...input,
        sourceKinds: ['workflow_run', 'execution_run', 'execution_run'] })).toEqual(request);
      const query = Object.fromEntries(new URL(request.path, 'https://home.test').searchParams);
      expect(JSON.parse(query.sourceKinds!)).toEqual(['execution_run', 'workflow_run']);
      expect(query.limit).toBe('1');
      const wire = { ...request, routeInput: { ...query, limit: 1,
        ...(receiver.kind === 'session' ? { destinationSessionId: receiver.sessionId } : {}) },
        ...(receiver.kind === 'session' ? { sessionRouteSessionId: receiver.sessionId } : {}) };
      expect(isSessionFollowActionHttpRequestV1('follow.list', wire)).toBe(true);
      expect(isSessionFollowActionHttpRequestV1('follow.list', { ...wire,
        routeInput: { ...wire.routeInput, sourceKinds: JSON.stringify(['discussion']) } })).toBe(false);
      expect(() => resolveSessionFollowActionRequest('follow.list', { ...input, sourceKinds: ['rule'] })).toThrow();
    }
  });
  it('carries a closed source selection on following pages and binds the signed HTTP purpose', () => {
    const source = { kind: 'session' as const, sessionId: 'selected-session' };
    for (const receiver of [{ kind: 'account' }, { kind: 'session', sessionId: 'receiver' }] as const) {
      const input = { direction: 'following' as const, receiver, source, limit: 1 };
      const request = resolveSessionFollowActionRequest('follow.list', input);
      const encoded = Object.fromEntries(new URL(request.path, 'https://home.test').searchParams);
      const query = { ...encoded, limit: 1 };
      expect(JSON.parse(encoded.source!)).toEqual(source);
      const wire = { ...request, routeInput: { ...query,
        ...(receiver.kind === 'session' ? { destinationSessionId: receiver.sessionId } : {}) },
        ...(receiver.kind === 'session' ? { sessionRouteSessionId: receiver.sessionId } : {}) };
      expect(isSessionFollowActionHttpRequestV1('follow.list', wire)).toBe(true);
      expect(isSessionFollowActionHttpRequestV1('follow.list', { ...wire,
        routeInput: { ...wire.routeInput, source: JSON.stringify({ ...source, sessionId: 'other' }) } })).toBe(false);
      expect(() => resolveSessionFollowActionRequest('follow.list', { ...input, source: { ...source, accountId: 'other' } })).toThrow();
    }
  });
  it('binds long exact Run source queries for both receivers and reverse inspection', () => {
    const source = { kind: 'execution_run' as const, sessionId: 'cmvjujoae0070m2opuposiddv',
      runId: "run_a29bce41-d16c-4af6-a586-6f96d8773e2d/%?+'" };
    for (const receiver of [{ kind: 'account' }, { kind: 'session', sessionId: 'receiver' }] as const) {
      for (const actionId of ['follow.get', 'follow.set', 'follow.remove'] as const) {
        const request = resolveSessionFollowActionRequest(actionId, { receiver, source,
          ...(actionId === 'follow.set' ? { policy: { preset: 'important' } } : {}) });
        const url = new URL(request.path, 'https://home.test');
        const sourceRef = url.searchParams.get('sourceRef');
        expect(JSON.parse(sourceRef!)).toEqual(source);
        const wire = { ...request, routeInput: { sourceRef,
          ...(receiver.kind === 'session' ? { destinationSessionId: receiver.sessionId } : {}), ...request.body },
          ...(receiver.kind === 'session' ? { sessionRouteSessionId: receiver.sessionId } : {}) };
        expect(isSessionFollowActionHttpRequestV1(actionId, wire)).toBe(true);
        expect(isSessionFollowActionHttpRequestV1(actionId, { ...wire,
          routeInput: { ...wire.routeInput, sourceRef: JSON.stringify({ ...source, runId: 'another-run' }) } })).toBe(false);
        expect(isSessionFollowActionHttpRequestV1(actionId, { ...wire, path: `${request.path}&accountId=foreign` })).toBe(false);
      }
    }
    const request = resolveSessionFollowActionRequest('follow.list', { direction: 'followers', source, cursor: 'next/page', limit: 1 });
    const sourceRef = new URL(request.path, 'https://home.test').searchParams.get('sourceRef');
    const wire = { ...request, routeInput: { sourceRef, cursor: 'next/page', limit: 1 } };
    expect(isSessionFollowActionHttpRequestV1('follow.list', wire)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.list', { ...wire, routeInput: { ...wire.routeInput, limit: 2 } })).toBe(false);
  });

  it('continues exact source keys after removal and binds the cursor to its admitted list', () => {
    const rows = ['source-c', 'source-a', 'source-b'];
    const first = pageFollowListV1({ rows, scope: 'receiver', limit: 1, key: row => row });
    expect(first.rows).toEqual(['source-a']);
    expect(first.continuation).toEqual(expect.any(String));
    expect(pageFollowListV1({ rows: ['source-b', 'source-c'], scope: 'receiver',
      cursor: first.continuation, key: row => row })).toEqual({ rows: ['source-b', 'source-c'] });
    expect(() => pageFollowListV1({ rows, scope: 'other-receiver', cursor: first.continuation, key: row => row })).toThrow();
    expect(pageFollowListV1({ rows, scope: 'receiver', key: row => row })).toEqual({ rows: ['source-a', 'source-b', 'source-c'] });
  });
  it('carries source-owned list continuation through the exact signed request and strict response', () => {
    const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: 'source' },
      cursor: 'source-page', limit: 2 };
    const request = resolveSessionFollowActionRequest('follow.list', input);
    expect(request).toEqual({ method: 'GET', path: '/v2/sessions/source/follows/followers?cursor=source-page&limit=2' });
    const wire = { ...request, routeInput: { sourceSessionId: 'source', cursor: 'source-page', limit: 2 }, sessionRouteSessionId: 'source' };
    expect(isSessionFollowActionHttpRequestV1('follow.list', wire)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.list', { ...wire, routeInput: { ...wire.routeInput, cursor: 'other' } })).toBe(false);
    const payload = { follows: [], sources: [], rules: [], peopleCount: 0, coverage: 'partial', continuation: 'next-page' };
    expect(parseSessionFollowActionResponse('follow.list', input, payload)).toEqual(payload);
  });
  it('binds a reverse read and its strict private census to the exact source', () => {
    const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: 'source' } };
    const request = resolveSessionFollowActionRequest('follow.list', input);
    expect(request).toEqual({ method: 'GET', path: '/v2/sessions/source/follows/followers' });
    const wire = { ...request, routeInput: { sourceSessionId: 'source' }, sessionRouteSessionId: 'source' };
    expect(isSessionFollowActionHttpRequestV1('follow.list', wire)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.get', wire)).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.list', { ...wire, sessionRouteSessionId: 'other' })).toBe(false);
    const payload = { follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'receiver',
      relation: 'manager', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false }],
      rules: [], coverage: 'complete', peopleCount: 2 };
    expect(parseSessionFollowActionResponse('follow.list', input, payload)).toEqual(payload);
    expect(() => parseSessionFollowActionResponse('follow.list', input,
      { ...payload, sources: [{ ...payload.sources[0], sourceSessionId: 'other' }] })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.list', input,
      { ...payload, sources: [{ ...payload.sources[0], relation: undefined }] })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.list', input,
      { ...payload, rules: [{ ruleId: 'private', receiver: { kind: 'account' }, version: 0,
        definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' } } }] })).toThrow();
    expect(() => parseSessionFollowActionResponse('follow.list', input,
      { ...payload, people: [{ accountId: 'private' }] })).toThrow();
  });
  it('admits the real mode-aware rule writer output without accepting plaintext authoring or extra authority', () => {
    const input = { receiver: { kind: 'account' as const }, source: { kind: 'rule' as const, ruleId: 'project/rule' },
      ruleDefinition: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1() },
      policy: { preset: 'important' as const }, expectedVersion: -1 };
    for (const mode of ['plain', 'e2ee'] as const) {
      const ruleContent = sealSessionFollowRuleContentV1({ ruleId: input.source.ruleId, receiver: input.receiver,
        definition: { ...input.ruleDefinition, policy: input.policy }, mode,
        material: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const request = resolveSessionFollowActionRequest('follow.set', input, { ruleContent });
      const wire = { ...request, routeInput: { ruleId: input.source.ruleId, ...request.body } };
      expect(isSessionFollowActionHttpRequestV1('follow.set', wire)).toBe(true);
      expect(isSessionFollowActionHttpRequestV1('follow.get', wire)).toBe(false);
      expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire, body: { ...request.body, ruleDefinition: input.ruleDefinition } })).toBe(false);
      expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire,
        routeInput: { ...wire.routeInput, accountId: 'other' } })).toBe(false);
      expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire, path: `${request.path}?accountId=other` })).toBe(false);
    }
  });

  it('requires the declared receiver binding and exact pair on operational Session requests', () => {
    const input = { receiver: { kind: 'session' as const, sessionId: 'receiver' },
      source: { kind: 'session' as const, sessionId: 'source' }, policy: { preset: 'important' as const } };
    const request = resolveSessionFollowActionRequest('follow.set', input);
    const wire = { ...request, sessionRouteSessionId: input.receiver.sessionId,
      routeInput: { destinationSessionId: input.receiver.sessionId, sourceSessionId: input.source.sessionId, ...request.body } };
    expect(isSessionFollowActionHttpRequestV1('follow.set', wire)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire, sessionRouteSessionId: undefined })).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire, sessionRouteSessionId: 'outside' })).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.set', { ...wire,
      routeInput: { ...wire.routeInput, sourceSessionId: 'outside' } })).toBe(false);
    const remove = resolveSessionFollowActionRequest('follow.remove', { receiver: input.receiver, source: input.source });
    expect(isSessionFollowActionHttpRequestV1('follow.remove', { ...remove, sessionRouteSessionId: 'receiver',
      routeInput: { destinationSessionId: 'receiver', sourceSessionId: 'source' } })).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.remove', { ...remove, body: {}, sessionRouteSessionId: 'receiver' })).toBe(false);
  });

  it('admits only each operation’s actual preparation reads and canonical Account transport', () => {
    const currentness = { method: 'GET', path: '/v1/account/encryption/currentness', routeInput: {} };
    for (const action of ['follow.get', 'follow.set', 'follow.list'] as const) {
      expect(isSessionFollowActionHttpRequestV1(action, currentness)).toBe(true);
    }
    expect(isSessionFollowActionHttpRequestV1('follow.remove', currentness)).toBe(false);
    const sourceKey = { method: 'GET', path: '/v2/sessions/source?accessProjectionVersion=1',
      routeInput: { sessionId: 'source', accessProjectionVersion: 1 }, sessionRouteSessionId: 'source' };
    expect(isSessionFollowActionHttpRequestV1('follow.set', sourceKey)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.remove', sourceKey)).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.set', { ...sourceKey, sessionRouteSessionId: 'other' })).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.set', { ...sourceKey, path: `${sourceKey.path}&other=1` })).toBe(false);
    const census = { method: 'GET', path: '/v2/account/session-follow-rules', routeInput: {} };
    expect(isSessionFollowActionHttpRequestV1('follow.list', census)).toBe(true);
    for (const action of ['follow.get', 'follow.set', 'follow.remove'] as const) {
      expect(isSessionFollowActionHttpRequestV1(action, census)).toBe(false);
    }
    for (const [actionId, input] of [
      ['follow.set', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'source' }, once: null }],
      ['follow.preferences.set', { assigned: true, direct: false, team: false, group: false }],
    ] as const) {
      const request = resolveSessionFollowActionRequest(actionId, input);
      expect(isSessionFollowActionHttpRequestV1(actionId, { ...request,
        ...(actionId === 'follow.set' ? { sessionRouteSessionId: 'source' } : {}),
        routeInput: { ...(actionId === 'follow.set' ? { sessionId: 'source' } : {}), ...request.body } })).toBe(true);
    }
    expect(isSessionFollowActionHttpRequestV1('follow.list', { method: 'GET', path: '/v2/account/settings', routeInput: {} })).toBe(false);
  });

  it('limits the preview Project snapshot to the actual read and never a private mutation', () => {
    const request = { method: 'POST', path: '/v1/account/project-rows/list', body: {}, routeInput: {} };
    expect(isSessionFollowActionHttpRequestV1('follow.preview', request)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.set', request)).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.preview', { ...request, body: { serverId: 'other' }, routeInput: { serverId: 'other' } })).toBe(false);
    expect(isSessionFollowActionHttpRequestV1('follow.preview', { ...request, path: '/v1/account/project-rows/mutate' })).toBe(false);
  });
  it('admits only the preview assignment-only organization snapshot for named Session ids', () => {
    const query = { includeFolders: 'false', includeTags: 'false', includeLabels: 'false', assignmentSessionIds: 'source,other' };
    const request = { method: 'GET', path: '/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=source%2Cother', routeInput: query };
    expect(isSessionFollowActionHttpRequestV1('follow.preview', request)).toBe(true);
    expect(isSessionFollowActionHttpRequestV1('follow.list', request)).toBe(false);
    for (const changed of [
      { ...request, path: `${request.path}&includeAllTagAssignments=true`, routeInput: { ...query, includeAllTagAssignments: 'true' } },
      { ...request, path: request.path.replace('includeTags=false', 'includeTags=true'), routeInput: { ...query, includeTags: 'true' } },
      { ...request, routeInput: { ...query, assignmentSessionIds: '' } },
      { ...request, method: 'POST', body: query },
    ]) expect(isSessionFollowActionHttpRequestV1('follow.preview', changed)).toBe(false);
  });
});
