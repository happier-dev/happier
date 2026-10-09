import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2UpdateRequestSchema, AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ProfileTransferMutationV1Schema, type ProfileTransferRowReadResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshActiveProfileCatalog } from './hydrateProfileCatalog';
import { readAccountLaunchProfiles } from './readProfilesFromAccountSettings';
import { resolveCanonicalSpawnProfile } from './validateSpawnProfile';
import { resolveSpawnLaunchProfileDefaults } from '@/daemon/spawn/resolveSpawnLaunchProfileDefaults';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as persistence from '@/persistence';
import { refreshDemandedActiveProfileCatalog } from './hydrateProfileCatalog';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('CLI Profile catalog hydration', () => {
  it('reobserves a demanded catalog when an Account row wake overtakes its final admission read', async () => {
    const credentials = { token: 'profile-wake-during-read', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    // Stored credentials are the filesystem boundary; catalog admission and publication stay real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    let revision = 1;
    let currentnessReads = 0;
    let releaseAdmission!: () => void;
    const admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        currentnessReads += 1;
        if (currentnessReads === 3) await admission;
        return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
      if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed',
        rows: [{ id: 'changed', revision, content: { t: 'plain', v: ProfileRecordV1Schema.parse({ v: 1,
          id: 'changed', enabled: revision === 1, promptStack: [], secretBindings: {},
          definition: { kind: 'inline', profile: { v: 2, id: 'changed', name: 'Current', createdAt: 1, updatedAt: 1 } },
        }) } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: revision,
        transferControl: { status: 'absent' } } };
      throw new Error(`Unexpected Profile wake boundary: ${path}`);
    });
    const pending = refreshActiveProfileCatalog({ credentials });
    try {
      await vi.waitFor(() => expect(currentnessReads).toBe(3));
      revision = 2;
      const wake = refreshDemandedActiveProfileCatalog({ token: credentials.token });
      releaseAdmission();
      await Promise.all([pending, wake]);
      expect(getActiveAccountSettingsSnapshot()?.profileCatalog).toMatchObject({ status: 'ready',
        referenceGuardRevision: 2, records: [{ revision: 2, record: { enabled: false } }] });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    } finally { releaseAdmission(); await pending; }
  });
  it('refreshes an admitted requester Profile catalog without publishing or borrowing the custodian Account', async () => {
    const credentials = { token: 'bob-profile', encryption: null };
    const alice = { token: 'alice-profile', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 8,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(alice) });
    const before = getActiveAccountSettingsSnapshot();
    let live = true;
    const transfer = { status: 'present' as const, revision: 2, content: { t: 'plain' as const,
      v: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 7, migratedLogicalRevision: 7,
        inventory: [{ kind: 'account_row' as const, id: 'bob-row', revision: 1 }] } } };
    const operationContext = runWithServerHttpBaseUrl('https://bob-home.test', () => createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
      serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => live }));
    vi.spyOn(axios, 'get').mockImplementation(async (input, config) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://bob-home.test');
      expect(config?.headers?.Authorization).toBe('Bearer bob-profile');
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 1 } };
      if (url.pathname.endsWith('/transfer')) return { status: 200, data: transfer };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (url.pathname === '/v1/account/entity-rows/prompt-library') return { status: 404, data: {} };
      if (url.pathname === '/v1/account/entity-rows/profiles') return { status: 200, data: {
        status: 'listed', rows: [{ id: 'bob-row', revision: 1, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
          v: 1, id: 'bob-row', enabled: true, promptStack: [], secretBindings: {},
          definition: { kind: 'inline', profile: { v: 2, id: 'bob-row', name: 'Bob', createdAt: 1, updatedAt: 1 } },
        }) } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: transfer,
      } };
      throw new Error(`Unexpected requester Profile read: ${url.pathname}`);
    });
    const input = { credentials, operationContext };
    const refreshed = await refreshActiveProfileCatalog(input);
    expect(refreshed).toMatchObject({ status: 'ready', source: 'destination', records: [{ record: { id: 'bob-row' } }] });
    expect(operationContext.readSnapshot()?.profileCatalog).toBe(refreshed);
    expect(getActiveAccountSettingsSnapshot()).toBe(before);
    live = false;
    expect(await refreshActiveProfileCatalog(input)).toMatchObject({ status: 'unavailable', reason: 'scope-retired' });
  });
  it('loads all pages and publishes row-only refreshes independently of Settings revision', async () => {
    const credentials = { token: 'profile-catalog-test', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    let revision = 1;
    const row = (index: number) => ({ id: `row-${index}`, revision,
      content: { t: 'plain', v: ProfileRecordV1Schema.parse({ v: 1, id: `row-${index}`, enabled: revision === 1,
        definition: { kind: 'inline', profile: { v: 2, id: `row-${index}`, name: `Row ${index}`, createdAt: 1, updatedAt: 1 } },
        promptStack: [], secretBindings: index === 256 ? { TOKEN: 'happier:shared-secret:v1:last' } : {},
      }) } });
    // Only the Home HTTP boundary is replaced; admission, paging, opening and publication stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
      if (url.pathname.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (url.pathname === '/v1/account/entity-rows/profiles') return { status: 200, data: {
        status: 'listed', rows: url.searchParams.has('cursor') ? [row(256)] : Array.from({ length: 256 }, (_, index) => row(index)),
        nextCursor: url.searchParams.has('cursor') ? null : 'last', complete: true, diagnostics: [],
        referenceGuardRevision: revision, transferControl: { status: 'absent' },
      } };
      throw new Error(`Unexpected Profile catalog request: ${url.pathname}`);
    });
    const first = await refreshActiveProfileCatalog({ credentials });
    expect(first.status === 'unavailable' ? first.reason : null).toBeNull();
    expect(first).toMatchObject({ status: 'ready', authority: 'inactive', source: 'destination' });
    expect(first.status === 'ready' && first.records).toHaveLength(257);
    expect(first.status === 'ready' && first.records.at(-1)?.record.secretBindings)
      .toEqual({ TOKEN: 'happier:shared-secret:v1:last' });
    revision = 2;
    const refreshed = await refreshActiveProfileCatalog({ credentials });
    expect(refreshed.status === 'ready' && refreshed.records[0]?.record.enabled).toBe(false);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    expect(getActiveAccountSettingsSnapshot()?.profileCatalog).toBe(refreshed);
  });
});

