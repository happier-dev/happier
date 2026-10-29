import { getActionSpec } from '../../actions/actionSpecs.js';
import { pluginJsonValuesEqual } from '../../plugins/contributions/jsonSchemaValues.js';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListRequestV1Schema } from '../../projects/projectAccountRowsV1.js';
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1 } from '../organization/snapshot.js';
import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1, type SessionFollowActionIdV1, type SessionFollowActionOutputV1 } from './actions.js';
import { DELIVERY_MUTE_HTTP_PATHS_V1, FollowReceiverRefV1Schema, FollowSourceRefV1Schema } from './sessionDeliveryMuteV1.js';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from './api.js';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1, ListSessionFollowSourcesResponseSchema } from './sessionFollowSourcesApi.js';
import { SESSION_FOLLOW_RULES_ROUTE_V1, SessionFollowRuleIdV1Schema, SetSessionFollowRuleRequestV1Schema, RemoveSessionFollowRuleRequestV1Schema, equalFollowRuleReceiverV1, type SessionFollowRuleContentV1 } from './sessionFollowRuleV1.js';
import { appendFollowListPageQueryV1, FollowListPageQueryV1Schema, FollowListPageRequestV1Schema, FollowListRequestV1Schema, parseFollowListQueryV1 } from './sessionFollowListV1.js';
import { appendFollowSourceRefQueryV1, parseOtherFollowSourceRefV1 } from './followSourceRefTransportV1.js';

const sameSourceRef = (row: Readonly<Record<string, unknown>>, source: Readonly<Record<string, unknown>>) =>
  source.kind === 'session' && (row.sourceSessionId === source.sessionId || row.sessionId === source.sessionId)
    || row.source !== undefined && pluginJsonValuesEqual(row.source, source);

