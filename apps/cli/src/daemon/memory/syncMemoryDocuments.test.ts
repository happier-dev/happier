import axios from 'axios';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { MemoryDocumentSearchScope } from './syncMemoryDocuments';

const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
let homeDir: string;

beforeEach(async () => {
  homeDir = await createTempDir('happier-document-admission-');
  applyEnvValues({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@/session/transport/http/sessionsHttp');
  restoreEnvValues(envBackup);
  vi.resetModules();
  await removeTempDir(homeDir);
});

async function withCurrentDocumentFixture(run: (fixture: Readonly<{
  scope: MemoryDocumentSearchScope;
  db: DeepIndexDbHandle;
  dbPath: string;
  prepare: () => Promise<MemoryDocumentSearchScope>;
  serverId: string;
  artifactId: string;
  replaceAccount: () => void;
}>) => Promise<void>, machineId = 'session-machine'): Promise<void> {
  const { accountSettingsParse } = await import('@happier-dev/protocol');
  const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
  const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { withdrawActiveProjectAccountRowsSnapshot } = await import('@/workspaces/projectAccountRows');
  const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
  const { configuration } = await import('@/configuration');
  const serverId = configuration.activeServerId;
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
  const entry = { id: 'project.instructions', ref: { kind: 'doc' as const, artifactId: 'project-context' }, enabled: true, placement: 'system_append' as const };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const artifact = { id: entry.ref.artifactId, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Remote Project' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'quartz remote project context', createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    if (path === '/v1/artifacts') return { status: 200, data: [artifact] };
    if (path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
    throw new Error(`Unexpected document admission HTTP path: ${path}`);
  });
  // Account rows and Session HTTP are transport boundaries; Project association,
  // four-layer admission, document decoding and SQLite remain real.
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
      id: 'checkout', serverId, machineId: 'session-machine', rootPath: '/remote/repo', createdAtMs: 1, projectKey: 'project',
    } } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry] } } } },
  ] } });
  vi.doMock('@/session/transport/http/sessionsHttp', async () => ({
    ...(await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp')),
    fetchSessionById: async () => ({ id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0, encryptionMode: 'plain',
      metadata: JSON.stringify({ ...createTestMetadata({ machineId: 'session-machine', path: '/container/checkout',
        sessionWorkspaceLocationV1: { v: 1, machineId: 'session-machine', agentPath: '/container/checkout', machinePath: '/remote/repo' } }),
        workspaceId: 'checkout', projectId: 'project' }) }),
    fetchSessionsPage: async () => ({ sessions: [{ id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0 }], nextCursor: null, hasNext: false }),
  }));
  const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
  const { syncMemoryDocuments } = await import('./syncMemoryDocuments');
  const dbPath = join(homeDir, 'deep.sqlite');
  const db = openDeepIndexDb({ dbPath });
  const prepare = () => syncMemoryDocuments({ credentials, machineId, scope: { type: 'global' },
    includeArchivedSessions: false, db, assertCurrent: () => {} });
  try {
    const scope = await prepare();
    await run({ scope, db, dbPath, prepare, serverId, artifactId: artifact.id, replaceAccount: () => {
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

it('qualifies global Project documents using the owning Session Machine and workspace mapping', async () => {
  await withCurrentDocumentFixture(async ({ scope, db, serverId, artifactId }) => {
    expect(scope).toMatchObject({ state: 'ready', eligibleDocuments: [{ ref: { serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 } }] });
    expect(db.searchDocuments({ query: 'quartz', eligibleDocuments: scope.eligibleDocuments, maxResults: 10 }))
      .toEqual([expect.objectContaining({ text: 'quartz remote project context', location: 'document' })]);
  }, 'daemon-machine');
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
