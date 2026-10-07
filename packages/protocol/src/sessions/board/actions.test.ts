import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../../actions/actionSpecs.js';

import {
  SESSION_BOARD_ACTION_IDS_V1,
  SessionBoardActionIdV1Schema,
} from './actionIds.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1,
  SESSION_BOARD_GET_MAX_LIMIT_V1,
  SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
  SessionBoardGetInputV1Schema,
  SessionBoardGetResultV1Schema,
  SessionBoardItemRemoveInputV1Schema,
  SessionBoardItemUpsertInputV1Schema,
  SessionBoardLayoutUpdateInputV1Schema,
  SessionBoardActionFailureV1Schema,
  SessionBoardActionRecoveryEvidenceV1Schema,
  SessionBoardApprovalRequestCreatedResultV1Schema,
  bindSessionBoardMutationRequestV1,
  classifySessionBoardMutationTransportResultV1,
  SessionBoardMutationActionResultV1Schema,
  createSessionBoardFailureV1,
  createSessionBoardOutcomeUnknownFailureV1,
  projectSessionBoardActionFailureV1,
  parseSessionBoardActionExecuteOutcomeV1,
  parseSessionBoardActionPortResultV1,
  projectSessionBoardAdapterFailureV1,
  projectSessionBoardGetResultV1,
} from './actions.js';
import { SessionBoardMutationV1Schema } from './mutations.js';
import {
  SessionBoardErrorV1Schema,
  projectSessionBoardFeatureDecisionFailureV1,
} from './errors.js';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = {
  v: 1,
  title: 'Note',
  frame: 'card',
  height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# Note' } } },
} as const;

