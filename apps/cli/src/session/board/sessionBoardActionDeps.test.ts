import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import axios from 'axios';
import {
  API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  projectSessionAccessCapabilitiesV1,
  FeaturesResponseSchema,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { decodeBase64, decrypt } from '@/api/encryption';
import { createSessionBoardActionDeps } from './sessionBoardActionDeps';
import { validateSessionSystemRecordOpenedContent } from '@/session/systemRecords/sessionSystemRecordCodec';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';
import type { AgentState } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCurrentSessionPresentationService } from '@/session/presentation/currentSessionPresentationService';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } },
} as const;
const installed = { ...item, source: { kind: 'widget', instance: {
  v: 1, id: 'status', definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'status' } }, bindings: {},
} } } as const;
const rawSession: RawSessionRecord = {
  id: 'session-one', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
  encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, dataEncryptionKey: null, agentState: null, agentStateVersion: 0,
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  responsibleAccountId: null,
  responsibleAccount: null,
};

describe('CLI Board Action family', () => {
  let app = fastify();
  let restore = () => {};
  let verifySessionRequest: ((request: Readonly<{ headers?: unknown; query?: unknown }>) => void) | undefined;
  beforeEach(() => {
    app = fastify();
    rawSession.encryptionMode = 'plain';
    rawSession.effectiveAccess = {
      v: 1,
      level: 'owner',
      sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
    };
    restore = installAxiosFastifyAdapter({ app, origin: 'http://board.test' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: {
        sessions: { enabled: true, board: { enabled: true } },
        sharing: { session: { enabled: true } },
      },
      capabilities: {},
    })));
    verifySessionRequest = undefined;
    app.get('/v2/sessions/session-one', async (request) => {
      verifySessionRequest?.(request);
      return { session: rawSession };
    });
  });
  afterEach(async () => { restore(); vi.restoreAllMocks(); await app.close(); });
  it('refuses a captured layout mismatch before sealing a size upsert to an old view', async () => {
    const movedLayoutRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
    const layout = { v: 1, tabs: [{ id: 'old', title: 'Old', items: [] },
      { id: 'new', title: 'New', items: [{ itemId: 'status', width: 'full', frameStyle: 'plain' }] }] };
    let writes = 0;
    app.get('/v2/sessions/session-one/system-records/record', async request => {
      const kind = (request.query as Record<string, string>).kind;
      return { record: { id: kind === 'layout.v1' ? 'layout-row' : 'item-row',
        address: { owner: 'host', namespace: 'surface', kind, localId: kind === 'layout.v1' ? 'layout' : 'status' },
        content: { t: 'plain', v: kind === 'layout.v1' ? layout : installed }, revision: kind === 'layout.v1' ? movedLayoutRevision : revision,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async () => { writes++; throw new Error('Stale size must not be written'); });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null }, serverHttpBaseUrl: 'http://board.test', serverId: 'home-a' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: 'session-one',
      itemId: 'status', expectedItemRevision: revision, expectedLayoutRevision: revision,
      item: { ...installed, height: { mode: 'fixed', size: 'tall' } }, placement: { tabId: 'old', width: 'medium' } } }))
      .resolves.toMatchObject({ errorCode: 'session_board_revision_conflict' });
    expect(writes).toBe(0);
  });
  it('reads additive stored fields and keeps canonical writes and strict Action admission', async () => {
    const canonicalLayout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'status', width: 'wide' }] }] };
    const storedItem = { ...installed, extra: true, source: { ...installed.source, extra: true,
      instance: { ...installed.source.instance, extra: true, definition: { ...installed.source.instance.definition,
        surface: { ...installed.source.instance.definition.surface, extra: true } } } } };
    const storedLayout = { ...canonicalLayout, extra: true, tabs: [{ ...canonicalLayout.tabs[0], extra: true,
      items: [{ ...canonicalLayout.tabs[0].items[0], extra: true }] }] };
    expect(() => validateSessionSystemRecordOpenedContent({ owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'status' },
      storedItem, 'plugin_session_record_invalid_request')).toThrow();
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const kind = (request.query as Record<string, string>).kind;
      return { record: { id: kind === 'layout.v1' ? 'layout-row' : 'item-row',
        address: { owner: 'host', namespace: 'surface', kind, localId: kind === 'layout.v1' ? 'layout' : 'status' },
        content: { t: 'plain', v: kind === 'layout.v1' ? storedLayout : storedItem }, revision,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    const writes: unknown[] = [];
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'updated', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a' };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context,
      input: { sessionId: 'session-one', itemIds: ['status'] } }))
      .resolves.toMatchObject({ layout: { document: canonicalLayout }, items: [{ item: installed }], incomplete: false });
    const input = { sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision, item: installed,
      placement: { tabId: 'overview', width: 'wide' as const } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input }))
      .resolves.toMatchObject({ result: { outcome: 'updated' } });
    expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: installed },
      placement: { expectedLayoutRevision: revision, layoutContent: { t: 'plain', v: canonicalLayout } } })]);
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context,
      input: { ...input, item: storedItem } })).resolves.toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
  });
  it('rejects a partially qualified fixed Home before constructing the transport', () => {
    expect(() => createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverId: 'home-a',
    } as unknown as Parameters<typeof createSessionBoardActionDeps>[0])).toThrow('fixed_action_server_target_incomplete');
    expect(() => createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverHttpBaseUrl: 'http://board.test',
    } as unknown as Parameters<typeof createSessionBoardActionDeps>[0])).toThrow('fixed_action_server_target_incomplete');
  });
  it.each([
    ['direct', { kind: 'direct' as const, shareId: 'share-1' }],
    ['Team', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: true }],
    ['Group', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses current exact-Home detail for %s access before reading Board state', async (_label, source) => {
    rawSession.effectiveAccess = {
      v: 1,
      level: 'edit',
      sources: [source],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: false,
        grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
      }),
    };
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));

    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
  });
  it.each([
    ['direct', { kind: 'direct' as const, shareId: 'share-1' }],
    ['Team-only', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: false }],
    ['Group-only', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses the injected exact-Home snapshot for %s current detail without ambient probing', async (_label, source) => {
    rawSession.effectiveAccess = {
      v: 1,
      level: 'edit',
      sources: [source],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: false,
        grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
      }),
    };
    const serverSnapshot = {
      status: 'ready' as const,
      features: {
        features: {
          sessions: { enabled: true, board: { enabled: true } },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      },
    };
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => serverSnapshot as never,
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
    // Exact-Home resolver owns the decision; no ambient feature probe may widen detail.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps record-read failure categories the producer already answered', async () => {
    let recordReply: Readonly<{ status: number; body: unknown }> = { status: 200, body: { record: null } };
    let puts = 0;
    app.get('/v2/sessions/session-one/system-records/record', async (_request, reply) =>
      reply.status(recordReply.status).send(recordReply.body));
    app.put('/v2/sessions/session-one/board', async () => { puts += 1; return { ok: true }; });
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    const read = () => deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    });

    // A definite authorization denial stays `forbidden`, not "you are not signed in".
    recordReply = { status: 403, body: { error: 'Forbidden', code: 'plugin_session_record_forbidden' } };
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'forbidden' });
    // The typed feature refusal keeps its operation, exactly like the mutation settlement.
    recordReply = { status: 404, body: { error: 'Not found', code: 'plugin_session_record_feature_disabled' } };
    await expect(read()).resolves.toMatchObject({
      ok: false, errorCode: 'feature_disabled', details: { operation: 'session.board.get' },
    });
    // A read that never reached the Home is `offline`, the same disposition the mutation path uses.
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const get = vi.spyOn(axios, 'get').mockRejectedValue(refused);
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'offline' });
    // Cancellation stays distinct from being offline.
    get.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
    await expect(read()).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    get.mockRestore();
    expect(puts).toBe(0);
  });

  it('fails a supported old Home closed without appending a qualifier', async () => {
    verifySessionRequest = (request) => {
      expect((request as { query?: unknown }).query).toEqual({});
    };
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => ({
        status: 'unsupported',
        reason: 'endpoint_missing',
      }) as never,
    });
    const result = await deps.sessionBoardAction!({
      actionId: 'session.board.get',
      input: { sessionId: 'session-one' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    });
    expect(result).toMatchObject({ ok: false });
    // Old Home never qualifies Team/Group detail; at most a bare owner/direct read occurs.
  });
  it('signs every external Board Home read without sending the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home-a', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.board.get', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    const verify = (request: Readonly<{ headers?: unknown }>, method: string, path: string) => {
      const readHeader = (name: string): string | null => {
        if (request.headers instanceof Headers) return request.headers.get(name);
        if (!request.headers || typeof request.headers !== 'object') return null;
        const value = Reflect.get(request.headers, name) ?? Reflect.get(request.headers, name.toLowerCase());
        if (typeof value === 'string') return value;
        return Array.isArray(value) ? value.join(', ') : null;
      };
      expect(readHeader('authorization')).toBeNull();
      expect(readHeader(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe('execution-proof');
      expect(readHeader(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('session.board.get');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.board.get',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method,
        path,
        publicKey: keyPair.publicKey,
        signature: String(readHeader(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)),
      })).toBe(true);
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      verify({ headers: init?.headers }, 'GET', '/v1/features');
      return new Response(JSON.stringify({
        features: {
          sessions: { enabled: true, board: { enabled: true } },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      }));
    });
    verifySessionRequest = (request) => {
      verify(request, 'GET', '/v2/sessions/session-one?accessProjectionVersion=1');
      expect(request.query).toEqual({ accessProjectionVersion: '1' });
    };
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as Record<string, string>;
      const path = `/v2/sessions/session-one/system-records/record?${new URLSearchParams(query).toString()}`;
      verify(request, 'GET', path);
      return { record: null };
    });
    app.get('/v2/sessions/session-one/system-records', async (request) => {
      const query = request.query as Record<string, string>;
      const path = `/v2/sessions/session-one/system-records?${new URLSearchParams(query).toString()}`;
      verify(request, 'GET', path);
      return { records: [], nextCursor: null, hasNext: false };
    });
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'daemon-token', encryption: null },
      serverId: 'home-a',
      serverIdentityId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.get',
      context: {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      input: { sessionId: 'session-one' },
    })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', items: [] });
  });
  it('creates a current external widget reference through the exact signed Board writer and refuses retired shapes', async () => {
    const previousMetadata = rawSession.metadata;
    rawSession.metadata = JSON.stringify({ machineId: 'machine-session' });
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'board-create-proof',
      binding: {
        serverIdentityId: 'home-a', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-caller', actionId: 'session.board.item.upsert', requestId: 'board-create-request',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    const context = {
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
      externalActionExecutionAuthorization: authorization,
      externalActionTarget: target,
    };
    let writes = 0;
    const sessionQueries: unknown[] = [];
    verifySessionRequest = (request) => {
      sessionQueries.push((request as { query?: unknown }).query);
    };
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes += 1;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.board.item.upsert',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'PUT',
        path: '/v2/sessions/session-one/board',
        body: request.body,
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'created', itemRevision: revision, layoutRevision: revision };
    });
    try {
      const deps = createSessionBoardActionDeps({
        credentials: { token: 'daemon-token', encryption: null },
        serverId: 'home-a',
        serverIdentityId: 'home-a',
        serverHttpBaseUrl: 'http://board.test',
        externalActionMachineRequestPrivateKey: keyPair.secretKey,
        externalActionMachineInstallationId: 'installation-1',
      });
      const input = { sessionId: 'session-one', itemId: 'status', item: installed, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } };
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input })).resolves.toMatchObject({ result: { outcome: 'created' } });
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context, input: {
        ...input,
        item: { ...item, source: { kind: 'installedSurface', surface: { pluginId: 'acme.widgets', localId: 'absent' } } },
      } })).resolves.toMatchObject({ errorCode: 'session_board_invalid' });
      expect(writes).toBe(1);
      // Retired shapes fail strict input admission before any Session transport.
      expect(sessionQueries).toEqual([{ accessProjectionVersion: '1' }]);
    } finally { rawSession.metadata = previousMetadata; }
  });
  it('updates a stored installed item while refusing a different surface identity', async () => {
    const writes: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: { id: 'item-row',
      address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'status' }, content: { t: 'plain', v: installed }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'upsert_item', itemId: 'status', outcome: 'updated', itemRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: {
      sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision, item: { ...installed, title: 'Renamed' },
    } })).resolves.toMatchObject({ result: { outcome: 'updated' } });
    expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: { ...installed, title: 'Renamed' } } })]);
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: {
      sessionId: 'session-one', itemId: 'status', expectedItemRevision: revision,
      item: { ...installed, source: { ...installed.source, instance: {
        ...installed.source.instance, definition: { ...installed.source.instance.definition, surface: { ...installed.source.instance.definition.surface, localId: 'other' } },
      } } },
    } })).resolves.toMatchObject({ errorCode: 'session_board_source_conflict' });
    expect(writes).toHaveLength(1);
  });
  it('refuses a different Home and read-only mutations before record access', async () => {
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: { serverId: 'home-b' }, input: { sessionId: 'session-one' } })).resolves.toMatchObject({ errorCode: 'server_target_mismatch' });
    const previous = rawSession.effectiveAccess;
    rawSession.effectiveAccess = { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share-one' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) };
    try {
      await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: 'session-one', itemId: 'note', item,
        expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } } })).resolves.toMatchObject({ errorCode: 'session_board_forbidden' });
    } finally { rawSession.effectiveAccess = previous; }
  });
  it('returns operation-scoped feature-disabled and update-required results before Session access', async () => {
    let serverSnapshot: CliServerFeaturesSnapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: false } } },
        capabilities: {},
      }),
    };
    const deps = createSessionBoardActionDeps({
      credentials: { token: 'token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
      resolveServerFeaturesSnapshot: async () => serverSnapshot,
    });
    const args = { actionId: 'session.board.get' as const, context: {}, input: { sessionId: 'session-one' } };

    await expect(deps.sessionBoardAction!(args)).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
      details: { operation: 'session.board.get', featureDecision: { featureId: 'sessions.board', state: 'disabled' } },
    });

    serverSnapshot = {
      status: 'unsupported' as const,
      reason: 'endpoint_missing' as const,
    };
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
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
  });
  it('returns bounded inventory and exact requested bodies through the same host reader', async () => {
    const record = { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' }, content: { t: 'plain', v: item }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
    app.get('/v2/sessions/session-one/system-records/record', async (request) => ({ record: (request.query as { kind?: string }).kind === 'layout.v1' ? null : record }));
    app.get('/v2/sessions/session-one/system-records', async () => ({ records: [record, record], nextCursor: 'page-two', hasNext: true }));
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {}, input: { sessionId: 'session-one' } })).resolves.toMatchObject({
      layout: null, items: [{ itemId: 'note', title: 'Note', sourceKind: 'declarative', revision }], incomplete: true, page: { cursor: 'page-two', hasNext: true },
    });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.get', context: {}, input: { sessionId: 'session-one', itemIds: ['note', 'note'] } })).resolves.toMatchObject({
      items: [{ itemId: 'note', item }], incomplete: false,
    });
  });
  it.each(['session.board.layout.update', 'session.board.item.remove'] as const)('uses complete layout operands for %s without inventory replacement', async (actionId) => {
    const layout = { v: 1, tabs: ['a', 'b'].map((id) => ({ id, title: id, items: [{ itemId: 'note', width: 'medium' }] })) };
    const writes: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
      revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return actionId === 'session.board.item.remove' ? { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision }
        : { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await deps.sessionBoardAction!({ actionId, context: {}, input: actionId === 'session.board.item.remove'
      ? { sessionId: 'session-one', itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision }
      : { sessionId: 'session-one', expectedLayoutRevision: revision, operation: { op: 'item.resize', itemId: 'note', tabId: 'a', width: 'wide' } } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedLayoutRevision: revision, layoutContent: { t: 'plain', v: { tabs: actionId === 'session.board.item.remove'
      ? [{ id: 'a', items: [] }, { id: 'b', items: [] }]
      : [{ id: 'a', items: [{ itemId: 'note', width: 'wide' }] }, { id: 'b', items: [{ itemId: 'note', width: 'medium' }] }],
    } } });
  });
  it('acknowledges the requested second view when an item already placed elsewhere gains another placement', async () => {
    const layout = { v: 1, tabs: [
      { id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] },
      { id: 'second', title: 'Second', items: [] },
    ] };
    const writes: Array<{ placement?: { layoutContent: { v: unknown } } }> = [];
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as { kind?: string };
      return { record: query.kind === 'item.v1'
        ? { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' },
          revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }
        : { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
          revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body as never);
      return { operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    // Through the real Action executor: its strict result correspondence is the deciding consumer.
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const input = { sessionId: 'session-one', itemId: 'note', expectedItemRevision: revision, item,
      placement: { tabId: 'second', width: 'wide' as const } };
    const result = await executor.execute('session.board.item.upsert', input, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-one',
    });
    expect(result).toMatchObject({ ok: true, result: { destination: { tabId: 'second', width: 'wide' } } });
    expect(writes[0]?.placement?.layoutContent.v).toMatchObject({ tabs: [
      { id: 'overview', items: [{ itemId: 'note', width: 'medium' }] },
      { id: 'second', items: [{ itemId: 'note', width: 'wide' }] },
    ] });
  });
  it('carries the exact current item participant for item.place and refuses a missing item before dispatch', async () => {
    const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
    const writes: unknown[] = [];
    let itemExists = true;
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as { kind?: string };
      return { record: query.kind === 'item.v1'
        ? itemExists ? { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' },
          revision, content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } : null
        : { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
          revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      writes.push(request.body);
      return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const input = { sessionId: 'session-one', expectedLayoutRevision: revision,
      operation: { op: 'item.place' as const, itemId: 'note', tabId: 'overview', width: 'wide' as const } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input })).resolves.toMatchObject({
      v: 1,
      serverId: 'home-a',
      sessionId: 'session-one',
      result: { operation: 'update_layout' },
    });
    expect(writes).toEqual([expect.objectContaining({
      operation: 'update_layout',
      itemPlacementParticipant: { itemId: 'note', expectedItemRevision: revision },
    })]);

    itemExists = false;
    writes.length = 0;
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input })).resolves.toEqual({
      ok: false, errorCode: 'session_board_item_not_found', error: 'session_board_item_not_found',
    });
    expect(writes).toHaveLength(0);
  });
  it('does not replay an ambiguous E2EE mutation whose acknowledgement is lost', async () => {
    rawSession.encryptionMode = 'e2ee';
    const secret = new Uint8Array(32).fill(7);
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    const bodies: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        bodies.push(config.data);
        throw new axios.AxiosError('acknowledgement lost', 'ECONNRESET');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: { type: 'legacy', secret } }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input: {
      itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' },
    } })).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(bodies).toHaveLength(1);
    const sealed = JSON.parse(String(bodies[0]));
    expect(sealed.itemContent.t).toBe('encrypted');
    expect(decrypt(secret, 'legacy', decodeBase64(sealed.itemContent.c, 'base64'))).toEqual(item);
    expect(decrypt(secret, 'legacy', decodeBase64(sealed.placement.layoutContent.c, 'base64'))).toMatchObject({ tabs: [{ items: [{ itemId: 'note' }] }] });
  });
  it('keeps DNS failure definite and does not replay the mutation', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    let writes = 0;
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes += 1;
        throw new axios.AxiosError('DNS lookup failed', 'ENOTFOUND');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input: {
      sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    } })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    expect(writes).toBe(1);
  });
  it('keeps a wrapped connection refusal definite on both carriers', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    const request = axios.request.bind(axios);
    let writes = 0;
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes += 1;
        // An interceptor-wrapped refusal: the code the UI carrier already walks to through `cause`.
        const wrapped = new axios.AxiosError('request failed', undefined, undefined, {});
        wrapped.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw wrapped;
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.layout.update', context: {}, input: {
      sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    } })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
    expect(writes).toBe(1);
  });
  it('preserves the original intent when a valid acknowledgement belongs to another item', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async () => ({ operation: 'upsert_item', itemId: 'other', outcome: 'created', itemRevision: revision, layoutRevision: revision }));
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const input = { itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' } };
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input })).resolves.toMatchObject({
      ok: false, errorCode: 'outcome_unknown', details: { recovery: { requestBody: expect.any(String), intent: input } },
    });
  });
  it('keeps exact sealed recovery evidence through the real Action executor without replaying an ambiguous mutation', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    app.put('/v2/sessions/session-one/board', async (_request, reply) => reply.hijack());
    const request = axios.request.bind(axios);
    const writes: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT') {
        writes.push(String(config.data));
        throw new axios.AxiosError('acknowledgement lost', 'ECONNRESET');
      }
      return request(config);
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const executor = createActionExecutor({
      ...deps,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const input = {
      sessionId: 'session-one',
      itemId: 'note',
      item,
      expectedItemRevision: null,
      placement: { tabId: 'overview', tabTitle: 'Overview' },
    } as const;

    const result = await executor.execute('session.board.item.upsert', input, {
      surface: 'cli',
      authority: 'present_user',
      serverId: 'home-a',
      defaultSessionId: 'session-one',
    });
    // An ambiguous post-dispatch loss is reported, never re-dispatched: the same
    // sealed bytes stay available as recovery evidence for a deliberate reread.
    expect(writes).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      error: 'outcome_unknown',
      details: {
        recovery: {
          v: 1,
          actionId: 'session.board.item.upsert',
          serverId: 'home-a',
          sessionId: 'session-one',
          requestBody: writes[0],
          mutationRequest: JSON.parse(writes[0]!),
          intent: input,
        },
      },
    });
  });
  it('preserves typed non-2xx failures and classifies malformed 2xx as outcome unknown', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let responseKind: 'conflict' | 'malformed_success' | 'malformed_failure' | 'feature_disabled' = 'conflict';
    app.put('/v2/sessions/session-one/board', async (_request, reply) => {
      if (responseKind === 'feature_disabled') return reply.code(404).send({ error: 'not_found' });
      if (responseKind === 'malformed_success') return reply.code(200).send({ definitely: 'not-a-board-result' });
      if (responseKind === 'malformed_failure') return reply.code(500).send({ definitely: 'not-a-board-error' });
      return reply.code(409).send({ error: 'session_board_revision_conflict', currentLayoutRevision: revision });
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    const args = {
      actionId: 'session.board.layout.update' as const,
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' } },
    };

    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    });
    responseKind = 'malformed_success';
    const malformedSuccess = await deps.sessionBoardAction!(args);
    expect(malformedSuccess).toMatchObject({
      ok: false,
      errorCode: 'outcome_unknown',
      details: {
        recovery: {
          v: 1,
          actionId: 'session.board.layout.update',
          serverId: 'home-a',
          sessionId: 'session-one',
          requestBody: expect.any(String),
          mutationRequest: expect.objectContaining({ operation: 'update_layout' }),
          intent: args.input,
        },
      },
    });
    responseKind = 'malformed_failure';
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_response',
      error: 'invalid_response',
    });
    responseKind = 'feature_disabled';
    await expect(deps.sessionBoardAction!(args)).resolves.toEqual({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'feature_disabled',
      details: { operation: 'session.board.layout.update' },
    });
  });
  it('preserves the current revision when the local Board read detects a conflict', async () => {
    let writes = 0;
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: {
      id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
      content: { t: 'plain', v: { v: 1, tabs: [] } }, revision,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    } }));
    app.put('/v2/sessions/session-one/board', async () => {
      writes += 1;
      return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });

    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.layout.update',
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    });
    expect(writes).toBe(0);
  });
  it('returns cancelled before dispatch when its signal is already aborted', async () => {
    app.get('/v2/sessions/session-one/system-records/record', async () => ({ record: null }));
    let writes = 0;
    app.put('/v2/sessions/session-one/board', async () => {
      writes += 1;
      return { operation: 'update_layout', outcome: 'created', layoutRevision: revision };
    });
    const controller = new AbortController();
    controller.abort();
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });

    await expect(deps.sessionBoardAction!({
      actionId: 'session.board.layout.update',
      context: {},
      input: { sessionId: 'session-one', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
      signal: controller.signal,
    })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(writes).toBe(0);
  });
  it('creates one atomic first placement through host V1 reads with keyless Plain credentials', async () => {
    const requests: unknown[] = [];
    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      expect(request.headers).not.toHaveProperty('x-happier-plugin-id');
      expect(request.query).toMatchObject({ owner: 'host', namespace: 'surface' });
      return { record: null };
    });
    app.put('/v2/sessions/session-one/board', async (request) => {
      requests.push(request.body);
      return { operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision };
    });
    const deps = createSessionBoardActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home-a', serverHttpBaseUrl: 'http://board.test' });
    await expect(deps.sessionBoardAction!({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session-one' }, input: {
      itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' },
    } })).resolves.toMatchObject({ serverId: 'home-a', sessionId: 'session-one', result: { outcome: 'created' } });
    expect(requests).toEqual([{ operation: 'upsert_item', itemId: 'note', expectedItemRevision: null, itemContent: { t: 'plain', v: item },
      placement: { expectedLayoutRevision: null, layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] }] } } },
    }]);
  });

  it('lets one admitted Agent author and organize a Board, then reveal its exact surviving item through the current UI owner', async () => {
    type StoredRecordFixture = Readonly<{
      id: string;
      address: Readonly<{ owner: 'host'; namespace: 'surface'; kind: 'item.v1' | 'layout.v1'; localId: string }>;
      content: unknown;
      revision: string;
      createdAt: string;
      updatedAt: string;
    }>;
    const timestamp = '2026-09-08T00:00:00.000Z';
    const makeRecord = (
      kind: StoredRecordFixture['address']['kind'],
      localId: string,
      content: unknown,
    ): StoredRecordFixture => ({
      id: `${kind}:${localId}`,
      address: { owner: 'host', namespace: 'surface', kind, localId },
      content,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let layoutRecord: StoredRecordFixture | null = null;
    const itemRecords = new Map<string, StoredRecordFixture>();
    const mutations: unknown[] = [];

    app.get('/v2/sessions/session-one/system-records/record', async (request) => {
      const query = request.query as Readonly<{ kind: 'item.v1' | 'layout.v1'; localId: string }>;
      return { record: query.kind === 'layout.v1' ? layoutRecord : itemRecords.get(query.localId) ?? null };
    });
    app.get('/v2/sessions/session-one/system-records', async () => ({
      records: [...itemRecords.values()],
      nextCursor: null,
      hasNext: false,
    }));
    app.put('/v2/sessions/session-one/board', async (request) => {
      const mutation = request.body as Readonly<{
        operation: 'upsert_item' | 'remove_item' | 'update_layout';
        itemId?: string;
        itemContent?: unknown;
        layoutContent?: unknown;
        placement?: Readonly<{ layoutContent: unknown }>;
      }>;
      mutations.push(mutation);
      if (mutation.operation === 'upsert_item' && mutation.itemId && mutation.itemContent) {
        const outcome = itemRecords.has(mutation.itemId) ? 'updated' : 'created';
        itemRecords.set(mutation.itemId, makeRecord('item.v1', mutation.itemId, mutation.itemContent));
        if (mutation.placement) layoutRecord = makeRecord('layout.v1', 'layout', mutation.placement.layoutContent);
        return { operation: 'upsert_item', itemId: mutation.itemId, outcome, itemRevision: revision, ...(mutation.placement ? { layoutRevision: revision } : {}) };
      }
      if (mutation.operation === 'remove_item' && mutation.itemId && mutation.layoutContent) {
        itemRecords.delete(mutation.itemId);
        layoutRecord = makeRecord('layout.v1', 'layout', mutation.layoutContent);
        return { operation: 'remove_item', itemId: mutation.itemId, outcome: 'removed', layoutRevision: revision };
      }
      if (mutation.operation === 'update_layout' && mutation.layoutContent) {
        layoutRecord = makeRecord('layout.v1', 'layout', mutation.layoutContent);
        return { operation: 'update_layout', outcome: 'updated', layoutRevision: revision };
      }
      throw new Error('Unexpected Board mutation fixture');
    });

    const boardDeps = createSessionBoardActionDeps({
      credentials: { token: 'runtime-account-token', encryption: null },
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://board.test',
    });
    const admittedContexts: unknown[] = [];
    const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async (args) => {
      admittedContexts.push(args.context);
      return await boardDeps.sessionBoardAction!(args);
    };
    const executor = createActionExecutor({
      ...boardDeps,
      sessionBoardAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    // Production Action executors are fixed to the selected Home by
    // `createCliActionExecutorHarness`; preserve that host-stamped context in
    // this lower-level composition fixture as well.
    const agentTools = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: (actionId, input, context) => executor.execute(actionId, input, {
          ...context,
          serverId: 'home-a',
        }),
      },
    });
    const executeBoardAction = async (actionId: string, input: unknown) => await agentTools.executeActionByToolName(
      'action_execute',
      { actionId, input },
      'session-one',
    );
    const note = (title: string, text: string) => ({
      ...item,
      title,
      source: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'markdown' as const, text } } },
    });

    const mutationCountBeforeSpoof = mutations.length;
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist',
      expectedItemRevision: null,
      item: note('Release checklist', 'Draft'),
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
      requestedBy: 'bob-account',
    })).resolves.toMatchObject({ ok: false });
    expect(mutations).toHaveLength(mutationCountBeforeSpoof);

    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist', expectedItemRevision: null,
      item: note('Release checklist', 'Draft'),
      placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'temporary-note', expectedItemRevision: null,
      item: note('Temporary note', 'Remove me'),
      placement: { tabId: 'overview' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.upsert', {
      itemId: 'release-checklist', expectedItemRevision: revision,
      item: note('Release checklist', 'Final'),
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'tab.create', tabId: 'details', title: 'Details' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'item.move', itemId: 'release-checklist', fromTabId: 'overview', toTabId: 'details' },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.layout.update', {
      expectedLayoutRevision: revision,
      operation: { op: 'tab.move', tabId: 'details', anchor: { side: 'before', tabId: 'overview' } },
    })).resolves.toMatchObject({ ok: true });
    await expect(executeBoardAction('session.board.item.remove', {
      itemId: 'temporary-note', expectedItemRevision: revision, expectedLayoutRevision: revision,
    })).resolves.toMatchObject({ ok: true });

    const board = await executeBoardAction('session.board.get', { itemIds: ['release-checklist', 'temporary-note'] });
    expect(board).toMatchObject({
      ok: true,
      result: {
        layout: { document: { tabs: [
          { id: 'details', items: [{ itemId: 'release-checklist', width: 'wide' }] },
          { id: 'overview', items: [] },
        ] } },
        items: [{ itemId: 'release-checklist', item: { title: 'Release checklist' } }],
        incomplete: true,
      },
    });
    expect(admittedContexts).toHaveLength(8);
    expect(admittedContexts).toEqual(admittedContexts.map((context) => expect.objectContaining({
      surface: 'agent',
      authority: 'account_automation',
    })));

    let agentState: AgentState = {};
    const rpcHandlers = new Map<string, RpcHandler>();
    const presentationContext = {
      signal: new AbortController().signal,
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
        sessionId: 'session-one',
        accountId: 'owner-account',
        connectionId: 'owner-ui-connection',
      },
    } as const;
    let boundHostNonce = '';
    const appliedIntents: unknown[] = [];
    const presentationSession = {
      sessionId: 'session-one',
      rpcHandlerManager: {
        registerHandler: (method: string, handler: RpcHandler) => { rpcHandlers.set(method, handler); },
        invokeLocal: async (method: string, params: unknown) => {
          const handler = rpcHandlers.get(method);
          if (!handler) throw new Error(`Missing local RPC handler: ${method}`);
          return await handler(params);
        },
      },
      updateAgentState: async (updater: (state: AgentState) => AgentState) => {
        agentState = updater(agentState);
        const state = CurrentSessionPresentationStateV1Schema.parse(
          (agentState as Record<string, unknown>)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
        );
        const command = state.command;
        if (command?.kind !== 'presentation.apply') return;
        const intent = command.intent;
        appliedIntents.push(intent);
        const openedLayout = layoutRecord?.content as Readonly<{ t: 'plain'; v: { tabs: readonly { id: string; items: readonly { itemId: string }[] }[] } }> | undefined;
        const targetExists = intent.kind !== 'board.item.reveal' || (
          itemRecords.has(intent.widgetId)
          && openedLayout?.v.tabs.some((tab) => tab.items.some((placement) => placement.itemId === intent.widgetId)) === true
        );
        queueMicrotask(() => {
          void rpcHandlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
            hostNonce: boundHostNonce,
            clientId: command.clientId,
            commandId: command.id,
            result: { status: targetExists ? 'applied' : 'invalidTarget' },
          }, presentationContext);
        });
      },
    } satisfies Pick<SessionClientPort, 'sessionId' | 'rpcHandlerManager' | 'updateAgentState'>;
    const presentationAbort = new AbortController();
    const presentation = createCurrentSessionPresentationService({
      session: presentationSession,
      signal: presentationAbort.signal,
      isCurrent: () => true,
      ackTimeoutMs: 100,
    });
    const bound = await rpcHandlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'focused-ui', focused: true, draftRevision: 0,
    }, presentationContext) as Readonly<{ hostNonce: string }>;
    boundHostNonce = bound.hostNonce;

    await expect(presentation.present({
      operationId: 'agent-open-board',
      intent: { kind: 'board.open', mode: 'focus' },
    })).resolves.toMatchObject({ status: 'applied' });
    await expect(presentation.present({
      operationId: 'agent-reveal-release-checklist',
      intent: { kind: 'board.item.reveal', widgetId: 'release-checklist', viewId: 'details' },
    })).resolves.toMatchObject({ status: 'applied' });
    expect(appliedIntents).toEqual([
      { kind: 'board.open', mode: 'focus' },
      { kind: 'board.item.reveal', widgetId: 'release-checklist', viewId: 'details' },
    ]);
    presentationAbort.abort();
  });
});
