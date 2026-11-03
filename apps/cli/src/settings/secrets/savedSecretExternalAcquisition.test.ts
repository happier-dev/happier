import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { createRequesterSessionCredentialCustody, readRequesterSessionCredentialsForChild } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { accountSettingsParse, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from './savedSecretOperationContext';
import { acquireSavedSecretMaterializerForOperation } from './savedSecretCatalogRead';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('external Saved Secret operation acquisition', () => {
  it('reads only selected distinct fields once per operation, observes rotation next time, and never reads for inline bootstrap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saved-secret-source-'));
    const field = join(directory, 'field');
    let nativeReads = 0;
    const fixture = await createSecretSourceHostFixture({ runtime: { async acquire() {
      nativeReads += 1;
      return { ok: true, value: await readFile(field, 'utf8') };
    } } });
    const token = 'vault-operation-account';
    const ref = 'happier:shared-secret:v1:selected';
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
      scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready',
      savedSecretResources: Array.from({ length: 51 }, (_, index) => ({
        resourceId: index === 0 ? 'selected' : `unselected-${index}`, ownerAccountId: 'owner', relationship: 'owner' as const,
        displayName: 'Vault field', kind: 'password' as const, encryptionMode: 'plain' as const,
        revision: 1, materialStatus: 'ready' as const,
        storedContent: { t: 'plain' as const, v: { v: 2 as const, name: 'Vault field', kind: 'password' as const,
          source: { kind: 'external' as const, contribution: fixture.contribution, account: 'chosen-account', reference: 'op://vault/item/field' } } },
      })),
    };
    const operationContext = createInvocationSavedSecretOperationContextV1({ snapshot,
      credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
      secretSources: fixture.host });
    const input = { snapshot, operationContext, references: [{ ref }, { ref }] };
    try {
      expect(fixture.host.list()).toHaveLength(1);
      expect(nativeReads).toBe(0);
      await writeFile(field, 'first-private-value');
      const first = await acquireSavedSecretMaterializerForOperation(input);
      for (let child = 0; child < 10; child += 1) expect(first.resolve(ref)).toMatchObject({ status: 'ready', value: 'first-private-value' });
      expect(first.resolve('happier:shared-secret:v1:unselected-1')).toEqual({ status: 'temporarily_unavailable' });
      expect(nativeReads).toBe(1);
      await writeFile(field, 'rotated-private-value');
      expect(first.resolve(ref)).toMatchObject({ value: 'first-private-value' });
      const next = await acquireSavedSecretMaterializerForOperation(input);
      expect(next.resolve(ref)).toMatchObject({ status: 'ready', value: 'rotated-private-value' });
      expect(nativeReads).toBe(2);
      const bootstrap = await acquireSavedSecretMaterializerForOperation({ ...input, sourceKind: 'inline' });
      expect(bootstrap.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
      expect(nativeReads).toBe(2);
      const member = createInvocationSavedSecretOperationContextV1({ snapshot, credentials: { token, encryption: null },
        serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, secretSources: fixture.host,
        machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', role: 'use' } });
      await expect(acquireSavedSecretMaterializerForOperation({ ...input, operationContext: member }))
        .rejects.toMatchObject({ reason: 'reference_forbidden' });
      await expect(acquireSavedSecretMaterializerForOperation({ ...input, operationContext: undefined,
        secretSources: fixture.host, isCurrent: () => true, machineAdmission: member.machineAdmission }))
        .rejects.toMatchObject({ reason: 'reference_forbidden' });
      expect(nativeReads).toBe(2);
      const manager = createInvocationSavedSecretOperationContextV1({ snapshot, credentials: { token, encryption: null },
        serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, secretSources: fixture.host,
        machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', role: 'manage' } });
      expect((await acquireSavedSecretMaterializerForOperation({ ...input, operationContext: manager })).resolve(ref))
        .toMatchObject({ status: 'ready', value: 'rotated-private-value' });
      expect(nativeReads).toBe(3);
    } finally {
      await fixture.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['use grantee', 'alice', 'use' as const, 0],
    ['custodian', 'bob', 'manage' as const, 1],
  ])('carries the admitted Machine grant into a requester Session runner context (%s)', async (_label, custodianAccountId, role, expectedReads) => {
    const directory = await mkdtemp(join(tmpdir(), 'saved-secret-runner-'));
    let nativeReads = 0;
    const fixture = await createSecretSourceHostFixture({ runtime: { async acquire() {
      nativeReads += 1;
      return { ok: true, value: 'custodian-vault-field' };
    } } });
    try {
      // The daemon writes requester custody after Machine admission; the runner reads only that file.
      const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: 'bob-session',
        attribution: { serverId: configuration.activeServerId, accountId: 'bob', machineId: 'alice-machine', installationId: 'installation' },
        machineAdmission: { custodianAccountId, role }, credentials: { token: 'bob-runner-token', encryption: null } });
      vi.stubEnv('HAPPIER_SESSION_REQUESTER_SESSION_ID', 'bob-session');
      const credentials = await readRequesterSessionCredentialsForChild(custody.path);
      if (!credentials) throw new Error('Missing requester runner credentials');
      const ref = 'happier:shared-secret:v1:vault';
      const snapshot: ActiveAccountSettingsSnapshot = {
        source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready',
        savedSecretResources: [{ resourceId: 'vault', ownerAccountId: 'bob', relationship: 'owner', displayName: 'Vault field',
          kind: 'password', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
          storedContent: { t: 'plain', v: { v: 2, name: 'Vault field', kind: 'password',
            source: { kind: 'external', contribution: fixture.contribution, account: 'alice-account', reference: 'op://vault/item/field' } } } }],
      };
      // Same construction as the runner's Session-open Account operation.
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, secretSources: fixture.host });
      const acquired = acquireSavedSecretMaterializerForOperation({ snapshot, operationContext, references: [{ ref }] });
      if (expectedReads === 0) await expect(acquired).rejects.toMatchObject({ reason: 'reference_forbidden' });
      else expect((await acquired).resolve(ref)).toMatchObject({ status: 'ready', value: 'custodian-vault-field' });
      expect(nativeReads).toBe(expectedReads);
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps admitted external material when inline bootstrap refresh retires its original E2EE key', async () => {
    const token = 'vault-bootstrap-account';
    const ref = 'happier:shared-secret:v1:selected';
    const inlineRef = 'happier:shared-secret:v1:inline';
    const originalKey = new Uint8Array(32).fill(7);
    const refreshedKey = new Uint8Array(originalKey);
    const inlineKey = new Uint8Array(32).fill(9);
    const refreshedInlineKey = new Uint8Array(inlineKey);
    let operationContext: SavedSecretOperationContextV1;
    const fixture = await createSecretSourceHostFixture({ runtime: { async acquire() {
      // The inline service-token read uses this same catalog refresh owner.
      operationContext.beginRefresh();
      operationContext.commitCatalog({ state: 'ready', resources: [{ ...resource, resourceDataKey: refreshedKey },
        { ...inlineResource, resourceDataKey: refreshedInlineKey }] });
      return { ok: true, value: 'acquired-with-inline-service-token' };
    } } });
    const content = { v: 2 as const, name: 'Vault field', kind: 'password' as const,
      source: { kind: 'external' as const, contribution: fixture.contribution, account: 'account', reference: 'op://vault/item/field' } };
    const resource = { resourceId: 'selected', ownerAccountId: 'owner', relationship: 'owner' as const,
      displayName: content.name, kind: content.kind, encryptionMode: 'e2ee' as const, revision: 1, materialStatus: 'ready' as const,
      resourceDataKey: originalKey, storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'selected', mode: 'e2ee',
        content, resourceDataKey: originalKey, randomBytes: length => new Uint8Array(length).fill(8) }) };
    const inlineResource = { ...resource, resourceId: 'inline', displayName: 'Inline field', resourceDataKey: inlineKey,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'inline', mode: 'e2ee', resourceDataKey: inlineKey,
        content: { v: 1, name: 'Inline field', kind: 'password', value: 'admitted-inline-value' },
        randomBytes: length => new Uint8Array(length).fill(10) }) };
    const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', settings: accountSettingsParse({}),
      settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [],
      savedSecretCatalogState: 'ready', savedSecretResources: [resource, inlineResource] };
    operationContext = createInvocationSavedSecretOperationContextV1({ snapshot, credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, secretSources: fixture.host });
    try {
      const admitted = await acquireSavedSecretMaterializerForOperation({ snapshot, operationContext,
        references: [{ ref }, { ref: inlineRef }] });
      expect(originalKey.every(byte => byte === 0)).toBe(true);
      expect(admitted.resolve(ref)).toMatchObject({ status: 'ready', value: 'acquired-with-inline-service-token' });
      expect(inlineKey.every(byte => byte === 0)).toBe(true);
      expect(admitted.resolve(inlineRef)).toMatchObject({ status: 'ready', value: 'admitted-inline-value' });
    } finally {
      await fixture.dispose();
      refreshedKey.fill(0);
      refreshedInlineKey.fill(0);
    }
  });

  it('settles native failures without their private output and propagates cancellation', async () => {
    const token = 'vault-errors-account';
    const ref = 'happier:shared-secret:v1:selected';
    const fixture = await createSecretSourceHostFixture({ runtime: { async acquire() {
      throw new Error('private-native-stdout-and-stderr');
    } } });
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
      scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready',
      savedSecretResources: [{ resourceId: 'selected', ownerAccountId: 'owner', relationship: 'owner',
        displayName: 'Vault field', kind: 'password', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        storedContent: { t: 'plain', v: { v: 2, name: 'Vault field', kind: 'password',
          source: { kind: 'external', contribution: fixture.contribution, account: 'account', reference: 'op://vault/item/field' } } } }],
    };
    const input = { snapshot, references: [{ ref }], isCurrent: () => true };
    try {
      const failed = await acquireSavedSecretMaterializerForOperation({ ...input, secretSources: fixture.host });
      expect(failed.resolve(ref)).toEqual({ status: 'temporarily_unavailable',
        sourceFailure: { code: 'acquisition_failed', repair: 'retry' } });
      const absent = await acquireSavedSecretMaterializerForOperation(input);
      expect(absent.resolve(ref)).toEqual({ status: 'temporarily_unavailable' });
      await fixture.dispose();
      const unavailable = await acquireSavedSecretMaterializerForOperation({ ...input, secretSources: fixture.host });
      expect(unavailable.resolve(ref)).toEqual({ status: 'temporarily_unavailable',
        sourceFailure: { code: 'source_unavailable', repair: 'configure' } });
      const controller = new AbortController();
      controller.abort();
      await expect(acquireSavedSecretMaterializerForOperation({ ...input, signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await fixture.dispose();
    }
  });
});
