import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import nacl from 'tweetnacl';
import {
  FeaturesResponseSchema,
  SessionAwarenessProjectionV1Schema,
  projectLegacySessionAccessCapabilitiesV1,
  SessionMetadataTuplePatchV1Schema,
  SessionDisplayProjectionV1Schema,
  openSessionSharedDisplayEnvelopeV1Sync,
  openSessionOwnerDisplayEnvelopeV1,
  API_TOKEN_FULL_GRANT_V1,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import {
  createAccountEncryptionCurrentnessFixture,
  createCurrentSessionProjectionRecordFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { sealMemorySystemRecordPayload, MEMORY_SYSTEM_RECORD_KINDS, buildMemorySynopsisSystemRecordLocalId } from '@/session/systemRecords/memory/memorySystemRecords';
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  // Keep Axios configuration real beneath the credential-scoped HTTP boundary.
  return { ...actual, default: { ...actual.default, get: vi.fn(), patch: vi.fn(), isAxiosError: () => false } };
});
const { socketBoundary } = vi.hoisted(() => ({ socketBoundary: { socket: null as EventEmitter | null } }));
// Socket transport and HTTP are system boundaries; awareness, observation and predicates stay real.
vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocketConnection: () => {
    const socket = Object.assign(socketBoundary.socket!, { connected: false, connect() {}, disconnect() {}, close() {} });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));
const credentials = { token: 'test-token', encryption: null } as const;
// The credential-reader boundary supplies this existing marker. The actual
// executor, not a caller-supplied authority claim, derives terminal authority.
const terminalCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'status-account', tokenEpoch: 4,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
  encryption: null, credentialProvenance: 'stored_session' } as const;
