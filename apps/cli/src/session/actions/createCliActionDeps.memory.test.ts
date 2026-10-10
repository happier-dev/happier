import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountOrganizationV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

const { callMachineRpc, callExactMachineRpc, fetchSessionById } = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  callExactMachineRpc: vi.fn(),
  fetchSessionById: vi.fn(),
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
  callExactMachineRpc,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
}));

import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { MemorySettingsV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

describe('createCliActionDeps memory bindings', () => {
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
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts/created') return { status: 200, data: {
        id: 'created', ownerAccountId: 'scope-account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, index: [], topics: [] }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
      throw new Error(`Unexpected read ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url).startsWith(serverHttpBaseUrl)).toBe(true);
      if (String(url).endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key, revision, content: { t: 'plain', v: { key, value } } },
      ] } };
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
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/account/project-rows/list`);
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: { id: 'checkout', serverId,
          projectKey: 'project', machineId: 'machine', rootPath: '/repo', createdAtMs: 1, source: { sourceId: source.id, revision: 3 } } } } },
      ] } };
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
    canManage = false;
    await expect(deps.memoryLibrary!.readScopeContext!(target, { surface: 'cli' })).rejects.toMatchObject({ code: 'project_context_access_denied' });
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('serves Project memory without reading an unavailable Account coding catalog', async () => {
    const serverId = 'project-memory-home';
    const serverHttpBaseUrl = 'https://project-memory-home.test';
    const credentials = { token: 'project-memory-token', encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const entry = { id: 'project.memory', ref: { kind: 'doc' as const, artifactId: 'memory' }, enabled: true,
      placement: 'system_append' as const };
    const entries = ['instructions-1', 'instructions-2'].map(id => ({ ...entry, id, ref: { kind: 'doc' as const, artifactId: id } }));
    entries.push(entry);
    const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
    const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
    const reads: string[] = [];
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      reads.push(String(url));
      if (new URL(String(url)).pathname === '/v1/artifacts') return { status: 200, data: entries.map(value => ({
        id: value.ref.artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: value.id === 'project.memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: value.id }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      })) };
      return String(url).endsWith('/prompt-library') ? { status: 403, data: { error: 'forbidden' } }
        : { status: 200, data: String(url).endsWith('/encryption/currentness') ? { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } : { mode: 'plain', updatedAt: 0 } };
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: { id: 'checkout', serverId,
        machineId: 'actual-machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
      { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: entries } } } },
    ] } });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl });
    const inherited = await deps.memoryLibrary!.readInheritedContext!({ revision: 1, machineId: 'actual-machine',
      metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } }, { surface: 'cli' });
    expect(inherited.projectEntries).toEqual(entries.map(value => ({ ...value, ref: { ...value.ref, serverId } })));
    await expect(deps.memoryLibrary!.readArtifactHeaders!(inherited.projectEntries.map(value => ({ ...value.ref, kind: 'doc' as const })),
      { surface: 'cli' })).resolves.toMatchObject([{ kind: 'prompt_doc.v2' }, { kind: 'prompt_doc.v2' }, { kind: 'memory_doc.v1' }]);
    expect(reads.some(url => url.includes('/prompt-library'))).toBe(false);
    expect(reads.filter(url => new URL(url).pathname === '/v1/artifacts')).toHaveLength(1);
    expect(reads.some(url => new URL(url).pathname.startsWith('/v1/artifacts/'))).toBe(false);
  });

  it('batches memory target header reads without loading instruction bodies', async () => {
    const serverId = 'header-home';
    const serverHttpBaseUrl = 'https://header-home.test';
    const credentials = { token: 'header-token', encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const refs = ['instruction-1', 'instruction-2', 'memory'].map(artifactId => ({ kind: 'doc' as const, artifactId, serverId }));
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path !== '/v1/artifacts') throw new Error(`Unexpected body read: ${path}`);
      return { status: 200, data: refs.map(ref => ({ id: ref.artifactId, ownerAccountId: 'owner', access: 'owner',
        encryptionMode: 'plain', header: encodePlainArtifactStoredContent({ v: 1,
          kind: ref.artifactId === 'memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: ref.artifactId }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      })) };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl });
    await expect(deps.memoryLibrary!.readArtifactHeaders!(refs, { surface: 'cli' })).resolves.toMatchObject([
      { kind: 'prompt_doc.v2' }, { kind: 'prompt_doc.v2' }, { kind: 'memory_doc.v1' },
    ]);
    expect(reads.filter(path => path === '/v1/artifacts')).toHaveLength(1);
    expect(reads.some(path => path.startsWith('/v1/artifacts/'))).toBe(false);
  });

  it.each([
    { label: 'a different authoritative Machine', machineId: 'actual-machine' },
    { label: 'no authoritative Machine', machineId: undefined },
  ])('refuses stale raw Project locality on layout-1 Sessions with $label', async ({ machineId }) => {
    const serverId = 'stale-session-home';
    const serverHttpBaseUrl = 'https://stale-session-home.test';
    const sessionId = 'cmemorysession000000000001';
    const credentials = { token: 'stale-session-token', encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl } };
    const workspaceKey = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
    const organizationKey = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    const staleMemory = { id: 'project.memory', enabled: true, placement: 'system_append' as const,
      ref: { kind: 'doc' as const, artifactId: 'stale-machine-memory' } };
    fetchSessionById.mockResolvedValue(V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { workspaceId: 'checkout', projectId: 'project',
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
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/account/project-rows/list`);
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
          id: 'checkout', serverId, machineId: 'stale-machine', rootPath: '/stale-repo', projectKey: 'project', createdAtMs: 1,
        } } } },
        { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [staleMemory] } } } },
      ] } };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl });
    const snapshot = await deps.memoryLibrary!.readSession!({ serverId, sessionId }, { surface: 'cli' });
    expect(snapshot.metadata.machineId).toBe(machineId);
    await expect(deps.memoryLibrary!.readInheritedContext!(snapshot, { surface: 'cli' })).rejects.toMatchObject({
      code: 'preparation_pending', reason: 'project_association_unavailable',
    });
  });

  it('pins document negotiation, search, and transcript hydration to the same exact Home', async () => {
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
    };
    const result = {
      v: 1, ok: true, documents: { state: 'ready' },
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
      query: { v: 1, query: 'fact', scope: { type: 'global' }, mode: 'auto', corpora: ['sessions', 'documents'] },
    })).resolves.toEqual(result);
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(callExactMachineRpc.mock.calls.map(([request]) => ({
      serverUrl: request.serverUrl, machineId: request.machineId,
      method: request.method, credentials: request.credentials, signal: request.signal,
    }))).toEqual([
      { serverUrl: 'https://home-a.test', machineId: 'machine-a', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        credentials, signal: controller.signal },
      { serverUrl: 'https://home-a.test', machineId: 'machine-a', method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        credentials, signal: controller.signal },
    ]);
    expect(fetchSessionById).toHaveBeenCalledWith({
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
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: {},
      }],
    ]);
  });
});