describe('Session Board Action contracts', () => {
  it('binds configured widget instance identity to the canonical Board item id on cleartext write seams', () => {
    const widget = { ...item, source: { kind: 'widget', instance: { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'status' } }, bindings: {} } } };
    const upsert = { itemId: 'copy-a', expectedItemRevision: revision, item: widget };
    expect(SessionBoardItemUpsertInputV1Schema.safeParse(upsert).success).toBe(true);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({ ...upsert, itemId: 'copy-b' }).success).toBe(false);
    const mutation = { operation: 'upsert_item', itemId: 'copy-a', expectedItemRevision: revision, itemContent: { t: 'plain', v: widget } };
    expect(SessionBoardMutationV1Schema.safeParse(mutation).success).toBe(true);
    expect(SessionBoardMutationV1Schema.safeParse({ ...mutation, itemId: 'copy-b' }).success).toBe(false);
  });
  it('binds one Board mutation to its exact Home request through the shared binder', () => {
    const mutation = SessionBoardMutationV1Schema.parse({
      operation: 'update_layout',
      expectedLayoutRevision: null,
      layoutContent: { t: 'plain', v: { v: 1, tabs: [] } },
    });
    const bound = bindSessionBoardMutationRequestV1({ sessionId: 'a/b c', mutation });
    expect(bound).toEqual({
      method: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1.method,
      path: '/v2/sessions/a%2Fb%20c/board',
      body: mutation,
    });
    expect(Object.keys(bound.body)).not.toContain('sessionId');
    expect(() => bindSessionBoardMutationRequestV1({ sessionId: '   ', mutation })).toThrow();
  });
  it('keeps every detail-free host refusal inside the strict Board failure union', () => {
    for (const code of ['session_board_forbidden', 'session_board_revision_conflict', 'offline', 'cancelled'] as const) {
      const failure = createSessionBoardFailureV1(code);
      expect(failure).toEqual({ ok: false, errorCode: code, error: code });
      expect(SessionBoardActionFailureV1Schema.safeParse(failure).success).toBe(true);
    }
  });
  it('normalizes incumbent record and encryption exceptions into the strict Board vocabulary', () => {
    expect(projectSessionBoardAdapterFailureV1({ code: 'plugin_session_records_unavailable' }))
      .toEqual({ ok: false, errorCode: 'protocol_unavailable', error: 'protocol_unavailable' });
    expect(projectSessionBoardAdapterFailureV1({ cause: { code: 'plugin_session_record_encryption_mismatch' } }))
      .toEqual({ ok: false, errorCode: 'mode_mismatch', error: 'mode_mismatch' });
    expect(projectSessionBoardAdapterFailureV1(new DOMException('cancelled', 'AbortError')))
      .toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(projectSessionBoardAdapterFailureV1(new Error('unexpected')))
      .toEqual({ ok: false, errorCode: 'invalid_response', error: 'invalid_response' });
    // A read that never reached the Home is the same disposition the mutation path already uses.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'] as const) {
      expect(projectSessionBoardAdapterFailureV1({ code }))
        .toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    }
    expect(projectSessionBoardAdapterFailureV1({ cause: { code: 'ECONNREFUSED' } }))
      .toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    expect(projectSessionBoardAdapterFailureV1({ code: 'ERR_CANCELED' }))
      .toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    // A definite authorization denial stays `forbidden` and never becomes `not_authenticated`.
    expect(projectSessionBoardAdapterFailureV1({ code: 'plugin_session_record_forbidden' }))
      .toEqual({ ok: false, errorCode: 'forbidden', error: 'forbidden' });
    // The feature refusal reuses the existing gate projection, which carries its operation.
    expect(projectSessionBoardAdapterFailureV1(
      { code: 'plugin_session_record_feature_disabled' },
      'invalid_response',
      'session.board.get',
    )).toEqual({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'feature_disabled',
      details: { operation: 'session.board.get' },
    });
  });
  it('projects readable Board conflict revisions through generic Action failure details', () => {
    expect(projectSessionBoardActionFailureV1({
      error: 'session_board_revision_conflict',
      currentItemRevision: null,
      currentLayoutRevision: revision,
    })).toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentItemRevision: null, currentLayoutRevision: revision },
    });
    expect(projectSessionBoardActionFailureV1({ error: 'session_board_forbidden' })).toEqual({
      ok: false,
      errorCode: 'session_board_forbidden',
      error: 'session_board_forbidden',
    });
    expect(SessionBoardErrorV1Schema.safeParse({
      error: 'session_board_forbidden', currentLayoutRevision: revision,
    }).success).toBe(false);
  });

  it('correlates successful Action-port results to the invoked Board intent', () => {
    const base = {
      v: 1, serverId: 'home-1', sessionId: 'session-1',
      destination: { tabId: 'overview', width: 'wide' },
    } as const;
    const createInput = {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: null, item,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    } as const;
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', createInput, {
      ...base,
      result: { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision },
      preview: { title: 'Note', sourceKind: 'declarative' },
    }, { expectedServerId: 'home-1', expectedSessionId: 'session-1' }).success).toBe(true);
    for (const result of [
      { ...base, result: { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision }, destination: null },
      { ...base, result: { operation: 'upsert_item', itemId: 'other', outcome: 'created', itemRevision: revision, layoutRevision: revision } },
      { ...base, result: { operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision, layoutRevision: revision } },
      { ...base, result: { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision } },
      { ...base, sessionId: 'other-session', result: { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision } },
    ]) {
      expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', createInput, result, {
        expectedServerId: 'home-1',
        expectedSessionId: 'session-1',
      }).success).toBe(false);
    }

    const getResult = {
      v: 1, serverId: 'home-1', sessionId: 'session-1',
      capabilities: { readTranscript: true, editSessionRecords: false }, layout: null,
      items: [{ itemId: 'other', revision, title: 'Other', sourceKind: 'declarative', item }],
      incomplete: false, page: { cursor: null, hasNext: false },
    };
    expect(parseSessionBoardActionPortResultV1('session.board.get', {
      sessionId: 'session-1', itemIds: ['note'],
    }, getResult).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.get', {}, {
      ...getResult, items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'declarative', item }],
    }).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.get', {
      sessionId: 'session-1', itemIds: ['note'],
    }, {
      ...getResult,
      serverId: 'other-home',
      items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'declarative', item }],
    }, { expectedServerId: 'home-1' }).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.get', {
      sessionId: 'session-1', itemIds: ['note'],
    }, {
      ...getResult,
      items: [{ itemId: 'note', revision, title: 'Wrong title', sourceKind: 'declarative', item }],
    }).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.get', {
      sessionId: 'session-1', itemIds: ['note'],
    }, {
      ...getResult,
      items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'hostedHtml', item }],
    }).success).toBe(false);
  });

  it('validates and correlates every Board Action-port failure envelope', () => {
    const input = { itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision } as const;
    expect(parseSessionBoardActionPortResultV1('session.board.item.remove', input, {
      ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    }).success).toBe(true);
    for (const failure of [
      { ok: false, errorCode: 'made_up', error: 'made_up' },
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden', details: { currentLayoutRevision: revision } },
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden', details: 'invalid' },
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden', details: {} },
      { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict', details: { error: 'session_board_forbidden' } },
      { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled', details: { operation: 'session.board.get' } },
      { ok: false, errorCode: 'update_required', error: 'update_required', details: { kind: 'update_required', operation: 'session.board.get', component: 'server', reason: 'old' } },
      { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: {} },
    ]) {
      expect(parseSessionBoardActionPortResultV1('session.board.item.remove', input, failure).success).toBe(false);
    }
  });
  it('keeps disabled and unsupported Board feature decisions typed and operation-scoped', () => {
    const disabled = {
      featureId: 'sessions.board' as const,
      state: 'disabled' as const,
      blockedBy: 'server' as const,
      blockerCode: 'feature_disabled' as const,
      diagnostics: ['server_enabled:false'],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime' as const },
    };
    expect(projectSessionBoardFeatureDecisionFailureV1('session.board.item.remove', disabled)).toEqual({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'feature_disabled',
      details: { operation: 'session.board.item.remove', featureDecision: disabled },
    });

    const unsupported = {
      ...disabled,
      state: 'unsupported' as const,
      blockerCode: 'endpoint_missing' as const,
      diagnostics: ['server_unsupported:endpoint_missing'],
    };
    expect(projectSessionBoardFeatureDecisionFailureV1('session.board.get', unsupported)).toEqual({
      ok: false,
      errorCode: 'update_required',
      error: 'update_required',
      details: {
        kind: 'update_required',
        operation: 'session.board.get',
        component: 'server',
        reason: 'sessions_board_endpoint_missing',
      },
    });
    expect(projectSessionBoardFeatureDecisionFailureV1('session.board.get', null)).toEqual({
      ok: false,
      errorCode: 'feature_unavailable',
      error: 'feature_unavailable',
      details: { operation: 'session.board.get' },
    });
  });
  it('declares one sealed aggregate transport for mutations and no Board read endpoint', () => {
    expect(getActionSpec('session.board.get').serverTransport).toBeUndefined();
    for (const id of ['session.board.item.upsert', 'session.board.item.remove', 'session.board.layout.update'] as const) {
      expect(getActionSpec(id).serverTransport).toBe(SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1);
    }
  });
  it('declares exactly the four canonical Board intents with schemas for each', () => {
    expect([...SESSION_BOARD_ACTION_IDS_V1]).toEqual([
      'session.board.get',
      'session.board.item.upsert',
      'session.board.item.remove',
      'session.board.layout.update',
    ]);
    expect(SessionBoardActionIdV1Schema.safeParse('session.board.item.create').success).toBe(false);
    for (const actionId of SESSION_BOARD_ACTION_IDS_V1) {
      expect(Object.hasOwn(SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1, actionId), actionId).toBe(true);
      expect(Object.hasOwn(SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1, actionId), actionId).toBe(true);
    }
  });

  it('closes every Action input against caller-supplied transport, authority and address fields', () => {
    const closed = [
      [SessionBoardGetInputV1Schema, {}],
      [SessionBoardItemUpsertInputV1Schema, { itemId: 'note', expectedItemRevision: revision, item }],
      [SessionBoardItemRemoveInputV1Schema, {
        itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision,
      }],
      [SessionBoardLayoutUpdateInputV1Schema, {
        expectedLayoutRevision: revision, operation: { op: 'tab.rename', tabId: 'overview', title: 'Overview' },
      }],
    ] as const;
    for (const [schema, valid] of closed) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, sessionId: 'session-1' }).success).toBe(true);
      for (const smuggled of [
        { serverId: 'home-2' },
        { accountId: 'account-1' },
        { pluginId: 'com.acme.test' },
        { authority: 'present_user' },
        { requestedBy: 'bob' },
        { namespace: 'surface' },
      ]) {
        expect(schema.safeParse({ ...valid, ...smuggled }).success, JSON.stringify(smuggled)).toBe(false);
      }
    }
  });

  it('bounds a Board read by the canonical System Record page limit rather than a Board-local number', () => {
    expect(SESSION_BOARD_GET_MAX_LIMIT_V1).toBe(500);
    expect(SessionBoardGetInputV1Schema.safeParse({ limit: SESSION_BOARD_GET_MAX_LIMIT_V1 }).success).toBe(true);
    expect(SessionBoardGetInputV1Schema.safeParse({ limit: SESSION_BOARD_GET_MAX_LIMIT_V1 + 1 }).success).toBe(false);
    expect(SessionBoardGetInputV1Schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(SessionBoardGetInputV1Schema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(SessionBoardGetInputV1Schema.safeParse({ cursor: '' }).success).toBe(false);
    expect(SessionBoardGetInputV1Schema.safeParse({ itemIds: ['note', 'chart'] }).success).toBe(true);
    const maximumItemIds = Array.from({ length: SESSION_BOARD_GET_MAX_LIMIT_V1 }, (_, index) => `item-${index}`);
    expect(SessionBoardGetInputV1Schema.safeParse({ itemIds: maximumItemIds }).success).toBe(true);
    expect(SessionBoardGetInputV1Schema.safeParse({ itemIds: [...maximumItemIds, 'one-too-many'] }).success).toBe(false);
  });

  it('requires Lane 04 capabilities and explicit incompleteness on every Board read result', () => {
    const result = {
      v: 1,
      serverId: 'home-1',
      sessionId: 'session-1',
      capabilities: { readTranscript: true, editSessionRecords: false },
      layout: { revision, document: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }] }] } },
      items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'declarative' }],
      incomplete: false,
      page: { cursor: null, hasNext: false },
    };
    expect(SessionBoardGetResultV1Schema.safeParse(result).success).toBe(true);
    // A Board with no layout record yet is an explicit absence, never a synthesized view.
    expect(SessionBoardGetResultV1Schema.safeParse({ ...result, layout: null }).success).toBe(true);
    // Full bodies ride the same entry when the caller asked for exact ids.
    expect(SessionBoardGetResultV1Schema.safeParse({
      ...result,
      items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'declarative', item }],
    }).success).toBe(true);
    expect(SessionBoardGetResultV1Schema.safeParse({
      ...result,
      items: [{ itemId: 'interactive', revision, title: 'Interactive', sourceKind: 'hostedHtml' }],
    }).success).toBe(true);
    const maximumItems = Array.from({ length: SESSION_BOARD_GET_MAX_LIMIT_V1 }, (_, index) => ({
      itemId: `item-${index}`, revision, title: `Item ${index}`, sourceKind: 'declarative' as const,
    }));
    expect(SessionBoardGetResultV1Schema.safeParse({ ...result, items: maximumItems }).success).toBe(true);
    expect(SessionBoardGetResultV1Schema.safeParse({
      ...result,
      items: [...maximumItems, { itemId: 'one-too-many', revision, title: 'One too many', sourceKind: 'declarative' }],
    }).success).toBe(false);

    for (const invalid of [
      { ...result, capabilities: undefined },
      { ...result, capabilities: { readTranscript: true } },
      { ...result, capabilities: { readTranscript: true, editSessionRecords: false, editBoard: true } },
      { ...result, incomplete: undefined },
      { ...result, page: undefined },
      { ...result, items: [{ itemId: 'note', title: 'Note', sourceKind: 'declarative' }] },
      { ...result, items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'unknown' }] },
    ]) {
      expect(SessionBoardGetResultV1Schema.safeParse(invalid).success, JSON.stringify(Object.keys(invalid))).toBe(false);
    }
  });

  it('projects one canonical Board read summary from opened record outcomes', () => {
    const projected = projectSessionBoardGetResultV1({
      serverId: 'home-1', sessionId: 'session-1',
      capabilities: { readTranscript: true, editSessionRecords: false },
      layout: null,
      requestedItemIds: ['note'],
      entries: [
        { status: 'ready', itemId: 'note', revision, item },
        { status: 'ready', itemId: 'note', revision, item },
        { status: 'ready', itemId: 'broken', revision, item: { ...item, source: { kind: 'unknown' } } },
        { status: 'unavailable' },
      ],
      incomplete: false,
      page: { cursor: null, hasNext: false },
    });
    expect(projected).toMatchObject({
      items: [{ itemId: 'note', revision, title: 'Note', sourceKind: 'declarative', item }],
      incomplete: true,
    });
    expect(projectSessionBoardGetResultV1({
      serverId: 'home-1', sessionId: 'session-1',
      capabilities: { readTranscript: true, editSessionRecords: false },
      layout: null,
      entries: [{ status: 'ready', itemId: 'note', revision, item }],
      incomplete: false,
      page: { cursor: null, hasNext: false },
    }).items[0]).not.toHaveProperty('item');
  });

  it('requires an atomic first placement for item creation and stable anchors for every move', () => {
    const create = { itemId: 'note', expectedItemRevision: null, item };
    expect(SessionBoardItemUpsertInputV1Schema.safeParse(create).success).toBe(false);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      ...create,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    }).success).toBe(true);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      itemId: 'note', expectedItemRevision: revision, item,
    }).success).toBe(true);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision, item,
      placement: { tabId: 'overview', width: 'medium' },
    }).success).toBe(true);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision, item,
    }).success).toBe(false);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      ...create, placement: { tabId: 'overview', tabTitle: 'Overview', index: 0 },
    }).success).toBe(false);
    expect(SessionBoardItemUpsertInputV1Schema.safeParse({
      ...create, placement: { tabId: 'overview', tabTitle: 'Overview', anchor: { side: 'before', index: 0 } },
    }).success).toBe(false);
    // Removal is unconditional-write free: both operands are exact revisions.
    expect(SessionBoardItemRemoveInputV1Schema.safeParse({
      itemId: 'note', expectedItemRevision: null, expectedLayoutRevision: revision,
    }).success).toBe(false);
  });

  it('accepts exactly one semantic layout operation per layout update', () => {
    const base = { expectedLayoutRevision: null };
    expect(SessionBoardLayoutUpdateInputV1Schema.safeParse({
      ...base, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    }).success).toBe(true);
    for (const invalid of [
      { ...base },
      { ...base, operation: [{ op: 'tab.create', tabId: 'overview', title: 'Overview' }] },
      { ...base, operations: [{ op: 'tab.create', tabId: 'overview', title: 'Overview' }] },
      { operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
      { ...base, operation: { op: 'item.move', itemId: 'note', fromTabId: 'a', toTabId: 'b', index: 1 } },
    ]) {
      expect(SessionBoardLayoutUpdateInputV1Schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('binds recovery evidence to the exact item and concurrency operands retained in the intent', async () => {
    const { SessionBoardActionRecoveryEvidenceV1Schema } = await import('./actions.js');
    const requestBody = JSON.stringify({
      operation: 'upsert_item', itemId: 'other', expectedItemRevision: revision,
      itemContent: { t: 'plain', v: item },
    });
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse({
      v: 1,
      actionId: 'session.board.item.upsert',
      requestBody,
      intent: { itemId: 'note', expectedItemRevision: revision, item },
    }).success).toBe(false);

    const placementIntent = {
      sessionId: 'session-1',
      itemId: 'note',
      expectedItemRevision: revision,
      item,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' as const },
    };
    const mutationWithoutPlacement = {
      operation: 'upsert_item' as const,
      itemId: 'note',
      expectedItemRevision: revision,
      itemContent: { t: 'plain' as const, v: item },
    };
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse({
      v: 1,
      actionId: 'session.board.item.upsert',
      serverId: 'home-1',
      sessionId: 'session-1',
      requestBody: JSON.stringify(mutationWithoutPlacement),
      mutationRequest: mutationWithoutPlacement,
      intent: placementIntent,
    }).success).toBe(false);

    const placeIntent = {
      sessionId: 'session-1',
      expectedLayoutRevision: revision,
      operation: { op: 'item.place' as const, itemId: 'note', tabId: 'overview', width: 'wide' as const },
    };
    const placedLayout = {
      operation: 'update_layout' as const,
      expectedLayoutRevision: revision,
      layoutContent: {
        t: 'plain' as const,
        v: { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' as const }] }] },
      },
    };
    const placeEvidence = (mutationRequest: unknown) => ({
      v: 1,
      actionId: 'session.board.layout.update',
      serverId: 'home-1',
      sessionId: 'session-1',
      requestBody: JSON.stringify(mutationRequest),
      mutationRequest,
      intent: placeIntent,
    });
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(placeEvidence(placedLayout)).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(placeEvidence({
      ...placedLayout,
      itemPlacementParticipant: { itemId: 'other', expectedItemRevision: revision },
    })).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(placeEvidence({
      ...placedLayout,
      itemPlacementParticipant: { itemId: 'note', expectedItemRevision: revision },
    })).success).toBe(true);
  });

  it('validates placement evidence with the semantics the layout operation actually guarantees', async () => {
    const { SessionBoardActionRecoveryEvidenceV1Schema } = await import('./actions.js');
    const layoutWithWideNote = {
      v: 1 as const,
      tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' as const }] }],
    };
    const upsertEvidence = (placement: unknown, layout: unknown) => {
      const mutationRequest = {
        operation: 'upsert_item' as const,
        itemId: 'note',
        expectedItemRevision: revision,
        itemContent: { t: 'plain' as const, v: item },
        placement: { layoutContent: { t: 'plain' as const, v: layout }, expectedLayoutRevision: revision },
      };
      return {
        v: 1,
        actionId: 'session.board.item.upsert',
        serverId: 'home-1',
        sessionId: 'session-1',
        requestBody: JSON.stringify(mutationRequest),
        mutationRequest,
        intent: { sessionId: 'session-1', itemId: 'note', expectedItemRevision: revision, item, placement },
      };
    };

    // An omitted width preserves the existing placement width, so the evidence must accept it.
    const captured = upsertEvidence({ tabId: 'overview', width: 'wide' }, layoutWithWideNote);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse({ ...captured,
      intent: { ...captured.intent, expectedLayoutRevision: revision },
    }).success).toBe(true);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse({ ...captured,
      intent: { ...captured.intent, expectedLayoutRevision: null },
    }).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview' }, layoutWithWideNote),
    ).success).toBe(true);
    // A tabTitle is consumed only when a missing view is created; it never renames an existing view.
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview', tabTitle: 'Renamed' }, layoutWithWideNote),
    ).success).toBe(true);
    // An explicitly invoked width is still compared exactly.
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview', width: 'narrow' }, layoutWithWideNote),
    ).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview', width: 'wide' }, layoutWithWideNote),
    ).success).toBe(true);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview', frameStyle: 'plain' }, layoutWithWideNote),
    ).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview', frameStyle: 'plain' }, { ...layoutWithWideNote,
        tabs: [{ ...layoutWithWideNote.tabs[0]!, items: [{ itemId: 'note', width: 'wide', frameStyle: 'plain' }] }] }),
    ).success).toBe(true);
    // The item must still be present in the intended view.
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'other' }, layoutWithWideNote),
    ).success).toBe(false);
    expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(
      upsertEvidence({ tabId: 'overview' }, { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [] }] }),
    ).success).toBe(false);
  });

  it('reports only facts the operation produced and never a removed item destination or preview', () => {
    const upsert = {
      v: 1,
      serverId: 'home-1',
      sessionId: 'session-1',
      result: { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision },
      destination: { tabId: 'overview', width: 'wide' },
      preview: { title: 'Note', sourceKind: 'declarative' },
    };
    expect(SessionBoardMutationActionResultV1Schema.safeParse(upsert).success).toBe(true);

    const removal = {
      v: 1,
      serverId: 'home-1',
      sessionId: 'session-1',
      result: { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision },
      destination: null,
    };
    expect(SessionBoardMutationActionResultV1Schema.safeParse(removal).success).toBe(true);
    expect(SessionBoardMutationActionResultV1Schema.safeParse({
      ...removal, destination: { tabId: 'overview', width: 'wide' },
    }).success).toBe(false);
    expect(SessionBoardMutationActionResultV1Schema.safeParse({
      ...removal, preview: { title: 'Note', sourceKind: 'declarative' },
    }).success).toBe(false);
    expect(SessionBoardMutationActionResultV1Schema.safeParse({
      ...removal, result: { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision, itemRevision: revision },
    }).success).toBe(false);
    // The descriptor stays presentation-neutral: no opened bytes cross the Action result.
    expect(SessionBoardMutationActionResultV1Schema.safeParse({
      ...upsert, preview: { title: 'Note', sourceKind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# Note' } } },
    }).success).toBe(false);
  });

  it('requires exact Home, Session, and explicit placement correlation for Action-port success', () => {
    const input = {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: null, item,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    } as const;
    const result = {
      v: 1,
      serverId: 'home-1',
      sessionId: 'session-1',
      result: { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision },
      destination: { tabId: 'overview', width: 'wide' },
      preview: { title: 'Note', sourceKind: 'declarative' },
    } as const;
    const binding = { expectedServerId: 'home-1', expectedSessionId: 'session-1' } as const;
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, result, binding).success).toBe(true);
    const framedInput = { ...input, placement: { ...input.placement, frameStyle: 'plain' as const } };
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', framedInput, {
      ...result, destination: { ...result.destination, frameStyle: 'plain' },
    }, binding).success).toBe(true);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', framedInput, result, binding).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', framedInput, {
      ...result, destination: { ...result.destination, frameStyle: 'card' },
    }, binding).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, result).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, {
      ...result, serverId: 'other-home',
    }, binding).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, {
      ...result, sessionId: 'other-session',
    }, binding).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, {
      ...result, destination: { tabId: 'other-view', width: 'wide' },
    }, binding).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', input, {
      ...result, destination: { tabId: 'overview', width: 'compact' },
    }, binding).success).toBe(false);

    // An update that moves an existing placement without naming a width keeps the width it had;
    // the result validator must not invent the create-time default for it.
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: revision, item,
      placement: { tabId: 'overview' },
    }, {
      ...result,
      result: { operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision, layoutRevision: revision },
      destination: { tabId: 'overview', width: 'wide' },
    }, binding).success).toBe(true);

    const updateWithoutPlacement = {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: revision, item,
    } as const;
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', updateWithoutPlacement, {
      ...result,
      result: { operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision },
    }, binding).success).toBe(false);
  });

  it('defines one strict Board Action failure schema with consistent nested details', () => {
    expect(SessionBoardActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
    }).success).toBe(true);
    expect(SessionBoardActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    }).success).toBe(true);
    for (const failure of [
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_invalid' },
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden', details: {} },
      { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict', details: {} },
      { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict', details: { error: 'session_board_forbidden' } },
      { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled', details: { operation: 'session.board.get', featureDecision: {
        featureId: 'sessions.board', state: 'unknown', blockedBy: 'server', blockerCode: 'server_unreachable', diagnostics: [], evaluatedAt: 1, scope: { scopeKind: 'runtime' },
      } } },
      { ok: false, errorCode: 'update_required', error: 'update_required', details: {
        kind: 'update_required', operation: 'session.board.item.remove', component: 'server', reason: 'old', extra: true,
      } },
    ]) {
      expect(SessionBoardActionFailureV1Schema.safeParse(failure).success, JSON.stringify(failure)).toBe(false);
    }
  });

  it('binds recovery evidence to the exact Home, Session, intent, and immutable sealed mutation', () => {
    const intent = {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: null, item,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    } as const;
    const mutationRequest = SessionBoardMutationV1Schema.parse({
      operation: 'upsert_item', itemId: 'note', expectedItemRevision: null,
      itemContent: { t: 'plain', v: item },
      placement: {
        expectedLayoutRevision: null,
        layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }] }] } },
      },
    });
    const failure = createSessionBoardOutcomeUnknownFailureV1({
      actionId: 'session.board.item.upsert',
      serverId: 'home-1',
      sessionId: 'session-1',
      mutationRequest,
      requestBody: JSON.stringify(mutationRequest),
      intent,
    });
    expect(SessionBoardActionRecoveryEvidenceV1Schema.parse(failure.details.recovery)).toEqual({
      v: 1,
      actionId: 'session.board.item.upsert',
      serverId: 'home-1',
      sessionId: 'session-1',
      mutationRequest,
      requestBody: JSON.stringify(mutationRequest),
      intent,
    });

    for (const recovery of [
      { ...failure.details.recovery, serverId: '' },
      { ...failure.details.recovery, actionRequestId: 'not-board-owned' },
      { ...failure.details.recovery, mutationRequest: { ...mutationRequest, itemId: 'other' } },
      { ...failure.details.recovery, requestBody: JSON.stringify({ ...mutationRequest, expectedItemRevision: revision }) },
      { ...failure.details.recovery, intent: { ...intent, placement: { ...intent.placement, width: 'compact' } } },
    ]) {
      expect(SessionBoardActionRecoveryEvidenceV1Schema.safeParse(recovery).success, JSON.stringify(recovery)).toBe(false);
    }

    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', intent, failure, {
      expectedServerId: 'home-1', expectedSessionId: 'session-1',
    }).success).toBe(true);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', intent, failure).success).toBe(false);
    expect(parseSessionBoardActionPortResultV1('session.board.item.upsert', intent, failure, {
      expectedServerId: 'other-home', expectedSessionId: 'session-1',
    }).success).toBe(false);
  });

  it('classifies canonical executor outcomes without confusing approval with failure or application', () => {
    const input = { itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision } as const;
    const binding = { expectedServerId: 'home-1', expectedSessionId: 'session-1' } as const;
    const applied = {
      v: 1, serverId: 'home-1', sessionId: 'session-1',
      result: { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision },
      destination: null,
    } as const;
    expect(parseSessionBoardActionExecuteOutcomeV1('session.board.item.remove', input, {
      ok: true, result: applied,
    }, binding)).toEqual({ success: true, kind: 'applied', data: applied });

    const approval = {
      kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.board.item.remove',
    } as const;
    expect(SessionBoardApprovalRequestCreatedResultV1Schema.safeParse(approval).success).toBe(true);
    expect(parseSessionBoardActionExecuteOutcomeV1('session.board.item.remove', input, {
      ok: true, result: approval,
    }, binding)).toEqual({ success: true, kind: 'approval_request_created', data: approval });
    expect(parseSessionBoardActionExecuteOutcomeV1('session.board.item.remove', input, {
      ok: true, result: { ...approval, actionId: 'session.board.get' },
    }, binding).success).toBe(false);

    const failure = { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden' } as const;
    expect(parseSessionBoardActionExecuteOutcomeV1('session.board.item.remove', input, failure, binding))
      .toEqual({ success: true, kind: 'failure', data: failure });
  });

  it('classifies malformed post-dispatch 2xx as outcome-unknown and non-2xx as definite refusal', () => {
    const intent = {
      sessionId: 'session-1', itemId: 'note', expectedItemRevision: null, item,
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    } as const;
    const mutationRequest = SessionBoardMutationV1Schema.parse({
      operation: 'upsert_item', itemId: 'note', expectedItemRevision: null,
      itemContent: { t: 'plain', v: item },
      placement: {
        expectedLayoutRevision: null,
        layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }] }] } },
      },
    });
    const common = {
      actionId: 'session.board.item.upsert' as const,
      serverId: 'home-1',
      sessionId: 'session-1',
      mutationRequest,
      requestBody: JSON.stringify(mutationRequest),
      intent,
    };
    const applied = { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision } as const;
    expect(classifySessionBoardMutationTransportResultV1({ ...common, status: 200, body: applied }))
      .toEqual({ kind: 'applied', result: applied });

    for (const body of [undefined, '', {}, { ...applied, itemId: 'other' }]) {
      const classified = classifySessionBoardMutationTransportResultV1({ ...common, status: 200, body });
      expect(classified.kind).toBe('failure');
      if (classified.kind === 'failure') {
        expect(classified.result).toMatchObject({
          ok: false,
          errorCode: 'outcome_unknown',
          details: { recovery: { serverId: 'home-1', sessionId: 'session-1', mutationRequest } },
        });
      }
    }

    expect(classifySessionBoardMutationTransportResultV1({
      ...common,
      status: 403,
      body: { error: 'session_board_forbidden' },
    })).toEqual({
      kind: 'failure',
      result: { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden' },
    });
    expect(classifySessionBoardMutationTransportResultV1({ ...common, status: 500, body: undefined }))
      .toEqual({ kind: 'failure', result: { ok: false, errorCode: 'invalid_response', error: 'invalid_response' } });
  });
});
