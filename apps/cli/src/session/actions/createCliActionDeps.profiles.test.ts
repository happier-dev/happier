import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, ProfileRowMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryMutationRequestV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createCliActionDeps } from './createCliActionDeps';
import { reloadConfiguration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
let fixtureHome: string | undefined;
beforeEach(async () => {
  fixtureHome = await createTempDir('happier-profile-actions-');
  environment.patch({ HAPPIER_HOME_DIR: fixtureHome, HAPPIER_SERVER_URL: 'https://profile-home.test',
    HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: 'https://profile-home.test', HAPPIER_ACTIVE_SERVER_ID: 'profile-home' });
  reloadConfiguration();
  resetActiveAccountSettingsSnapshotForTests();
  resetInMemoryAccountSettingsContextForTests();
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
  resetInMemoryAccountSettingsContextForTests();
  environment.restore();
  reloadConfiguration();
  if (fixtureHome) await removeTempDir(fixtureHome);
  fixtureHome = undefined;
});

describe('CLI Profile entity Action front door', () => {
  it('duplicates a captured MachineLogin source through the canonical closed clone mutation', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'legacy-login', enabled: false, promptStack: [],
      secretBindings: { MASKED: null }, definition: { kind: 'legacy', profile: { id: 'legacy-login', name: 'Login',
        authMode: 'machineLogin', requiresMachineLogin: 'claude', createdAt: 1, updatedAt: 1,
        environmentVariables: [{ name: 'TEAM_FLAG', value: 'keep' }], defaultPermissionModeByAgent: { claude: 'default' } } } });
    if (record.definition.kind !== 'legacy') throw new Error('Expected a captured compatibility source');
    const transferControl = { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, phase: 'active',
      sourceSettingsVersion: 5, migratedLogicalRevision: 0, inventory: [] } } };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        contentKeyFingerprint: null, signingKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 4 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: transferControl };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ id: record.id,
        revision: 3, content: { t: 'plain', v: record } }], nextCursor: null, complete: true, diagnostics: [],
        referenceGuardRevision: 4, transferControl } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      throw new Error(`unexpected_profile_clone_get:${path}`);
    });
    let saved: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      expect(new URL(String(url)).pathname).toBe(PROFILE_RECORDS_ROUTE_V1);
      saved = ProfileRowMutationV1Schema.parse(body);
      return { status: 200, data: { status: 'updated', revision: 0, cursor: 5, referenceGuardRevision: 5 } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    expect(await executor.execute('launch_profiles.duplicate', { id: record.id, expectedRevision: 3,
      newProfileId: 'login-copy', name: 'Copy', now: 20 }, { serverId: 'profile-home', surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { status: 'updated', id: 'login-copy', revision: 0 } });
    expect(saved).toMatchObject({ operation: 'clone-legacy', expectedRevision: 'absent',
      legacyCloneSource: { id: record.id, revision: 3 }, content: { t: 'plain', v: { id: 'login-copy', enabled: false,
        secretBindings: { MASKED: null }, definition: { kind: 'legacy', profile: { ...record.definition.profile,
          id: 'login-copy', name: 'Copy', isBuiltIn: false, createdAt: 20, updatedAt: 20 } } } } });
  });
  it('acknowledges null selection only after its canonical memory CAS without demanding a Profile catalog', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    let selected: string | null = 'other-profile';
    let revision = 2;
    const memoryUrl = `https://profile-home.test${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url) === 'https://profile-home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (String(url) === 'https://profile-home.test/v2/account/settings') return { status: 200,
        data: { version: 5, content: { t: 'plain', v: {} } } };
      if (String(url) === memoryUrl) return { status: 200, data: { status: 'present', revision,
        content: { t: 'plain', v: selected } } };
      throw new Error(`unexpected_null_selection_get:${url}`);
    });
    const memoryPost = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      expect(String(url)).toBe(memoryUrl);
      const mutation = AuthoringMemoryMutationRequestV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe(revision);
      expect(mutation.content).toEqual({ t: 'plain', v: null });
      selected = null; revision += 1;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    expect(await executor.execute('launch_profiles.select', { id: null },
      { serverId: 'profile-home', surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { status: 'selected', id: null } });
    expect(selected).toBeNull();
    const acknowledgedRevision = revision;
    memoryPost.mockResolvedValueOnce({ status: 409, data: { status: 'conflict', revision: revision + 1 } });
    expect(await executor.execute('launch_profiles.select', { id: null },
      { serverId: 'profile-home', surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'authoring_memory_revision_conflict' } });
    expect(revision).toBe(acknowledgedRevision);
    expect(memoryPost).toHaveBeenCalledTimes(2);
  });
  it('reports unavailable coverage instead of a successful empty list when the Profile catalog is incomplete', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        contentKeyFingerprint: null, signingKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 4 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [],
        nextCursor: null, complete: false, diagnostics: [], referenceGuardRevision: 4, transferControl: { status: 'absent' } } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      throw new Error(`unexpected_incomplete_profile_get:${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected_incomplete_profile_write'));
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    const result = await executor.execute('sessions.spawn.profiles.list', {},
      { serverId: 'profile-home', surface: 'cli', bypassApprovals: true });
    expect(result.ok ? true : result).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { items: [], coverage: 'unavailable', truncated: false } });
    expect(post).not.toHaveBeenCalled();
  });
  it('changes only the desired favorite preference against the admitted current Settings winner', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, version: 6 } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { version: 5,
        content: { t: 'plain', v: { favoriteProfiles: ['kept'], profileEnabledById: { kept: false }, futurePreference: { keep: true } } } } };
      throw new Error(`unexpected_favorite_get:${url}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    const favoriteResult = await executor.execute('launch_profiles.favorite.set', { id: 'private', favorite: true },
      { serverId: 'profile-home', surface: 'cli', bypassApprovals: true });
    expect(favoriteResult.ok ? true : favoriteResult).toBe(true);
    expect(favoriteResult)
      .toMatchObject({ ok: true, result: { status: 'updated', id: 'private', favorite: true } });
    expect(post.mock.calls.at(-1)?.[1]).toMatchObject({ expectedVersion: 5, content: { t: 'plain', v: {
      favoriteProfiles: ['private', 'kept'], profileEnabledById: { kept: false }, futurePreference: { keep: true },
    } } });
  });
  it('uses the captured Home row and binds a SavedSecret revision in the same CAS', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    const record = { v: 1, id: 'private', enabled: false, promptStack: [], secretBindings: { EXISTING: 'secret-kept' },
      definition: { kind: 'inline', profile: { v: 2, id: 'private', name: 'Private', createdAt: 1, updatedAt: 1,
        extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} } } };
    const transferControl = { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, phase: 'active',
      sourceSettingsVersion: 5, migratedLogicalRevision: 0, inventory: [] } } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
        features: { teams: { enabled: true } }, capabilities: {},
      }));
      throw new Error(`unexpected_saved_secret_fetch:${path}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(String(url)).toMatch(/^https:\/\/profile-home\.test\//);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        contentKeyFingerprint: null, signingKeyFingerprint: null, updatedAt: 0 } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 4 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: transferControl };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed',
        rows: [{ id: record.id, revision: 3, content: { t: 'plain', v: record } }], nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision: 4, transferControl } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200,
        data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId: 'secret-selected', encryptionMode: 'plain',
          entry: { ref: 'happier:shared-secret:v1:secret-selected', source: 'shared_resource', relationship: 'owner', name: 'Selected',
            kind: 'token', revision: 7, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
          storedContent: { t: 'plain', v: { v: 1, name: 'Selected', kind: 'token', value: 'selected-boundary-value' } }, recipientEnvelope: null }] }) };
      throw new Error(`unexpected_profile_get:${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200,
      data: { status: 'updated', revision: 4, cursor: 4, referenceGuardRevision: 5 } });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    const context = { serverId: 'profile-home', surface: 'cli' as const, bypassApprovals: true };
    const readResult = await executor.execute('launch_profiles.read', { id: 'private' }, context);
    expect(readResult.ok ? true : readResult).toBe(true);
    expect(readResult)
      .toMatchObject({ ok: true, result: { status: 'present', revision: 3, record: { enabled: false } } });
    const bindingResult = await executor.execute('launch_profiles.secrets.select', { id: 'private', expectedRevision: 3, envName: 'TOKEN',
      selection: { kind: 'resource', resourceId: 'secret-selected', expectedResourceRevision: 7 } }, context);
    expect(bindingResult, JSON.stringify(bindingResult))
      .toMatchObject({ ok: true, result: { status: 'updated', id: 'private', revision: 4 } });
    const [mutationUrl, mutationBody] = post.mock.calls.at(-1) ?? [];
    expect(mutationUrl).toBe(`https://profile-home.test${PROFILE_RECORDS_ROUTE_V1}`);
    expect(ProfileRowMutationV1Schema.parse(mutationBody)).toMatchObject({
      id: 'private', expectedRevision: 3, content: { t: 'plain', v: { ...record,
        secretBindings: { EXISTING: 'secret-kept', TOKEN: 'happier:shared-secret:v1:secret-selected' } } },
      savedSecretRevisions: [{ resourceId: 'secret-selected', expectedRevision: 7 }],
    });
  });
  it('publishes the canonical private row without copying private metadata into the Artifact or writing a Settings mirror', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'profiles-account' })).toString('base64url')}.signature`;
    const record = { v: 1, id: 'private', enabled: false, secretBindings: {},
      promptStack: [{ id: 'private-stack', ref: { kind: 'doc', artifactId: 'private-doc' }, enabled: true, placement: 'system_append' }],
      definition: { kind: 'inline', profile: { v: 2, id: 'private', name: 'Private', createdAt: 1, updatedAt: 1,
        extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} } } };
    const artifactRows = new Map<string, Readonly<Record<string, unknown>>>();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        contentKeyFingerprint: null, signingKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 4 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ id: record.id, revision: 3,
        content: { t: 'plain', v: record } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 4,
        transferControl: { status: 'absent' } } };
      if (path === '/v1/artifacts') return { status: 200, data: [...artifactRows.values()] };
      if (path.startsWith('/v1/artifacts/')) {
        const row = artifactRows.get(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
        if (row) return { status: 200, data: row };
      }
      throw new Error(`unexpected_publish_get:${path}`);
    });
    let artifactId: string | undefined;
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') {
        if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string') throw new Error('invalid_artifact_create_fixture');
        artifactId = body.id;
        artifactRows.set(body.id, { ...body, ownerAccountId: 'profiles-account', access: 'owner', encryptionMode: 'plain',
          publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: artifactId, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path === PROFILE_RECORDS_ROUTE_V1) return { status: 200,
        data: { status: 'updated', revision: 4, cursor: 4, referenceGuardRevision: 5 } };
      throw new Error(`unexpected_publish_post:${path}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'profile-home', serverHttpBaseUrl: 'https://profile-home.test' }));
    const result = await executor.execute('launch_profiles.publish', { profileId: 'private' },
      { serverId: 'profile-home', surface: 'cli', bypassApprovals: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId } });
    expect(artifactId).toBeTypeOf('string');
    expect(post.mock.calls.find(([url]) => new URL(String(url)).pathname === PROFILE_RECORDS_ROUTE_V1)?.[1])
      .toMatchObject({ id: 'private', expectedRevision: 3, content: { t: 'plain', v: { ...record,
        definition: { kind: 'artifact', artifactId } } } });
    expect(post.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v2/account/settings')).toBe(false);
    const created = post.mock.calls.find(([url]) => new URL(String(url)).pathname === '/v1/artifacts')?.[1];
    if (!created || typeof created !== 'object' || !('body' in created) || typeof created.body !== 'string') throw new Error('artifact_create_receipt_missing');
    const openedBody = decodePlainArtifactStoredContent(created.body);
    expect(openedBody).toMatchObject({ body: expect.any(String) });
    expect(JSON.stringify(openedBody)).not.toContain('private-stack');
    expect(JSON.stringify(openedBody)).not.toContain('private-doc');
  });
});
