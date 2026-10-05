import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import type { SessionListQueryV1 } from '../sessions/listing/query.js';
import { getActionSpec } from './actionSpecs.js';
import type { SessionAwarenessProjectionV1 } from '../sessions/awareness/projectionV1.js';
import { encodeV2SessionListCursorV1 } from '../sessions/listing/cursor.js';
import { projectSessionAwarenessV1 } from '../sessions/awareness/projectV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

const canonicalQuery: SessionListQueryV1 = {
  v: 1,
  storage: 'active',
  includeInactive: false,
  scope: 'all_accessible',
  attention: 'any',
  audiences: [],
  tagIds: [],
};

// Exercise the credential-backed direct API path here. Autonomous Agent listing has a separate
// execution-principal admission contract; this suite isolates result validation after admission.
const agentContext = {
  surface: 'api',
  authority: 'account_automation',
  bypassApprovals: true,
} as const;

describe('session.list execution', () => {
  it('offers native widget Session options from the same awareness owner without requiring a plugin catalog', async () => {
    const sessionList = vi.fn(async () => buildSessionAwarenessListResultV1({ sessions: [{
      v: 1, sessionId: 'B', title: 'Bound B', lifecycle: 'active', runtime: 'idle', freshness: 'live',
      operational: { primary: 'none', reasons: [] }, encryption: 'plain', availability: 'complete',
    }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }));
    const executor = createExecutor({ sessionList, widgetAccountScope: () => ({ serverId: 'home-current', accountId: 'viewer' }) });
    const result = await executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface: { serverId: 'home-current', accountId: 'viewer', owner: { kind: 'home' } },
        definition: { kind: 'builtin', id: 'changes' } }, fieldPath: 'session',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-current' });
    expect(result).toEqual({ ok: true, result: expect.objectContaining({ options: [expect.objectContaining({ value: { serverId: 'home-current', sessionId: 'B' }, label: 'Bound B' })] }) });
  });
  it('does not let native descriptor discovery bypass the current Account scope or Session-list grant', async () => {
    const sessionList = vi.fn(async () => buildSessionAwarenessListResultV1({ sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false }));
    const request = { consumer: { kind: 'widget', surface: { serverId: 'home-current', accountId: 'viewer', owner: { kind: 'home' } },
      definition: { kind: 'builtin', id: 'changes' } }, fieldPath: 'session' };
    for (const [scope, errorCode] of [[null, 'widget_scope_unavailable'], [{ serverId: 'home-current', accountId: 'other' }, 'account_target_mismatch']] as const) {
      await expect(createExecutor({ sessionList, widgetAccountScope: () => scope }).execute('action.options.resolve', request,
        { surface: 'ui', authority: 'present_user', serverId: 'home-current' })).resolves.toMatchObject({ ok: false, errorCode });
    }
    await expect(createExecutor({ sessionList, widgetAccountScope: () => ({ serverId: 'home-current', accountId: 'viewer' }) }).execute('action.options.resolve', request, {
      surface: 'api', authority: 'account_automation', serverId: 'home-current',
      externalActionCredential: { accountId: 'viewer', principalId: 'token', credentialId: 'token', grant: {
        v: 1, actions: { families: [], ids: ['widgets.catalog.list'] }, targets: null, approve: false,
        origins: [], models: null, permissionModes: null, create: null,
      } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(sessionList).not.toHaveBeenCalled();
  });
  it('discovers qualified Session options through the admitted awareness reader with complete paging and shared status order', async () => {
    const awareness = (sessionId: string, runtime: SessionAwarenessProjectionV1['runtime'], primary: SessionAwarenessProjectionV1['operational']['primary']): SessionAwarenessProjectionV1 => ({
      v: 1, sessionId, title: `Title ${sessionId}`, lifecycle: 'active', runtime, freshness: 'live',
      operational: { primary, reasons: [] }, encryption: 'plain', availability: 'complete',
    });
    const requests: Parameters<ActionExecutorDeps['sessionList']>[0][] = [];
    const cursor = encodeV2SessionListCursorV1('recent');
    const executor = createExecutor({ machinesList: async () => { throw new Error('Session choices must not query machines'); },
      sessionList: async (request) => {
        requests.push(request);
        return buildSessionAwarenessListResultV1({
          sessions: request.query?.cursor
            ? [awareness('working', 'working', 'working'), awareness('needs', 'offline', 'permission_required')]
            : [awareness('recent', 'waiting', 'pending_input'), { ...awareness('locked', 'idle', 'none'), title: undefined, encryption: 'locked', availability: 'locked' }],
          nextCursor: request.query?.cursor ? null : cursor,
          hasNext: !request.query?.cursor, attentionNextCursor: null, attentionHasNext: false,
        });
      } });
    await expect(executor.execute('action.options.resolve', { optionsSourceId: 'sessions', actionId: 'session.spawn_new',
      draftInput: { executionTarget: { serverId: 'other-home' }, machineId: 'unrelated-machine' } }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-current',
    })).resolves.toMatchObject({ ok: true, result: { options: [
      { value: { serverId: 'home-current', sessionId: 'needs' }, label: 'Title needs', description: 'Needs you' },
      { value: { serverId: 'home-current', sessionId: 'working' }, label: 'Title working', description: 'Working' },
      { value: { serverId: 'home-current', sessionId: 'recent' }, label: 'Title recent', description: 'Recent' },
      { value: { serverId: 'home-current', sessionId: 'locked' }, label: 'locked', description: 'Recent', disabled: true },
    ] } });
    expect(requests).toHaveLength(2);
    expect(requests.map(request => ({ serverId: request.serverId, view: request.view, query: request.query }))).toEqual([
      { serverId: 'home-current', view: 'awareness', query: { ...canonicalQuery, includeInactive: true, includeAttention: false } },
      { serverId: 'home-current', view: 'awareness', query: { ...canonicalQuery, includeInactive: true, includeAttention: false, cursor } },
    ]);
  });

  it('does not return partial Session options when current read authority is refused on continuation', async () => {
    const executor = createExecutor({ sessionList: async ({ query }) => query?.cursor
      ? { ok: false, errorCode: 'permission_denied', error: 'permission_denied' }
      : buildSessionAwarenessListResultV1({ sessions: [projectSessionAwarenessV1({
          nowMs: 1, sessionId: 'first', title: 'First', lifecycle: {}, runtime: { presence: 'online', active: false },
          pending: {}, content: { mode: 'plain' }, currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
        })], nextCursor: encodeV2SessionListCursorV1('next'), hasNext: true,
        attentionNextCursor: null, attentionHasNext: false }) });
    await expect(executor.execute('action.options.resolve', { optionsSourceId: 'sessions' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-current',
    })).resolves.toMatchObject({ ok: false, errorCode: 'permission_denied' });
  });

  it('refuses Session discovery before reading when the autonomous caller has no admitted Session corpus', async () => {
    const sessionList = vi.fn(async () => buildSessionAwarenessListResultV1({ sessions: [], nextCursor: null, hasNext: false }));
    await expect(createExecutor({ sessionList }).execute('action.options.resolve', { optionsSourceId: 'sessions' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'home-current', sessionListAccess: 'unavailable',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('requires the actual Session-list grant even when the consuming widget descriptor is granted', async () => {
    const sessionList = vi.fn(async () => buildSessionAwarenessListResultV1({ sessions: [], nextCursor: null, hasNext: false }));
    const surface = { serverId: 'home-current', accountId: 'viewer', owner: { kind: 'home' as const } };
    const definition = { kind: 'builtin' as const, id: 'checks' };
    let descriptorRead = false;
    const executor = createExecutor({ sessionList,
      widgetAccountScope: () => ({ serverId: 'home-current', accountId: 'viewer' }),
      widgetCatalog: { list: async () => {
        descriptorRead = true;
        return [{ definition, title: 'Checks', availability: 'available', instanceCount: 0,
          fields: [{ path: 'session', title: 'Session', widget: 'select', optionsSourceId: 'sessions' }] }];
      } },
    });
    await expect(executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface, definition }, fieldPath: 'session',
    }, {
      surface: 'api', authority: 'account_automation', serverId: 'home-current',
      externalActionCredential: { accountId: 'viewer', principalId: 'token', credentialId: 'token', grant: {
        v: 1, actions: { families: [], ids: ['widgets.catalog.list'] }, targets: null,
        approve: false, origins: [], models: null, permissionModes: null, create: null,
      } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(descriptorRead).toBe(true);
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('does not invent a Home identity for Session choices when the host has no selected Home', async () => {
    const sessionList = vi.fn(async () => buildSessionAwarenessListResultV1({ sessions: [], nextCursor: null, hasNext: false }));
    await expect(createExecutor({ sessionList }).execute('action.options.resolve', { optionsSourceId: 'sessions' }, {
      surface: 'ui', authority: 'present_user',
    })).resolves.toMatchObject({ ok: false, errorCode: 'server_not_selected' });
    expect(sessionList).not.toHaveBeenCalled();
  });
  it('requires a marked server query for a subtree read instead of accepting an ignored selector', async () => {
    const executor = createExecutor({ sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false }) });
    await expect(executor.execute('session.list', { underSessionId: 'lead' }, agentContext))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_list_query_update_required' });
  });
  it('validates list output as a summary or closed marked awareness result', () => {
    const schema = getActionSpec('session.list').outputSchema;
    expect(schema.safeParse({ unrelated: 'not a list' }).success).toBe(false);
    expect(schema.safeParse({
      view: 'awareness', projectionVersion: 2, sessions: [], nextCursor: null, hasNext: false,
    }).success).toBe(false);
    expect(schema.safeParse({
      sessions: [{ id: 'legacy-ui', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null,
    }).success).toBe(true);
    expect(schema.safeParse({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }).success).toBe(true);
    expect(schema.safeParse({
      sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null,
    }).success).toBe(false);
    expect(schema.safeParse({
      sessions: [], nextCursor: null, hasNext: false, queryVersion: 1,
    }).success).toBe(false);
    expect(schema.safeParse({
      view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }).success).toBe(true);
    expect(schema.safeParse({
      view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null,
    }).success).toBe(false);
  });
  it('retains exact Home and cancellation when the compatibility activity Action acquires awareness', async () => {
    let request: unknown;
    const executor = createExecutor({ sessionActivityGet: async (args) => {
      request = args;
      return { ok: true, sessionId: args.sessionId };
    } });
    const signal = new AbortController().signal;
    await executor.execute('session.activity.get', { sessionId: 'same-id' }, {
      ...agentContext, serverId: 'home-two', signal,
    });
    expect(request).toEqual({ context: { ...agentContext, serverId: 'home-two', signal }, sessionId: 'same-id', serverId: 'home-two', signal });
  });
  it('forwards the canonical Lane 07 query and the admitted context to the listing owner', async () => {
    const sessionList = vi.fn(async () => markSessionListQueryResultV1({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }));
    const executor = createExecutor({ sessionList });
    const signal = new AbortController().signal;

    const result = await executor.execute('session.list', { query: canonicalQuery }, {
      ...agentContext,
      serverId: 'home-1',
      signal,
    });

    expect(sessionList).toHaveBeenCalledWith({ context: { ...agentContext, serverId: 'home-1', signal }, query: canonicalQuery, serverId: 'home-1', signal });
    expect(result).toMatchObject({ ok: true, result: { queryVersion: 1 } });
  });

  it('rejects a marker-only strict-query summary from the listing dependency', async () => {
    const executor = createExecutor({
      sessionList: async () => ({
        sessions: [], nextCursor: null, hasNext: false, queryVersion: 1,
      }),
    });

    const result = await executor.execute('session.list', { query: canonicalQuery }, agentContext);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'session_list_query_update_required',
    });
  });

  it('rejects an unmarked summary answer when awareness was explicitly requested', async () => {
    // A host that predates awareness silently ignores `view` and answers with a summary list.
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 'session-1', createdAt: 1, updatedAt: 2, active: true, activeAt: 2, encryption: null }],
      nextCursor: null,
      hasNext: false,
    }));
    const executor = createExecutor({ sessionList });

    const result = await executor.execute('session.list', { view: 'awareness' }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'awareness_view_unsupported' });
  });

  it('returns the marked awareness result with its marker intact', async () => {
    const payload = buildSessionAwarenessListResultV1({
      sessions: [{
        v: 1,
        sessionId: 'session-1',
        lifecycle: 'active',
        runtime: 'working',
        freshness: 'live',
        operational: { primary: 'working', reasons: ['working'] },
        encryption: 'plain',
        availability: 'complete',
      }],
      nextCursor: 'cursor-2',
      hasNext: true,
    });
    const executor = createExecutor({ sessionList: async () => payload });

    const result = await executor.execute('session.list', { view: 'awareness' }, agentContext);

    expect(result).toEqual({ ok: true, result: payload });
  });

  it('returns strict-query awareness with both continuation families and no query marker', async () => {
    const payload = buildSessionAwarenessListResultV1({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: 'attention-next', attentionHasNext: true,
    });
    const executor = createExecutor({ sessionList: async () => payload });

    const result = await executor.execute('session.list', {
      query: canonicalQuery,
      view: 'awareness',
    }, agentContext);

    expect(result).toEqual({ ok: true, result: payload });
    expect(result.result).not.toHaveProperty('queryVersion');
    expect(result.result).toMatchObject({ attentionNextCursor: 'attention-next', attentionHasNext: true });
  });

  it('rejects a predecessor success that silently ignored a strict query', async () => {
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 'legacy-unfiltered', createdAt: 1, updatedAt: 2, active: true, activeAt: 2, encryption: null }],
      nextCursor: null,
      hasNext: false,
    }));
    const executor = createExecutor({ sessionList });
    const query = {
      v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
      audiences: [], tagIds: [],
    } as const;

    const result = await executor.execute('session.list', { query }, agentContext);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'session_list_query_update_required',
    });
  });

  it('passes a listing failure through instead of reporting an unsupported view', async () => {
    const executor = createExecutor({
      sessionList: async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }),
    });

    const result = await executor.execute('session.list', { view: 'awareness' }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  });

  it('normalizes the strict query unavailable response without exposing unrelated error fields', async () => {
    const executor = createExecutor({
      sessionList: async () => {
        throw Object.assign(new Error('private-error-sentinel'), {
          code: 'filtered_session_listing_unavailable',
          details: {
            error: 'not_found',
            code: 'filtered_session_listing_unavailable',
            reason: 'scope',
          },
          responseBody: { privateDiagnostic: 'secret-sentinel' },
        });
      },
    });

    const result = await executor.execute('session.list', { query: canonicalQuery }, agentContext);

    expect(result).toEqual({
      ok: false,
      errorCode: 'filtered_session_listing_unavailable',
      error: 'filtered_session_listing_unavailable',
      details: {
        error: 'not_found',
        code: 'filtered_session_listing_unavailable',
        reason: 'scope',
      },
    });
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  it('does not reinterpret a generic 404 as strict query unavailability', async () => {
    const executor = createExecutor({
      sessionList: async () => {
        throw Object.assign(new Error('Unexpected status from /v2/sessions/query: 404'), {
          response: { status: 404 },
          responseBody: { privateDiagnostic: 'secret-sentinel' },
        });
      },
    });

    const result = await executor.execute('session.list', { query: canonicalQuery }, agentContext);

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_failed',
      error: 'Unexpected status from /v2/sessions/query: 404',
    });
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });

  it('rejects awareness combined with a message preview at the input boundary', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList });

    const result = await executor.execute('session.list', {
      view: 'awareness',
      includeLastMessagePreview: true,
    }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionList).not.toHaveBeenCalled();
  });
});

