import { createServer } from 'node:http';
import { AsyncResource } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { publishServerHttpRuntimeOrigin, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createMachineSkillActions } from './machineSkillActions';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { ApiMachineClient } from '@/api/apiMachine';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentSkillsCapability } from '@/agent/skills/resolveAgentSkillsCapability';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import * as persistence from '@/persistence';
import { FeaturesResponseSchema, HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { createDaemonMachineBootstrapRuntime } from '@/daemon/startup/createDaemonMachineBootstrapRuntime';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '@/daemon/serverWork';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

async function fixture(run: (fixture: Readonly<{
  service: ReturnType<typeof createMachineSkillActions>; home: string;
  credentials: persistence.StoredCredentials; base: string;
  state: { text: string; homeIdentity: string; conflict: boolean; retireOnRead: boolean; retireOnWrite: boolean; unavailable: boolean; missingArtifact: boolean; malformedSkillHeader: boolean; unreadableNeighbour: boolean; writes: number; artifactListKinds: Array<string | null>; requests: string[] };
  readLinks(): Extract<ReturnType<typeof PromptLibraryRecordV1Schema.parse>, { key: 'external-links' }>;
}>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'happier-machine-actions-'));
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE rows (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)');
  const foreign = { id: 'foreign', artifactId: 'other', assetTypeId: 'skills.user:.agents/skills', scope: 'user' as const,
    machineId: 'machine', serverIdentityId: 'srv_elsewhere', externalRef: { skillName: 'foreign' }, lastExternalDigest: 'untouched' };
  for (const key of PromptLibraryCatalogKeyV1Schema.options) database.prepare('INSERT INTO rows VALUES (?, 1, ?)')
    .run(key, JSON.stringify(key === 'external-links' ? { key, value: { v: 1, links: [foreign] } } : emptyPromptLibraryRecordV1(key)));
  const state = { text: 'initial', homeIdentity: 'srv_home', conflict: false, retireOnRead: false, retireOnWrite: false, unavailable: false, missingArtifact: false, malformedSkillHeader: false, unreadableNeighbour: false, writes: 0, artifactListKinds: [] as Array<string | null>, requests: [] as string[] };
  const artifact = () => ({ id: 'skill', ownerAccountId: 'fixture-account', access: 'owner', encryptionMode: 'plain',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', ...(state.malformedSkillHeader ? {} : { title: 'example' }), bundleSchemaId: 'skills.skill_md_v1' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8', unixMode: 0o644,
      contentBase64: Buffer.from(`---\nname: example\n---\n${state.text}`).toString('base64') }] }) }) });
  // Only the remote Home boundary is a fixture; real CLI codecs, catalog reads and CAS transport run beneath the service.
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture');
      const path = url.pathname;
      state.requests.push(path);
      let result: unknown;
      if (path === '/v1/account/entity-rows/prompt-library') {
        if (state.unavailable) { response.statusCode = 503; result = { error: 'unreachable' }; }
        else result = { status: 'listed', rows: database.prepare('SELECT * FROM rows').all().map(row => ({ key: row.key, revision: row.revision,
          content: { t: 'plain', v: JSON.parse(String(row.record)) } })) };
      } else if (path.startsWith('/v1/account/entity-rows/prompt-library/')) {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain fixture Account');
        const record = PromptLibraryRecordV1Schema.parse(mutation.content.v); expect(record.key).toBe('external-links');
        state.writes++;
        if (state.conflict) database.prepare('UPDATE rows SET revision = revision + 1 WHERE key = ?').run(record.key);
        const write = database.prepare('UPDATE rows SET record = ?, revision = revision + 1 WHERE key = ? AND revision = ?')
          .run(JSON.stringify(record), record.key, mutation.expectedRevision);
        const current = database.prepare('SELECT revision FROM rows WHERE key = ?').get(record.key)!;
        result = write.changes === 1 ? { status: 'updated', revision: current.revision, cursor: state.writes } : { status: 'conflict', revision: current.revision };
        if (state.retireOnWrite) setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'retired-account' });
      } else if (path === '/v1/features') result = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: state.homeIdentity } } });
      else if (path === '/v1/plugins/availability/materializations/read') result = { availabilityCursor: 0, inventoryComplete: true, snapshots: [], releases: [] };
      else if (path === '/v1/artifacts') {
        const kind = url.searchParams.get('kind'); state.artifactListKinds.push(kind);
        const skills = [artifact(), ...(state.unreadableNeighbour ? [{ ...artifact(), id: 'broken' }] : [])];
        const unrelated = { ...artifact(), id: 'unrelated', header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Unrelated prompt' }) };
        result = kind === 'skill' ? { items: skills, hasUnclassified: false } : [...skills, unrelated];
      }
      else if (path === '/v1/artifacts/broken') result = { ...artifact(), id: 'broken', body: encodePlainArtifactStoredContent({ body: '{malformed' }) };
      else if (path === '/v1/artifacts/skill') {
        if (state.retireOnRead) setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'retired-account' });
        if (state.missingArtifact) { response.statusCode = 404; result = { error: 'not_found' }; }
        else result = artifact();
      } else if (path === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
      else if (path.startsWith('/v1/artifacts/')) { response.statusCode = 503; result = { error: 'unreachable' }; }
      else if (path === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 1 };
      else if (path === '/v2/account/settings') result = { content: { t: 'plain', v: {} }, version: 1 };
      else if (path === '/v2/account/settings/history') result = { snapshots: [] };
      else { response.statusCode = 404; result = { error: 'not_found' }; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture');
  const base = `http://127.0.0.1:${address.port}`;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_home', getAccountEncryptionMode: async () => 'plain' });
      const service = createMachineSkillActions({ store: store.promptLibraryStore, readPluginSkills: store.readPluginSkills,
        target: { machineId: 'machine', serverIdentityId: 'srv_home' },
        libraryServerIdentityId: 'srv_home', homeDirectory: home, happierHomeDirectory: join(home, '.happier'),
        agents: [{ agentId: 'claude', nativeRoots: { user: [['.claude', 'skills']] } }, { agentId: 'codex', nativeRoots: { user: [['.agents', 'skills']], plugin: [['.codex', 'plugins', 'cache', '*', '{plugin}', '*', 'skills']] } }],
        readInstalledAgents: async () => ['codex'], nowMs: () => 1 });
      await run({ service, state, home, credentials, base, readLinks: () => {
        const row = database.prepare('SELECT record FROM rows WHERE key = ?').get('external-links')!;
        const record = PromptLibraryRecordV1Schema.parse(JSON.parse(String(row.record)));
        if (record.key !== 'external-links') throw new Error('Wrong persisted row'); return record;
      } });
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks();
  }
}