const sessionId = 'c123456789012345678901234';
/** No external-Action authorization: these reads carry the daemon credential. */
const context: ActionExecutorContext = {};
function deps() { return createCliActionDeps({token:credentials.token,credentials,sessionId,mode:'plain',ctx:null}); }
function collaborationFeatures() {
  return FeaturesResponseSchema.parse({
    features: {
      sessions: { enabled: true },
      sharing: { session: { enabled: true } },
    },
    capabilities: {},
  });
}
describe('CLI activity compatibility awareness', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.useRealTimers(); socketBoundary.socket = null; });
  it.each(['synopsis', 'synopsis_e2ee', 'worker', 'empty', 'unavailable', 'mode_mismatch'] as const)('reads the %s Recap through the composed Action and existing HTTP readers', async (scenario) => {
    const encrypted = scenario === 'synopsis_e2ee' || scenario === 'mode_mismatch';
    const secret = new Uint8Array(32).fill(7);
    const recapCredentials = encrypted ? { token: credentials.token, encryption: { type: 'legacy' as const, secret } } : credentials;
    const crypto = encrypted ? { mode: 'e2ee' as const, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } }
      : { mode: 'plain' as const, ctx: null };
    const fields = buildSessionMetadataEnvelopeFields({ credentials: recapCredentials, accountEncryptionMode: encrypted ? 'e2ee' : 'plain',
      ...(encrypted ? { storedContentMode: 'e2ee' as const, encryptionKey: secret, encryptionVariant: 'legacy' as const }
        : { storedContentMode: 'plain' as const }),
      metadata: { path: '/repo', host: 'host', work: { memoryEnabled: true } }, agentState: {} });
    const row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: crypto.mode, metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState });
    const synopsis = { v: 1 as const, seqTo: 10, updatedAtMs: 20, synopsis: 'Memory result' };
    const content = sealMemorySystemRecordPayload({ mode: scenario === 'mode_mismatch' ? 'plain' : crypto.mode,
      ...(crypto.mode === 'e2ee' ? { ctx: crypto.ctx } : {}), kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis, payload: synopsis });
    const record = { id: 'synopsis', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      address: { owner: 'host', namespace: 'memory', kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
        localId: buildMemorySynopsisSystemRecordLocalId(synopsis) }, content,
      createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' };
    const requests: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const target = new URL(String(url));
      requests.push(target.pathname);
      if (target.pathname.endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: encrypted ? 'e2ee' : 'plain' }) };
      if (target.pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
      if (target.pathname.endsWith('/system-records')) {
        expect(target.searchParams.get('owner')).toBe('host');
        expect(target.searchParams.get('namespace')).toBe('memory');
        expect(target.searchParams.get('kind')).toBe(MEMORY_SYSTEM_RECORD_KINDS.synopsis);
        if (scenario === 'unavailable') return { status: 403, data: { code: 'plugin_session_record_forbidden' } };
        return { status: 200, data: { records: scenario.startsWith('synopsis') || scenario === 'mode_mismatch' ? [record] : [], hasNext: false, nextCursor: null } };
      }
      if (target.pathname.endsWith('/messages')) return { status: 200, data: { messages: scenario === 'worker' ? [{
        id: 'delivered', seq: 12, localId: 'worker-update', createdAt: 30, updatedAt: 30,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'delivered-update', data: { type: 'worker-update', update: {
          v: 1, workerKind: 'session', workerId: sessionId, ownerState: 'settled', wake: 'finished',
          headline: 'Worker finished', result: 'Delivered body', canInspect: true,
        } } } } },
      }] : [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
      throw new Error(`Unexpected Recap request: ${target.pathname}`);
    });
    const owner = createCliActionExecutor({ token: recapCredentials.token, credentials: recapCredentials, sessionId: 'cli-global', ...crypto });
    const result = await owner.execute('session.activity.get', { sessionId, view: 'recap' }, { surface: 'cli', bypassApprovals: true });
    const expected = scenario.startsWith('synopsis') ? { status: 'ready', recap: { source: 'synopsis', text: 'Memory result', atMs: 20 } }
      : scenario === 'worker' ? { status: 'ready', recap: { source: 'worker_update', body: 'Delivered body', workerSessionId: sessionId, atMs: 30 } }
      : { status: scenario === 'mode_mismatch' ? 'unavailable' : scenario, recap: null };
    expect(result).toMatchObject({ ok: true, result: { view: 'recap', sessionId, ...expected } });
    if (scenario.startsWith('synopsis') || scenario === 'unavailable' || scenario === 'mode_mismatch') expect(requests.filter(path => path.endsWith('/messages'))).toHaveLength(0);
  });
  it('backfills display through the ordinary Account status Action using its captured Home and token', async () => {
    const credentials = terminalCredentials;
    const home = 'https://status-home.example';
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/retained/workspace', host: 'retained-host', summary: { text: 'Retained status', updatedAt: 1 } }, agentState: {} });
    let row = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
      metadataVersion: 7, agentStateVersion: 4 });
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      expect(new URL(String(url)).origin).toBe(home);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected status request: ${url}`);
    });
    vi.mocked(axios.patch).mockImplementation(async (url, body, options) => {
      expect(String(url)).toBe(`${home}/v2/sessions/${sessionId}`);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected complete same-tuple owner display maintenance');
      expect(patch).toMatchObject({ sharedMetadata: { ciphertext: fields.sharedMetadata.ciphertext, expectedVersion: 7 },
        ownerMetadata: fields.ownerMetadata, agentState: { ciphertext: fields.agentState, expectedVersion: 4 } });
      row = createSessionRecordFixture({ ...row, metadataVersion: 8, displayProjectionV1: patch.displayProjectionV1 });
      return { status: 200, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 8 }, agentState: { version: 4 } } };
    });
    const owner = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'status-home', serverHttpBaseUrl: home });
    await expect(owner.execute('session.status.get', { sessionId, live: false }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { ok: true, session: { id: sessionId, title: 'Retained status' } } });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(2);
    const display = SessionDisplayProjectionV1Schema.parse(row.displayProjectionV1);
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', envelope: display.shared }))
      .toMatchObject({ ok: true, display: { summaryText: 'Retained status' } });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', envelope: display.owner }))
      .toMatchObject({ ok: true, display: { path: '/retained/workspace' } });
    await expect(owner.execute('session.status.get', { sessionId, live: false }, { surface: 'cli' })).resolves.toMatchObject({ ok: true });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });
  function fullOwnerStatusRow() {
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/retained/workspace', host: 'host', summary: { text: 'Full status fallback', updatedAt: 1 } }, agentState: {} });
    return createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
      metadataVersion: 7, agentStateVersion: 4 });
  }
  it('keeps signed status on requester HTTP authority without display maintenance', async () => {
    const home = 'https://status-home.example';
    const target = { kind: 'session' as const, sessionId };
    const actionId = 'session.status.get';
    const envelope = { v: 1 as const, requestId: 'signed-status-read', target, input: { sessionId, live: false } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'srv_status_home', custodianAccountId: 'host-owner', machineId: 'reader-machine', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const row = fullOwnerStatusRow();
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      expect(new URL(String(url)).origin).toBe(home);
      expect(options?.headers).not.toHaveProperty('Authorization');
      expect(options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
        publicKey: keys.publicKey, signature: String(options?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected signed status request: ${url}`);
    });
    const owner = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId: 'status-home', serverIdentityId: 'srv_status_home', serverHttpBaseUrl: home,
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    await expect(owner.sessionStatusGet!({ sessionId, live: false, context: { surface: 'api',
      externalActionExecutionAuthorization: authorization, externalActionTarget: target } }))
      .resolves.toMatchObject({ ok: true, session: { title: 'Full status fallback' } });
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
  it('refuses an external credential without its admitted proof before borrowing host authority', async () => {
    const owner = deps();
    await expect(owner.sessionStatusGet!({ sessionId, live: false, context: { surface: 'api',
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } }))
      .rejects.toThrow('authorization unavailable');
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.patch).not.toHaveBeenCalled();
  });
  it('preserves a distinct status transport token without borrowing the content credentials for maintenance', async () => {
    const row = fullOwnerStatusRow();
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer read-transport-token' });
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected scoped status request: ${url}`);
    });
    const owner = createCliActionDeps({ token: 'read-transport-token', credentials, sessionId, mode: 'plain', ctx: null });
    await expect(owner.sessionStatusGet!({ sessionId, live: false, context: { surface: 'cli', authority: 'present_user' } }))
      .resolves.toMatchObject({ ok: true });
    expect(axios.patch).not.toHaveBeenCalled();
  });
  it('retains the Account automation authority ceiling instead of treating it as an ordinary owner read', async () => {
    const row = fullOwnerStatusRow();
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}`,
        [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected automation status request: ${url}`);
    });
    await expect(deps().sessionStatusGet!({ sessionId, live: false, context: { authority: 'account_automation' } }))
      .resolves.toMatchObject({ ok: true });
    expect(axios.patch).not.toHaveBeenCalled();
  });
  it('keeps a raw factory status read without admitted invocation context read-only', async () => {
    const row = fullOwnerStatusRow();
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected raw status request: ${url}`);
    });
    await expect(deps().sessionStatusGet!({ sessionId, live: false })).resolves.toMatchObject({ ok: true });
    expect(axios.patch).not.toHaveBeenCalled();
  });
  it('preserves full status when its same admitted Account token cannot write', async () => {
    const row = fullOwnerStatusRow();
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected scoped status request: ${url}`);
    });
    vi.mocked(axios.patch).mockResolvedValue({ status: 403, data: { error: 'Insufficient Account token scope' } });
    const owner = createCliActionExecutor({ token: terminalCredentials.token, credentials: terminalCredentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null });
    await expect(owner.execute('session.status.get', { sessionId, live: false }, { surface: 'cli' })).resolves.toMatchObject({ ok: true });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.patch).mock.calls[0]?.[2]?.headers).toMatchObject({ Authorization: `Bearer ${terminalCredentials.token}` });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
  it('persists a caller-bound update without a manager and refuses foreign deliverables and workflow steps', async () => {
    const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { session: row } });
    const committed: unknown[] = [];
    const deliverables = [{ kind: 'workspace_file' as const, sessionId, path: 'docs/result.md' }, { kind: 'artifact' as const, artifactId: 'document-1' }];
    const owner = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      postSessionUpdate: async (report) => { committed.push(report); return { persisted: true, localId: 'worker-report-1' }; } });
    expect(await owner.sessionUpdatePost!({ context, summary: 'Partial finding', deliverables })).toEqual({ sessionId, localId: 'worker-report-1', persisted: true });
    expect(await owner.sessionUpdatePost!({ context, summary: 'Foreign source', deliverables: [{ kind: 'workspace_file', sessionId: 'other', path: 'docs/result.md' }] })).toMatchObject({ ok: false, errorCode: 'session_update_deliverable_scope_mismatch' });
    row.origin = { kind: 'run_step', runId: 'workflow-run' };
    expect(await owner.sessionUpdatePost!({ context, summary: 'Wrong carrier' })).toMatchObject({ ok: false, errorCode: 'session_update_run_step_requires_publish_draft' });
    expect(committed).toEqual([{ summary: 'Partial finding', deliverables }]);
  });
  it('never reports an update as persisted without its original committed reference', async () => {
    const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { session: row } });
    const owner = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      postSessionUpdate: async () => ({ persisted: false }),
    });
    expect(await owner.sessionUpdatePost!({ context, summary: 'Uncommitted finding' }))
      .toMatchObject({ ok: false, errorCode: 'session_update_not_committed' });
  });
  it('refuses a session caller publishing as a different bound source', async () => {
    const posted: unknown[] = [];
    const owner = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      postSessionUpdate: async report => { posted.push(report); return { persisted: true, localId: 'update-1' }; },
    });
    expect(await owner.sessionUpdatePost!({ summary: 'Wrong source', context: {
      actionCaller: { kind: 'session', sessionId: 'other-session', starterDepth: 0, turnDepth: 0 },
    } })).toMatchObject({ ok: false, errorCode: 'session_update_source_mismatch' });
    expect(posted).toEqual([]);
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });
  it('projects status through awareness while retaining released pending count fields', async () => {
    const now = Date.now();
    const row = createSessionRecordFixture({id:sessionId,encryptionMode:'plain',metadata:'{}',active:true,activeAt:now,latestTurnStatus:'in_progress',latestTurnStatusObservedAt:now,pendingCount:2,pendingPermissionRequestCount:0,pendingUserActionRequestCount:0});
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) return {status:200,data:createAccountEncryptionCurrentnessFixture()};
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return {status:200,data:{session:row}};
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(await deps().sessionActivityGet({ context, sessionId})).toMatchObject({
      ok:true,sessionId,presence:'online',working:true,blocked:false,pendingCount:2,
      pendingPermissionRequestCount:0,pendingUserActionRequestCount:0,
    });
  });
  it('reports a pending permission without inventing the request identities it cannot read', async () => {
    const now = Date.now();
    const row = createSessionRecordFixture({id:sessionId,encryptionMode:'plain',metadata:'{}',active:true,activeAt:now,pendingPermissionRequestCount:2,pendingUserActionRequestCount:0,pendingRequestObservedAt:now});
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) return {status:200,data:createAccountEncryptionCurrentnessFixture()};
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return {status:200,data:{session:row}};
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await deps().sessionActivityGet({ context, sessionId});
    expect(result).toMatchObject({ok:true,permissionRequired:true,blocked:true,pendingPermissionRequestCount:2});
    expect(result).not.toHaveProperty('permissionRequestIds');
  });
  it('preserves authorization failure instead of calling it not found', async () => {
    vi.mocked(axios.get).mockResolvedValue({status:403,data:{error:'forbidden'}});
    await expect(deps().sessionActivityGet({ context, sessionId})).rejects.toMatchObject({response:{status:403}});
  });
  it('retains a real not-found result and does not fetch Account content state for it', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 404, data: { error: 'session_not_found' } });
    expect(await deps().sessionActivityGet({ context, sessionId })).toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1);
  });
  it('preserves a network failure and cancellation without substituting absence', async () => {
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    vi.mocked(axios.get).mockRejectedValue(error);
    await expect(deps().sessionActivityGet({ context, sessionId })).rejects.toBe(error);
    vi.mocked(axios.get).mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(deps().sessionActivityGet({ context, sessionId, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });
  it('answers the requested awareness view with the canonical projection instead of the digest', async () => {
    const now = Date.now();
    const row = createSessionRecordFixture({id:sessionId,encryptionMode:'plain',metadata:'{}',active:true,activeAt:now,latestTurnStatus:'in_progress',latestTurnStatusObservedAt:now,pendingCount:0,pendingPermissionRequestCount:0,pendingUserActionRequestCount:0});
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) return {status:200,data:createAccountEncryptionCurrentnessFixture()};
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return {status:200,data:{session:row}};
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await deps().sessionActivityGet({ context, sessionId,view:'awareness'});
    // The same projector the compatibility digest is derived from, returned unadapted: the
    // marked `v` plus the absent released digest fields are what prove the view was applied.
    expect(SessionAwarenessProjectionV1Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({v:1,sessionId,operational:{primary:'working'}});
    expect(result).not.toHaveProperty('ok');
    expect(result).not.toHaveProperty('pendingCount');
  });
  it.each(['idle', 'ready'] as const)('waits for %s from current V2 presence and follows presence changes without a cadence', async (kind) => {
    vi.useFakeTimers();
    const now = Date.now();
    const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}',
      updatedAt: now, active: false, activeAt: now, latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: now, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const socket = new EventEmitter();
    socketBoundary.socket = socket;
    const owner = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'srv_awareness_home', serverHttpBaseUrl: 'https://home.example' });
    expect(await owner.sessionAwarenessWait!({ context,
      input: { target: { kind: 'session', serverId: 'srv_foreign', sessionId }, condition: { kind } },
      options: { condition: { kind }, timeoutMs: 10_000, deadlineMs: now + 10_000 },
      readAwareness: () => owner.sessionActivityGet({ context, sessionId, view: 'awareness' }),
    })).toMatchObject({ disposition: 'permission_denied' });
    const settled = vi.fn();
    const waiting = owner.sessionAwarenessWait!({ context,
      input: { target: { kind: 'session', serverId: 'srv_awareness_home', sessionId }, condition: { kind } },
      options: { condition: { kind }, timeoutMs: 10_000, deadlineMs: now + 10_000 },
      readAwareness: () => owner.sessionActivityGet({ context, sessionId, view: 'awareness' }),
    }).then((result) => { settled(result); return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    const reads = vi.mocked(axios.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(reads);
    row.active = true;
    row.activeAt = Date.now();
    row.updatedAt = Date.now();
    socket.emit('ephemeral', { type: 'activity', id: 'unrelated-session', active: true, activeAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    socket.emit('ephemeral', { type: 'activity', id: sessionId, active: true, activeAt: row.activeAt });
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toMatchObject({ disposition: 'matched', snapshot: {
      awareness: { runtime: 'idle', freshness: 'live', availability: 'complete' },
    } });
    expect(socket.listenerCount('ephemeral')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    row.active = false;
    expect(await owner.sessionActivityGet({ context, sessionId })).toMatchObject({ presence: 'offline' });
  });
  it.each([
    ['Team', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: false }],
    ['Group', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses the exact Home feature snapshot for %s-aware detail acquisition', async (_label, accessSource) => {
    const now = Date.now();
    const row = createCurrentSessionProjectionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: now,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: now,
      pendingCount: 0,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      effectiveAccess: {
        v: 1,
        level: 'view',
        sources: [accessSource],
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
      },
      viewer: {
        latestFailureSeq: null,
        readState: { state: 'not_started' },
        relevance: { relevant: false, reasons: [] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null },
        notification: { level: 'none', source: 'none' },
      },
    });
    const resolveServerFeaturesSnapshot = vi.fn(async () => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: collaborationFeatures(),
    }));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}?accessProjectionVersion=1`)) {
        return { status: 200, data: { session: row } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId,
      mode: 'plain',
      ctx: null,
      resolveServerFeaturesSnapshot,
    }).sessionActivityGet({ context, sessionId, view: 'awareness' })).resolves.toMatchObject({
      v: 1,
      sessionId,
      operational: { primary: 'working' },
    });
    expect(resolveServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
  });
  it('keeps the released bare detail request when the exact Home lacks feature discovery', async () => {
    const now = Date.now();
    const row = createSessionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: now,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: now,
      pendingCount: 0,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    });
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: row } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId,
      mode: 'plain',
      ctx: null,
      resolveServerFeaturesSnapshot: async () => ({
        status: 'unsupported',
        reason: 'endpoint_missing',
      }),
    }).sessionActivityGet({ context, sessionId })).resolves.toMatchObject({ ok: true, sessionId });
  });
  it('returns a typed unsupported result when this host cannot honor windowSeconds', async () => {
    const result = await deps().sessionActivityGet({ context, sessionId, windowSeconds: 60 });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.activity.get.windowSeconds',
    });
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });
  it('preserves malformed transport results instead of calling them not found', async () => {
    vi.mocked(axios.get).mockResolvedValue({status:200,data:{wrong:'shape'}});
    await expect(deps().sessionActivityGet({ context, sessionId})).rejects.toThrow('Unexpected /v2/sessions response shape');
  });
});