describe('session.activity.get awareness view selector', () => {
  const projection = {
    v: 1,
    sessionId: 'session-1',
    lifecycle: 'active',
    runtime: 'working',
    freshness: 'live',
    operational: { primary: 'working', reasons: ['working'] },
    encryption: 'plain',
    availability: 'complete',
  } as const;
  const compatibilityDigest = {
    ok: true,
    sessionId: 'session-1',
    active: true,
    updatedAt: 2,
    pendingCount: 0,
    pendingPermissionRequestCount: 0,
    pendingUserActionRequestCount: 0,
  } as const;

  function viewFieldOf(actionId: 'session.list' | 'session.activity.get') {
    return getActionSpec(actionId).inputHints?.fields.find((field) => field.path === 'view');
  }

  it('offers the one canonical view selector in the Action form hints', () => {
    const field = viewFieldOf('session.activity.get');
    expect(field?.widget).toBe('select');
    expect(field?.options?.map((option) => option.value)).toEqual(['summary', 'awareness']);
    // The selector is owned by the awareness contract, so both Actions offer the same values
    // instead of each host or spec retyping its own list.
    expect(field?.options).toEqual(viewFieldOf('session.list')?.options);
  });

  it('accepts the supported view values, keeps omission valid, and rejects anything else', () => {
    const schema = getActionSpec('session.activity.get').inputSchema;
    expect(schema.safeParse({ sessionId: 'session-1' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 'session-1', view: 'summary' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 'session-1', view: 'awareness' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 'session-1', view: 'operational' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: 'session-1', views: 'awareness' }).success).toBe(false);
  });

  it('rejects awareness combined with the retained-window count input', async () => {
    const sessionActivityGet = vi.fn(async () => projection);
    const executor = createExecutor({ sessionActivityGet });

    const result = await executor.execute('session.activity.get', {
      sessionId: 'session-1',
      view: 'awareness',
      windowSeconds: 60,
    }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('forwards the requested view and returns the canonical awareness projection', async () => {
    const sessionActivityGet = vi.fn(async () => projection);
    const executor = createExecutor({ sessionActivityGet });

    const result = await executor.execute('session.activity.get', {
      sessionId: 'session-1',
      view: 'awareness',
    }, agentContext);

    expect(sessionActivityGet).toHaveBeenCalledWith({
      context: agentContext,
      sessionId: 'session-1',
      view: 'awareness',
    });
    expect(result).toEqual({ ok: true, result: projection });
  });

  it('keeps the released compatibility digest when no view is requested', async () => {
    const sessionActivityGet = vi.fn(async () => compatibilityDigest);
    const executor = createExecutor({ sessionActivityGet });

    const result = await executor.execute('session.activity.get', { sessionId: 'session-1' }, agentContext);

    expect(sessionActivityGet).toHaveBeenCalledWith({ context: agentContext, sessionId: 'session-1' });
    expect(result).toEqual({ ok: true, result: compatibilityDigest });
  });

  it('rejects a compatibility digest when awareness was explicitly requested', async () => {
    // A host that predates the selector ignores `view` and answers with its activity digest.
    const executor = createExecutor({ sessionActivityGet: async () => compatibilityDigest });

    const result = await executor.execute('session.activity.get', {
      sessionId: 'session-1',
      view: 'awareness',
    }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'awareness_view_unsupported' });
  });

  it('passes an activity failure through instead of reporting an unsupported view', async () => {
    const executor = createExecutor({
      sessionActivityGet: async () => ({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' }),
    });

    const result = await executor.execute('session.activity.get', {
      sessionId: 'session-1',
      view: 'awareness',
    }, agentContext);

    expect(result).toMatchObject({ ok: false, errorCode: 'session_not_found' });
  });
});