describe('machine skill service through real Account HTTP and SQLite CAS', () => {
  it('reads no Account inventory for an empty native scan and rereads disk on Check again', async () => fixture(async ({ service, state, home }) => {
    const empty = SkillFoundListResultV1Schema.parse(await service.found());
    expect(empty.items).toEqual([]);
    expect(empty.roots).toHaveLength(3);
    expect(state.requests).toEqual([]);

    const native = join(home, '.agents/skills/fresh');
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'SKILL.md'), '---\nname: fresh\n---\nCurrent disk content');
    expect((await service.found()).items).toEqual([expect.objectContaining({ name: 'fresh', inLibrary: null })]);
    expect(state.artifactListKinds).toEqual(['skill']);
  }));
  it('keeps a retired plugin id out of an unrelated unavailable Artifact store', async () => {
    await fixture(async ({ service }) => {
      await expect(service.install({ skillId: 'plugin:com.acme.retired/check', agents: ['codex'] }))
        .rejects.toMatchObject({ code: 'not_found' });
    });
  });
  it('installs through the published Iroh carrier while retaining canonical saved Home identity', async () => {
    // Construct outside the fixture's invocation URL scope, so the actual publication owns endpoint selection.
    const runtimeContext = new AsyncResource('machine-skill-published-home');
    try { await fixture(async ({ credentials, base, home, state, readLinks }) => runtimeContext.runInAsyncScope(async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_home', revision: 1,
      canonicalServerUrl: 'https://canonical-home.example.test', endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] });
    // Saved-profile persistence and the local tunnel HTTP server are genuine boundaries;
    // real Home resolution, publication, identity observation, C5 and native copies stay beneath them.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true,
      activeServerId: configuration.activeServerId, servers: { [configuration.activeServerId]: {
        id: configuration.activeServerId, name: 'Fixture Home', serverUrl: descriptor.canonicalServerUrl,
        webappUrl: descriptor.canonicalServerUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptor: descriptor,
      } } });
    const release = publishServerHttpRuntimeOrigin(base, 'iroh');
    expect(resolveServerHttpBaseUrl()).toBe(base);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    const catalog = readAgentCatalogSnapshot();
    const agentId = Object.keys(catalog.catalogEntriesById).find(id => resolveAgentSkillsCapability(id, catalog).nativeRoots?.user?.length);
    if (!agentId) throw new Error('Current Agent catalog has no native user roots');
    const machine = new ApiMachineClient(credentials.token, { id: 'machine', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
      const effect = machine.createMachineSkillActionExecutor({ credentials });
      const context = { surface: 'rpc', serverId: configuration.activeServerId, authority: 'present_user' } as const;
      const installed = await effect({ actionId: 'skills.machine.install', input: { skillId: 'skill', machineId: 'machine', agents: [agentId] }, context });
      if (installed && typeof installed === 'object' && 'errorCode' in installed) throw new Error(JSON.stringify(installed));
      expect(installed).toHaveProperty('receipts');
      expect(readLinks().value.links).toHaveLength(2);
      const root = resolveAgentSkillsCapability(agentId, catalog).nativeRoots!.user![0]!;
      const path = join(home, ...root, 'example/SKILL.md'); expect(readFileSync(path, 'utf8')).toContain('initial');
      state.homeIdentity = 'srv_other';
      expect(await effect({ actionId: 'skills.machine.uninstall', input: { skillId: 'skill', machineId: 'machine', force: true }, context }))
        .toMatchObject({ ok: false, errorCode: 'identity_mismatch' });
      expect(existsSync(path)).toBe(true); expect(readLinks().value.links).toHaveLength(2);
    } finally { await machine.shutdown(); release(); }
    })); } finally { runtimeContext.emitDestroy(); }
  });
  it('refreshes a receipted copy through the actual pre-connect bootstrap lifecycle', async () => fixture(async ({ service, credentials, state, home }) => {
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    await service.install({ skillId: 'skill' }); state.text = 'bootstrap library edit';
    const unused = async (): Promise<never> => { throw new Error('Unexpected native process boundary'); };
    const bootstrap = createDaemonMachineBootstrapRuntime({ api: await ApiClient.create(credentials), credentials, controlPort: 0,
      runtimeId: 'fixture-runtime', publicReleaseChannel: 'dev', startupSource: 'manual', serviceLabel: undefined,
      transferRuntimeStatePublisher: null, directPeerServerLifecycle: null,
      spawnSessionForInternalResume: unused,
      spawnSession: unused, stopSession: unused, awaitAgentSessionOpen: unused,
      isSessionAlreadyRunning: unused, loadLocalSessionMetadataForHandoff: unused,
      beforeShutdown: async () => {}, requestShutdown: () => {},
      directTransferRegistryHost: createCliRegistryHostV1({ credentials }),
      daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
      setDaemonServerWorkOnline: () => {}, onMachineConnectionOnline: () => {},
      reconcileConnectedServicesProjection: async () => {}, isShuttingDown: () => false,
    });
    const machine = await bootstrap.createConnectedApiMachine({ id: 'machine', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    if (!machine) throw new Error('Missing actual bootstrap Machine');
    try {
      // Exercise the real Account ingress owner installed by the constructor, without opening a live socket.
      const ingress = machine as unknown as { refreshDemandedPromptLibraryCatalog(input: { signal: AbortSignal; initializeMachineInstallDemand: boolean }): Promise<void> };
      await ingress.refreshDemandedPromptLibraryCatalog({ signal: new AbortController().signal, initializeMachineInstallDemand: true });
      expect(readFileSync(join(home, '.agents/skills/example/SKILL.md'), 'utf8')).toContain('bootstrap library edit');
      state.homeIdentity = 'srv_other'; state.text = 'different Home edit';
      await ingress.refreshDemandedPromptLibraryCatalog({ signal: new AbortController().signal, initializeMachineInstallDemand: true });
      expect(readFileSync(join(home, '.agents/skills/example/SKILL.md'), 'utf8')).toContain('bootstrap library edit');
    } finally { await machine.shutdown(); }
  }));
  it('binds the actual ApiMachine factory through the credentialed policy executor to native copies and receipt CAS', async () => fixture(async ({ credentials, base, home, readLinks }) => {
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    const catalog = readAgentCatalogSnapshot();
    const agentId = Object.keys(catalog.catalogEntriesById).find(id => resolveAgentSkillsCapability(id, catalog).nativeRoots?.user?.length);
    if (!agentId) throw new Error('Current Agent catalog has no native user roots');
    const machine = new ApiMachineClient(credentials.token, { id: 'machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
      const guest = { ...credentials, token: `e30.${Buffer.from(JSON.stringify({ sub: 'guest-account' })).toString('base64url')}.signature` };
      expect(await machine.createMachineSkillActionExecutor({ credentials: guest })({ actionId: 'skills.machine.install',
        input: { skillId: 'skill', machineId: 'machine', agents: [agentId] }, context: { surface: 'ui', serverId: 'srv_home', authority: 'present_user' } }))
        .toMatchObject({ ok: false, errorCode: 'machine_skill_custodian_required' });
      expect(readLinks().value.links).toHaveLength(1);
      const effect = machine.createMachineSkillActionExecutor({ credentials });
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'srv_home', serverApiUrl: base,
        skillMachineActionExecute: effect, machineId: 'machine', readCredentials: async () => credentials,
        pluginActionExecutionOwner: 'current_process' });
      const result = await executor.execute('skills.machine.install', { skillId: 'skill', machineId: 'machine', agents: [agentId] },
        // The authenticated RPC receiver supplies this verified actor stamp; a raw UI caller cannot confer it.
        { surface: 'rpc', serverId: 'srv_home', authority: 'present_user',
          externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({ ok: true }); expect(readLinks().value.links).toHaveLength(2);
      const root = resolveAgentSkillsCapability(agentId, catalog).nativeRoots!.user![0]!;
      expect(existsSync(join(home, ...root, 'example/SKILL.md'))).toBe(true);
      const snapshot = getActiveAccountSettingsSnapshot(); if (!snapshot) throw new Error('Missing captured Account');
      const retiredOperation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: base, isCurrent: async () => false });
      const retiredEffect = machine.createMachineSkillActionExecutor({ credentials, operationContext: retiredOperation });
      const request = { actionId: 'skills.machine.uninstall', input: { skillId: 'skill', machineId: 'machine' },
        context: { surface: 'ui', serverId: 'srv_home', authority: 'present_user' } } as const;
      expect(await retiredEffect(request)).toMatchObject({ ok: false, errorCode: 'scope-retired' });
      expect(existsSync(join(home, ...root, 'example/SKILL.md'))).toBe(true);
      expect(await retiredEffect({ ...request, input: { ...request.input, machineId: 'foreign' } }))
        .toMatchObject({ ok: false, errorCode: 'machine_target_mismatch' });
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: base, isCurrent: async () => true });
      const scopedEffect = machine.createMachineSkillActionExecutor({ credentials, operationContext });
      const scopedExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: 'srv_home', serverApiUrl: base,
        savedSecretOperationContext: operationContext, skillMachineActionExecute: scopedEffect, machineId: 'machine',
        readCredentials: async () => credentials, pluginActionExecutionOwner: 'current_process' });
      const removed = await scopedExecutor.execute(request.actionId, request.input, { ...request.context,
        surface: 'cli', presentUserConfirmation: { actionId: request.actionId },
        externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      if (!removed.ok) throw new Error(JSON.stringify(removed));
      expect(removed).toMatchObject({ ok: true, result: { removed: [join(home, ...root, 'example')] } });
      expect(readLinks().value.links).toHaveLength(1);
    } finally { await machine.shutdown(); }
  }));
  it('keeps Found available beside a malformed stored skill without fabricating library membership', async () => fixture(async ({ service, state }) => {
    await service.install({ skillId: 'skill' });
    const writes = state.writes;
    state.unreadableNeighbour = true;
    expect(SkillFoundListResultV1Schema.parse(await service.found()).items.find(item => item.name === 'example'))
      .toMatchObject({ inLibrary: 'skill', masksLibrary: true, happierInstalled: true });
    state.malformedSkillHeader = true;
    expect(SkillFoundListResultV1Schema.parse(await service.found()).items.find(item => item.name === 'example'))
      .toMatchObject({ inLibrary: null, masksLibrary: false });
    expect(state.writes).toBe(writes);
    state.unavailable = true;
    await expect(service.found()).rejects.toMatchObject({ code: 'library_unavailable' });
  }));
  it('joins Found to verified library content and exact own receipts, without giving plugin skills install ownership', async () => fixture(async ({ service, state, home }) => {
    expect((await service.install({ skillId: 'skill' })).results[0]?.status).toBe('installed');
    const plugin = join(home, '.codex/plugins/cache/market/fixture/1/skills/example'); mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'SKILL.md'), readFileSync(join(home, '.agents/skills/example/SKILL.md')));
    chmodSync(join(plugin, 'SKILL.md'), 0o644);
    const hidden = join(home, '.agents/skills/hidden'); mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'SKILL.md'), '---\nname: hidden\ndescription: Native\nuser-invocable: false\n---\nBody');
    const result = SkillFoundListResultV1Schema.parse(await service.found());
    expect(state.artifactListKinds).toEqual(['skill']);
    expect(result.items.find(item => item.name === 'hidden')).toMatchObject({ userInvocable: false, inLibrary: null });
    expect(result.items.find(item => item.scope === 'user')).toMatchObject({ inLibrary: 'skill', masksLibrary: true, happierInstalled: true, pluginOwned: null });
    expect(result.items.find(item => item.scope === 'plugin')).toMatchObject({ inLibrary: 'skill', masksLibrary: false, happierInstalled: false, pluginOwned: { pluginName: 'fixture' } });
    writeFileSync(join(home, '.agents/skills/example/SKILL.md'), 'local edit');
    expect((await service.found()).items.find(item => item.scope === 'user')).toMatchObject({ inLibrary: null, masksLibrary: true, happierInstalled: false });
    state.missingArtifact = true;
    expect(SkillFoundListResultV1Schema.parse(await service.found()).items.find(item => item.scope === 'user'))
      .toMatchObject({ inLibrary: null, masksLibrary: false });
  }));
  it('installs for actual installed Agents, refreshes and uninstalls while preserving foreign receipts', async () => fixture(async ({ service, state, home, readLinks }) => {
    const installed = await service.install({ skillId: 'skill' }); expect(installed.results[0]?.status).toBe('installed'); expect(installed.row.status).toBe('updated');
    expect(existsSync(join(home, '.claude/skills/example'))).toBe(false); expect(readLinks().value.links).toHaveLength(2);
    expect(readLinks().value.links[0]?.id).toBe('foreign');
    state.text = 'library edit'; const refreshed = await service.refresh({ artifactIds: ['skill'] }); expect(refreshed.results[0]?.status).toBe('refreshed');
    const path = join(home, '.agents/skills/example/SKILL.md'); expect(readFileSync(path, 'utf8')).toContain('library edit');
    state.missingArtifact = true; expect((await service.refresh()).results).toEqual([]); expect(readFileSync(path, 'utf8')).toContain('library edit'); state.missingArtifact = false;
    writeFileSync(path, 'local edit'); state.text = 'next library edit';
    expect((await service.refresh()).results[0]?.status).toBe('externally_modified'); expect(readFileSync(path, 'utf8')).toBe('local edit');
    expect((await service.uninstall({ skillId: 'skill' })).results[0]?.status).toBe('externally_modified');
    expect((await service.uninstall({ skillId: 'skill', force: true })).results[0]?.status).toBe('removed');
    expect(readLinks().value.links.map(link => link.id)).toEqual(['foreign']); expect(state.writes).toBe(3);
  }));
  it('retains actual filesystem effects when receipt CAS conflicts, without retrying', async () => fixture(async ({ service, state, home, readLinks }) => {
    state.conflict = true; const result = await service.install({ skillId: 'skill' });
    expect(result.results[0]?.status).toBe('installed'); expect(result.row.status).toBe('conflict');
    expect(existsSync(join(home, '.agents/skills/example/SKILL.md'))).toBe(true); expect(state.writes).toBe(1);
    expect(readLinks().value.links.map(link => link.id)).toEqual(['foreign']);
  }));
  it('rejects unknown Agents and retired Account authority before native writes', async () => fixture(async ({ service, state, home }) => {
    await expect(service.install({ skillId: 'skill', agents: ['unknown'] })).rejects.toMatchObject({ code: 'unknown_agent' });
    expect(existsSync(join(home, '.agents'))).toBe(false);
    state.retireOnRead = true; await expect(service.install({ skillId: 'skill' })).rejects.toMatchObject({ code: 'scope-retired' });
    expect(existsSync(join(home, '.agents'))).toBe(false); expect(state.writes).toBe(0);
  }));
  it('retains acknowledged receipt writes when the Home retires while its response is in flight', async () => fixture(async ({ service, state, home, readLinks }) => {
    state.retireOnWrite = true; const result = await service.install({ skillId: 'skill', agents: ['claude'] });
    expect(result.results[0]?.status).toBe('installed'); expect(result.row.status).toBe('updated');
    expect(existsSync(join(home, '.claude/skills/example/SKILL.md'))).toBe(true);
    expect(readLinks().value.links).toHaveLength(2); expect(state.writes).toBe(1);
  }));
  it('supports bundled first-party content and rejects cancelled requests before filesystem effects', async () => fixture(async ({ service, state, home }) => {
    const aborted = new AbortController(); aborted.abort();
    await expect(service.install({ skillId: 'skill', signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(home, '.agents'))).toBe(false); expect(state.writes).toBe(0);
    const installed = await service.install({ skillId: 'happier:happier' }); expect(installed.results[0]?.status).toBe('installed');
    expect(readFileSync(join(home, '.agents/skills/happier/SKILL.md'), 'utf8')).toContain('happier --help');
  }));
  it('refuses unreadable receipts before writing native files', async () => fixture(async ({ service, state, home }) => {
    state.unavailable = true; await expect(service.install({ skillId: 'skill' })).rejects.toMatchObject({ code: 'library_unavailable' });
    expect(existsSync(join(home, '.agents'))).toBe(false); expect(state.writes).toBe(0);
  }));
});