it('demand reads use refreshed active rows without any Settings definition or revision advance', async () => {
  const credentials = { token: 'demand-test', encryption: null };
  const settings = accountSettingsParse({ profiles: [{ v: 2, id: 'focused', name: 'Stale', createdAt: 1, updatedAt: 1 }] });
  setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  let revision = 1;
  const control = { status: 'present' as const, revision: 1, content: { t: 'plain' as const,
    v: { v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } } };
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
    if (path.endsWith('/transfer')) return { status: 200, data: control };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: {
      status: 'listed', rows: [{ id: 'focused', revision, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
        v: 1, id: 'focused', enabled: revision === 1, promptStack: [], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Destination', createdAt: 1, updatedAt: 1 } },
      }) } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: revision, transferControl: control } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 7 } };
    throw new Error(`Unexpected demand read: ${path}`);
  });
  const first = await readAccountLaunchProfiles(settings, credentials);
  expect(first.profiles.find((profile) => profile.id === 'focused')).toMatchObject({ name: 'Destination', enabled: true, profileRecordRevision: 1 });
  revision = 2;
  const next = await readAccountLaunchProfiles(settings, credentials);
  expect(next.profiles.find((profile) => profile.id === 'focused')).toMatchObject({ enabled: false, profileRecordRevision: 2 });
  expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
});

it('selects the exact inherited identity returned by the admitted Account reader', async () => {
  const credentials = { token: 'exact-retained-profile', encryption: null };
  const id = `  legacy/branch\\資料/😀-${'x'.repeat(300)}  `;
  const settings = accountSettingsParse({});
  const record = ProfileRecordV1Schema.parse({ v: 1, id, enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'legacy', profile: { id, name: 'Exact inherited identity', environmentVariables: [], createdAt: 1, updatedAt: 1 } } });
  setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 1 } };
    if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed',
      rows: [{ id, revision: 1, content: { t: 'plain', v: record } }], nextCursor: null, complete: true,
      diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
    throw new Error(`Unexpected exact identity boundary: ${path}`);
  });
  const profilesSnapshot = await readAccountLaunchProfiles(settings, credentials);
  const selected = profilesSnapshot.visibleProfiles.find(profile => profile.id === id);
  expect(selected).toMatchObject({ id, profileRecordRevision: 1 });
  const input = { rawSettings: settings, profileId: selected?.id,
    expectedProfileRecordRevision: selected?.profileRecordRevision, profilesSnapshot,
    profileCatalog: getActiveAccountSettingsSnapshot()?.profileCatalog };
  expect(resolveCanonicalSpawnProfile(input)).toMatchObject({ ok: true, kind: 'legacy' });
  const options = { directory: '/repo', profileId: selected?.id,
    backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' } } satisfies SpawnSessionOptions;
  expect(resolveSpawnLaunchProfileDefaults({ ...input, options, effectiveBackendTarget: options.backendTarget })).toMatchObject({ ok: true });
  expect(resolveCanonicalSpawnProfile({ ...input, profileId: id.trim() })).toMatchObject({ ok: false });
});

