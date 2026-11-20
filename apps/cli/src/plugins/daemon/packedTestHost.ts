import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import fastify from 'fastify';
import { isPidPresent } from '@happier-dev/cli-common/process';
import {
  PluginAvailabilityActionHttpPathsV1,
  PluginAvailabilityIntentReadActionInputV1Schema,
  PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability/actions';

import { createDaemonControlAuthGuard } from '@/daemon/controlAuth';
import { configuration } from '@/configuration';
import { acquireDaemonLock, releaseDaemonLock, type StoredCredentials } from '@/persistence';
import { registerDaemonPluginChangeRoutes } from '@/plugins/daemon/controlRoutes';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import {
  PACKED_TEST_TARGETED_ADMISSION_READ_PATH,
  PackedTestTargetedAdmissionReadRequestSchema,
  readPackedTestTargetedAdmission,
} from '@/plugins/daemon/packedTestTargetedAdmissions';
import type {
  AccountPluginDataStorageHostDependencies,
} from '@/plugins/runtime/context/accountPluginDataStorage';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { logger } from '@/ui/logger';

export type PackedTestDaemonReady = Readonly<{
  kind: 'happier_packed_test_daemon_ready_v1';
  pid: number;
  httpPort: number;
  controlToken: string;
  incarnationId: string;
}>;

const packedTestAccountCredentials = {
  token: 'packed-test-account-token',
  encryption: null,
} satisfies StoredCredentials;

function readRequiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing required ${name} option`);
  }
  return value;
}

function readOptionalOption(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing ${name} option value`);
  }
  return value;
}

/**
 * The packed daemon has no real Account client, but bundled Resources still
 * execute their canonical Account Data admission reads during readiness. Keep
 * that test boundary explicit and deterministic: real storage logic is used,
 * while only its authenticated HTTP/system port is supplied by the harness.
 */
function createPackedTestAccountStorageDependencies(): AccountPluginDataStorageHostDependencies {
  const fixtureCredentials = packedTestAccountCredentials;

  return {
    readCredentials: async () => fixtureCredentials,
    isCurrentAccount: (credentials) => credentials.token === fixtureCredentials.token,
    resolveAccountScopeKey: () => 'packed-test-account',
    resolveBaseUrl: () => 'https://packed-test-account.invalid',
    resolveAccountEncryptionCurrentness: async () => ({
      mode: 'plain' as const,
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
      recipientEnvelopeReadiness: {
        status: 'unavailable' as const,
        reason: 'plain_account' as const,
      },
    }),
    http: {
      async get(url) {
        if (url.endsWith('/v1/account/encryption')) {
          return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        }
        if (url.includes('/v1/account/plugin-storage/')) {
          return { status: 200, data: { status: 'absent' } };
        }
        throw new Error(`Unexpected packed Account Data GET: ${url}`);
      },
      async post(url) {
        if (url.endsWith('/v1/plugins/data/query')) {
          return { status: 200, data: { rows: [], changeCursor: 0 } };
        }
        if (url.endsWith('/v1/plugins/data/get')) {
          return { status: 200, data: { row: null } };
        }
        throw new Error(`Unexpected packed Account Data POST: ${url}`);
      },
    },
  };
}