/** Match signed wire bytes, including sealed private content, without reopening an authoring definition. */
export function isSessionFollowActionHttpRequestV1(actionId: SessionFollowActionIdV1, request: Readonly<{
  method: string; path: string; body?: unknown; routeInput?: unknown; sessionRouteSessionId?: string;
}>): boolean {
  if (!actionId.startsWith('follow.')) return false;
  const route = request.routeInput === undefined ? {} : request.routeInput;
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
  const input = route as Readonly<Record<string, unknown>>;
  const same = (left: unknown, right: unknown) => left === undefined && right === undefined || pluginJsonValuesEqual(left, right);
  const matches = (expected: Readonly<{ method: string; path: string; body?: unknown }>, params: Record<string, unknown> = {}) =>
    request.method.toUpperCase() === expected.method && request.path === expected.path
      && same(expected.body, request.body) && same(input, { ...params,
        ...(expected.body && typeof expected.body === 'object' ? expected.body : {}) });
  const accountRead = (path: string) => request.sessionRouteSessionId === undefined && matches({ method: 'GET', path });
  // Session corpus collection phases remain at the shared Session-list owner.
  // Project facets consume only the installed reader's exact private snapshot.
  if (actionId === 'follow.preview') {
    if (request.method.toUpperCase() === 'GET' && request.body === undefined && typeof input.assignmentSessionIds === 'string') {
      try {
        const snapshot = buildSessionOrganizationAssignmentSnapshotHttpRequestV1(input.assignmentSessionIds.split(','));
        return request.sessionRouteSessionId === undefined && request.path === snapshot.path && same(input, snapshot.query);
      } catch { return false; }
    }
    const parsed = ProjectAccountRowListRequestV1Schema.safeParse(request.body);
    return request.sessionRouteSessionId === undefined && parsed.success && same(parsed.data, {})
      && matches({ method: 'POST', path: `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, body: parsed.data });
  }
  if (request.path === '/v1/account/encryption/currentness') {
    return ['follow.get', 'follow.set', 'follow.list'].includes(actionId) && accountRead(request.path);
  }
  if (request.path === SESSION_FOLLOW_RULES_ROUTE_V1) return actionId === 'follow.list' && accountRead(request.path);
  if (input.ruleId !== undefined) {
    if (request.sessionRouteSessionId !== undefined) return false;
    const id = SessionFollowRuleIdV1Schema.safeParse(input.ruleId);
    if (!id.success) return false;
    const path = `${SESSION_FOLLOW_RULES_ROUTE_V1}/${encodeURIComponent(id.data)}`;
    if (actionId === 'follow.get') return matches({ method: 'GET', path }, { ruleId: id.data });
    const body = actionId === 'follow.set' ? SetSessionFollowRuleRequestV1Schema.safeParse(request.body)
      : actionId === 'follow.remove' ? RemoveSessionFollowRuleRequestV1Schema.safeParse(request.body) : null;
    return !!body?.success && matches({ method: actionId === 'follow.set' ? 'PUT' : 'DELETE', path, body: body.data }, { ruleId: id.data });
  }
  try {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
    const page = FollowListPageQueryV1Schema.parse({ ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }) });
    if (input.source !== undefined || input.sourceKinds !== undefined) {
      if (actionId !== 'follow.list' || input.sourceRef !== undefined || input.sourceSessionId !== undefined) return false;
      const selection = parseFollowListQueryV1({ ...page,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.sourceKinds === undefined ? {} : { sourceKinds: input.sourceKinds }) });
      const destinationSessionId = input.destinationSessionId;
      if (destinationSessionId !== undefined && (typeof destinationSessionId !== 'string' || request.sessionRouteSessionId !== destinationSessionId)
        || destinationSessionId === undefined && request.sessionRouteSessionId !== undefined) return false;
      const receiver = typeof destinationSessionId === 'string' ? { kind: 'session', sessionId: destinationSessionId } : { kind: 'account' };
      return matches(resolveSessionFollowActionRequest('follow.list', { direction: 'following', receiver, ...selection }),
        { ...page, ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.sourceKinds === undefined ? {} : { sourceKinds: input.sourceKinds }),
          ...(destinationSessionId === undefined ? {} : { destinationSessionId }) });
    }
    if (input.sourceRef !== undefined) {
      if (typeof input.sourceRef !== 'string') return false;
      const source = parseOtherFollowSourceRefV1(input.sourceRef);
      if (!source) return false;
      if (input.destinationSessionId !== undefined) {
        if (typeof input.destinationSessionId !== 'string' || request.sessionRouteSessionId !== input.destinationSessionId || Object.keys(page).length) return false;
        const receiver = { kind: 'session', sessionId: input.destinationSessionId };
        const expected = resolveSessionFollowActionRequest(actionId, { receiver, source, ...body });
        return matches(expected, { destinationSessionId: input.destinationSessionId, sourceRef: input.sourceRef, ...body });
      }
      if (request.sessionRouteSessionId !== undefined) return false;
      if (actionId === 'follow.list') return matches(resolveSessionFollowActionRequest(actionId,
        { direction: 'followers', source, ...page }), { sourceRef: input.sourceRef, ...page });
      return matches(resolveSessionFollowActionRequest(actionId, { receiver: { kind: 'account' }, source, ...body }),
        { sourceRef: input.sourceRef, ...body });
    }
    if (input.sourceSessionId !== undefined && input.destinationSessionId === undefined) {
      return actionId === 'follow.list' && typeof input.sourceSessionId === 'string'
        && request.sessionRouteSessionId === input.sourceSessionId
        && matches(resolveSessionFollowActionRequest('follow.list', { direction: 'followers',
          source: { kind: 'session', sessionId: input.sourceSessionId }, ...page }), { sourceSessionId: input.sourceSessionId, ...page });
    }
    if (input.destinationSessionId !== undefined) {
      if (typeof input.destinationSessionId !== 'string' || request.sessionRouteSessionId !== input.destinationSessionId) return false;
      const receiver = { kind: 'session', sessionId: input.destinationSessionId };
      if (actionId === 'follow.list' || actionId === 'follow.get') {
        if (actionId === 'follow.get' && Object.keys(page).length) return false;
        return matches(resolveSessionFollowActionRequest('follow.list', { receiver, direction: 'following', ...page }), { destinationSessionId: input.destinationSessionId, ...page });
      }
      const expected = resolveSessionFollowActionRequest(actionId, { receiver,
        source: { kind: 'session', sessionId: input.sourceSessionId }, ...body });
      return matches(expected, { destinationSessionId: input.destinationSessionId, sourceSessionId: input.sourceSessionId });
    }
    if (input.sessionId !== undefined) {
      if (typeof input.sessionId !== 'string' || request.sessionRouteSessionId !== input.sessionId) return false;
      if (actionId === 'follow.set') {
        const path = `/v2/sessions/${encodeURIComponent(input.sessionId)}`;
        if (matches({ method: 'GET', path }, { sessionId: input.sessionId })
          || matches({ method: 'GET', path: `${path}?accessProjectionVersion=1` }, { sessionId: input.sessionId, accessProjectionVersion: 1 })) return true;
      }
      const expected = resolveSessionFollowActionRequest(actionId, { receiver: { kind: 'account' },
        source: { kind: 'session', sessionId: input.sessionId }, ...body });
      return matches(expected, { sessionId: input.sessionId });
    }
    if (request.sessionRouteSessionId !== undefined) return false;
    if (actionId === 'follow.list') return matches(resolveSessionFollowActionRequest(actionId, { receiver: { kind: 'account' }, direction: 'following', ...page }), page);
    if (actionId === 'follow.preferences.get' || actionId === 'follow.preferences.set') {
      return matches(resolveSessionFollowActionRequest(actionId, body));
    }
  } catch { return false; }
  return false;
}

/** A schema-valid response must still belong to the exact requested relation. */
export function parseSessionFollowActionResponse<TActionId extends SessionFollowActionIdV1>(
  actionId: TActionId,
  input: unknown,
  payload: unknown,
): SessionFollowActionOutputV1[TActionId] {
  const request: Record<string, unknown> = SessionFollowActionInputSchemasV1[actionId].parse(input);
  let candidate = payload;
  const receiver = FollowReceiverRefV1Schema.safeParse(request.receiver);
  const source = request.source && typeof request.source === 'object' ? request.source as Readonly<Record<string, unknown>> : null;
  const mismatch = () => { throw new Error('session_follow_response_target_mismatch'); };
  if (actionId === 'follow.get' && receiver.success && receiver.data.kind === 'session' && source?.kind === 'session') {
    const list = ListSessionFollowSourcesResponseSchema.safeParse(payload);
    if (list.success) {
      const destinationSessionId = receiver.data.sessionId;
      if (list.data.sources.some(row => row.destinationSessionId !== destinationSessionId)) mismatch();
      candidate = { source: list.data.sources.find(row => sameSourceRef(row, source)) ?? null };
    }
  }
  const result = SessionFollowActionOutputSchemasV1[actionId].parse(candidate);
  if (actionId === 'follow.list' && request.direction === 'followers' && 'sources' in result) {
    if (!source || source.kind === 'rule' || result.sources.some(row => !sameSourceRef(row, source) || row.relation === undefined)
      || result.follows.length > 1 || result.follows.some(row => !sameSourceRef(row, source)) || result.rules.length !== 0
      || result.peopleCount === undefined) mismatch();
  }
  if (actionId === 'follow.get' || actionId === 'follow.set') {
    const selectedField = source?.kind === 'rule' ? 'rule' : receiver.success && receiver.data.kind === 'account' ? 'follow' : 'source';
    if (!(selectedField in result)) mismatch();
  }
  if (actionId === 'follow.remove' && (source?.kind === 'rule') !== ('version' in result)) mismatch();
  if ('follow' in result && result.follow && (!source || !sameSourceRef(result.follow, source))) mismatch();
  if ('source' in result && result.source) {
    if (!receiver.success || receiver.data.kind !== 'session'
      || result.source.destinationSessionId !== receiver.data.sessionId || !source || !sameSourceRef(result.source, source)) mismatch();
  }
  if ('rule' in result && result.rule) {
    if (!receiver.success || result.rule.ruleId !== source?.ruleId || !equalFollowRuleReceiverV1(result.rule.receiver, receiver.data)) mismatch();
    if (actionId === 'follow.set' && (result.rule.version !== Number(request.expectedVersion) + 1
      || JSON.stringify(result.rule.definition) !== JSON.stringify({ ...request.ruleDefinition as object, policy: request.policy }))) mismatch();
  }
  if (actionId === 'follow.remove' && source?.kind === 'rule' && 'version' in result
    && (typeof result.version !== 'number' || result.version <= Number(request.expectedVersion))) mismatch();
  if ('sources' in result && receiver.success && result.sources.some(row => receiver.data.kind !== 'session' || row.destinationSessionId !== receiver.data.sessionId)) mismatch();
  if ('rules' in result && receiver.success && result.rules.some(rule => !equalFollowRuleReceiverV1(rule.receiver, receiver.data))) mismatch();
  if ('follows' in result && receiver.success && receiver.data.kind !== 'account' && result.follows.length) mismatch();
  // The schema map associates each Action with its exact result type.
  return result as SessionFollowActionOutputV1[TActionId];
}

/** Project the catalog's method/path and strict input into the domain HTTP request. */
export function resolveSessionFollowActionRequest(actionId: SessionFollowActionIdV1, input: unknown,
  prepared?: Readonly<{ ruleContent?: SessionFollowRuleContentV1 }>,
): Readonly<{
  path: string; method: 'GET' | 'PUT' | 'DELETE'; body?: Record<string, unknown>;
}> {
  const data: Record<string, unknown> = SessionFollowActionInputSchemasV1[actionId].parse(input);
  if (actionId === 'follow.preferences.set') {
    const { assigned, direct, team, group, ...policies } = data;
    return { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences,
      body: { defaultRules: { assigned, direct, team, group }, ...policies } };
  }
  if (actionId === 'follow.preview') throw new Error('follow_preview_requires_authorized_corpus');
  if (actionId === 'follow.list') {
    const page = FollowListPageRequestV1Schema.parse({ cursor: data.cursor, limit: data.limit });
    if (data.direction === 'followers') {
      const source = data.source as Readonly<Record<string, unknown>>;
      return { method: 'GET', path: source.kind === 'session'
        ? appendFollowListPageQueryV1(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.followers
          .replace(':sourceSessionId', encodeURIComponent(String(source.sessionId))), page)
        : appendFollowSourceRefQueryV1(appendFollowListPageQueryV1(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherFollowers, page),
          FollowSourceRefV1Schema.parse(source)) };
    }
    const receiver = FollowReceiverRefV1Schema.parse(data.receiver);
    return { method: 'GET', path: appendFollowListPageQueryV1(receiver.kind === 'account' ? '/v2/account/session-follows'
      : SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list.replace(':destinationSessionId', encodeURIComponent(receiver.sessionId)),
      FollowListRequestV1Schema.parse({ ...page, source: data.source, sourceKinds: data.sourceKinds })) };
  }
  if (actionId === 'follow.get' || actionId === 'follow.set' || actionId === 'follow.remove') {
    const receiver = FollowReceiverRefV1Schema.parse(data.receiver);
    const source = data.source as Readonly<Record<string, unknown>>;
    const method = actionId === 'follow.get' ? 'GET' : actionId === 'follow.set' ? 'PUT' : 'DELETE';
    if (source.kind === 'rule') {
      const path = `${SESSION_FOLLOW_RULES_ROUTE_V1}/${encodeURIComponent(String(source.ruleId))}`;
      if (method === 'GET') return { path, method };
      if (method === 'DELETE') return { path, method, body: { receiver, expectedVersion: data.expectedVersion } };
      if (!prepared?.ruleContent) throw new Error('follow_rule_content_not_prepared');
      return { path, method, body: { receiver, content: prepared.ruleContent, expectedVersion: data.expectedVersion } };
    }
    if (source.kind !== 'session') {
      const base = receiver.kind === 'account' ? SESSION_FOLLOW_HTTP_PATHS_V1.otherSource
        : SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherSource.replace(':destinationSessionId', encodeURIComponent(receiver.sessionId));
      return { path: appendFollowSourceRefQueryV1(base, FollowSourceRefV1Schema.parse(source)), method,
        ...(method === 'PUT' ? { body: { ...(data.policy !== undefined ? { policy: data.policy } : {}),
          ...(data.once !== undefined ? { once: data.once } : {}),
          ...(data.clearOnceDeliveries === true ? { clearOnceDeliveries: true } : {}) } } : {}) };
    }
    if (receiver.kind === 'account') return {
      path: SESSION_FOLLOW_HTTP_PATHS_V1.follow.replace(':sessionId', encodeURIComponent(String(source.sessionId))), method,
      ...(method === 'PUT' ? { body: { ...(data.policy !== undefined ? { policy: data.policy } : {}), ...(data.once !== undefined ? { once: data.once } : {}) } } : {}),
    };
    const base = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list.replace(':destinationSessionId', encodeURIComponent(receiver.sessionId));
    return { path: method === 'GET' ? base : `${base}/${encodeURIComponent(String(source.sessionId))}`, method,
      ...(method === 'PUT' ? { body: { policy: data.policy } } : {}) };
  }
  const transport = getActionSpec(actionId).serverTransport;
  if (!transport || !['GET', 'PUT', 'DELETE'].includes(transport.method)) throw new Error('Invalid Follow Action transport');
  const body = { ...data };
  let transportPath = transport.path;
  if (actionId.startsWith('session.delivery.mute.')) {
    const receiver = FollowReceiverRefV1Schema.parse(data.receiver);
    delete body.receiver;
    if (receiver.kind === 'session') {
      transportPath = DELIVERY_MUTE_HTTP_PATHS_V1.session;
      body.sessionId = receiver.sessionId;
    }
  }
  const path = transportPath.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key: string) => {
    const value = body[key] ?? data[key];
    if (typeof value !== 'string') throw new Error('Missing Follow Action path parameter');
    delete body[key];
    return encodeURIComponent(value);
  });
  const method = transport.method as 'GET' | 'PUT' | 'DELETE';
  return { path, method, ...((method === 'PUT' || method === 'DELETE' && actionId === 'session.delivery.mute.remove') ? { body } : {}) };
}