it.each(['enabled', 'remembered'] as const)('admits a visible native builtin preset from captured %s evidence without inventing a private membership row', async evidence => {
  const credentials = { token: 'native-builtin-read', encryption: null };
  const profileId = 'gemini-api-key';
  let raw: Record<string, unknown> = evidence === 'enabled' ? { profileEnabledById: { [profileId]: true } } : {};
  let lastUsedProfile: string | null = evidence === 'remembered' ? profileId : null;
  let settingsVersion = 7;
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [],
      nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: raw }, version: settingsVersion } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: lastUsedProfile === null
      ? { status: 'absent' } : { status: 'present', revision: 1, content: { t: 'plain', v: lastUsedProfile } } };
    throw new Error(`Unexpected native builtin read: ${path}`);
  });
  const capture = async () => {
    const settings = accountSettingsParse(raw);
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: raw, settingsVersion,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const profilesSnapshot = await readAccountLaunchProfiles(settings, credentials);
    return { rawSettings: settings, profileId, profilesSnapshot, profileCatalog: getActiveAccountSettingsSnapshot()?.profileCatalog };
  };
  const input = await capture();
  expect(input.profilesSnapshot.visibleProfiles.some(profile => profile.id === profileId)).toBe(true);
  expect(input.profileCatalog).toMatchObject({ status: 'ready', source: 'destination', authority: 'inactive', records: [] });
  expect(resolveCanonicalSpawnProfile(input)).toMatchObject({ ok: true, kind: 'legacy' });
  const options = { directory: '/repo', profileId,
    backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' } } satisfies SpawnSessionOptions;
  expect(resolveSpawnLaunchProfileDefaults({ ...input, options, effectiveBackendTarget: options.backendTarget })).toMatchObject({ ok: true });
  // Supplied raw preferences are not a second decision-maker after capture.
  expect(resolveCanonicalSpawnProfile({ ...input, rawSettings: {} })).toMatchObject({ ok: true, kind: 'legacy' });
  expect(resolveCanonicalSpawnProfile({ ...input, expectedProfileRecordRevision: 1 })).toMatchObject({ ok: false });
  raw = {};
  lastUsedProfile = null;
  settingsVersion += 1;
  expect(resolveCanonicalSpawnProfile(await capture())).toMatchObject({ ok: false });
  raw = { favoriteProfiles: [profileId], profileEnabledById: { [profileId]: false } };
  settingsVersion += 1;
  expect(resolveCanonicalSpawnProfile(await capture())).toMatchObject({ ok: false });
});