export async function runPackedTestDaemonHost(args: readonly string[]): Promise<void> {
  const happyHomeDir = readRequiredOption(args, '--home');
  const readyFile = readRequiredOption(args, '--ready-file');
  const expectedParentPid = Number.parseInt(readRequiredOption(args, '--parent-pid'), 10);
  const connectedAccountsFixturePluginId = readOptionalOption(
    args,
    '--connected-accounts-fixture-plugin-id',
  );
  if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 0) {
    throw new Error('Invalid --parent-pid option');
  }

  const incarnationId = randomUUID();
  const controlToken = randomUUID();
  const connectedAccounts = createPackedTestConnectedAccountsRuntime({
    happyHomeDir,
    pluginId: connectedAccountsFixturePluginId ?? 'happier.packed.connected-accounts-unavailable',
    runtimeRegistry: pluginReloadController,
  });
  const accountStorageDependencies = createPackedTestAccountStorageDependencies();
  const app = fastify({ logger: false });
  let capturedServerUrl: string | null = null;
  const managedResourceHomeId = 'packed-test-home';
  const managedResourceController = { machineId: 'packed-test-machine', installationId: 'packed-test-installation' };
  const runtimeOwner = createDaemonPluginRuntimeOwner({
    happyHomeDir,
    staleCandidateCleanup: 'exclusiveHome',
    reloadController: pluginReloadController,
    connectedAccounts: connectedAccounts.owner,
    accountStorageDependencies,
    managedResourcePreflight: {
      credentials: packedTestAccountCredentials,
      get serverUrl() {
        if (!capturedServerUrl) throw new Error('Packed test HTTP boundary is not listening');
        return capturedServerUrl;
      },
      homeId: managedResourceHomeId,
      controller: managedResourceController,
    },
    reconcileConnectedAccountPurposePublication:
      connectedAccounts.reconcileRegistryPublication,
  });
  // The same isolated Account boundary supports canonical removal preflight.
  // It cannot model managed machines, so provider declarations fail closed.
  app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${packedTestAccountCredentials.token}`) return reply.code(401).send();
    const parsed = PluginAvailabilityIntentReadActionInputV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    const input = parsed.data;
    if (input.includeManagedResources !== true || input.homeId !== managedResourceHomeId
      || input.controller?.machineId !== managedResourceController.machineId
      || input.controller.installationId !== managedResourceController.installationId) return reply.code(403).send();
    const plugin = (await runtimeOwner.readCatalog()).find(entry => entry.pluginId === input.pluginId);
    if (!plugin?.manifest || (plugin.manifest.contributes?.machineProvisioners?.length ?? 0) > 0) return reply.code(409).send();
    return PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 0,
      hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
      managedResources: [], managedResourcesReviewed: true });
  });
  const requireControlAuth = createDaemonControlAuthGuard(controlToken);
  registerDaemonPluginChangeRoutes(app, {
    service: runtimeOwner.changeService,
    requireAuth: requireControlAuth,
    recoverFailedAccountCensus: pluginReloadController.recoverFailedAccountCensus,
    readCatalog: runtimeOwner.readCatalog,
  });
  app.post(
    PACKED_TEST_TARGETED_ADMISSION_READ_PATH,
    { preHandler: requireControlAuth },
    async (request, reply) => {
      const parsed = PackedTestTargetedAdmissionReadRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return await reply.code(400).send({
          kind: 'unavailable',
          code: 'plugin_packed_targeted_admission_invalid_request',
        });
      }
      return await readPackedTestTargetedAdmission({
        reloadController: pluginReloadController,
        request: parsed.data,
      });
    },
  );

  let parentWatch: NodeJS.Timeout | null = null;
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown();
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;

  try {
    await mkdir(happyHomeDir, { recursive: true });
    if (resolve(happyHomeDir) !== resolve(configuration.happyHomeDir)) {
      throw new Error('Packed plugin daemon home must match the daemon lifecycle home');
    }
    daemonLockHandle = await acquireDaemonLock(5, 200);
    if (!daemonLockHandle) {
      throw new Error('Packed plugin daemon could not acquire exclusive home ownership');
    }
    await runtimeOwner.initialize();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    capturedServerUrl = address;
    const parsedAddress = new URL(address);
    const httpPort = Number.parseInt(parsedAddress.port, 10);
    const ready: PackedTestDaemonReady = Object.freeze({
      kind: 'happier_packed_test_daemon_ready_v1',
      pid: process.pid,
      httpPort,
      controlToken,
      incarnationId,
    });
    await mkdir(dirname(readyFile), { recursive: true });
    await writeFile(readyFile, `${JSON.stringify(ready)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    parentWatch = setInterval(() => {
      // Only proof of absence retires this host: a parent we may not signal is still there.
      if (!isPidPresent(expectedParentPid)) requestShutdown();
    }, 500);
    parentWatch.unref?.();
    await shutdownRequested;
  } finally {
    if (parentWatch) clearInterval(parentWatch);
    process.off('SIGINT', requestShutdown);
    process.off('SIGTERM', requestShutdown);
    try {
      await app.close().catch(() => undefined);
      await runtimeOwner.changeService.shutdown();
      await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    } finally {
      if (daemonLockHandle) await releaseDaemonLock(daemonLockHandle);
      logger.flushSync();
    }
  }
}
