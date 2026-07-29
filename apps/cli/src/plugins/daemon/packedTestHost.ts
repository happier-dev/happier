import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import fastify from 'fastify';

import { createDaemonControlAuthGuard } from '@/daemon/controlAuth';
import { configuration } from '@/configuration';
import { acquireDaemonLock, releaseDaemonLock } from '@/persistence';
import { registerDaemonPluginChangeRoutes } from '@/plugins/daemon/controlRoutes';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { logger } from '@/ui/logger';

export type PackedTestDaemonReady = Readonly<{
  kind: 'happier_packed_test_daemon_ready_v1';
  pid: number;
  httpPort: number;
  controlToken: string;
  incarnationId: string;
}>;

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
  const startedAt = Date.now();
  const connectedAccounts = createPackedTestConnectedAccountsRuntime({
    happyHomeDir,
    pluginId: connectedAccountsFixturePluginId ?? 'happier.packed.connected-accounts-unavailable',
  });
  const runtimeOwner = createDaemonPluginRuntimeOwner({
    happyHomeDir,
    staleCandidateCleanup: 'exclusiveHome',
    daemonInstanceId: incarnationId,
    daemonUptimeMs: () => Math.max(0, Date.now() - startedAt),
    reloadController: pluginReloadController,
    connectedAccounts: connectedAccounts.owner,
    reconcileConnectedAccountPurposePublication:
      connectedAccounts.reconcileRegistryPublication,
  });
  const app = fastify({ logger: false });
  registerDaemonPluginChangeRoutes(app, {
    service: runtimeOwner.changeService,
    requireAuth: createDaemonControlAuthGuard(controlToken),
    readCatalog: runtimeOwner.readCatalog,
  });

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
      try {
        process.kill(expectedParentPid, 0);
      } catch {
        requestShutdown();
      }
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
