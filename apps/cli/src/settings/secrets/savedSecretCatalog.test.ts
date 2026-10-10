import { afterEach, describe, expect, it } from 'vitest';

import {
  encryptSecretStringV1,
  sealSavedSecretResourceStoredContentV1,
  accountSettingsParse,
} from '@happier-dev/protocol';

import { createSavedSecretMaterializerV1, createSavedSecretMaterializerFromSnapshotV1, readSavedSecretRevisionsFromSnapshotV1 } from './savedSecretCatalog';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, commitActiveSavedSecretCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const key = new Uint8Array(32).fill(7);
const randomBytes = (length: number) => new Uint8Array(length).fill(3);

describe('Saved Secret catalog materializer', () => {
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());

  it('projects exact resource destination revisions without exporting credential material or guessing personal row revisions', () => {
    const ref = 'happier:shared-secret:v1:destination';
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId: 'destination', mode: 'plain',
      content: { v: 1, name: 'Destination', kind: 'token', value: 'not-transfer-metadata' },
    });
    const resources = [{
      resourceId: 'destination', ownerAccountId: 'owner', displayName: 'Destination', kind: 'token' as const,
      encryptionMode: 'plain' as const, revision: 7, storedContent, materialStatus: 'ready' as const,
    }];
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'home:owner',
      savedSecretResources: resources, savedSecretCatalogState: 'ready',
    });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, [ref, ref])).toEqual({
      status: 'ready', resourcesByRef: new Map([[ref, { resourceId: 'destination', revision: 7 }]]),
    });
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, ['personal-key'])).toEqual({ status: 'partial' });
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, ['happier:shared-secret:v1:missing'])).toEqual({ status: 'partial' });
    setActiveAccountSettingsSnapshot({
      ...snapshot, settingsVersion: 2,
      settings: accountSettingsParse({ secrets: [{
        id: ref, name: 'Reserved personal', kind: 'token', createdAt: 1, updatedAt: 99,
        encryptedValue: { _isSecretValue: true, value: 'personal-material' },
      }] }),
    });
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, [ref])).toEqual({ status: 'unavailable' });
    expect(readSavedSecretRevisionsFromSnapshotV1(getActiveAccountSettingsSnapshot(), [ref])).toEqual({ status: 'partial' });
  });

  it('keeps resource revision inventory incompleteness distinct from catalog unavailability', () => {
    const ref = 'happier:shared-secret:v1:destination';
    expect(readSavedSecretRevisionsFromSnapshotV1(null, [])).toEqual({ status: 'ready', resourcesByRef: new Map() });
    expect(readSavedSecretRevisionsFromSnapshotV1(null, [ref])).toEqual({ status: 'unavailable' });
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'home:owner',
      savedSecretResources: [], savedSecretCatalogState: 'temporarily_unavailable',
    });
    expect(readSavedSecretRevisionsFromSnapshotV1(getActiveAccountSettingsSnapshot(), [ref])).toEqual({ status: 'unavailable' });
    commitActiveSavedSecretCatalog({
      scopeKey: 'home:owner', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      resources: [{
        resourceId: 'destination', ownerAccountId: 'owner', displayName: 'Destination', kind: 'token',
        encryptionMode: 'plain', revision: 7, storedContent: null, materialStatus: 'access_removed',
      }], state: 'ready',
    });
    expect(readSavedSecretRevisionsFromSnapshotV1(getActiveAccountSettingsSnapshot(), [ref])).toEqual({ status: 'partial' });
  });

  it('projects an admitted invocation revision without ambient publication and refuses its retired lifetime', () => {
    const ref = 'happier:shared-secret:v1:bootstrap-key';
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'home:owner', savedSecretCatalogState: 'ready' as const,
      savedSecretResources: [{ resourceId: 'bootstrap-key', ownerAccountId: 'owner', displayName: 'Bootstrap', kind: 'other' as const,
        encryptionMode: 'plain' as const, revision: 7, storedContent: null, materialStatus: 'ready' as const }] };
    let current = true;
    const admission = { isCurrent: () => current };
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, [ref], admission)).toEqual({ status: 'ready',
      resourcesByRef: new Map([[ref, { resourceId: 'bootstrap-key', revision: 7 }]]) });
    current = false;
    expect(readSavedSecretRevisionsFromSnapshotV1(snapshot, [ref], admission)).toEqual({ status: 'unavailable' });
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
  });

  it('reopens one persisted bootstrap reference with the same key and refuses retired, revoked or mode-changed material', () => {
    const ref = 'happier:shared-secret:v1:bootstrap-key';
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId: 'bootstrap-key', mode: 'plain',
      content: { v: 1, name: 'Bootstrap key', kind: 'other', value: 'private-bootstrap-key' },
    });
    const resources = [{
      resourceId: 'bootstrap-key', ownerAccountId: 'owner', displayName: 'Bootstrap key', kind: 'other' as const,
      encryptionMode: 'plain' as const, revision: 1, storedContent, materialStatus: 'ready' as const,
    }];
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'home:owner',
      savedSecretResources: resources, savedSecretCatalogState: 'ready',
    });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    const first = createSavedSecretMaterializerFromSnapshotV1(snapshot);
    const delivered = first.resolve(ref);
    expect(delivered).toMatchObject({ status: 'ready', value: 'private-bootstrap-key' });
    expect(first.describe(ref)).toEqual({ status: 'ready', source: 'shared_resource', displayName: 'Bootstrap key' });
    // A rebuilt controller/materializer uses the persisted reference instead
    // of generating a replacement bootstrap key. File delivery is a separate
    // consumer contract, not simulated by this materializer test.
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref)).toEqual(delivered);
    commitActiveSavedSecretCatalog({
      scopeKey: 'home:owner', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      resources: [{ ...resources[0]!, materialStatus: 'recipient_mode_unsupported' }], state: 'ready',
    });
    expect(first.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
    expect(first.describe(ref)).toEqual({ status: 'temporarily_unavailable' });
    expect(createSavedSecretMaterializerFromSnapshotV1(getActiveAccountSettingsSnapshot()!).resolve(ref))
      .toEqual({ status: 'mode_incompatible' });
    commitActiveSavedSecretCatalog({
      scopeKey: 'home:owner', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      resources: [], state: 'ready',
    });
    expect(first.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
    expect(createSavedSecretMaterializerFromSnapshotV1(getActiveAccountSettingsSnapshot()!).resolve(ref))
      .toEqual({ status: 'forbidden' });
    resetActiveAccountSettingsSnapshotForTests();
    expect(first.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
  });

  it('resolves an extant reserved-reference personal record as personal until rekey commits', () => {
    const ref = 'happier:shared-secret:v1:legacy-personal';
    const resource = sealSavedSecretResourceStoredContentV1({
      resourceId: 'legacy-personal', mode: 'plain',
      content: { v: 1, name: 'shared', kind: 'token', value: 'shared-value' },
    });
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {
        secrets: [{
          id: ref, name: 'legacy', kind: 'token', updatedAt: 7,
          encryptedValue: { _isSecretValue: true, value: 'exact-personal-value' },
        }],
      },
      settingsSecretsReadKeys: [],
      resources: [{
        resourceId: 'legacy-personal', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent: resource, materialStatus: 'ready',
      }],
      resourceCatalogState: 'ready',
    });

    expect(materializer.resolve(ref)).toMatchObject({
      status: 'ready',
      value: 'exact-personal-value',
      source: 'personal',
    });
    expect(materializer.matchesSharedResourceRevision(ref, 1)).toBe(false);
    expect(materializer.inspect(ref)).toMatchObject({ catalogFingerprint: `personal:${ref}:7` });

    const afterRekey = createSavedSecretMaterializerV1({
      accountSettings: { secrets: [] },
      settingsSecretsReadKeys: [],
      resources: [{
        resourceId: 'legacy-personal', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent: resource, materialStatus: 'ready',
      }],
      resourceCatalogState: 'ready',
    });
    expect(afterRekey.resolve(ref)).toMatchObject({
      status: 'ready',
      value: 'shared-value',
      source: 'shared_resource',
    });
    expect(afterRekey.matchesSharedResourceRevision(ref, 1)).toBe(true);
    expect(afterRekey.inspect(ref)).toMatchObject({ catalogFingerprint: `shared:${ref}:1` });
  });

  it('resolves personal and plain shared resources through one API', () => {
    const resource = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1', mode: 'plain',
      content: { v: 1, name: 'shared', kind: 'token', value: 'shared-value' },
    });
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {
        secrets: [{
          id: 'personal_1', name: 'personal', kind: 'token',
          encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('personal-value', key, randomBytes) },
        }],
      },
      settingsSecretsReadKeys: [key],
      resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent: resource, materialStatus: 'ready',
      }],
    });

    expect(materializer.resolve('personal_1')).toMatchObject({ status: 'ready', value: 'personal-value', source: 'personal' });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1')).toMatchObject({ status: 'ready', value: 'shared-value', source: 'shared_resource' });
    expect(materializer.describe('personal_1')).toEqual({ status: 'ready', source: 'personal', displayName: 'personal' });
    expect(materializer.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: 'ready', source: 'shared_resource', displayName: 'shared' });
    expect(materializer.matchesSharedResourceRevision(
      'happier:shared-secret:v1:resource_1',
      1,
    )).toBe(true);
    expect(materializer.matchesSharedResourceRevision(
      'happier:shared-secret:v1:resource_1',
      2,
    )).toBe(false);
    expect(materializer.matchesSharedResourceRevision('personal_1', 1)).toBe(false);
  });

  it('keeps preparing and stale-resource states typed and fails closed', () => {
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'e2ee', revision: 2,
        storedContent: { t: 'encrypted', c: 'AA==' },
        materialStatus: 'preparing_encrypted_access',
      }],
    });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1')).toEqual({ status: 'temporarily_unavailable' });
    expect(materializer.resolve('happier:shared-secret:v1:missing')).toEqual({ status: 'temporarily_unavailable' });
    expect(materializer.resolve('happier:shared-secret:v1:')).toEqual({ status: 'missing' });
  });

  it('distinguishes an unhydrated shared catalog from a missing personal record', () => {
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resourceCatalogState: 'temporarily_unavailable',
    });

    expect(materializer.resolve('personal_1')).toEqual({ status: 'missing' });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1'))
      .toEqual({ status: 'temporarily_unavailable' });
  });

  it('treats authoritative current absence as revoked while retryable catalog absence stays unavailable', () => {
    const ref = 'happier:shared-secret:v1:resource_1';
    const authoritative = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources: [],
      resourceCatalogState: 'ready',
    });
    const retryable = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resourceCatalogState: 'temporarily_unavailable',
    });
    expect(authoritative.resolve(ref)).toEqual({ status: 'forbidden' });
    expect(retryable.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
    expect(authoritative.resolve('personal_1')).toEqual({ status: 'missing' });
  });

  it('detects rotation through the existing currentness recheck', () => {
    const first = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1', mode: 'plain',
      content: { v: 1, name: 'shared', kind: 'token', value: 'v1' },
    });
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent: first, materialStatus: 'ready',
      }],
    });
    const resolved = materializer.resolve('happier:shared-secret:v1:resource_1');
    expect(resolved.status).toBe('ready');
    expect(materializer.recheck('happier:shared-secret:v1:resource_1', 'different')).toEqual({ status: 'repair_required' });
  });

  it('opens an E2EE resource only when the caller snapshot includes its resource DEK', () => {
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1', mode: 'e2ee',
      content: { v: 1, name: 'encrypted', kind: 'apiKey', value: 'secret' },
      resourceDataKey: key,
      randomBytes,
    });
    const withoutKey = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'encrypted', kind: 'apiKey',
        encryptionMode: 'e2ee', revision: 1, storedContent, materialStatus: 'ready',
      }],
    });
    expect(withoutKey.inspect('happier:shared-secret:v1:resource_1')).toEqual({ status: 'temporarily_unavailable' });
    expect(withoutKey.resolve('happier:shared-secret:v1:resource_1')).toEqual({ status: 'temporarily_unavailable' });
    expect(withoutKey.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: 'temporarily_unavailable' });
    expect(withoutKey.inspect('happier:shared-secret:v1:resource_1')).toEqual({ status: 'temporarily_unavailable' });
    const withKey = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'encrypted', kind: 'apiKey',
        encryptionMode: 'e2ee', revision: 1, storedContent, materialStatus: 'ready', resourceDataKey: key,
      }],
    });
    expect(withKey.resolve('happier:shared-secret:v1:resource_1')).toMatchObject({ status: 'ready', value: 'secret' });
    expect(withKey.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: 'ready', source: 'shared_resource', displayName: 'encrypted' });
  });

  it('rejects opened content whose authenticated metadata disagrees with the catalog projection', () => {
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1', mode: 'plain',
      content: { v: 1, name: 'source-name', kind: 'token', value: 'secret' },
    });
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'stale-name', kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent, materialStatus: 'ready',
      }],
    });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1')).toEqual({ status: 'corrupt' });
    expect(materializer.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: 'corrupt' });
  });

  it('materializes a retained resource whose Home projects no display name', () => {
    // The Home maps an empty stored display name to `name: null` and still
    // projects the row as ready, so a snapshot that invents a name out of the
    // resource id would reject healthy material as corrupt. The UI already
    // compares only when the projected name exists.
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1', mode: 'plain',
      content: { v: 1, name: 'source-name', kind: 'token', value: 'secret' },
    });
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: null, kind: 'token',
        encryptionMode: 'plain', revision: 1, storedContent, materialStatus: 'ready',
      }],
    });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1')).toMatchObject({ status: 'ready', value: 'secret' });
    expect(materializer.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: 'ready', source: 'shared_resource', displayName: null });
  });

  it.each([
    ['recipient_mode_unsupported', 'mode_incompatible'],
    ['access_removed', 'forbidden'],
    ['update_required', 'repair_required'],
    ['deleted', 'deleted'],
  ] as const)('normalizes catalog status %s to %s', (materialStatus, expected) => {
    const materializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
        resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'shared', kind: 'token',
        encryptionMode: 'e2ee', revision: 2,
        storedContent: { t: 'encrypted', c: 'AA==' },
        materialStatus,
      }],
    });
    expect(materializer.resolve('happier:shared-secret:v1:resource_1')).toEqual({ status: expected });
    expect(materializer.describe('happier:shared-secret:v1:resource_1')).toEqual({ status: expected });
  });
});