it.each(['applied', 'conflict'] as const)('cleans transferred source and retained history under the original active control while keeping destination admission on history %s', async historyResult => {
  const credentials = { token: 'transfer-demand-test', encryption: null };
  let raw: Record<string, unknown> = { profiles: [{ v: 2, id: 'retained', name: 'Retained', createdAt: 1, updatedAt: 1 }],
    futurePreference: { preserve: true } };
  let settingsVersion = 7;
  let historyContent = { t: 'plain' as const, v: raw };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  let control: ProfileTransferRowReadResponseV1 = { status: 'absent' };
  let rows: ReadonlyArray<{ id: string; revision: number; content: unknown }> = [];
  const operations: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: rows.length ? 0 : 'absent' } };
    if (path.endsWith('/transfer')) return { status: 200, data: control };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: raw }, version: settingsVersion } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 404, data: {} };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
      version: 7, contentKind: 'plain', byteLength: 100, createdAt: '2026-01-01T00:00:00.000Z' }] } };
    if (path === '/v2/account/settings/history/7') return { status: 200, data: {
      version: 7, content: historyContent, createdAt: '2026-01-01T00:00:00.000Z' } };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows,
      nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: rows.length ? 0 : 'absent', transferControl: control } };
    throw new Error(`Unexpected transfer read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/account/settings') {
      const request = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(request).toMatchObject({ expectedVersion: 7, expectedProfileTransferRevision: 2,
        content: { t: 'plain', v: { futurePreference: { preserve: true } } } });
      if (request.content?.t !== 'plain') throw new Error('Expected actual Plain source cleanup envelope');
      raw = request.content.v;
      settingsVersion = 8;
      operations.push('source-cleanup');
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    if (path === '/v2/account/settings/history/7/mutate') {
      const request = AccountSettingsV2HistoryMutationRequestSchema.parse(body);
      expect(request).toMatchObject({ expectedSettingsVersion: 8, expectedProfileTransferRevision: 2,
        expectedContent: historyContent, operation: { kind: 'normalize', transferredProfileIds: ['retained'],
          removedRoots: ['profiles', 'secretBindingsByProfileId'], content: { t: 'plain', v: { futurePreference: { preserve: true } } } } });
      if (request.operation.kind !== 'normalize' || request.operation.content.t !== 'plain') {
        throw new Error('Expected actual Plain retained-history normalization');
      }
      if (historyResult === 'applied') historyContent = request.operation.content;
      operations.push('history-normalize');
      return { status: 200, data: { status: historyResult } };
    }
    expect(path).toBe('/v1/account/entity-rows/profiles/transfer');
    const mutation = ProfileTransferMutationV1Schema.parse(body);
    operations.push(mutation.operation);
    if (mutation.operation === 'prepare') rows = mutation.imports.map((row) => ({ id: row.id, revision: 0, content: row.content }));
    control = { status: 'present', revision: mutation.operation === 'prepare' ? 1 : 2, content: mutation.content };
    return { status: 200, data: { status: 'updated', revision: control.revision, cursor: control.revision } };
  });
  const catalog = await refreshActiveProfileCatalog({ credentials });
  expect(catalog).toMatchObject({ status: 'ready', source: 'destination', authority: 'active', records: [{ revision: 0, record: { id: 'retained' } }] });
  expect(raw).toEqual({ futurePreference: { preserve: true } });
  expect(operations).toEqual(['prepare', 'activate', 'source-cleanup', 'history-normalize']);
  expect(historyContent.v).toEqual(historyResult === 'applied' ? raw
    : { profiles: [{ v: 2, id: 'retained', name: 'Retained', createdAt: 1, updatedAt: 1 }], futurePreference: { preserve: true } });
});

it('reads the full captured predecessor source rather than its bounded preference projection', async () => {
  const credentials = { token: 'retained-source-read', encryption: null };
  const raw = { profiles: Array.from({ length: 257 }, (_, index) => ({ v: 2, id: `retained-${index}`,
    name: `Retained ${index}`, createdAt: 1, updatedAt: 1 })),
    secretBindingsByProfileId: { 'retained-256': { TOKEN: 'last-secret' } } };
  const catalog = { status: 'ready' as const, source: 'legacy' as const, authority: 'inactive' as const,
    control: null, controlRevision: 'absent' as const, records: [], diagnostics: [], referenceGuardRevision: 'absent' as const };
  const settings = accountSettingsParse({});
  setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: raw, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials), profileCatalog: catalog });
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: raw }, version: 7 } };
    throw new Error(`Unexpected retained source read: ${path}`);
  });
  const result = await readAccountLaunchProfiles(settings, credentials, undefined, catalog);
  expect(result.profiles).toHaveLength(257);
  expect(result.secretBindingsByProfileId['retained-256']).toEqual({ TOKEN: 'last-secret' });
});

it('refuses to disclose a captured Profile after Account retirement during Artifact hydration', async () => {
  const credentials = { token: 'retired-profile-read', encryption: null };
  const settings = accountSettingsParse({});
  const catalog = { status: 'ready' as const, source: 'destination' as const, authority: 'inactive' as const,
    control: null, controlRevision: 'absent' as const, diagnostics: [], referenceGuardRevision: 1,
    records: [{ revision: 1, record: ProfileRecordV1Schema.parse({ v: 1, id: 'private', enabled: true, promptStack: [],
      secretBindings: {}, definition: { kind: 'inline', profile: { v: 2, id: 'private', name: 'Private', createdAt: 1, updatedAt: 1 } } }) }] };
  setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 7, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials), profileCatalog: catalog });
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/artifacts') {
      resetActiveAccountSettingsSnapshotForTests();
      return { status: 200, data: [] };
    }
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
    throw new Error(`Unexpected retired Profile read: ${path}`);
  });
  await expect(readAccountLaunchProfiles(settings, credentials, undefined, catalog))
    .rejects.toMatchObject({ code: 'profile_catalog_unavailable' });
  // Supplying the old admitted catalog cannot revive its retired Account.
  await expect(readAccountLaunchProfiles(settings, credentials, undefined, catalog))
    .rejects.toMatchObject({ code: 'profile_catalog_unavailable' });
});
