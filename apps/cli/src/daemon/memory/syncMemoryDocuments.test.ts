import axios from 'axios';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, onTestFailed, vi } from 'vitest';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { MemoryDocumentSearchScope } from './syncMemoryDocuments';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createCompactSessionListRowFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';

type LegacySessionProjection = Readonly<Pick<RawSessionRecord, 'metadata' | 'share'>
  & Partial<Pick<RawSessionRecord, 'projectKey' | 'ownerAccountId' | 'encryptionMode'>>>;

// Transform the API graph during collection; per-test resets reload it below.
await import('@/api/api');
await import('./syncMemoryDocuments');

const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
let homeDir: string;
let admissionPhase = 'not_started';

beforeEach(async () => {
  homeDir = await createTempDir('happier-document-admission-');
  applyEnvValues({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
  vi.resetModules();
  // Environment isolation invalidates collection's module instances. Reload the
  // real owners during fixture setup, before the admission workload starts.
  admissionPhase = 'fixture_module_setup';
  await import('@/api/api');
  await import('./syncMemoryDocuments');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('@/session/transport/http/sessionsHttp');
  restoreEnvValues(envBackup);
  vi.resetModules();
  await removeTempDir(homeDir);
});

async function withCurrentDocumentFixture(run: (fixture: Readonly<{
  scope: MemoryDocumentSearchScope;
  db: DeepIndexDbHandle;
  dbPath: string;
  prepare: (options?: Readonly<{ includeArchivedSessions?: boolean; signal?: AbortSignal; scope?: import('@happier-dev/protocol/memory/memorySearch').MemorySearchScope }>) => Promise<MemoryDocumentSearchScope>;
  serverId: string;
  artifactId: string;
  replaceAccount: () => void;
  credentials: import('@/persistence').StoredCredentials;
  setSessionWork: (work: Record<string, unknown>, index?: number) => void;
  setArtifactState: (state: 'available' | 'unavailable' | 'missing') => void;
  setCurrentnessStatus: (status: number) => void;
  setSessionDetailUnavailable: (unavailable: boolean) => void;
  setInventoryState: (state: 'paged' | 'incomplete' | 'unreadable' | 'archived') => void;
  setSessionCount: (count: number) => void;
  setSessionProject: (index: number, projectKey: string) => void;
  setSessionSharedContentUnavailable: (unavailable: boolean) => void;
  setLegacySessionProjection: (projection: LegacySessionProjection) => void;
}>) => Promise<void>, machineId = 'session-machine', memory = false, qualifiedHome = false): Promise<void> {
  admissionPhase = 'fixture_schemas';
  const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
  const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
  const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { withdrawActiveProjectAccountRowsSnapshot } = await import('@/workspaces/projectAccountRows');
  const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
  const { buildSessionMetadataEnvelopeFields } = await import('@/session/metadata/buildSessionMetadataEnvelopeCreateFields');
  const { sealSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
  const { configuration } = await import('@/configuration');
  const { logger } = await import('@/ui/logger');
  const diagnostics = vi.spyOn(logger, 'infoFile');
  admissionPhase = 'fixture_http';
  let serverId = configuration.activeServerId;
  if (qualifiedHome) {
    const { addServerProfile, setActiveServerProfileHomeConnectionDescriptor, getServerProfile, resolveServerProfileHomeIdentityId } = await import('@/server/serverProfiles');
    const profile = await addServerProfile({ name: 'project-search', serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test', use: true });
    applyEnvValues({ HAPPIER_ACTIVE_SERVER_ID: profile.id });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const bound = await setActiveServerProfileHomeConnectionDescriptor({ v: 1, homeServerIdentityId: 'srv_project_search',
      canonicalServerUrl: 'https://api.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://api.example.test' }] });
    serverId = 'srv_project_search';
    expect(bound.id).toBe(profile.id);
    expect(await getServerProfile(profile.id)).toMatchObject({ homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: { homeServerIdentityId: serverId } });
    expect((await import('@/configuration')).configuration.activeServerId).toBe(profile.id);
    expect(await resolveServerProfileHomeIdentityId(profile.id)).toBe(serverId);
  }
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
  const entry = { id: 'project.instructions', ref: { kind: 'doc' as const, artifactId: 'project-context' }, enabled: true, placement: 'system_append' as const,
    ...(memory ? { maxChars: '- Key preference [id: key; added: 1970-01-01]'.length } : {}) };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const artifact = { id: entry.ref.artifactId, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    header: encodePlainArtifactStoredContent({ v: 1, kind: memory ? 'memory_doc.v1' : 'prompt_doc.v2', title: 'Remote Project' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(memory ? { v: 1, index: [
      { id: 'key', text: 'Key preference', createdAtMs: 0, sourceSessionRef: null },
      { id: 'budget', text: 'Another active preference', createdAtMs: 0, sourceSessionRef: null },
      { id: 'expired', text: 'Expired preference', createdAtMs: 0, expiresAtMs: 1, sourceSessionRef: null },
    ], topics: [
      { title: 'detail', summary: 'Topic summary', facts: [{ id: 'detail', text: 'Topic-only fact', createdAtMs: 0, sourceSessionRef: null }] },
      { title: 'archive', summary: 'Archived facts', facts: [{ id: 'old', text: 'Archived fact', createdAtMs: 0, sourceSessionRef: null }] },
    ] } : { v: 1, markdown: 'quartz remote project context', createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
  let artifactState: 'available' | 'unavailable' | 'missing' = 'available';
  let currentnessStatus = 200;
  let sessionDetailUnavailable = false;
  let inventoryState: 'paged' | 'incomplete' | 'unreadable' | 'archived' | undefined;
  let sessionCount = 1;
  const sessionProjects = new Map<number, string>();
  let sessionSharedContentUnavailable = false;
  let legacySessionProjection: LegacySessionProjection | undefined;
  let sessionWork: Record<string, unknown> | undefined = memory ? { memoryEnabled: true } : undefined;
  const httpPaths: string[] = [];
  const sessionWorks = new Map<number, Record<string, unknown>>();
  const sessionArtifact = (index: number) => ({ ...artifact, id: `session-context-${index}`,
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: `Session context ${index}` }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1,
      markdown: `quartz session-context-${index}`, createdAtMs: 1, updatedAtMs: 1 }) }) });
  const projectArtifact = (projectKey: string) => projectKey === 'project' ? artifact : { ...artifact,
    id: `${projectKey}-context`, header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: projectKey }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1,
      markdown: `quartz ${projectKey} context`, createdAtMs: 1, updatedAtMs: 1 }) }) };
  const sessionRecord = (index = 0) => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      ...(sessionSharedContentUnavailable
        ? { storedContentMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' } as const
        : { storedContentMode: 'plain' } as const),
      agentState: null, metadata: { ...createTestMetadata({ machineId: 'session-machine', path: '/container/checkout',
      sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } }),
      workspaceId: sessionProjects.has(index) ? `checkout-${sessionProjects.get(index)}` : 'checkout',
      projectId: sessionProjects.get(index) ?? 'project',
      ...((sessionWorks.get(index) ?? sessionWork) ? { work: sessionWorks.get(index) ?? sessionWork } : {}) } });
    const record = { id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
      encryptionMode: sessionSharedContentUnavailable ? 'e2ee' as const : 'plain' as const,
      metadataVersion: 1, dataEncryptionKey: null, share: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: inventoryState === 'unreadable' ? sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
        ownerMetadata: fields.ownerMetadataValue, randomBytes: length => new Uint8Array(length).fill(3),
      }) : fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 0 };
    if (!legacySessionProjection) return record;
    const { ownerMetadata: _ownerMetadata, metadataLayoutVersion: _metadataLayoutVersion, ...legacyRecord } = record;
    return { ...legacyRecord, ...legacySessionProjection };
  };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    httpPaths.push(`GET ${path}`);
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') {
      if (inventoryState === 'archived' && path === '/v2/sessions') {
        return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      }
      if (inventoryState === 'paged' && !new URL(String(url)).searchParams.has('cursor')) {
        return { status: 200, data: { sessions: [], nextCursor: 'next-page', hasNext: true } };
      }
      return { status: 200, data: { sessions: Array.from({ length: sessionCount }, (_, i) => createCompactSessionListRowFixture({ ...sessionRecord(i),
        id: i === 0 ? 'remote-session' : `remote-session-${i}`,
        ...(path.endsWith('/archived') ? { archivedAt: 1 } : {}),
        })), nextCursor: null, hasNext: false,
        ...(inventoryState === 'incomplete' ? { metadataUpgradeRequiredCount: 1 } : {}) } };
    }
    if (/^\/v2\/sessions\/remote-session(?:-\d+)?$/.test(path)) {
      if (sessionDetailUnavailable) throw Object.assign(new Error('Session detail transport unavailable'), { code: 'ECONNRESET' });
      return { status: 200, data: { session: { ...sessionRecord(), id: path.split('/').at(-1) } } };
    }
    if (path === '/v1/account/encryption/currentness') return { status: currentnessStatus, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
    if (path === '/v1/auth/ping') return { status: 200, data: { ok: true } };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 1,
      sessionAccessProbe: { v: 1, sessionId: 'remote-session', throughCursor: 1, status: 'available' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    if (path === '/v1/artifacts') return { status: 200, data: [artifact,
      ...[...new Set(sessionProjects.values())].filter(key => key !== 'project').map(projectArtifact),
      ...[...sessionWorks.keys()].map(sessionArtifact)] };
    if (/^\/v1\/artifacts\/session-context-\d+$/.test(path)) return { status: 200,
      data: sessionArtifact(Number(path.split('-').at(-1))) };
    if (path === `/v1/artifacts/${artifact.id}`) {
      if (artifactState === 'unavailable') throw new Error('Artifact Home unavailable');
      if (artifactState === 'missing') return { status: 404, data: { error: 'artifact_not_found' } };
      return { status: 200, data: artifact };
    }
    const additionalProject = [...sessionProjects.values()].find(key => path === `/v1/artifacts/${key}-context`);
    if (additionalProject) return { status: 200, data: projectArtifact(additionalProject) };
    throw new Error(`Unexpected document admission HTTP path: ${path}`);
  });
  // Account rows and Session HTTP are transport boundaries; Project association,
  // four-layer admission, document decoding and SQLite remain real.
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    httpPaths.push(`POST ${path}`);
    if (path === '/v2/sessions/read-batch') return { status: 200, data: createSessionReadBatchResponseFixture({
      request: body, sessions: Array.from({ length: sessionCount }, (_, i) => ({ ...sessionRecord(i),
        id: i === 0 ? 'remote-session' : `remote-session-${i}` })),
    }) };
    if (path === '/v1/artifacts/read') {
      const input = ArtifactReadHeadersBatchInputV1Schema.parse(body);
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: input.artifactIds.map(artifactId => {
        if (artifactId === artifact.id && artifactState === 'unavailable') throw new Error('Artifact Home unavailable');
        const stored = artifactId === artifact.id && artifactState === 'missing' ? undefined : [artifact,
          ...[...new Set(sessionProjects.values())].map(projectArtifact),
          ...[...sessionWorks.keys()].map(sessionArtifact)].find(row => row.id === artifactId);
        if (!stored) return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
        const { body: _body, ...header } = stored;
        return { artifactId, ok: true, artifact: header };
      }) }) };
    }
    return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
      id: 'checkout', serverId, machineId: 'session-machine', rootPath: '/remote/repo', createdAtMs: 1, projectKey: 'project',
    } } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry] } } } },
    ...[...new Set(sessionProjects.values())].flatMap(projectKey => {
      const key = { ...workspaceKey, id: `checkout-${projectKey}` };
      const organization = { ...organizationKey, projectKey };
      return [{ key, revision: 1, content: { t: 'plain', v: { key, value: {
        id: key.id, serverId, machineId: 'session-machine', rootPath: '/remote/repo', createdAtMs: 1, projectKey,
      } } } }, ...(projectKey === 'project' ? [] : [{ key: organization, revision: 1, content: { t: 'plain', v: {
        key: organization, value: { promptStack: [{ ...entry, ref: { ...entry.ref, artifactId: projectArtifact(projectKey).id } }] },
      } } }])];
    }),
  ] } };
  });
  admissionPhase = 'fixture_sqlite_and_admission_imports';
  const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
  const { syncMemoryDocuments } = await import('./syncMemoryDocuments');
  const { readCliProjectPromptStackContext } = await import('@/agent/prompting/coding/sessionProjectPromptStack');
  const dbPath = join(homeDir, 'deep.sqlite');
  const db = openDeepIndexDb({ dbPath });
  const prepare = (options?: Readonly<{ includeArchivedSessions?: boolean; signal?: AbortSignal; scope?: import('@happier-dev/protocol/memory/memorySearch').MemorySearchScope }>) => syncMemoryDocuments({ credentials, machineId,
    scope: options?.scope ?? (memory ? { type: 'session', sessionId: 'remote-session' } : { type: 'global' }),
    readProjectContext: (projectRef, signal) => readCliProjectPromptStackContext({ credentials, projectRef, signal }),
    includeArchivedSessions: options?.includeArchivedSessions ?? false, signal: options?.signal, db, assertCurrent: () => {} });
  try {
    admissionPhase = 'initial_document_admission';
    const scope = await prepare();
    expect(scope.state, JSON.stringify({ httpPaths, diagnostics: diagnostics.mock.calls.filter(([message]) =>
      !String(message).includes('Admission phase')) })).toBe('ready');
    admissionPhase = 'fixture_callback';
    await run({ scope, db, dbPath, prepare, serverId, artifactId: artifact.id, credentials,
      setArtifactState: state => { artifactState = state; },
      setCurrentnessStatus: status => { currentnessStatus = status; },
      setSessionDetailUnavailable: unavailable => { sessionDetailUnavailable = unavailable; },
      setInventoryState: state => { inventoryState = state; },
      setSessionCount: count => { sessionCount = count; },
      setSessionProject: (index, projectKey) => { sessionProjects.set(index, projectKey); },
      setSessionSharedContentUnavailable: unavailable => { sessionSharedContentUnavailable = unavailable; },
      setLegacySessionProjection: projection => { legacySessionProjection = projection; },
      setSessionWork: (work, index) => { if (index === undefined) sessionWork = work; else sessionWorks.set(index, work); }, replaceAccount: () => {
      const replacement = { token: `header.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        scopeKey: resolveAccountSettingsScopeKey(replacement), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    } });
  } finally {
    db.close();
    resetActiveAccountSettingsSnapshotForTests();
    withdrawActiveProjectAccountRowsSnapshot();
  }
}

it('searches direct Project memory with zero Sessions, excludes other Projects and fails closed after revocation', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, serverId, setSessionCount, setArtifactState }) => {
    setSessionCount(0);
    const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'project' } };
    const admitted = await prepare({ scope });
    expect(admitted).toMatchObject({ state: 'ready', eligibleSessionIds: [], eligibleDocuments: [{ ref: { serverId, artifactId: 'project-context' } }] });
    expect(db.searchDocuments({ query: 'preference', eligibleDocuments: admitted.eligibleDocuments, maxResults: 1 }))
      .toHaveLength(1);
    const other = await prepare({ scope: { type: 'project', projectRef: { serverId, projectKey: 'unrelated-project' } } });
    expect(other).toMatchObject({ state: 'unavailable', eligibleDocuments: [] });
    setArtifactState('missing');
    expect(await prepare({ scope })).toMatchObject({ state: 'unavailable', eligibleDocuments: [] });
  }, 'daemon-machine', true);
});

it('uses the exact saved Home binding for portable Project refs without accepting another Home', async () => {
  await withCurrentDocumentFixture(async ({ prepare, serverId, setSessionCount }) => {
    setSessionCount(0);
    expect(await prepare({ scope: { type: 'project', projectRef: { serverId, projectKey: 'project' } } }))
      .toMatchObject({ state: 'ready', eligibleDocuments: [{ ref: { serverId, artifactId: 'project-context' } }] });
    expect(await prepare({ scope: { type: 'project', projectRef: { serverId: 'srv_unrelated_home', projectKey: 'project' } } }))
      .toMatchObject({ state: 'unavailable', eligibleDocuments: [] });
  }, 'daemon-machine', true, true);
});

it('moves an expired Memory fact to archive in search without changing its Artifact revision', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  await withCurrentDocumentFixture(async ({ prepare, dbPath, serverId, artifactId }) => {
    const { searchTier2Memory } = await import('./searchMemory');
    const search = () => searchTier2Memory({ dbPath, previewChars: 64,
      query: { v: 1, query: 'Expired', scope: { type: 'session', sessionId: 'remote-session' },
        mode: 'deep', corpora: ['documents'], maxResults: 10 },
      resolveDocuments: scope => prepare({ scope }),
    });
    const identity = { ref: { kind: 'doc', serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 }, factId: 'expired' };
    expect(await search()).toMatchObject({ ok: true, hits: [{ ...identity, location: 'facts' }] });
    now.mockReturnValue(2);
    expect(await search()).toMatchObject({ ok: true, hits: [{ ...identity, location: 'archive' }] });
  }, 'daemon-machine', true);
});

it('admits only matching Project Sessions and reports unreadable Project membership explicitly', async () => {
  await withCurrentDocumentFixture(async ({ prepare, serverId, setInventoryState }) => {
    const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'project' } };
    expect(await prepare({ scope })).toMatchObject({ state: 'ready', eligibleSessionIds: ['remote-session'] });
    setInventoryState('unreadable');
    expect(await prepare({ scope })).toMatchObject({ state: 'partial', eligibleSessionIds: [],
      eligibleDocuments: [{ ref: { serverId, artifactId: 'project-context' } }] });
  }, 'daemon-machine');
});

it('keeps private Project tuple inference owner-only while honoring published recipient Project keys without metadata', async () => {
  await withCurrentDocumentFixture(async ({ prepare, serverId, setLegacySessionProjection }) => {
    const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'project' } };
    const metadata = JSON.stringify({ machineId: 'session-machine', path: '/container/checkout',
      sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } });
    // Actual predecessor 413054f V2 owner/direct markers; no ownerAccountId was published.
    setLegacySessionProjection({ metadata, share: null });
    expect(await prepare({ scope })).toMatchObject({ state: 'ready', eligibleSessionIds: ['remote-session'] });
    setLegacySessionProjection({ metadata, share: { accessLevel: 'view', canApprovePermissions: false } });
    expect(await prepare({ scope })).toMatchObject({ state: 'partial', eligibleSessionIds: [] });
    setLegacySessionProjection({ metadata, share: null, ownerAccountId: 'another-account' });
    expect(await prepare({ scope })).toMatchObject({ state: 'partial', eligibleSessionIds: [] });
    // A plain Account cannot open this historical encrypted recipient's metadata.
    // The Home's accepted Project key still proves membership without a private tuple.
    setLegacySessionProjection({ metadata: 'unavailable-ciphertext', encryptionMode: 'e2ee',
      share: { accessLevel: 'view', canApprovePermissions: false }, projectKey: 'project' });
    expect(await prepare({ scope })).toMatchObject({ state: 'ready', eligibleSessionIds: ['remote-session'] });
    setLegacySessionProjection({ metadata: 'unavailable-ciphertext', encryptionMode: 'e2ee',
      share: { accessLevel: 'view', canApprovePermissions: false }, projectKey: 'another-project' });
    expect(await prepare({ scope })).toMatchObject({ state: 'ready', eligibleSessionIds: [] });
  }, 'daemon-machine', true);
});

it('withholds private Project inference from recipient global and Session preparations without dropping shared attachments', async () => {
  await withCurrentDocumentFixture(async ({ scope: ownerScope, prepare, db, setSessionWork, setLegacySessionProjection }) => {
    expect(ownerScope.eligibleDocuments.map(document => document.ref.artifactId)).toContain('project-context');
    const projectReads = () => vi.mocked(axios.post).mock.calls.filter(([url]) =>
      new URL(String(url)).pathname === '/v1/account/project-rows/list').length;
    const work = { memoryEnabled: true, promptStack: [{ id: 'session.context', enabled: true,
      placement: 'system_append', ref: { kind: 'doc', artifactId: 'session-context-0' } }] };
    setSessionWork(work, 0);
    setLegacySessionProjection({ share: { accessLevel: 'view', canApprovePermissions: false },
      metadata: JSON.stringify({ machineId: 'session-machine', path: '/container/checkout', work,
        sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } }) });
    for (const scope of [{ type: 'session', sessionId: 'remote-session' }, { type: 'global' }] as const) {
      const beforeProjectReads = projectReads();
      const admitted = await prepare({ scope });
      expect(admitted).toMatchObject({ state: 'ready' });
      expect(admitted.eligibleDocuments.map(document => document.ref.artifactId)).toContain('session-context-0');
      expect(projectReads() - beforeProjectReads).toBe(0);
      expect(admitted.eligibleDocuments).toHaveLength(1);
      expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: admitted.eligibleDocuments, maxResults: 10 }))
        .toEqual([expect.objectContaining({ text: 'quartz session-context-0' })]);
    }
  }, 'daemon-machine', true);
});

it('applies current Project eligibility before deep and hints paging and rechecks revocation after embedding', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, dbPath, serverId, setSessionCount, setSessionProject, setArtifactState }) => {
    setSessionCount(3);
    setSessionProject(0, 'other-project');
    const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'project' } };
    const started = performance.now();
    const admitted = await prepare({ scope });
    const admissionMs = performance.now() - started;
    expect(admitted).toMatchObject({ state: 'ready', eligibleSessionIds: ['remote-session-1', 'remote-session-2'] });
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { searchTier1Memory, searchTier2Memory } = await import('./searchMemory');
    const summaryPath = join(homeDir, 'project-summary.sqlite');
    const summary = openSummaryShardIndexDb({ dbPath: summaryPath });
    try {
      for (const [sessionId, time, text] of [
        ['remote-session', 9, 'quartz project evidence'],
        ['remote-session-1', 1, 'quartz project evidence'],
        ['remote-session-2', 2, 'quartz project evidence'],
      ] as const) {
        db.insertChunk({ sessionId, seqFrom: 1, seqTo: 1, createdAtFromMs: time, createdAtToMs: time, text });
        summary.insertSummaryShard({ sessionId, seqFrom: 1, seqTo: 1, createdAtFromMs: time, createdAtToMs: time,
          summary: text, keywords: [], entities: [], decisions: [] });
      }
    } finally { summary.close(); }
    const query = { v: 1 as const, query: 'quartz', scope, mode: 'deep' as const, corpora: ['sessions' as const], maxResults: 1 };
    const queryStarted = performance.now();
    for (const mode of ['deep', 'hints'] as const) {
      let cursor: string | undefined;
      const found: string[] = [];
      do {
        const current = { ...query, mode, ...(cursor ? { cursor } : {}) };
        const result = mode === 'deep'
          ? await searchTier2Memory({ dbPath, query: current, previewChars: 64,
            resolveDocuments: scope => prepare({ scope }) })
          : searchTier1Memory({ dbPath: summaryPath, query: current, projectScope: await prepare({ scope }) });
        expect(result).toMatchObject({ ok: true, project: { state: 'ready' } });
        if (!result.ok) throw new Error(result.error);
        for (const hit of result.hits) { if (hit.type === undefined) found.push(hit.sessionId); }
        cursor = result.nextCursor;
      } while (cursor);
      expect(found).toEqual(['remote-session-2', 'remote-session-1']);
    }
    console.info('[C6-U3 scoped cost]', { inventorySessions: 3, admittedSessions: 2, admissionMs,
      deepAndHintsPagingMs: performance.now() - queryStarted });
    const projectDefaultQuery = { ...query, corpora: undefined };
    const mixed = await searchTier2Memory({ dbPath, query: projectDefaultQuery, previewChars: 64,
      resolveDocuments: scope => prepare({ scope }) });
    expect(mixed).toMatchObject({ ok: true, documents: { state: 'ready' }, hasMore: true });
    if (!mixed.ok || !mixed.nextCursor) throw new Error('Expected Project default corpus continuation');
    expect(await searchTier2Memory({ dbPath, query: { ...query, cursor: mixed.nextCursor }, previewChars: 64,
      resolveDocuments: scope => prepare({ scope }) })).toMatchObject({ ok: false, errorCode: 'memory_invalid_query' });
    const changedMembership = await searchTier2Memory({ dbPath, query, previewChars: 64,
      resolveDocuments: scope => prepare({ scope }),
      embeddings: { enabled: true, mode: 'custom', presetId: null, providerKind: 'local_transformers', modelId: 'test',
        providerConfig: null, blend: { ftsWeight: 0.1, embeddingWeight: 0.9 } },
      embedQuery: async () => { setSessionProject(2, 'other-project'); return new Float32Array([1]); },
    });
    expect(changedMembership).toMatchObject({ ok: true, project: { state: 'partial' } });
    expect(changedMembership.ok && changedMembership.hits.some(hit => hit.type === undefined && hit.sessionId === 'remote-session-2')).toBe(false);
    setSessionProject(2, 'project');
    const revoked = await searchTier2Memory({ dbPath, query, previewChars: 64,
      resolveDocuments: scope => prepare({ scope }),
      embeddings: { enabled: true, mode: 'custom', presetId: null, providerKind: 'local_transformers', modelId: 'test',
        providerConfig: null, blend: { ftsWeight: 0.1, embeddingWeight: 0.9 } },
      embedQuery: async () => { setArtifactState('missing'); return new Float32Array([1]); },
    });
    expect(revoked).toMatchObject({ ok: true, hits: [], project: { state: 'unavailable' } });
  }, 'daemon-machine');
});

it('qualifies global Project documents using the owning Session Machine and workspace mapping', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, serverId, artifactId }) => {
    expect(scope).toMatchObject({ state: 'ready', eligibleDocuments: [{ ref: { serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 } }] });
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toEqual([expect.objectContaining({ text: 'quartz remote project context', location: 'document' })]);
  }, 'daemon-machine');
});

it('admits global documents from compact paginated Sessions using batched documents without singleton reads', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, setSessionDetailUnavailable, setInventoryState }) => {
    setSessionDetailUnavailable(true);
    setInventoryState('paged');
    const scope = await prepare();
    expect(scope.state).toBe('ready');
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toHaveLength(1);
  }, 'daemon-machine');
});

it.each([false, true])('admits readable owner context independently of unavailable shared Session content (scoped=%s)', async memory => {
  await withCurrentDocumentFixture(async ({ prepare, db, setSessionSharedContentUnavailable, credentials }) => {
    setSessionSharedContentUnavailable(true);
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } = await import('@/session/transport/encryption/sessionEncryptionContext');
    const session = await fetchSessionById({ token: credentials.token, sessionId: 'remote-session' });
    expect(session).not.toBeNull();
    if (!session) throw new Error('Missing fixture Session');
    const input = { credentials, accountEncryptionMode: 'plain' as const, rawSession: session };
    expect(tryDecryptSessionOwnerMetadata(input)).not.toBeNull();
    expect(tryDecryptSessionOwnerMetadataView(input)).toBeNull();
    const scope = await prepare();
    expect(scope.state).toBe('ready');
    expect(db.searchDocuments({ query: memory ? 'Topic-only' : 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toHaveLength(1);
    if (memory && scope.state === 'ready') expect(scope.preparation?.[0]?.loadedFactIds).toEqual(['key']);
  }, 'daemon-machine', memory);
});

it.each(['incomplete', 'unreadable'] as const)('retains prior documents without publishing %s Session inventory as complete coverage', async state => {
  await withCurrentDocumentFixture(async ({ prepare, db, scope, setInventoryState }) => {
    const { logger } = await import('@/ui/logger');
    const diagnostic = vi.spyOn(logger, 'infoFile');
    setInventoryState(state);
    expect((await prepare()).state).not.toBe('ready');
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 })).toHaveLength(1);
    if (state === 'unreadable') expect(diagnostic).toHaveBeenCalledWith('[memoryDocuments] Admission failed',
      expect.objectContaining({ sessionId: 'remote-session', errorCode: 'session_owner_metadata_unavailable', cancelled: false }));
  });
});

it('reads shared prompt and Project inventories once per fresh global admission, preserving distinct Session documents', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, setSessionCount, setSessionWork, setSessionProject }) => {
    setSessionCount(4);
    setSessionProject(3, 'another-project');
    for (const index of [1, 2]) setSessionWork({ promptStack: [{ id: 'session.context', enabled: true,
      placement: 'system_append', ref: { kind: 'doc', artifactId: `session-context-${index}` } }] }, index);
    const requests = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
      new URL(String(url)).pathname === '/v1/account/entity-rows/prompt-library').length;
    const before = requests();
    const projectRequests = () => vi.mocked(axios.post).mock.calls.filter(([url]) =>
      new URL(String(url)).pathname === '/v1/account/project-rows/list').length;
    const beforeProjects = projectRequests();
    const documentBatches = () => vi.mocked(axios.post).mock.calls.filter(([url]) =>
      new URL(String(url)).pathname === '/v2/sessions/read-batch').length;
    const beforeBatches = documentBatches();
    const singletonReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
      /^\/v2\/sessions\/remote-session(?:-\d+)?$/.test(new URL(String(url)).pathname)).length;
    const beforeSingletons = singletonReads();
    const admitted = await prepare();
    expect(admitted.state).toBe('ready');
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: admitted.eligibleDocuments, maxResults: 10 })
      .map(hit => hit.text).sort()).toEqual(['quartz another-project context', 'quartz remote project context',
        'quartz session-context-1', 'quartz session-context-2']);
    // Every admission is fresh, while its Sessions share that admitted Account inventory.
    expect(requests() - before).toBe(1);
    expect(projectRequests() - beforeProjects).toBe(1);
    expect(documentBatches() - beforeBatches).toBe(1);
    expect(singletonReads() - beforeSingletons).toBe(0);
    const afterProjects = projectRequests();
    expect((await prepare({ includeArchivedSessions: true })).state).toBe('ready');
    expect(projectRequests() - afterProjects).toBe(1);
  });
});

it('admits archived Session records only when requested and retains the index on cancellation', async () => {
  await withCurrentDocumentFixture(async ({ prepare, db, setInventoryState, setSessionDetailUnavailable }) => {
    setInventoryState('archived');
    setSessionDetailUnavailable(true);
    const archived = await prepare({ includeArchivedSessions: true });
    expect(archived.state).toBe('ready');
    const search = () => db.searchDocuments({ query: 'quartz', eligibleDocuments: archived.eligibleDocuments, maxResults: 10 });
    expect(search()).toHaveLength(1);
    const controller = new AbortController();
    const reason = new Error('Search cancelled');
    controller.abort(reason);
    await expect(prepare({ signal: controller.signal })).rejects.toBe(reason);
    expect(search()).toHaveLength(1);
    const duringRead = new AbortController();
    vi.mocked(axios.post).mockImplementationOnce(async () => { duringRead.abort(reason); throw reason; });
    await expect(prepare({ includeArchivedSessions: true, signal: duringRead.signal })).rejects.toBe(reason);
    expect(search()).toHaveLength(1);
    expect(await prepare()).toMatchObject({ state: 'ready', eligibleDocuments: [] });
    expect(search()).toHaveLength(0);
  });
});

it('reuses daemon Account observation across idle memory inventory admissions and refuses disconnect or a pushed mode change', async () => {
  onTestFailed(() => console.error('Memory observation regression failed during:', admissionPhase));
  await withCurrentDocumentFixture(async ({ credentials, prepare, scope }) => {
    expect(scope.state).toBe('ready');
    admissionPhase = 'user_socket_harness';
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    admissionPhase = 'machine_transport_imports';
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const machineTransport = await import('@/api/machine/connection/createMachineSocketTransport');
    const { createSocketTransportAdapter } = await import('@happier-dev/sync-client');
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    const machineSocket = createApiSessionSocketStub();
    vi.spyOn(machineTransport, 'createMachineSocketTransport').mockImplementation(() => ({
      // The main Machine network is a boundary stub; its transport/supervisor and the user Socket.IO channel stay real.
      socket: machineSocket as unknown as ReturnType<typeof machineTransport.createMachineSocketTransport>['socket'],
      transport: createSocketTransportAdapter(machineSocket),
    }));
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'fixture-home' } } })));
    const client = new ApiMachineClient(credentials.token, { id: 'daemon-machine', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const counts = () => vi.mocked(axios.get).mock.calls.reduce((total, [url]) => {
      const path = new URL(String(url)).pathname;
      return total + Number(path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness');
    }, 0);
    try {
      const foreign = new ApiMachineClient(`header.${Buffer.from(JSON.stringify({ sub: 'other-account' })).toString('base64url')}.signature`,
        { id: 'foreign-machine', encryptionMode: 'plain',
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      try {
        admissionPhase = 'foreign_profile_refusal';
        await expect(foreign.resolvePluginResourceSessionAccess({ accountId: 'other-account', sessionId: 'remote-session',
          signal: new AbortController().signal })).rejects.toThrow();
        expect(channel.clients).toHaveLength(0);
      } finally { admissionPhase = 'foreign_profile_shutdown'; await foreign.shutdown(); }
      // Real Machine identity admission authenticates the Profile before owning the observation.
      const beforeAdmission = counts();
      admissionPhase = 'machine_connect_observation';
      client.connect();
      await vi.waitFor(() => expect(channel.clients).toHaveLength(1));
      const { readObservedAccountEncryptionCurrentness } = await import('@/api/client/accountEncryptionCurrentnessObservation');
      await readObservedAccountEncryptionCurrentness({ token: credentials.token, serverBaseUrl: 'https://api.example.test' });
      expect(counts() - beforeAdmission).toBe(1);
      const initial = counts();
      admissionPhase = 'idle_admission_workload';
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      for (let tick = 0; tick < 12; tick++) {
        await vi.advanceTimersByTimeAsync(50_000);
        expect((await prepare()).state).toBe('ready');
      }
      expect(counts() - initial).toBe(0);
      expect(channel.clients).toHaveLength(1);
      vi.useRealTimers();
      admissionPhase = 'disconnect_refusal';
      await channel.disconnect();
      expect((await prepare()).state).not.toBe('ready');
      await channel.reconnect();
      admissionPhase = 'reconnect_admission';
      expect((await prepare()).state).toBe('ready');
      await channel.push('account', { mode: 'e2ee', version: 2, updatedAt: 2,
        signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' });
      admissionPhase = 'pushed_mode_refusal';
      expect((await prepare()).state).not.toBe('ready');
    } finally {
      vi.useRealTimers();
      await client.shutdown();
      expect(channel.clients.every(socket => !socket.connected)).toBe(true);
      await channel.close();
    }
  });
});

it('retains the global document index during optional transport unavailability and prunes observed absence', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, prepare, setArtifactState }) => {
    const search = () => db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 });
    expect(search()).toHaveLength(1);
    setArtifactState('unavailable');
    expect(await prepare()).toMatchObject({ state: 'pending', eligibleDocuments: [] });
    expect(search()).toHaveLength(1);
    setArtifactState('missing');
    expect(await prepare()).toMatchObject({ state: 'ready', eligibleDocuments: [] });
    expect(search()).toHaveLength(0);
  });
});

it.each([503, 404])('keeps transient initial observation recoverable while retaining legacy HTTP for a missing endpoint (%s)', async status => {
  await withCurrentDocumentFixture(async ({ credentials, setCurrentnessStatus }) => {
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const { ApiClient } = await import('@/api/api');
    const client = new ApiMachineClient(credentials.token, { id: 'daemon-machine', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
      setCurrentnessStatus(status);
      await client.resolvePluginResourceSessionAccess({ accountId: 'account', sessionId: 'remote-session', signal: new AbortController().signal });
      setCurrentnessStatus(200);
      const initial = vi.mocked(axios.get).mock.calls.length;
      const api = await ApiClient.create(credentials);
      expect(await api.getAccountEncryptionMode()).toBe('plain');
      expect(await api.getAccountEncryptionMode()).toBe('plain');
      const paths = vi.mocked(axios.get).mock.calls.slice(initial).map(([url]) => new URL(String(url)).pathname);
      expect(paths).toEqual(status === 404 ? ['/v1/account/encryption', '/v1/account/encryption'] : ['/v1/account/encryption/currentness']);
    } finally { await client.shutdown(); await channel.close(); }
  });
});

it('retains budget-loaded preparation facts separately from indexed topics, archive and expired facts', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, serverId, artifactId }) => {
    expect(scope).toMatchObject({ state: 'ready', preparation: [{ ref: { serverId, artifactId },
      revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactIds: ['key'] }] });
    expect(db.getDocumentFactCounts({ eligibleDocuments: scope.eligibleDocuments })).toEqual([
      { ref: { serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 5 },
    ]);
  }, 'session-machine', true);
});

it('exposes fresh scoped preparation and exact indexed facts through daemon status', async () => {
  await withCurrentDocumentFixture(async ({ credentials, serverId, artifactId, setSessionWork }) => {
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep' });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials, machineId: 'session-machine' });
    try {
      const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
      const { RPC_METHODS, MemoryStatusV1Schema } = await import('@happier-dev/protocol');
      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      // Registration is the RPC transport boundary; the worker, admission and SQLite are real.
      const transport = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      } } as unknown as import('@/api/rpc/RpcHandlerManager').RpcHandlerManager;
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: transport, memoryWorker: worker });
      const status = MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({
        scope: { type: 'session', sessionId: 'remote-session' },
      }));
      expect(status.documents).toEqual({ state: 'ready', facts: [{
        ref: { kind: 'doc', serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 },
        loadedFactCount: 1, indexedFactCount: 5,
      }] });
      expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({})).documents).toBeUndefined();
      expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({ scope: { type: 'global' } })).documents)
        .toEqual({ state: 'ready', facts: [{ ref: { kind: 'doc', serverId, artifactId },
          revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 5 }] });
      for (const work of [{ memoryEnabled: false }, { memoryEnabled: true, disabledInheritedEntryIds: ['project.instructions'] }]) {
        setSessionWork(work);
        expect(MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!({
          scope: { type: 'session', sessionId: 'remote-session' },
        })).documents).toEqual({ state: 'ready', facts: [] });
      }
    } finally {
      await worker.stop();
    }
  }, 'session-machine', true);
});

it('withdraws ready document admission after Account retirement before the consumer continuation', async () => {
  await withCurrentDocumentFixture(async ({ scope, dbPath, prepare, replaceAccount }) => {
    expect(scope.state).toBe('ready');
    const { searchTier2Memory } = await import('./searchMemory');
    const result = await searchTier2Memory({ dbPath,
      query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'deep', corpora: ['documents'] }, previewChars: 200,
      resolveDocuments: async () => {
        // Real admission remains intact; the Account boundary changes while its consumer resumes.
        const current = await prepare();
        expect(current.state).toBe('ready');
        replaceAccount();
        return current;
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'memory_failed' });
    expect(result).not.toHaveProperty('hits');
  });
});
