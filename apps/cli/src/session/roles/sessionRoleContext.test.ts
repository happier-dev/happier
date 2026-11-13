import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1, accountSettingsParse, buildBackendTargetKeyV2, renderSessionRoleBlockV1, type SessionMetadata, type V2SessionByIdResponse } from '@happier-dev/protocol';
import { createSessionRoleContext } from './sessionRoleContext';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, commitActivePromptLibraryCatalog, beginActivePromptLibraryCatalogRefresh,
  readActiveAccountRoleOverrides } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { TokenOnlyCredentials } from '@/persistence';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createRoleSourceReaderV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { createRoleSourceReader } from './roleSources';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred } from '@/testkit/async/deferred';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { RoleInstructionsOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

const defaultEngine = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }) };
const snapshotInputs = { defaultEngine, availableAgentTargetKeys: [defaultEngine.agentTargetKey] };

function createPromptRoleInventoryBoundary(onRead?: () => void) {
  let instructions = 'SELECTED_FIRST_REVISION';
  let bodyVersion = 1;
  let available = true;
  const costs = { pages: 0, bodies: 0 };
  const artifact = (artifactId: string) => ({
    artifactId, ownerAccountId: 'account', access: 'owner' as const,
    header: { kind: 'role.v1' }, headerVersion: 1, bodyVersion, seq: bodyVersion, createdAt: 1, updatedAt: bodyVersion,
    body: JSON.stringify({ ...BUILT_IN_ROLES_V1.builder, instructions }),
  });
  const unrelatedRoleIds = Array.from({ length: 1_001 }, (_, index) => `unrelated-role-${index}`);
  const roleIds = ['selected-role', ...unrelatedRoleIds];
  // Artifact persistence is the boundary; paging, source admission, resolution
  // and rendering remain the production owners.
  const read = createRoleSourceReader({
    readPluginRoles: () => available ? [{ pluginId: 'external-roles', localId: 'builder',
      role: { ...BUILT_IN_ROLES_V1.builder, instructions } }] : [],
    artifactStore: {
      read: async roleId => {
        if (!available || !roleIds.includes(roleId)) return null;
        costs.bodies++;
        onRead?.();
        return { ...artifact(roleId), revision: { headerVersion: 1, bodyVersion } };
      },
      list: async options => {
        costs.pages++;
        onRead?.();
        const start = Number(options?.cursor ?? 0);
        const pageRoleIds = roleIds.slice(start, start + (options?.limit ?? roleIds.length));
        costs.bodies += pageRoleIds.length;
        const next = start + pageRoleIds.length;
        return { coverage: 'complete' as const, items: pageRoleIds.map(artifact),
          ...(next < roleIds.length ? { nextCursor: String(next) } : {}) };
      },
    },
  });
  return { read, costs,
    revise: () => { instructions = 'SELECTED_SECOND_REVISION'; bodyVersion++; },
    revoke: () => { available = false; },
  };
}

