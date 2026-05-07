import { afterEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createMinimalCodexPetPackage, readMinimalAccountPetCreatePayload } from '../../src/testkit/pets/petPackageFixture';
import { FeaturesResponseSchema, readServerEnabledBit } from '@happier-dev/protocol';

const run = createRunDirs({ runLabel: 'core' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestedRecord(root: unknown, key: string): Record<string, unknown> | null {
  return isRecord(root) && isRecord(root[key]) ? root[key] : null;
}

async function fetchAccountSettingsVersion(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<number> {
  const res = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200 || !isRecord(res.data) || typeof res.data.version !== 'number') {
    throw new Error(`Failed to fetch account settings version (status=${res.status})`);
  }
  return res.data.version;
}

describe('core e2e: pets account sync', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('syncs imported pet metadata and selected account pet ref to a second authenticated client', async () => {
    const testDir = run.testDir('pets-account-sync-second-client');
    const privateFilesDir = resolve(join(testDir, 'private-files'));
    await mkdir(privateFilesDir, { recursive: true });
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'CN=Example Root CA',
        HAPPIER_FEATURE_PETS_SYNC__ENABLED: '1',
        HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: privateFilesDir,
      },
    });

    const clientA = await createTestAuthMtls(server.baseUrl, {
      email: 'pet-sync@example.com',
      issuer: 'CN=Example Root CA',
    });
    const clientB = await createTestAuthMtls(server.baseUrl, {
      email: 'pet-sync@example.com',
      issuer: 'CN=Example Root CA',
    });

    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`, { timeoutMs: 20_000 });
    expect(features.status).toBe(200);
    expect(readServerEnabledBit(FeaturesResponseSchema.parse(features.data), 'pets.sync')).toBe(true);

    const codexPetsDir = resolve(join(testDir, 'codex-home', 'pets'));
    await mkdir(codexPetsDir, { recursive: true });
    const petPackage = await createMinimalCodexPetPackage({
      rootDir: codexPetsDir,
      petId: 'blink-e2e-fixture',
      displayName: 'Blink E2E Fixture',
    });
    const createPayload = await readMinimalAccountPetCreatePayload(petPackage, {
      kind: 'detectedCodexHome',
      homeKind: 'user',
    });

    const createRes = await fetchJson<unknown>(`${server.baseUrl}/v1/account/pets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientA.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPayload),
      timeoutMs: 30_000,
    });
    expect(createRes.status).toBe(201);
    expect(JSON.stringify(createRes.data)).not.toContain(petPackage.packageDir);
    expect(JSON.stringify(createRes.data)).not.toContain(createPayload.spritesheet.data);
    const createData = isRecord(createRes.data) ? createRes.data : {};
    const pet = nestedRecord(createData, 'pet');
    const accountPetId = typeof pet?.accountPetId === 'string' ? pet.accountPetId : '';
    expect(accountPetId.length).toBeGreaterThan(0);

    const expectedVersion = await fetchAccountSettingsVersion({ baseUrl: server.baseUrl, token: clientA.token });
    const settingsRes = await fetchJson<unknown>(`${server.baseUrl}/v2/account/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientA.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion,
        content: {
          t: 'plain',
          v: {
            schemaVersion: 2,
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'accountPet', accountPetId },
          },
        },
      }),
      timeoutMs: 20_000,
    });
    expect(settingsRes.status).toBe(200);

    const listRes = await fetchJson<unknown>(`${server.baseUrl}/v1/account/pets`, {
      headers: { Authorization: `Bearer ${clientB.token}` },
      timeoutMs: 20_000,
    });
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.data)).toContain(accountPetId);
    expect(JSON.stringify(listRes.data)).toContain('Blink E2E Fixture');
    expect(JSON.stringify(listRes.data)).not.toContain(petPackage.packageDir);
    expect(JSON.stringify(listRes.data)).not.toContain(createPayload.spritesheet.data);

    const settingsOnClientB = await fetchJson<unknown>(`${server.baseUrl}/v2/account/settings`, {
      headers: { Authorization: `Bearer ${clientB.token}` },
      timeoutMs: 20_000,
    });
    expect(settingsOnClientB.status).toBe(200);
    expect(JSON.stringify(settingsOnClientB.data)).toContain(accountPetId);
  }, 240_000);
});
