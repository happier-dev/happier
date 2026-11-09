import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createActionExecutor, SessionEffectiveAccessV1Schema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema, type SessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountOrganizationV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { z } from 'zod/mini';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { seedTestServerProfile } from '@/testkit/serverProfiles';

const { callMachineRpc, callExactMachineRpc, fetchSessionById, patchSessionMetadataEnvelopeTuple } = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  callExactMachineRpc: vi.fn(),
  fetchSessionById: vi.fn(),
  patchSessionMetadataEnvelopeTuple: vi.fn(),
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
  callExactMachineRpc,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  patchSessionMetadataEnvelopeTuple,
}));

import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { MemorySettingsV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

describe('createCliActionDeps memory bindings', () => {
  it.each(['memory', 'context', 'instructions', 'voice'] as const)('rejects a stale %s caller before the first metadata write', async field => {
    const serverId = 'reviewed-home';
    const serverHttpBaseUrl = 'https://reviewed-home.test';
    const sessionId = 'creviewedsession000000001';
    const work = { memoryEnabled: false, voicePreference: {
      providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'current',
    }, promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'current' },
      enabled: true, required: true, placement: 'system_append' }],
      sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep current notes' } } satisfies NonNullable<SessionOwnerMetadataV1['work']>;
    let row = V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 5,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work }),
      agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null });
    // HTTP is the boundary: keep the real lookup, decoder, tuple CAS and registered updater.
    const http = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
    fetchSessionById.mockImplementation(http.fetchSessionById);
    patchSessionMetadataEnvelopeTuple.mockImplementation(http.patchSessionMetadataEnvelopeTuple);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected reviewed read: ${path}`);
    });
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      const input = SessionMetadataOwnerPatchV1Schema.parse(body);
      expect(input.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
      row = { ...row, metadataVersion: row.metadataVersion + 1, metadata: input.sharedMetadata.ciphertext,
        ownerMetadata: input.ownerMetadata, agentState: input.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token: 'reviewed-token', credentials: { token: 'reviewed-token', encryption: null },
      sessionId, serverId, serverHttpBaseUrl, mode: 'plain', ctx: null }));
    const execute = (expectedMetadataRevision: number) => {
      const target = { sessionId, serverId, expectedMetadataRevision };
      const context = { surface: 'cli', authority: 'present_user', serverId } as const;
      return field === 'memory' ? executor.execute('session.memory.set', { ...target, enabled: true }, context)
        : field === 'context' ? executor.execute('session.context.update', { ...target,
          intent: { kind: 'inherited_enable', entryId: 'account-memory', enabled: false } }, context)
        : field === 'instructions' ? executor.execute('session.instructions.set', { ...target, ref: null }, context)
        : executor.execute('session.voice.preference.set', { ...target, preference: null }, context);
    };
    expect(await execute(4)).toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(patch).not.toHaveBeenCalled();
    expect(row.ownerMetadata).toEqual(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work }));
    expect(await execute(5)).toMatchObject({ ok: true });
    expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Keep current notes' } } } });
    if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner fixture');
    expect(row.ownerMetadata.v.work).toMatchObject(field === 'memory' ? { memoryEnabled: true }
      : field === 'context' ? { disabledInheritedEntryIds: ['account-memory'] }
      : field === 'instructions' ? { promptStack: [] } : { memoryEnabled: false });
    if (field === 'voice') expect(row.ownerMetadata.v.work).not.toHaveProperty('voicePreference');
  });
  it.each(['keep_both', 'update', 'replace'] as const)('resubmits %s through the real CLI bindings on the reviewed Team-shared Memory document', async kind => {
    const serverHttpBaseUrl = 'https://qa-memory-home.test';
    const serverId = 'qa-memory-home';
    const artifactId = '74a91a24-de24-424e-831c-2ffd6aff956a';
    const original = { id: 'e5b7472e-ff36-441e-96a1-8dcff5a0c022', createdAtMs: 1, sourceSessionRef: null,
      text: 'QA N3 payments runbook: verify webhook signatures before acknowledgement and reuse one stable idempotency key across settlement retries.' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'qa-owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    let stored = { id: artifactId, ownerAccountId: 'qa-owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 2, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 1,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'QA N3 Team payment runbook' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [original], topics: [] }) }) };
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (path === `/v1/artifacts/${artifactId}`) return { status: 200, data: stored };
      if (path === `/v1/artifacts/${artifactId}/access/grants`) return { status: 200, data: {
        artifactId, ownerAccountId: 'qa-owner', access: 'owner', grants: [{ principal: { kind: 'team', teamId: 'qa-team' },
          accessLevel: 'view', createdByAccountId: 'qa-owner', createdAt: 1, display: { name: null } }],
      } };
      if (path === '/v1/public-shares') return { status: 200, data: { publicShares: [] } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      throw new Error(`Unexpected boundary read: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
      expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/artifacts/${artifactId}`);
      expect(wire).toMatchObject({ expectedHeaderVersion: 2, expectedBodyVersion: 2 });
      const update = z.looseObject({ header: z.string(), body: z.string() }).parse(wire);
      stored = { ...stored, header: update.header, body: update.body, headerVersion: 3, bodyVersion: 3 };
      return { status: 200, data: { success: true, headerVersion: 3, bodyVersion: 3 } };
    });
    const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global',
      serverId, serverHttpBaseUrl, mode: 'plain', ctx: null });
    // Waive only confirmation, never access/exposure admission or the reviewed CAS.
    const context = { surface: 'cli' as const, authority: 'account_automation' as const, serverId,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'memory.remember': ['cli'] } }) };
    const input = { ref: { kind: 'doc' as const, artifactId, serverId }, expectedRevision: { headerVersion: 2, bodyVersion: 2 },
      topic: 'operations', text: 'QA N3 payment triage: verify webhook signatures and keep the settlement idempotency key in incident notes.' };
    const review = await executor.execute('memory.remember', input, context);
    expect(review, JSON.stringify(review)).toMatchObject({ ok: true, result: { ok: false, errorCode: 'memory_duplicate_choice_required',
      ref: input.ref, revision: input.expectedRevision, candidates: [{ factId: original.id }] } });
    expect(post).not.toHaveBeenCalled();
    const result = await executor.execute('memory.remember', { ...input, duplicateChoice: {
      kind, expectedRevision: input.expectedRevision, ...(kind === 'keep_both' ? {} : { factId: original.id }),
    } }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, revision: { headerVersion: 3, bodyVersion: 3 } } });
    const envelope = decodePlainArtifactStoredContent(stored.body);
    if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('Expected a text Memory body');
    const saved = MemoryDocBodyV1Schema.parse(JSON.parse(envelope.body));
    expect(saved.topics.find(topic => topic.title === 'operations')?.facts).toEqual([
      expect.objectContaining({ text: input.text, ...(kind === 'keep_both' ? {} : { supersedes: original.id }) }),
    ]);
    expect(kind === 'keep_both' ? saved.index : saved.topics.find(topic => topic.title === 'archive')?.facts).toEqual([original]);
    expect(get.mock.calls.every(([url]) => new URL(String(url)).origin === serverHttpBaseUrl)).toBe(true);
  });

  it('preserves admitted native search hits while rechecking only Happier Session ranges', async () => {
    const nativeHit = { type: 'external_transcript' as const,
      source: { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
      sourceItemId: 'native-item', createdAtFromMs: 1, createdAtToMs: 2, summary: 'native quartz', score: 0.8 };
    const sessionHit = { sessionId: 'revoked', seqFrom: 1, seqTo: 2,
      createdAtFromMs: 1, createdAtToMs: 2, summary: 'retained quartz', score: 0.8 };
    callMachineRpc.mockResolvedValue({ v: 1, ok: true, hits: [nativeHit, sessionHit] });
    fetchSessionById.mockResolvedValue(null);
    const deps = createCliActionDeps({ token: 't', credentials: { token: 't', encryption: null }, sessionId: 'unused',
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null });
    expect(await deps.daemonMemorySearch({ machineId: 'machine', serverId: 'home',
      query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto', corpora: ['sessions', 'external_transcripts'] },
    })).toEqual({ v: 1, ok: true, hits: [nativeHit] });
    expect(fetchSessionById.mock.calls.map(([request]) => request.sessionId)).toEqual(['revoked']);
  });

  it('reads a native memory window on its exact Machine and Home without a Session read', async () => {
    const source = { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' };
    const window = { v: 1, snippets: [], citations: [], externalSnippets: [{ source, sourceItemId: 'item', createdAtMs: 1, text: 'quartz' }] };
    callExactMachineRpc.mockResolvedValue(window);
    const deps = createCliActionDeps({ token: 't', credentials: { token: 't', encryption: null }, sessionId: 'unused',
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null });
    expect(await createActionExecutor(deps).execute('memory.get_window', { machineId: 'machine', source, sourceItemId: 'item', cursor: 'page' },
      { surface: 'cli', serverId: 'home' })).toEqual({ ok: true, result: window });
    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverUrl: 'https://home.test',
      method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, request: { v: 1, source, sourceItemId: 'item', cursor: 'page' } }));
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
  it('persists Search settings and clears only the exact requested Machine through the Action owner', async () => {
    const credentials = { token: 'search-token', encryption: null };
    let persisted = MemorySettingsV1Schema.parse({ v: 1 });
    let cleared = false;
    callExactMachineRpc.mockImplementation(async ({ machineId, method, request }) => {
      expect(machineId).toBe('search-machine');
      if (method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return persisted;
      if (method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET) { persisted = MemorySettingsV1Schema.parse(request); return persisted; }
      if (method === RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX) { expect(request).toEqual({}); cleared = true; return { ok: true }; }
      throw new Error('unexpected_method');
    });
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
      sessionId: 'cli-global', serverId: 'search-home', serverHttpBaseUrl: 'https://search-home.test', mode: 'plain', ctx: null });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'search-home',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'memory.clear_index': ['cli'] } }),
    } as const;
    expect(await executor.execute('search.settings.get', { machineId: 'search-machine' }, context)).toMatchObject({
      ok: true, result: { conversationSearch: { standardSearch: { enabled: true } } },
    });
    const settings = MemorySettingsV1Schema.parse({ v: 1, conversationSearch: { standardSearch: { enabled: false } } });
    expect(await executor.execute('search.settings.set', { machineId: 'search-machine', settings }, context)).toEqual({ ok: true, result: settings });
    expect(await executor.execute('search.settings.get', { machineId: 'search-machine' }, context)).toEqual({ ok: true, result: settings });
    expect(await executor.execute('memory.clear_index', { machineId: 'search-machine' }, context)).toEqual({ ok: true, result: { ok: true } });
    expect(cleared).toBe(true);
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot(); });
  beforeEach(() => {
    callMachineRpc.mockReset();
    callExactMachineRpc.mockReset();
    fetchSessionById.mockReset();
    patchSessionMetadataEnvelopeTuple.mockReset();
  });

  it('keeps Session-target Memory owner-only before private Project discovery across current and legacy HTTP roles', async () => {
    const serverId = 'memory-owner-home';
    const serverHttpBaseUrl = 'https://memory-owner-home.test';
    const sessionId = 'cmemorysession000000000001';
    const accountId = 'memory-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const artifactId = '74a91a24-de24-424e-831c-2ffd6aff956a';
    const text = 'Keep the private quartz owner notebook';
    const fact = { id: 'e5b7472e-ff36-441e-96a1-8dcff5a0c022', createdAtMs: 1, sourceSessionRef: null, text };
    const stored = { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Owner Memory' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [fact], topics: [] }) }) };
    // Predecessor 413054f: v2SessionListRows projects share:null for owners and
    // {accessLevel,canApprovePermissions} for recipients, without ownerAccountId.
    const legacy = { id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadata: JSON.stringify({ path: '/repo', host: 'host', machineId: 'machine',
        workspaceId: 'checkout', projectId: 'project', work: { memoryEnabled: true } }),
      metadataVersion: 3, dataEncryptionKey: null, agentState: null, agentStateVersion: 1 };
    let projection: Record<string, unknown> = { share: null };
    const reads: string[] = [];
    const actualSessionHttp = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
    fetchSessionById.mockImplementation(actualSessionHttp.fetchSessionById);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: { ...legacy, ...projection } } };
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === `/v1/artifacts/${artifactId}`) return { status: 200, data: stored };
      if (path === `/v1/artifacts/${artifactId}/access/grants`) return { status: 200, data: {
        artifactId, ownerAccountId: accountId, access: 'owner', grants: [],
      } };
      if (path === '/v1/public-shares') return { status: 200, data: { publicShares: [] } };
      throw new Error(`Unexpected owner boundary read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/project-rows/list' || path === '/v1/account/project-rows/read') {
        const key = { kind: 'project-organization', serverId, projectKey: 'project' };
        const refKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
        return projectAccountRowsReadHttpResponse([
          { key: refKey, revision: 1, content: { t: 'plain', v: { key: refKey, value: {
            id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
          } } } },
          { key, revision: 1, content: { t: 'plain', v: { key, value: { promptStack: [{ id: 'project.memory',
            ref: { kind: 'doc', artifactId }, enabled: true, placement: 'system_append' }] } } } },
        ], String(url), body);
      }
      if (path === '/v1/artifacts/read') {
        const request = ArtifactReadHeadersBatchInputV1Schema.parse(body);
        expect(request.artifactIds).toEqual([artifactId]);
        const { body: _body, ...header } = stored;
        return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers',
          items: [{ artifactId, ok: true, artifact: header }] }) };
      }
      throw new Error(`Unexpected owner boundary mutation: ${path}`);
    });
    const ownerAccess = SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl });
    const executor = createActionExecutor(deps);
    for (const current of [false, true]) {
      projection = { share: null, ...(current ? { effectiveAccess: ownerAccess, ownerAccountId: accountId } : {}) };
      reads.length = 0;
      const result = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executor.execute('memory.remember', { sessionRef: { serverId, sessionId },
        expectedMetadataRevision: 3, text }, { surface: 'cli', authority: 'present_user', serverId }));
      expect(result, JSON.stringify({ result, reads })).toMatchObject({ ok: true, result: { ok: false,
        errorCode: 'memory_duplicate_choice_required', candidates: [{ factId: fact.id }] } });
      expect(reads).toContain('/v1/account/project-rows/list');
      expect(reads).toContain(`/v1/artifacts/${artifactId}`);
    }
    for (const role of [
      { share: { accessLevel: 'view', canApprovePermissions: false } },
      { share: { accessLevel: 'view', canApprovePermissions: false }, projectKey: 'project' },
      { share: null, effectiveAccess: ownerAccess, ownerAccountId: 'another-account' },
      { owner: { id: accountId } },
    ]) {
      projection = role;
      reads.length = 0;
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executor.execute('memory.remember', { sessionRef: { serverId, sessionId },
        expectedMetadataRevision: 3, text }, { surface: 'cli', authority: 'present_user', serverId })))
        .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
      expect(reads).toContain(`/v2/sessions/${sessionId}`);
      expect(reads.filter(path => path !== `/v2/sessions/${sessionId}` && path !== '/v1/account/encryption/currentness')).toEqual([]);
    }
    projection = { share: null, effectiveAccess: ownerAccess, ownerAccountId: accountId };
    reads.length = 0;
    expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executor.execute('memory.remember', {
      sessionRef: { serverId, sessionId }, expectedMetadataRevision: 3, text,
    }, { surface: 'cli', authority: 'present_user', serverId, runtimeAccountId: 'another-account' })))
      .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(reads).toEqual([]);
    for (const [targetServerId, contextServerId] of [['foreign-home', serverId], [serverId, 'foreign-home']] as const) {
      await expect(deps.memoryLibrary!.readSession!({ serverId: targetServerId, sessionId },
        { surface: 'cli', serverId: contextServerId })).rejects.toMatchObject({ code: 'session_target_unavailable' });
      expect(reads).toEqual([]);
    }
  });

  it.each(['srv_memory_home', 'memory-profile'])('creates and attaches Bot memory addressed by %s with portable Home provenance', async requestedServerId => withConfiguredDaemonTestHome({ prefix: 'memory-portable-home-' }, async () => {
    const serverId = 'memory-profile';
    const serverIdentityId = 'srv_memory_home';
    const serverHttpBaseUrl = 'https://memory-home.test';
    await seedTestServerProfile({ id: serverId, homeId: serverIdentityId, serverUrl: serverHttpBaseUrl });
    const sessionId = 'cmemorysession000000000001';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    fetchSessionById.mockResolvedValue(V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: '/repo', host: 'host' },
        work: { bot: { kind: 'bot' }, memoryEnabled: true } }),
      metadataVersion: 3, dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1,
      effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }) }));
    patchSessionMetadataEnvelopeTuple.mockImplementation(async ({ patch }) => {
      SessionMetadataOwnerPatchV1Schema.parse(patch);
      return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 4 }, agentState: { version: 2 } };
    });
    const artifacts: { id: string; header: string; body: string; dataEncryptionKey: string }[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const stored = artifacts.map(artifact => ({ ...artifact,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 }));
      if (path === '/v1/artifacts') return { status: 200, data: stored };
      const artifact = stored.find(value => path === `/v1/artifacts/${value.id}`);
      if (artifact) return { status: 200, data: artifact };
      throw new Error(`Unexpected read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname === '/v1/artifacts/read') {
        const input = ArtifactReadHeadersBatchInputV1Schema.parse(body);
        return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: input.artifactIds.map(artifactId => {
          const stored = artifacts.find(artifact => artifact.id === artifactId);
          if (!stored) throw new Error('Unexpected selected Artifact');
          const { body: _body, ...artifact } = stored;
          return { artifactId, ok: true, artifact: { ...artifact, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        }) }) };
      }
      expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/artifacts`);
      // HTTP boundary: retain the actual producer's encoded Artifact for its real header/body readers.
      artifacts.push(body as typeof artifacts[number]);
      return { status: 200, data: { id: artifacts.at(-1)!.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId, serverIdentityId, serverHttpBaseUrl });
    const result = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createActionExecutor(deps).execute('memory.remember', {
      sessionRef: { serverId: requestedServerId, sessionId }, expectedMetadataRevision: 3, text: 'Keep the quartz notebook',
    }, { surface: 'cli', authority: 'present_user', serverId: requestedServerId, defaultSessionId: sessionId }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, attachment: 'attached',
      ref: { kind: 'doc', artifactId: expect.any(String), serverId: serverIdentityId } } });
    expect(artifacts).toHaveLength(1);
    const envelope = decodePlainArtifactStoredContent(artifacts[0]!.body);
    if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('Expected plain text body');
    expect(MemoryDocBodyV1Schema.parse(JSON.parse(envelope.body)).index).toEqual([expect.objectContaining({
      text: 'Keep the quartz notebook', sourceSessionRef: { serverId: serverIdentityId, sessionId },
    })]);
    await expect(runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createActionExecutor(deps).execute('memory.read', {
      ref: { kind: 'doc', artifactId: artifacts[0]!.id, serverId },
    }, { surface: 'cli', serverId: serverIdentityId }))).resolves.toMatchObject({ ok: true, result: {
      body: { index: [expect.objectContaining({ text: 'Keep the quartz notebook',
        sourceSessionRef: { serverId: serverIdentityId, sessionId } })] },
    } });
    const patch = SessionMetadataOwnerPatchV1Schema.parse(patchSessionMetadataEnvelopeTuple.mock.calls[0]?.[0]?.patch);
    expect(patch.ownerMetadata).toMatchObject({ t: 'plain', v: {
        work: expect.objectContaining({ promptStack: [expect.objectContaining({ id: 'session.memory',
          ref: { kind: 'doc', artifactId: artifacts[0]!.id, serverId: serverIdentityId } })] }),
      } });
  }));

  it('rejects a foreign Memory Home before reading or allocating anything', async () => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected foreign Home read'));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected foreign Home write'));
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'unused', mode: 'plain', ctx: null, serverId: 'memory-profile', serverIdentityId: 'srv_memory_home',
      serverHttpBaseUrl: 'https://memory-home.test' });
    const result = await createActionExecutor(deps).execute('memory.remember', {
      sessionRef: { serverId: 'srv_foreign_home', sessionId: 'cmemorysession000000000001' },
      expectedMetadataRevision: 3, text: 'Must stay private',
    }, { surface: 'cli', authority: 'present_user', serverId: 'memory-profile' });
    expect(result).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    await expect(createActionExecutor(deps).execute('memory.read', {
      ref: { kind: 'doc', artifactId: 'foreign', serverId: 'srv_foreign_home' },
    }, { surface: 'cli', serverId: 'memory-profile' })).resolves.toMatchObject({ ok: false, errorCode: 'action_failed', error: 'server_target_mismatch' });
    await expect(deps.sessionStateFieldSet!({ actionId: 'session.instructions.set',
      context: { surface: 'cli' }, sessionId: 'cmemorysession000000000001', serverId: 'srv_foreign_home',
      fieldId: 'intent.context', expectedMetadataRevision: 3,
      value: { kind: 'attach', entry: { id: 'session.instructions', ref: { kind: 'doc', artifactId: 'foreign' },
        enabled: true, placement: 'system_append' } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTuple).not.toHaveBeenCalled();
  });

  it.each(['memory', 'session'] as const)('refuses to translate a Home reference into an unbound private reader scope for %s', async owner => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected foreign Home read'));
    const credentials = { token: 'token', encryption: null, requesterSessionCredentialScope: {
      serverId: 'foreign-profile', serverHttpBaseUrl: 'https://foreign-home.test',
    } };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'unused', mode: 'plain', ctx: null,
      serverId: 'memory-profile', serverIdentityId: 'srv_memory_home', serverHttpBaseUrl: 'https://memory-home.test' });
    const ref = { kind: 'doc' as const, artifactId: 'private-memory', serverId: 'srv_memory_home' };
    if (owner === 'memory') {
      await expect(deps.memoryLibrary!.readArtifactHeaders!([ref], { surface: 'cli' }))
        .rejects.toMatchObject({ code: 'server_target_mismatch' });
    } else {
      await expect(deps.sessionStateFieldSet!({ actionId: 'session.context.update', context: { surface: 'cli' },
        sessionId: 'cmemorysession000000000001', serverId: 'srv_memory_home', fieldId: 'intent.context', expectedMetadataRevision: 3,
        value: { kind: 'attach', entry: { id: 'session.memory', ref, enabled: true, placement: 'system_append' } },
      })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('attaches Account memory with the captured coding row revision and preserves neighboring entries', async () => {
    const credentials = { token: 'account-memory-token', encryption: null };
    const serverId = 'memory-home';
    const serverHttpBaseUrl = 'https://memory-home.test';
    const neighbor = { id: 'instructions', ref: { kind: 'doc' as const, artifactId: 'instructions' }, enabled: true,
      placement: 'system_append' as const };
    let entries: PromptStackEntryV1[] = [neighbor];
    let revision = 4;
    const mutations: unknown[] = [];
    runWithServerHttpBaseUrl(serverHttpBaseUrl, () => {
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    });
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/prompt-library')
        ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision,
          content: { t: 'plain', v: key === 'coding' ? { key, value: { v: 1, scope: { kind: key }, entries } }
            : emptyPromptLibraryRecordV1(key) } })) }
        : String(url).endsWith('/v2/account/settings') ? { version: 7, content: { t: 'plain', v: {} } }
          : String(url).endsWith('/encryption/currentness') ? { mode: 'plain', version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }
            : { mode: 'plain', updatedAt: 0 } }));
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/account/entity-rows/prompt-library/coding`);
        const mutation = PromptLibraryRowMutationV1Schema.parse(body);
        mutations.push(mutation);
        expect(mutation.expectedRevision).toBe(4);
        if (revision !== 4) return { status: 409, data: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('expected keyless Plain row');
        const record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
        if (record.key !== 'coding') throw new Error('wrong row');
        entries = record.value.entries;
        revision = 5;
        return { status: 200, data: { status: 'updated', revision, cursor: revision } };
      });
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null,
        serverId, serverHttpBaseUrl });
      const account = await deps.memoryLibrary!.readScopeContext!({ scope: 'account' }, { surface: 'cli' });
      expect(account.entries).toEqual([neighbor]);
      expect(account.safety).toBe('safe');
      await expect(account.attachMemory({ kind: 'doc', artifactId: 'created', serverId })).resolves.toBe(true);
      expect(entries).toEqual([neighbor, { id: 'account.memory', ref: { kind: 'doc', artifactId: 'created', serverId },
        enabled: true, placement: 'system_append' }]);
      await expect(account.attachMemory({ kind: 'doc', artifactId: 'loser', serverId })).resolves.toBe(false);
      expect(mutations).toHaveLength(2);
      expect(entries[1]?.ref.artifactId).toBe('created');
  });

  it('attaches personal Project memory without a Session through the captured semantic row CAS', async () => {
    const serverId = 'project-scope-home';
    const serverHttpBaseUrl = 'https://project-scope-home.test';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'scope-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const key = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    const neighbor = { id: 'instructions', ref: { kind: 'doc' as const, artifactId: 'instructions' }, enabled: true,
      placement: 'system_append' as const };
    let value = ProjectAccountOrganizationV1Schema.parse({ hidden: true, pinned: true, promptStack: [neighbor] });
    let revision = 4;
    const writes: unknown[] = [];
    const projectReads: unknown[] = [];
    const created = {
      id: 'created', ownerAccountId: 'scope-account', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [], topics: [] }) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts/created') return { status: 200, data: created };
      throw new Error(`Unexpected read ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url).startsWith(serverHttpBaseUrl)).toBe(true);
      if (new URL(String(url)).pathname === '/v1/artifacts/read') return artifactReadResponse(body, id => id === created.id ? created : null);
      if (String(url).endsWith('/list') || String(url).endsWith('/read')) {
        projectReads.push(body);
        return projectAccountRowsReadHttpResponse([
          { key, revision, content: { t: 'plain', v: { key, value } } },
        ], String(url), body);
      }
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
      writes.push(mutation);
      expect(mutation.mutations[0]?.expectedRevision).toBe(4);
      if (revision !== 4) return { status: 409, data: { status: 'conflict', key, revision } };
      const content = mutation.mutations[0]?.content;
      if (content?.t !== 'plain' || typeof content.v !== 'object' || !content.v || !('value' in content.v)) throw new Error('Expected plain organization');
      value = ProjectAccountOrganizationV1Schema.parse(content.v.value);
      revision += 1;
      return { status: 200, data: { status: 'updated', rows: [{ key, revision, content }], cursor: revision } };
    });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'unused-session', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl });
    const scope = await deps.memoryLibrary!.readScopeContext!({ scope: 'project', projectRef: { serverId, projectKey: 'project' } }, { surface: 'cli' });
    expect(scope).toMatchObject({ safety: 'safe', entries: [{ id: neighbor.id }] });
    expect(projectReads).toEqual([{ kinds: ['workspace-ref'], serverId }, { key }]);
    await expect(scope.attachMemory({ kind: 'doc', artifactId: 'created', serverId })).resolves.toBe(true);
    expect(value).toMatchObject({ hidden: true, pinned: true, promptStack: [{ id: neighbor.id }, { id: 'project.memory' }] });
    await expect(scope.attachMemory({ kind: 'doc', artifactId: 'created', serverId })).resolves.toBe(false);
    expect(writes).toHaveLength(1);
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('classifies shared Project scope as dangerous and refuses view-only Sources before creation', async () => {
    const serverId = 'shared-scope-home';
    const serverHttpBaseUrl = 'https://shared-scope-home.test';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'scope-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const workspaceKey = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
    const entry = { id: 'instructions', ref: { kind: 'doc' as const, artifactId: 'instructions' }, enabled: true, placement: 'system_append' as const };
    let canManage = true;
    const source = { id: 'shared-source', revision: 3, name: 'Shared project', createdByAccountId: 'scope-account', audience: [],
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' }, protocol: 'https' },
      attachments: [{ purpose: 'context', entry }] };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const projectReads: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toMatch(new RegExp(`${serverHttpBaseUrl}/v1/account/project-rows/(list|read)$`));
      projectReads.push(body);
      return projectAccountRowsReadHttpResponse([
        { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: { id: 'checkout', serverId,
          projectKey: 'project', machineId: 'machine', rootPath: '/repo', createdAtMs: 1, source: { sourceId: source.id, revision: 3 } } } } },
        ...Array.from({ length: 1024 }, (_, index) => {
          const key = { kind: 'project-organization', serverId, projectKey: `unrelated-${index}` };
          return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
        }),
      ], String(url), body);
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe(`${serverHttpBaseUrl}/v1/projects/sources/${source.id}?serverId=${serverId}`);
      return { status: 200, data: { ok: true, source, canManage } };
    });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'unused-session', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl });
    const target = { scope: 'project' as const, projectRef: { serverId, projectKey: 'project' } };
    await expect(deps.memoryLibrary!.readScopeContext!(target, { surface: 'cli' })).resolves.toMatchObject({
      safety: 'danger', entries: [{ id: entry.id, ref: { serverId } }],
    });
    expect(projectReads).toEqual([{ kinds: ['workspace-ref'], serverId }]);
    canManage = false;
    await expect(deps.memoryLibrary!.readScopeContext!(target, { surface: 'cli' })).rejects.toMatchObject({ code: 'project_context_access_denied' });
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('serves Project memory without reading an unavailable Account coding catalog', async () => {
    const serverId = 'srv_project_memory_home';
    const serverProfileId = 'project-memory-profile';
    const serverHttpBaseUrl = 'https://project-memory-home.test';
    const credentials = { token: 'project-memory-token', encryption: null,
      requesterSessionCredentialScope: { serverId: serverProfileId, serverHttpBaseUrl } };
    const entry = { id: 'project.memory', ref: { kind: 'doc' as const, artifactId: 'memory' }, enabled: true,
      placement: 'system_append' as const };
    const entries = ['instructions-1', 'instructions-2'].map(id => ({ ...entry, id, ref: { kind: 'doc' as const, artifactId: id } }));
    entries.push(entry);
    const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
    const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
    const reads: string[] = [];
    const headerReads: string[] = [];
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      reads.push(String(url));
      if (new URL(String(url)).pathname.startsWith('/v1/artifacts')) throw new Error('Unexpected Artifact GET');
      return String(url).endsWith('/prompt-library') ? { status: 403, data: { error: 'forbidden' } }
        : { status: 200, data: String(url).endsWith('/encryption/currentness') ? { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } : { mode: 'plain', updatedAt: 0 } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname === '/v1/artifacts/read') {
        const input = ArtifactReadHeadersBatchInputV1Schema.parse(body);
        headerReads.push(...input.artifactIds);
        return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: input.artifactIds.map(artifactId => {
          const value = entries.find(entry => entry.ref.artifactId === artifactId);
          if (!value) throw new Error('Unexpected selected Artifact');
          return { artifactId, ok: true, artifact: { id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            header: encodePlainArtifactStoredContent({ v: 1, kind: value.id === 'project.memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: value.id }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        }) }) };
      }
      return projectAccountRowsReadHttpResponse([
      { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: { id: 'checkout', serverId,
        machineId: 'actual-machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
      { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: entries } } } },
      ], String(url), body);
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null,
      serverId: serverProfileId, serverIdentityId: serverId, serverHttpBaseUrl });
    const inherited = await deps.memoryLibrary!.readInheritedContext!({ revision: 1, machineId: 'actual-machine',
      metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } }, { surface: 'cli' });
    expect(inherited.projectEntries).toEqual(entries.map(value => ({ ...value, ref: { ...value.ref, serverId } })));
    await expect(deps.memoryLibrary!.readArtifactHeaders!(inherited.projectEntries.map(value => ({ ...value.ref, kind: 'doc' as const })),
      { surface: 'cli' })).resolves.toMatchObject([{ kind: 'prompt_doc.v2' }, { kind: 'prompt_doc.v2' }, { kind: 'memory_doc.v1' }]);
    expect(reads.some(url => url.includes('/prompt-library'))).toBe(false);
    expect(headerReads).toEqual(entries.map(entry => entry.ref.artifactId));
    expect(reads.filter(url => new URL(url).pathname === '/v1/artifacts')).toHaveLength(0);
    expect(reads.some(url => new URL(url).pathname.startsWith('/v1/artifacts/'))).toBe(false);
  });

  it('reads exact memory target headers without loading instruction bodies', async () => {
    const serverId = 'header-home';
    const serverHttpBaseUrl = 'https://header-home.test';
    const credentials = { token: 'header-token', encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const refs = ['instruction-1', 'instruction-2', 'memory'].map(artifactId => ({ kind: 'doc' as const, artifactId, serverId }));
    const reads: string[] = [];
    const headerReads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected body read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts/read');
      const input = ArtifactReadHeadersBatchInputV1Schema.parse(body);
      headerReads.push(...input.artifactIds);
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: input.artifactIds.map(artifactId => {
        expect(refs.some(ref => ref.artifactId === artifactId)).toBe(true);
        return { artifactId, ok: true, artifact: { id: artifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
        encryptionMode: 'plain', header: encodePlainArtifactStoredContent({ v: 1,
          kind: artifactId === 'memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: artifactId }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        } };
      }) }) };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl });
    await expect(deps.memoryLibrary!.readArtifactHeaders!(refs, { surface: 'cli' })).resolves.toMatchObject([
      { kind: 'prompt_doc.v2' }, { kind: 'prompt_doc.v2' }, { kind: 'memory_doc.v1' },
    ]);
    expect(headerReads).toEqual(refs.map(ref => ref.artifactId));
    expect(reads.filter(path => path === '/v1/artifacts')).toHaveLength(0);
    expect(reads.some(path => path.startsWith('/v1/artifacts/'))).toBe(false);
  });

  it.each([
    { label: 'a different authoritative Machine', machineId: 'actual-machine' },
    { label: 'no authoritative Machine', machineId: undefined },
  ])('refuses stale raw Project locality on layout-1 Sessions with $label', async ({ machineId }) => {
    const serverId = 'stale-session-home';
    const serverHttpBaseUrl = 'https://stale-session-home.test';
    const sessionId = 'cmemorysession000000000001';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'stale-session-owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const workspaceKey = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
    const organizationKey = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    const staleMemory = { id: 'project.memory', enabled: true, placement: 'system_append' as const,
      ref: { kind: 'doc' as const, artifactId: 'stale-machine-memory' } };
    fetchSessionById.mockResolvedValue(V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
      // No accepted checkout id: only authoritative locality may select this Project.
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { projectId: 'project',
        path: '/agent', ...(machineId ? { machineId } : {}), sessionWorkspaceLocationV1: {
          v: 1, machineId: 'stale-machine', agentPath: '/agent', machinePath: '/stale-repo',
        } }, work: { memoryEnabled: true } }),
      metadataVersion: 3, dataEncryptionKey: null, machineId: 'stale-machine', share: null,
      agentState: null, agentStateVersion: 1 }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected read: ${String(url)}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toMatch(new RegExp(`${serverHttpBaseUrl}/v1/account/project-rows/(list|read)$`));
      return projectAccountRowsReadHttpResponse([
        { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
          id: 'checkout', serverId, machineId: 'stale-machine', rootPath: '/stale-repo', projectKey: 'project', createdAtMs: 1,
        } } } },
        { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [staleMemory] } } } },
      ], String(url), body);
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl });
    const snapshot = await deps.memoryLibrary!.readSession!({ serverId, sessionId }, { surface: 'cli' });
    expect(snapshot.metadata.machineId).toBe(machineId);
    await expect(deps.memoryLibrary!.readInheritedContext!(snapshot, { surface: 'cli' })).rejects.toMatchObject({
      code: 'preparation_pending', reason: 'project_association_unavailable',
    });
  });

  it.each(['global', 'project'] as const)('pins %s document negotiation, search, and transcript hydration to the same exact Home', async (type) => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const status = {
      v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
      deepIndexReady: true, activeIndexReady: true, embeddingsEnabled: false,
      embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
      embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
      tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
      documentSearchSupported: true,
      projectSearchSupported: true,
    };
    const result = {
      v: 1, ok: true, documents: { state: 'ready' },
      ...(type === 'project' ? { project: { state: 'ready' } } : {}),
      hits: [{ sessionId: 'session-a', seqFrom: 1, seqTo: 2, createdAtFromMs: 1,
        createdAtToMs: 2, summary: 'Retained transcript', score: 0.5 }],
    };
    fetchSessionById.mockResolvedValue({ id: 'session-a', seq: 2 });
    for (const rpc of [callMachineRpc, callExactMachineRpc]) {
      rpc.mockImplementation(async ({ method }: { method: string }) =>
        method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status : result,
      );
    }
    const controller = new AbortController();
    const deps = createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'plugin-global', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
    });
    await expect(deps.daemonMemorySearch({
      machineId: 'machine-a', serverId: 'home-a', signal: controller.signal,
      query: { v: 1, query: 'fact', scope: type === 'project'
        ? { type, projectRef: { serverId: 'home-a', projectKey: 'payments' } } : { type },
        mode: 'auto', corpora: ['sessions', 'documents'] },
    })).resolves.toEqual(result);
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(callExactMachineRpc.mock.calls.map(([request]) => ({
      serverUrl: request.serverUrl, machineId: request.machineId,
      method: request.method, credentials: request.credentials, signal: request.signal, timeoutMs: request.timeoutMs,
    }))).toEqual([
      { serverUrl: 'https://home-a.test', machineId: 'machine-a', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        credentials, signal: controller.signal, timeoutMs: null },
      { serverUrl: 'https://home-a.test', machineId: 'machine-a', method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        credentials, signal: controller.signal, timeoutMs: null },
    ]);
    expect(fetchSessionById).toHaveBeenCalledWith({
      reason: 'session-action',
      token: credentials.token, sessionId: 'session-a', serverUrl: 'https://home-a.test', signal: controller.signal,
    });
    await expect(deps.daemonMemorySearch({
      machineId: 'machine-a', serverId: 'different-home',
      query: { v: 1, query: 'fact', scope: { type: 'global' }, mode: 'auto', corpora: ['documents'] },
    })).resolves.toMatchObject({ v: 1, ok: false, errorCode: 'memory_invalid_query' });
    expect(callExactMachineRpc).toHaveBeenCalledTimes(2);
  });

  it('suppresses retained hits that the current Account can no longer read through Action execution', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const hit = (sessionId: string) => ({
      sessionId,
      seqFrom: 1,
      seqTo: 2,
      createdAtFromMs: 10,
      createdAtToMs: 20,
      summary: `retained ${sessionId}`,
      score: 0.8,
    });
    callMachineRpc.mockResolvedValue({
      v: 1,
      ok: true,
      hits: [hit('still-readable'), hit('revoked')],
    });
    fetchSessionById.mockImplementation(async ({ sessionId }: { sessionId: string }) => (
      sessionId === 'still-readable' ? { id: sessionId, seq: 2 } : null
    ));

    const executor = createActionExecutor(createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    }));
    const result = await executor.execute('memory.search', {
      machineId: 'machine-1',
      query: { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent' });

    expect(result).toEqual({
      ok: true,
      result: { v: 1, ok: true, hits: [hit('still-readable')] },
    });
    expect(fetchSessionById).toHaveBeenCalledTimes(2);
  });

  it('suppresses retained ranges above the current caller-visible Session sequence ceiling', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const hit = (seqFrom: number, seqTo: number) => ({
      sessionId: 'shared-session',
      seqFrom,
      seqTo,
      createdAtFromMs: seqFrom,
      createdAtToMs: seqTo,
      summary: `retained ${seqFrom}-${seqTo}`,
      score: 0.8,
    });
    callMachineRpc.mockResolvedValue({
      v: 1,
      ok: true,
      hits: [hit(1, 4), hit(5, 6)],
    });
    fetchSessionById.mockResolvedValue({ id: 'shared-session', seq: 4 });

    const executor = createActionExecutor(createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    }));
    const result = await executor.execute('memory.search', {
      machineId: 'machine-1',
      query: { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent' });

    expect(result).toEqual({
      ok: true,
      result: { v: 1, ok: true, hits: [hit(1, 4)] },
    });
  });

  it('rejects a memory window for a revoked Session before daemon RPC', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    fetchSessionById.mockResolvedValue(null);
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.daemonMemoryGetWindow({
      machineId: 'machine-1',
      sessionId: 'revoked-session',
      seqFrom: 1,
      seqTo: 2,
      serverId: null,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects a memory window crossing the caller-visible Session ceiling before daemon RPC', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    fetchSessionById.mockResolvedValue({ id: 'shared-session', seq: 5 });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.daemonMemoryGetWindow({
      machineId: 'machine-1',
      sessionId: 'shared-session',
      seqFrom: 4,
      seqTo: 6,
      serverId: null,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('routes the three canonical memory actions through the authenticated machine RPC owner', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const searchResult = { v: 1 as const, ok: true as const, hits: [] };
    const windowResult = { v: 1 as const, snippets: [], citations: [] };
    const ensureResult = { ok: true as const };
    callMachineRpc
      .mockResolvedValueOnce(searchResult)
      .mockResolvedValueOnce(windowResult)
      .mockResolvedValueOnce(ensureResult)
      .mockResolvedValueOnce(ensureResult);
    fetchSessionById.mockResolvedValue({ id: 'session-1', seq: 18 });

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });
    const query = {
      v: 1 as const,
      query: 'canonical owner',
      scope: { type: 'global' as const },
      mode: 'hints' as const,
    };

    await expect(deps.daemonMemorySearch({
      machineId: 'machine-1',
      query,
      serverId: null,
    })).resolves.toEqual(searchResult);
    await expect(deps.daemonMemoryGetWindow({
      machineId: 'machine-1',
      sessionId: 'session-1',
      seqFrom: 12,
      seqTo: 18,
      serverId: null,
    })).resolves.toEqual(windowResult);
    await expect(deps.daemonMemoryEnsureUpToDate({
      machineId: 'machine-1',
      sessionId: 'session-1',
      serverId: null,
    })).resolves.toEqual(ensureResult);
    await expect(deps.daemonMemoryEnsureUpToDate({
      machineId: 'machine-1',
      serverId: null,
    })).resolves.toEqual(ensureResult);

    expect(callMachineRpc.mock.calls).toEqual([
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        request: query,
        timeoutMs: null,
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId: 'session-1', seqFrom: 12, seqTo: 18 },
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: { sessionId: 'session-1' },
        timeoutMs: null,
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: {},
        timeoutMs: null,
      }],
    ]);
  });
});
