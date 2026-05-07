import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';
import { createMinimalCodexPetPackage, minimalPetPngSignature } from '../../src/testkit/pets/petPackageFixture';
import {
  DaemonPetDiscoverResponseV1Schema,
  DaemonPetImportLocalPackageResponseV1Schema,
  DaemonPetReadPreviewAssetResponseV1Schema,
  PET_DAEMON_RPC_METHODS,
  type DaemonPetDiscoverResponseV1,
  type DaemonPetImportLocalPackageResponseV1,
  type DaemonPetReadPreviewAssetResponseV1,
} from '@happier-dev/protocol';

const run = createRunDirs({ runLabel: 'core' });
const daemonStartupTimeoutMs = 90_000;

type RpcAck = { ok: boolean; result?: string; error?: string; errorCode?: string };
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };
type ImportLocalPetSuccess = Exclude<DaemonPetImportLocalPackageResponseV1, { ok: false }>;
type ReadPreviewAssetSuccess = Exclude<DaemonPetReadPreviewAssetResponseV1, { ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, max = 220): string {
  const raw = String(value ?? '');
  return raw.length <= max ? raw : `${raw.slice(0, max)}...`;
}

function requireDiscoverSuccess(
  response: DaemonPetDiscoverResponseV1,
): Extract<DaemonPetDiscoverResponseV1, { ok: true }> {
  if (response.ok !== true) {
    throw new Error(`Pet discovery failed: ${response.errorCode} ${truncate(response.error)}`);
  }
  return response;
}

function isImportLocalPetSuccess(
  response: DaemonPetImportLocalPackageResponseV1,
): response is ImportLocalPetSuccess {
  return Object.prototype.hasOwnProperty.call(response, 'importedPet');
}

function requireImportedLocalPet(
  response: DaemonPetImportLocalPackageResponseV1,
): ImportLocalPetSuccess['importedPet'] {
  if (!isImportLocalPetSuccess(response)) {
    throw new Error(`Local pet import failed: ${response.errorCode} ${truncate(response.error)}`);
  }
  return response.importedPet;
}

function isReadPreviewAssetSuccess(
  response: DaemonPetReadPreviewAssetResponseV1,
): response is ReadPreviewAssetSuccess {
  return Object.prototype.hasOwnProperty.call(response, 'dataBase64');
}

function requirePreviewAsset(
  response: DaemonPetReadPreviewAssetResponseV1,
): ReadPreviewAssetSuccess {
  if (!isReadPreviewAssetSuccess(response)) {
    throw new Error(`Pet preview read failed: ${response.errorCode} ${truncate(response.error)}`);
  }
  return response;
}

async function resolveDaemonMachineIdFromSettings(params: { daemonHomeDir: string }): Promise<string> {
  const raw = await readFile(resolve(join(params.daemonHomeDir, 'settings.json')), 'utf8').catch(() => '');
  const parsed = raw ? JSON.parse(raw) as unknown : null;
  if (!isRecord(parsed)) throw new Error('Missing daemon settings object');
  const activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId : '';
  const machineIdByServerId = isRecord(parsed.machineIdByServerId) ? parsed.machineIdByServerId : null;
  const machineId = activeServerId && typeof machineIdByServerId?.[activeServerId] === 'string'
    ? machineIdByServerId[activeServerId]
    : '';
  if (!machineId) throw new Error('Missing machineIdByServerId[activeServerId] in seeded settings.json');
  return machineId;
}

async function resolveMachineDataEncryptionKeyBase64(params: {
  baseUrl: string;
  token: string;
  machineId: string;
}): Promise<string | null> {
  let out: string | null = null;
  await waitFor(
    async () => {
      const res = await fetchJson<unknown>(`${params.baseUrl}/v1/machines`, {
        headers: { Authorization: `Bearer ${params.token}` },
        timeoutMs: 10_000,
      });
      if (res.status !== 200 || !Array.isArray(res.data)) {
        throw new Error(`Failed to fetch /v1/machines (status=${res.status})`);
      }
      const row = res.data.find((machine) => isRecord(machine) && machine.id === params.machineId);
      if (!isRecord(row)) return false;
      out = typeof row.dataEncryptionKey === 'string' && row.dataEncryptionKey.length > 0
        ? row.dataEncryptionKey
        : null;
      return true;
    },
    { timeoutMs: 20_000, context: `machine registered: ${params.machineId}` },
  );
  return out;
}

