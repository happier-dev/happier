import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { SessionRolePromptContextV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const serverId = 'context-home';
const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'context-account' })).toString('base64url')}.signature`, encryption: null };
let taskHome: string;
let peer: Server;
let sourceAvailable = true;
let sessionEntryIds: string[];
let documents: ReturnType<typeof storedDocument>[];
let onArtifactRead: (() => void) | undefined;
let artifactReadAvailable: boolean;
let createSessionPromptPlanResolver: typeof import('./sessionPromptPlan').createSessionPromptPlanResolver;

function entry(id: string): PromptStackEntryV1 {
  return { id, ref: { kind: 'doc', artifactId: id }, enabled: true, required: true, placement: 'system_append' };
}

function storedDocument(id: string, markdown = `CONTEXT_${id.toUpperCase()}`, revision = 1) {
  return { id, ownerAccountId: 'context-account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: id }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: revision, bodyVersion: revision, seq: revision, createdAt: 1, updatedAt: revision,
  };
}

// The daemon IPC endpoint is a genuine boundary; this peer selects no plugin additions.
const daemonBridge: DaemonAgentRuntimeTurnContributionsBridge = {
  resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }),
  resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
  resolveComposerReference: async () => { throw new Error('Unexpected reference request'); },
  resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
  afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
  transformAgentContext: async () => { throw new Error('Unexpected context transform'); },
  transformSessionInput: async () => { throw new Error('Unexpected input transform'); },
  transformAgentRequest: async () => { throw new Error('Unexpected request transform'); },
};

beforeEach(async () => {
  vi.resetModules();
  sourceAvailable = true;
  sessionEntryIds = ['session'];
  onArtifactRead = undefined;
  artifactReadAvailable = true;
  taskHome = await createTempDir('happier-project-context-plan-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
  const workspace = { id: 'checkout', serverId, machineId: 'context-machine', rootPath: '/tmp/project', createdAtMs: 1,
    projectKey: 'project', source: { sourceId: 'source', revision: 1 } };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: workspace.id };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const rows = [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: workspace } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry('personal')] } } } },
  ];
  const source = { id: 'source', revision: 2, name: 'Current Source', createdByAccountId: 'context-account', audience: [],
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'public' }, protocol: 'https' },
    attachments: [{ purpose: 'context', entry: entry('source') }],
  };
  documents = ['account', 'profile', 'worker_profile', 'source', 'personal', 'session'].map(id => storedDocument(id));
  peer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let status = 200;
    let data: unknown;
    if (request.headers.authorization !== `Bearer ${credentials.token}`) { status = 401; data = { error: 'wrong_account' }; }
    else if (path === '/v1/account/encryption') data = { mode: 'plain', updatedAt: 1 };
    else if (path === '/v1/account/project-rows/list') data = { status: 'listed', coverage: 'complete', rows };
    else if (path === '/v1/projects/sources/source') {
      status = sourceAvailable ? 200 : 503;
      data = sourceAvailable ? { ok: true, source, canManage: false } : { ok: false, error: 'source_backend_unavailable' };
    } else if (path === '/v1/artifacts') data = documents;
    else if (path.startsWith('/v1/artifacts/')) {
      onArtifactRead?.();
      const id = decodeURIComponent(path.slice('/v1/artifacts/'.length));
      data = documents.find(document => document.id === id);
      if (!data) { status = 404; data = { error: 'artifact_not_found' }; }
      if (!artifactReadAvailable) { status = 503; data = { error: 'artifact_backend_unavailable' }; }
    } else { status = 404; data = { error: 'unexpected_route' }; }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('HTTP peer has no address');
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(join(taskHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: serverId, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } },
  }));
  // Load the real producer after establishing its Home, before the measured
  // preparation itself. Module loading is not an Artifact preparation fact.
  ({ createSessionPromptPlanResolver } = await import('./sessionPromptPlan'));
});

afterEach(async () => {
  const account = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  account.resetActiveAccountSettingsSnapshotForTests();
  const projects = await import('@/workspaces/projectAccountRows');
  projects.withdrawActiveProjectAccountRowsSnapshot();
  peer.closeAllConnections();
  await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
  await removeTempDir(taskHome);
});

async function resolver(withAccount: boolean, withProject: boolean, worker = false) {
  const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const settings = accountSettingsParse({});
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  if (withAccount) setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: PromptLibraryRecordV1Schema.parse({
      key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [entry('account')] },
    }) }], tombstones: [], diagnostics: [] },
    profileCatalog: { status: 'ready', authority: 'active', source: 'destination', diagnostics: [], referenceGuardRevision: 1,
      control: null, controlRevision: 'absent', records: [{ revision: 1, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'focused', enabled: true, promptStack: [entry('profile')], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } },
      }) }, { revision: 1, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'worker-profile', enabled: true, promptStack: [entry('worker_profile')], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'worker-profile', name: 'Worker', createdAt: 1, updatedAt: 1 } },
      }) }],
    },
  });
  return createSessionPromptPlanResolver({
    opts: { credentials, ...(withAccount ? { accountSettingsContext: { source: 'network' as const, settings, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null } } : {}) },
    session: { sessionId: 'context-session', getMetadataSnapshot: () => createTestMetadata({
      ...(withAccount ? { profileId: worker ? 'worker-profile' : 'focused' } : {}),
      ...(withProject ? { workspaceId: 'checkout', projectId: 'project' } : {}),
      ...(worker ? { reportsTo: { sessionId: 'lead' } } : {}),
      work: { memoryEnabled: true, promptStack: worker ? [] : sessionEntryIds.map(entry) },
    }) },
    agentId: 'codex', machineId: 'context-machine', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
    readNativeSessionId: () => 'native', daemonBridge,
    resolveRoleContext: async () => ({ role: { roleId: 'context-role', name: 'Context role', instructions: 'CONTEXT_ROLE',
      engine: { agentTargetKey: 'agent:codex', modelId: 'test-model' }, runsAs: { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off', enabled: true }, notes: 'CONTEXT_NOTES' } satisfies SessionRolePromptContextV1),
  });
}

it('prepares Account → Profile → current Source/personal Project → Session before Role and Notes', async () => {
  const prepare = await resolver(true, true);
  const text = await prepare({ baseOverride: 'CONTEXT_BASE' });
  const markers = ['BASE', 'ACCOUNT', 'PROFILE', 'SOURCE', 'PERSONAL', 'SESSION', 'ROLE', 'NOTES'];
  const positions = markers.map(marker => text.indexOf(`CONTEXT_${marker}`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
});

it('publishes current admitted inventory with its text from the same preparation', async () => {
  const prepare = await resolver(true, true);
  const options = { baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true as const };
  const first = await prepare(options);
  expect(first).toMatchObject({ text: expect.stringContaining('CONTEXT_SESSION'), admittedEntries: [
    { entryId: 'account', layer: 'account', ref: { artifactId: 'account', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'profile', layer: 'profile', ref: { artifactId: 'profile', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'source', layer: 'project', ref: { artifactId: 'source', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'personal', layer: 'project', ref: { artifactId: 'personal', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
    { entryId: 'session', layer: 'session', scope: { serverId, accountId: 'context-account', sessionId: 'context-session', projectKey: 'project', profileId: 'focused' },
      ref: { artifactId: 'session', serverId }, revision: { headerVersion: 1, bodyVersion: 1 }, outcome: 'ready' },
  ] });

  // Membership comes from the current Session, not the prior rendered plan or
  // an Artifact inventory. Empty documents remain admitted for indexing.
  sessionEntryIds = ['current', 'empty'];
  documents.push(storedDocument('current', 'CONTEXT_CURRENT', 2), storedDocument('empty', '', 3));
  const second = await prepare(options);
  expect(second).toMatchObject({ text: expect.stringContaining('CONTEXT_CURRENT'), admittedEntries: [
    { entryId: 'account' }, { entryId: 'profile' }, { entryId: 'source' }, { entryId: 'personal' },
    { entryId: 'current', layer: 'session', ref: { artifactId: 'current', serverId }, revision: { headerVersion: 2, bodyVersion: 2 }, outcome: 'ready' },
    { entryId: 'empty', layer: 'session', ref: { artifactId: 'empty', serverId }, revision: { headerVersion: 3, bodyVersion: 3 }, outcome: 'valid-empty' },
  ] });
  expect(second).toHaveProperty('text', expect.not.stringContaining('CONTEXT_SESSION'));
});

it.each([true, false])('does not publish admitted inventory after the current Account retires with body availability %s', async (bodyAvailable) => {
  const prepare = await resolver(true, true);
  const { resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  onArtifactRead = resetActiveAccountSettingsSnapshotForTests;
  artifactReadAvailable = bodyAvailable;
  const options = { baseOverride: 'CONTEXT_BASE', includeAdmittedInventory: true as const };
  let failure: unknown;
  try { await prepare(options); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'context_source_unavailable' });
  expect(failure).not.toHaveProperty('admittedEntries');
  expect(prepare.readStartupInstructions?.()).toBeNull();
  expect(prepare.readCodingPromptBehavior?.()).toBeNull();
});

it('prepares a Session-only stack without an Account catalog', async () => {
  const prepare = await resolver(false, false);
  expect(await prepare({ baseOverride: 'CONTEXT_BASE' })).toContain('CONTEXT_SESSION');
});

it('prepares a worker from its selected Profile and Account/Project context without the lead Session layer', async () => {
  const prepare = await resolver(true, true, true);
  const text = await prepare({ baseOverride: 'CONTEXT_BASE' });
  const positions = ['ACCOUNT', 'WORKER_PROFILE', 'SOURCE', 'PERSONAL', 'ROLE', 'NOTES']
    .map(marker => text.indexOf(`CONTEXT_${marker}`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  expect(text).not.toContain('CONTEXT_SESSION');
  expect(text).not.toContain('CONTEXT_PROFILE');
});

it('keeps unavailable current Source context pending rather than publishing the personal subset', async () => {
  sourceAvailable = false;
  const prepare = await resolver(true, true);
  await expect(prepare({ baseOverride: 'CONTEXT_BASE' })).rejects.toMatchObject({
    code: 'preparation_pending', reason: 'project_source_unavailable',
  });
  expect(prepare.readStartupInstructions?.()).toBeNull();
});