describe('session role prompt-plan context', () => {
  it.each([
    { roleId: 'builder', bodiesPerPrompt: 0 },
    { roleId: 'selected-role', bodiesPerPrompt: 1 },
    { roleId: 'plugin:external-roles/builder', bodiesPerPrompt: 0 },
  ])('reads only selected Role bodies for nondelegating $roleId prompts and renders fresh revisions', async ({ roleId, bodiesPerPrompt }) => {
    const boundary = createPromptRoleInventoryBoundary();
    let settingsOverrides: Record<string, RoleInstructionsOverrideV1> = {};
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId, overrides: {}, sessionRoles: {}, notes: '',
    } } }), readOrganization: async () => ({}), readRoleSources: boundary.read,
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: settingsOverrides }), readDefaultEngine: () => defaultEngine });
    const first = renderSessionRoleBlockV1((await owner.resolvePromptContext())!);
    expect(first).toContain(roleId === 'builder' ? BUILT_IN_ROLES_V1.builder.instructions : 'SELECTED_FIRST_REVISION');
    expect(boundary.costs).toEqual({ pages: 0, bodies: bodiesPerPrompt });
    expect(() => owner.readResolvedRoles()).toThrow('role_source_incomplete');
    boundary.revise();
    if (roleId === 'builder') settingsOverrides = { builder: { roleId, instructionsOverride: 'SELECTED_SECOND_REVISION' } };
    const updated = renderSessionRoleBlockV1((await owner.resolvePromptContext())!);
    expect(updated).toContain('SELECTED_SECOND_REVISION');
    expect(updated).not.toContain('SELECTED_FIRST_REVISION');
    expect(boundary.costs).toEqual({ pages: 0, bodies: 2 * bodiesPerPrompt });
    if (roleId !== 'builder') {
      boundary.revoke();
      await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_target_unavailable' });
      expect(owner.readWorkspaceWrites()).toBe('deny');
      expect(boundary.costs).toEqual({ pages: 0, bodies: 2 * bodiesPerPrompt });
    }
  });

  it.each([false, true])('rechecks a Role selection changed during a source read and honors cancellation (%s)', async cancel => {
    let roleId = 'selected-role';
    const controller = new AbortController();
    const boundary = createPromptRoleInventoryBoundary(() => {
      roleId = 'unrelated-role-1000';
      if (cancel) controller.abort(new Error('selection preparation cancelled'));
    });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId, overrides: {}, sessionRoles: {}, notes: '',
    } } }), readOrganization: async () => ({}), readRoleSources: boundary.read,
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    if (cancel) await expect(owner.resolvePromptContext(controller.signal)).rejects.toThrow('selection preparation cancelled');
    const current = renderSessionRoleBlockV1((await owner.resolvePromptContext(cancel ? undefined : controller.signal))!);
    expect(current).toContain('role_id="unrelated-role-1000"');
    expect(current).not.toContain('role_id="selected-role"');
    expect(boundary.costs).toEqual({ pages: 0, bodies: 2 });
    expect(() => owner.readResolvedRoles()).toThrow('role_source_incomplete');
  });

  it.each(['settings', 'session'] as const)('loads callable Roles only for the resolved %s delegation trait and keeps complete child snapshots', async layer => {
    const boundary = createPromptRoleInventoryBoundary();
    const roleId = 'plugin:external-roles/builder';
    let canDelegateToOtherRoles = false;
    const overrides = (): Record<string, RoleInstructionsOverrideV1> => ({ [roleId]: { roleId, canDelegateToOtherRoles } });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId, overrides: layer === 'session' ? overrides() : {}, sessionRoles: {}, notes: '',
    } } }), readOrganization: async () => ({}), readRoleSources: boundary.read,
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: layer === 'settings' ? overrides() : {} }),
      readDefaultEngine: () => defaultEngine });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).not.toContain('unrelated-role-1000');
    expect(boundary.costs).toEqual({ pages: 0, bodies: 0 });
    canDelegateToOtherRoles = true;
    const delegating = renderSessionRoleBlockV1((await owner.resolvePromptContext())!);
    expect(delegating).toContain('session.spawn_new {"roleId":"unrelated-role-1000"}');
    expect(boundary.costs).toEqual({ pages: 3, bodies: 1_002 });
    canDelegateToOtherRoles = false;
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).not.toContain('unrelated-role-1000');
    expect(boundary.costs).toEqual({ pages: 3, bodies: 1_002 });
    expect(() => owner.readResolvedRoles()).toThrow('role_source_incomplete');
    const roles = await owner.resolveRoles(snapshotInputs);
    const snapshot = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles });
    expect(snapshot.sessionRoles['unrelated-role-1000']?.instructions).toBe('SELECTED_FIRST_REVISION');
    expect(snapshot.sessionRoles[roleId]?.canDelegateToOtherRoles).toBe(false);
    expect(owner.readResolvedRoles()).toEqual(roles);
    expect(boundary.costs).toEqual({ pages: 6, bodies: 2_004 });
  });

  it.each(['plain', 'e2ee'] as const)('opens selected %s Roles without unrelated inventory and preserves fresh mode refusal', async mode => {
    const secret = randomBytes(32);
    const credentials = { token: 'selected-role-token', encryption: mode === 'plain' ? null : {
      type: 'dataKey' as const, publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } };
    const key = await createResourceDataKey({ credentials, mode });
    const seal = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, key.dataKey));
    let accountMode = mode;
    let bodyVersion = 1;
    let instructions = 'Selected first revision';
    const paths: string[] = [];
    const controller = new AbortController();
    let cancel = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/v1/artifacts/selected-role/access/recipients') return { status: 200, data: {
        artifactId: 'selected-role', ownerAccountId: 'account', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: key.dataEncryptionKey, callerDataEncryptionKey: key.dataEncryptionKey, recipients: [],
      } };
      if (path !== '/v1/artifacts/selected-role') throw new Error('Unrelated locked Artifact inventory');
      if (cancel) controller.abort(new Error('cancelled'));
      return { status: 200, data: { id: 'selected-role', ownerAccountId: 'account', access: 'owner',
        encryptionMode: mode, publicAudience: 'none', dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
        header: seal({ kind: 'role.v1' }), body: seal({ body: JSON.stringify({ ...BUILT_IN_ROLES_V1.builder, instructions }) }),
        headerVersion: 1, bodyVersion, seq: bodyVersion, createdAt: 1, updatedAt: bodyVersion } };
    });
    const read = createRoleSourceReader({ readPluginRoles: () => [], artifactStore: createAccountArtifactStore({
      credentials, getAccountEncryptionMode: async () => accountMode,
    }) });
    expect((await read(undefined, { roleIds: ['selected-role'] })).entries).toMatchObject([
      { roleId: 'selected-role', role: { instructions }, revision: { headerVersion: 1, bodyVersion: 1 } },
    ]);
    instructions = 'Selected updated revision'; bodyVersion = 2;
    expect((await read(undefined, { roleIds: ['selected-role'] })).entries).toMatchObject([
      { roleId: 'selected-role', role: { instructions }, revision: { headerVersion: 1, bodyVersion: 2 } },
    ]);
    expect(paths).toEqual(Array.from({ length: 2 }, () => ['/v1/artifacts/selected-role',
      ...(mode === 'e2ee' ? ['/v1/artifacts/selected-role/access/recipients'] : [])]).flat());
    accountMode = mode === 'plain' ? 'e2ee' : 'plain';
    await expect(read(undefined, { roleIds: ['selected-role'] })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    accountMode = mode;
    cancel = true;
    await expect(read(controller.signal, { roleIds: ['selected-role'] })).rejects.toThrow('cancelled');
  });

  it('keeps selected demand independent of a concurrent complete catalog read on the same signal', async () => {
    const release = createDeferred<void>();
    const paths: string[] = [];
    const row = { id: 'selected-role', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ kind: 'role.v1' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(BUILT_IN_ROLES_V1.builder) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/v1/artifacts') { await release.promise; return { status: 200, data: artifactListResponse(String(input), [row]) }; }
      if (path === '/v1/artifacts/selected-role') return { status: 200, data: row };
      throw new Error(`Unexpected Artifact request: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path !== '/v1/artifacts/read') throw new Error(`Unexpected Artifact request: ${path}`);
      return { status: 200, data: { items: [{ artifactId: row.id, ok: true, artifact: row, recipientCensus: null }] } };
    });
    const read = createRoleSourceReader({ readPluginRoles: () => [], artifactStore: createAccountArtifactStore({
      credentials: { token: 'same-signal-role-token', encryption: null }, getAccountEncryptionMode: async () => 'plain',
    }) });
    const signal = new AbortController().signal;
    const complete = read(signal);
    const selected = read(signal, { roleIds: ['selected-role'] });
    const empty = read(signal, { roleIds: [] });
    const observations = Promise.all([complete, selected, empty]);
    release.resolve();
    const [allRoles, selectedRoles, noRoles] = await observations;
    expect(allRoles.entries).toHaveLength(Object.keys(BUILT_IN_ROLES_V1).length + 1);
    expect(selectedRoles.entries.map(entry => entry.roleId)).toEqual(['selected-role']);
    expect(noRoles.entries).toEqual([]);
    expect(paths).toEqual(['/v1/artifacts', '/v1/artifacts/selected-role']);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'database_connection_unavailable'])('keeps a transient Home Role read pending without falling back to a Role set (%s)', async code => {
    vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('PRIVATE_NETWORK_DETAIL'), { code }));
    const artifactStore = createAccountArtifactStore({ credentials: { token: 'role-read-test-token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '',
    } } }), readOrganization: async () => ({}),
      readRoleSources: createRoleSourceReader({ readPluginRoles: () => [], artifactStore }),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    const error: unknown = await owner.resolveRoles(snapshotInputs).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'preparation_pending', reason: 'unavailable' });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error })).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
    expect(() => owner.readResolvedRoles()).toThrow('role_source_incomplete');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_NETWORK_DETAIL');
    expect(String(error)).not.toContain('PRIVATE_NETWORK_DETAIL');
  });

  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('shares concurrent complete snapshots and reads fresh selected prompt revisions independently', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let selectedReads = 0;
    let instructions = 'FIRST_ARTIFACT';
    const readSources = createRoleSourceReader({ readPluginRoles: () => [], artifactStore: {
      read: async artifactId => {
        selectedReads++;
        return { artifactId, ownerAccountId: 'account', access: 'owner', header: { kind: 'role.v1' },
          body: JSON.stringify({ ...BUILT_IN_ROLES_V1.builder, instructions }), revision: { headerVersion: 1, bodyVersion: selectedReads },
          seq: selectedReads, createdAt: 1, updatedAt: selectedReads };
      },
      list: async () => {
        reads++;
        await pending;
        return { coverage: 'complete', items: [{ artifactId: 'user-role', ownerAccountId: 'account', access: 'owner',
          header: { kind: 'role.v1' }, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
          body: JSON.stringify({ ...BUILT_IN_ROLES_V1.builder, instructions }) }] };
      },
    } });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'user-role', overrides: {}, sessionRoles: {}, notes: '',
    } } }), readOrganization: async () => ({}), readRoleSources: readSources,
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    const roles = owner.resolveRoles(snapshotInputs);
    const concurrentRoles = owner.resolveRoles(snapshotInputs);
    const prompt = owner.resolvePromptContext();
    release();
    expect((await roles)['user-role']?.instructions).toBe('FIRST_ARTIFACT');
    expect((await concurrentRoles)['user-role']?.instructions).toBe('FIRST_ARTIFACT');
    expect((await prompt)?.role?.instructions).toBe('FIRST_ARTIFACT');
    expect(reads).toBe(1);
    instructions = 'EDITED_ARTIFACT';
    expect((await owner.resolvePromptContext())?.role?.instructions).toBe('EDITED_ARTIFACT');
    expect(reads).toBe(1);
    expect(selectedReads).toBe(2);
  });
  it('resolves conversational Role facts without fabricating a coding engine', async () => {
    // The conversational caller has no coding engine; the Role owner must not require one.
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'builder', overrides: { builder: { roleId: 'builder', instructionsOverride: 'VOICE_ROLE' } }, sessionRoles: {}, notes: 'VOICE_NOTES',
    } } }), readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    });
    const context = await owner.resolvePromptContext();
    const rendered = renderSessionRoleBlockV1({ ...context!, modality: 'voice' });
    expect(rendered).toContain('VOICE_ROLE');
    expect(rendered).toContain('VOICE_NOTES');
    expect(context?.role?.engine).toBeUndefined();
  });
  it('demands the actual catalog for first use and explicit recovery without retargeting a retired Account', async () => {
    const credentials: TokenOnlyCredentials = { token: 'first-role-account', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const rawSettings = { rolesV1: { overrides: { builder: { roleId: 'builder', instructionsOverride: 'OLD_RETAINED', workspaceWrites: 'allow' } } } };
    const initial = { source: 'network' as const, settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
    setActiveAccountSettingsSnapshot(initial);
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    let retireDuringRead = false;
    let rowsUnavailable = false;
    // HTTP is the system boundary; storage admission, hydration, publication and Role resolution stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (rowsUnavailable && path === '/v1/account/entity-rows/prompt-library') throw new Error('Home unavailable');
      const data = path === '/v1/account/encryption/currentness'
        ? { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
        : path === '/v1/account/entity-rows/prompt-library'
          ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 7,
              content: { t: 'plain', v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
                builder: { roleId: 'builder', instructionsOverride: 'CURRENT_ROW', workspaceWrites: 'deny' },
              } } } : emptyPromptLibraryRecordV1(key) } })) }
          : (() => { throw new Error(`Unexpected HTTP path: ${path}`); })();
      if (retireDuringRead && path === '/v1/account/entity-rows/prompt-library') {
        setActiveAccountSettingsSnapshot({ ...initial, scopeKey: 'other-account', rawSettings: {} });
      }
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data };
    });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound),
      prepareAccountRoleOverrides: async signal => {
        await prepareActiveAccountRoleOverrides({ credentials, ...bound, signal });
      },
    });
    await runWithServerHttpBaseUrl('http://catalog-home.test', async () => {
      expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_ROW');
      expect(owner.readWorkspaceWrites()).toBe('deny');
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
      beginActivePromptLibraryCatalogRefresh(bound);
      rowsUnavailable = true;
      await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
      rowsUnavailable = false;
      expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_ROW');
      beginActivePromptLibraryCatalogRefresh(bound);
      retireDuringRead = true;
      await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
    });
  });
  it('prepares a catalog-only Role refresh through the current snapshot without a Settings version advance', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'scope-a' });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const catalog = (instructionsOverride: string) => ({ status: 'ready' as const, tombstones: [], diagnostics: [], rows: [{ revision: instructionsOverride === 'FIRST' ? 0 : 1,
      record: { key: 'role-overrides' as const, value: { v: 1 as const, overrides: {
        builder: { roleId: 'builder', workspaceWrites: 'deny' as const, instructionsOverride },
      } } },
    }] });
    commitActivePromptLibraryCatalog({ ...bound, catalog: catalog('FIRST') });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound) });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('FIRST');
    commitActivePromptLibraryCatalog({ ...bound, catalog: catalog('SECOND') });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('SECOND');
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
    beginActivePromptLibraryCatalogRefresh(bound);
    expect(owner.readWorkspaceWrites()).toBe('deny');
    await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
    resetActiveAccountSettingsSnapshotForTests();
  });
  it('uses current typed override admission and refuses unavailable catalogs instead of widening deny', async () => {
    let current: Readonly<{ status: 'ready'; overrides: { builder: { roleId: string; workspaceWrites: 'deny'; instructionsOverride: string } } }>
      | Readonly<{ status: 'unavailable'; reason: string }> = { status: 'ready', overrides: {
        builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'CURRENT_CATALOG' },
      } };
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }),
      readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => current,
    });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_CATALOG');
    expect(owner.readWorkspaceWrites()).toBe('deny');
    current = { status: 'unavailable', reason: 'scope-retired' };
    expect(owner.readWorkspaceWrites()).toBe('deny');
    await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
  });
  it('retains a complete inherited Role snapshot when Account catalog authority is unavailable', async () => {
    const boundary = createPromptRoleInventoryBoundary();
    const inherited = { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', engine: defaultEngine,
      instructions: 'FROZEN_ROLE', workspaceWrites: 'allow' as const, canDelegateToOtherRoles: true };
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'builder', inheritedFrom: 'lead', overrides: {}, sessionRoles: { builder: inherited,
        'plugin:external-roles/builder': { ...BUILT_IN_ROLES_V1.builder, roleId: 'plugin:external-roles/builder', instructions: 'FROZEN_PLUGIN_ROLE' },
      }, notes: '',
    } } }), readOrganization: async () => ({ manager: { sessionId: 'lead' } }),
      readRoleSources: boundary.read, readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => ({ status: 'unavailable', reason: 'catalog-unobserved' }),
    });
    const prompt = await owner.resolvePromptContext();
    expect(renderSessionRoleBlockV1(prompt!)).toContain('FROZEN_ROLE');
    expect(renderSessionRoleBlockV1(prompt!)).toContain('session.spawn_new {"roleId":"plugin:external-roles/builder"}');
    expect(prompt?.availableRoles?.find(role => role.roleId === 'plugin:external-roles/builder')?.instructions).toBe('FROZEN_PLUGIN_ROLE');
    expect(boundary.costs).toEqual({ pages: 0, bodies: 0 });
    expect(owner.readWorkspaceWrites()).toBe('allow');
  });
  it('does not create a Role ceiling after acknowledged Role removal when Account overrides are unavailable', () => {
    const scopeKey = 'native-role-account';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', tombstones: [], diagnostics: [], rows: [{ revision: 1,
      record: { key: 'role-overrides', value: { v: 1, overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } },
    }] } });
    let metadata: unknown = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => ({}),
      readRoleSources: createRoleSourceReaderV1({}), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound) });
    expect(owner.readWorkspaceWrites()).toBe('deny');
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'unavailable', reason: 'unreachable' } });
    expect(owner.readWorkspaceWrites()).toBe('deny');
    // The Session metadata owner has acknowledged removal; unavailable Account
    // overrides cannot invent a selection or keep the removed Role's ceiling.
    metadata = { work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBeUndefined();
    metadata = { work: { sessionRolesV1: { roleId: 'private-role', overrides: {}, sessionRoles: {}, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBe('deny');
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {
      builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', engine: defaultEngine, workspaceWrites: 'allow' },
    }, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBe('allow');
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 17 } } };
    expect(owner.readWorkspaceWrites()).toBe('deny');
  });
  it('resolves live source and session fields for the canonical Session prompt plan', async () => {
    let metadata: SessionMetadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata,
      readOrganization: async () => ({}),
      readRoleSources: async () => ({ status: 'ready', entries: [{ roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false }], diagnostics: [] }),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine,
    });
    const first = await owner.resolvePromptContext();
    expect(renderSessionRoleBlockV1(first!)).toContain(BUILT_IN_ROLES_V1.builder.instructions);
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: { builder: { roleId: 'builder', instructionsOverride: 'CHANGED_ROLE' } }, sessionRoles: {}, notes: 'CURRENT_NOTES' } } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CHANGED_ROLE');
  });

  it('renders a live worker boundary without a selected role and leaves frozen step roles to step input', async () => {
    const scopeKey = 'notes-worker-account';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'unavailable', reason: 'unreachable' } });
    expect(readActiveAccountRoleOverrides(bound)).toMatchObject({ status: 'unavailable' });
    let metadata: SessionMetadata = {};
    let organization: Pick<V2SessionByIdResponse['session'], 'manager' | 'origin'> = { manager: { sessionId: 'lead' } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => organization,
      readRoleSources: createRoleSourceReaderV1({}), readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound),
      readDefaultEngine: () => defaultEngine });
    const workerContext = await owner.resolvePromptContext();
    expect(workerContext).toMatchObject({ availableRoles: [], worker: { leadSessionId: 'lead' } });
    expect(workerContext?.role).toBeUndefined();
    expect(renderSessionRoleBlockV1(workerContext!)).toContain('lead_session_id="lead"');
    metadata = { work: { sessionRolesV1: { inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'TASK_BOUNDARY' } } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('TASK_BOUNDARY');
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).not.toContain('prompt_doc.update');
    organization = { ...organization, origin: { kind: 'run_step' } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toBe('');
    organization = {};
    const detached = renderSessionRoleBlockV1((await owner.resolvePromptContext())!);
    expect(detached).not.toContain('lead_session_id');
    expect(detached).not.toContain('memory');
    expect(detached).toContain('TASK_BOUNDARY');
  });

  it('does not use an inherited snapshot as a live relation when its Home projection is unavailable', async () => {
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      inheritedFrom: 'old-lead', overrides: {}, sessionRoles: {}, notes: 'old boundary',
    } } }), readOrganization: async () => { throw new Error('home unavailable'); },
      readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    await expect(owner.resolvePromptContext()).rejects.toThrow('home unavailable');
  });
});