async function callMachineRpc<TReq, TRes>(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineId: string;
  method: string;
  req: TReq;
  encryptParams: (value: unknown) => string;
  decryptResult: (value: string) => unknown | null;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  const encryptedParams = params.encryptParams(params.req);
  const fullMethod = `${params.machineId}:${params.method}`;

  await waitFor(
    async () => {
      const res = await params.ui.rpcCall<RpcAck>(fullMethod, encryptedParams);
      if (!res) throw new Error('rpcCall returned null/undefined');
      if (res.ok !== true || typeof res.result !== 'string') {
        const errorCode = typeof res.errorCode === 'string' ? res.errorCode : '';
        const error = typeof res.error === 'string' ? res.error : '';
        throw new Error(`rpc ack not ok (errorCode=${errorCode || 'none'} error=${truncate(error) || 'none'})`);
      }
      const decrypted = unwrapSerializedJsonValue(params.decryptResult(res.result));
      if (!decrypted) throw new Error('failed to decrypt rpc result');
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) {
        throw new Error(`failed to parse rpc result as ${params.method} response: ${truncate(JSON.stringify(decrypted))}`);
      }
      out = parsed.data;
      return true;
    },
    { timeoutMs: params.timeoutMs ?? 25_000, context: fullMethod },
  );

  if (!out) throw new Error(`RPC call did not return a valid response: ${params.method}`);
  return out;
}

describe('core e2e: pets local daemon import', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('imports a detected Codex pet into daemon-managed local storage when pets sync is disabled', async () => {
    const testDir = run.testDir('pets-local-daemon-import-sync-disabled');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_PETS_SYNC__ENABLED: '0',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, 'codex-home'));
    const codexPetsDir = resolve(join(codexHomeDir, 'pets'));
    await mkdir(daemonHomeDir, { recursive: true });
    await createMinimalCodexPetPackage({
      rootDir: codexPetsDir,
      petId: 'blink-e2e-fixture',
      displayName: 'Blink E2E Fixture',
    });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
      env: {
        ...process.env,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        CI: '1',
        CODEX_HOME: codexHomeDir,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        HAPPIER_FEATURE_PETS_SYNC__ENABLED: '0',
      },
    });

    const machineId = await resolveDaemonMachineIdFromSettings({ daemonHomeDir });
    const machineDekBase64 = await resolveMachineDataEncryptionKeyBase64({
      baseUrl: serverBaseUrl,
      token: auth.token,
      machineId,
    });
    const machineDek = machineDekBase64 ? new Uint8Array(Buffer.from(machineDekBase64, 'base64')) : null;
    const encryptParams = (value: unknown) => machineDek
      ? encryptDataKeyBase64(value, machineDek)
      : encryptLegacyBase64(value, secret);
    const decryptResult = (value: string) => machineDek
      ? decryptDataKeyBase64(value, machineDek)
      : decryptLegacyBase64(value, secret);

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      const discover = requireDiscoverSuccess(await callMachineRpc({
        ui,
        machineId,
        method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
        req: { includeDetectedCodexHomes: true, includeManagedLocal: true },
        encryptParams,
        decryptResult,
        schema: DaemonPetDiscoverResponseV1Schema,
        timeoutMs: 45_000,
      }));
      const detected = discover.pets.find((pet) => pet.petId === 'blink-e2e-fixture') ?? null;
      expect(detected).not.toBeNull();
      expect(detected?.kind).toBe('detectedCodexHome');
      expect(detected).not.toHaveProperty('source');

      const importedPet = requireImportedLocalPet(await callMachineRpc({
        ui,
        machineId,
        method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
        req: { sourceKey: detected?.sourceKey },
        encryptParams,
        decryptResult,
        schema: DaemonPetImportLocalPackageResponseV1Schema,
        timeoutMs: 45_000,
      }));
      expect(importedPet.petId).toBe('blink-e2e-fixture');
      expect(importedPet.kind).toBe('happierManagedLocal');
      expect(importedPet.sourceKey).not.toBe(detected?.sourceKey);
      expect(importedPet).not.toHaveProperty('source');

      const preview = requirePreviewAsset(await callMachineRpc({
        ui,
        machineId,
        method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
        req: { sourceKey: importedPet.sourceKey },
        encryptParams,
        decryptResult,
        schema: DaemonPetReadPreviewAssetResponseV1Schema,
        timeoutMs: 45_000,
      }));
      expect(preview.sourceKey).toBe(importedPet.sourceKey);
      expect(preview.digest).toBe(importedPet.digest);
      expect(preview.mediaType).toBe('image/png');
      const previewBytes = Buffer.from(preview.dataBase64, 'base64');
      expect(previewBytes.subarray(0, minimalPetPngSignature.length)).toEqual(minimalPetPngSignature);
    } finally {
      ui.disconnect();
    }
  }, 240_000);
});
