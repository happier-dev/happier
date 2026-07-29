import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';
import {
  decideDaemonPluginChange,
  readDaemonPluginCatalog,
  requestDaemonPluginActionExecution,
  requestDaemonPluginChange,
  type DaemonControlRequestOptions,
} from '@/daemon/controlClient';
import { sanitizeDaemonSpawnEnv } from '@happier-dev/cli-common/process';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import type {
  PluginChangeDecisionResult,
  PluginChangeRequestResult,
} from '@/plugins/daemon/changeContract';
import { readPluginManifest } from '@/plugins/manifest/read';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';
import {
  PLUGIN_CATALOG_READ_PATH,
} from '@/plugins/daemon/controlRoutes';
import type { PackedTestDaemonReady } from '@/plugins/daemon/packedTestHost';

export type PackedPluginTestDiagnostic = Readonly<{
  code: string;
  message: string;
}>;

export type PackedPluginTestResult =
  | Readonly<{
      ok: true;
      mode: 'packed';
      projectRoot: string;
      pluginId: string;
      archiveDigest: string;
      invocation: Readonly<{
        actionId: string;
        result: unknown;
      }> | null;
      publicationRemovalReadd?: Readonly<{
        removed: true;
        readded: true;
        invocation: Readonly<{
          actionId: string;
          result: unknown;
        }>;
      }>;
      daemon: Readonly<{
        authenticatedControl: true;
        initialPid: number;
        restartedPid: number;
        initialIncarnationId: string;
        restartedIncarnationId: string;
        staleIncarnationRejected: true;
      }>;
    }>
  | Readonly<{
      ok: false;
      mode: 'packed';
      projectRoot: string;
      diagnostics: readonly PackedPluginTestDiagnostic[];
    }>;

function failure(
  projectRoot: string,
  code: string,
  message: string,
): Extract<PackedPluginTestResult, { ok: false }> {
  return Object.freeze({
    ok: false,
    mode: 'packed',
    projectRoot,
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}

function selectEmptyInputCliAction(
  manifest: CanonicalPluginManifest,
): string | null {
  for (const action of manifest.contributes.actions) {
    if (action.dangerLevel !== 'safe' || !action.surfaces.includes('cli')) continue;
    if (!action.inputSchema) return action.id;
    const validate = compilePluginJsonSchema(action.inputSchema);
    if (isValidPluginJsonSchemaValue(validate, {})) return action.id;
  }
  return null;
}

type DisposableDaemon = Readonly<{
  ready: PackedTestDaemonReady;
  target: NonNullable<DaemonControlRequestOptions['target']>;
  stop: () => Promise<void>;
}>;

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()));
}

async function stopDisposableDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 12_000)),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  const forced = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!forced) throw new Error(`Disposable plugin daemon ${child.pid ?? 'unknown'} did not stop`);
}

function parseReady(raw: string): PackedTestDaemonReady | null {
  try {
    const value = JSON.parse(raw) as Partial<PackedTestDaemonReady>;
    if (value.kind !== 'happier_packed_test_daemon_ready_v1'
      || !Number.isInteger(value.pid)
      || !Number.isInteger(value.httpPort)
      || typeof value.controlToken !== 'string'
      || !value.controlToken
      || typeof value.incarnationId !== 'string'
      || !value.incarnationId) {
      return null;
    }
    return value as PackedTestDaemonReady;
  } catch {
    return null;
  }
}

async function startDisposableDaemon(params: Readonly<{
  operationRoot: string;
  happyHomeDir: string;
  projectRoot: string;
  connectedAccountsFixturePluginId?: string;
}>): Promise<DisposableDaemon> {
  const readyFile = join(params.operationRoot, `daemon-ready-${randomUUID()}.json`);
  const launchSpec = buildHappyCliSubprocessLaunchSpec([
    'daemon',
    'plugin-packed-test-host',
    '--home',
    params.happyHomeDir,
    '--ready-file',
    readyFile,
    '--parent-pid',
    String(process.pid),
    ...(params.connectedAccountsFixturePluginId ? [
      '--connected-accounts-fixture-plugin-id',
      params.connectedAccountsFixturePluginId,
    ] : []),
  ]);
  const child = spawn(launchSpec.filePath, launchSpec.args, {
    cwd: params.projectRoot,
    env: sanitizeDaemonSpawnEnv({
      ...process.env,
      ...(launchSpec.env ?? {}),
      HAPPIER_HOME_DIR: params.happyHomeDir,
      HAPPIER_CLI_UPDATE_CHECK: '0',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  // A cold source-mode daemon imports the complete production registry. Under
  // concurrent workspace builds that can legitimately cross one minute before
  // the restricted host writes readiness, while packaged invocations remain
  // much faster.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Disposable plugin daemon exited before readiness${stderr ? `: ${stderr.trim()}` : ''}`);
    }
    const ready = await readFile(readyFile, 'utf8').then(parseReady).catch(() => null);
    if (ready) {
      if (ready.pid !== child.pid) {
        await stopDisposableDaemon(child);
        throw new Error('Disposable plugin daemon readiness PID did not match its child process');
      }
      return Object.freeze({
        ready,
        target: Object.freeze({
          pid: ready.pid,
          httpPort: ready.httpPort,
          controlToken: ready.controlToken,
        }),
        stop: async () => await stopDisposableDaemon(child),
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  await stopDisposableDaemon(child);
  throw new Error(`Disposable plugin daemon readiness timed out${stderr ? `: ${stderr.trim()}` : ''}`);
}

async function verifyAuthenticatedControlBoundary(daemon: DisposableDaemon): Promise<boolean> {
  const response = await fetch(
    `http://127.0.0.1:${daemon.ready.httpPort}${PLUGIN_CATALOG_READ_PATH}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3_000),
    },
  );
  return response.status === 401;
}

async function invokeAction(params: Readonly<{
  daemon: DisposableDaemon;
  actionId: string;
}>): Promise<PluginActionExecutionAttempt> {
  return await requestDaemonPluginActionExecution({
    actionId: params.actionId,
    input: {},
    surface: 'cli',
  }, { target: params.daemon.target });
}

export async function runPackedPluginTest(params: Readonly<{
  projectRoot: string;
  connectedAccountsFixturePluginId?: string;
  connectedAccountPurposeRemovalReaddActionLocalId?: string;
  expectedRedactedValues?: readonly string[];
}>): Promise<PackedPluginTestResult> {
  const projectRoot = resolve(params.projectRoot);
  const operationRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-packed-test-'));
  const happyHomeDir = join(operationRoot, 'home');
  const archivePath = join(operationRoot, 'plugin.happier-plugin.tgz');
  let daemon: DisposableDaemon | null = null;

  try {
    await mkdir(happyHomeDir, { recursive: true });
    const packed = await packLocalPlugin({
      locator: projectRoot,
      outPath: archivePath,
    });
    if (!packed.ok) {
      return Object.freeze({
        ok: false,
        mode: 'packed',
        projectRoot,
        diagnostics: packed.diagnostics,
      });
    }

    const manifestRead = await readPluginManifest({ manifestPath: packed.manifestPath });
    if (!manifestRead.ok) {
      return Object.freeze({
        ok: false,
        mode: 'packed',
        projectRoot,
        diagnostics: manifestRead.diagnostics,
      });
    }

    daemon = await startDisposableDaemon({
      operationRoot,
      happyHomeDir,
      projectRoot,
      ...(params.connectedAccountsFixturePluginId ? {
        connectedAccountsFixturePluginId: params.connectedAccountsFixturePluginId,
      } : {}),
    });
    const authenticatedControl = await verifyAuthenticatedControlBoundary(daemon);
    if (!authenticatedControl) {
      return failure(projectRoot, 'plugin_packed_control_auth_missing', 'Disposable daemon accepted an unauthenticated control request');
    }
    const initialDaemon = daemon;
    const requested: PluginChangeRequestResult | Readonly<{ kind: 'unavailable'; code: string }> =
      await requestDaemonPluginChange(
        {
          kind: 'installArchive',
          locator: packed.archivePath,
          expectedIntegrity: packed.archiveIntegrity,
        },
        { target: daemon.target },
      );
    if (requested.kind !== 'reviewRequired') {
      return failure(
        projectRoot,
        'plugin_packed_install_review_missing',
        `Disposable daemon returned '${requested.kind}' before Install and trust`,
      );
    }

    const decided: PluginChangeDecisionResult | Readonly<{ kind: 'unavailable'; code: string }> =
      await decideDaemonPluginChange({
        pendingChangeId: requested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: randomUUID(),
          occurredAtMs: Date.now(),
        },
        optionalSelections: requested.review.optionalHostAccess.map((access) => ({
          accessId: access.id,
          selected: false,
        })),
      }, { target: daemon.target });
    if (decided.kind !== 'committed'
      || decided.desiredGeneration === null
      || decided.appliedGeneration !== decided.desiredGeneration) {
      const decisionDetails = decided.kind === 'failed'
        ? `${decided.kind}:${decided.code}${decided.message ? `:${decided.message}` : ''}`
        : decided.kind === 'committed'
          ? `${decided.kind}:desired=${String(decided.desiredGeneration)}:applied=${String(decided.appliedGeneration)}`
          : decided.kind;
      return failure(
        projectRoot,
        'plugin_packed_install_failed',
        `Disposable daemon did not commit and apply the packed plugin (${decisionDetails})`,
      );
    }

    const installedCatalog = await readDaemonPluginCatalog({ target: daemon.target });
    if (installedCatalog.kind !== 'available'
      || !installedCatalog.plugins.some((entry) => entry.pluginId === packed.pluginId && entry.enabled)) {
      const observed = installedCatalog.kind === 'available'
        ? installedCatalog.plugins.map((entry) => `${entry.pluginId}:${entry.enabled ? 'enabled' : 'disabled'}`).join(', ')
        : `unavailable:${installedCatalog.code}`;
      return failure(
        projectRoot,
        'plugin_packed_catalog_missing',
        `Applied plugin was absent from the daemon-owned catalog (observed: ${observed || 'empty'})`,
      );
    }

    const actionLocalId = selectEmptyInputCliAction(manifestRead.manifest);
    let invocation: Extract<PackedPluginTestResult, { ok: true }>['invocation'] = null;
    let publicationRemovalReadd:
      Extract<PackedPluginTestResult, { ok: true }>['publicationRemovalReadd'];
    if (actionLocalId) {
      const actionId = `${packed.pluginId}/${actionLocalId}`;
      const initialAttempt = await invokeAction({ daemon, actionId });
      if (!initialAttempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          `Packed action '${actionId}' was unavailable`,
        );
      }
      if (!initialAttempt.result.ok) {
        return failure(projectRoot, 'plugin_packed_invocation_failed', initialAttempt.result.error);
      }
    }

    await daemon.stop();
    daemon = null;
    const staleCatalog = await readDaemonPluginCatalog({ target: initialDaemon.target });
    if (staleCatalog.kind !== 'unavailable') {
      return failure(projectRoot, 'plugin_packed_stale_incarnation_accepted', 'Stopped daemon incarnation remained addressable');
    }

    daemon = await startDisposableDaemon({
      operationRoot,
      happyHomeDir,
      projectRoot,
      ...(params.connectedAccountsFixturePluginId ? {
        connectedAccountsFixturePluginId: params.connectedAccountsFixturePluginId,
      } : {}),
    });
    if (daemon.ready.incarnationId === initialDaemon.ready.incarnationId || daemon.ready.pid === initialDaemon.ready.pid) {
      return failure(projectRoot, 'plugin_packed_daemon_restart_failed', 'Disposable daemon did not start a fresh incarnation');
    }
    const restartedCatalog = await readDaemonPluginCatalog({ target: daemon.target });
    if (restartedCatalog.kind !== 'available'
      || !restartedCatalog.plugins.some((entry) => entry.pluginId === packed.pluginId && entry.enabled)) {
      return failure(projectRoot, 'plugin_packed_restart_currentness_failed', 'Packed plugin was not current after daemon restart');
    }

    if (actionLocalId) {
      const actionId = `${packed.pluginId}/${actionLocalId}`;
      const attempt = await invokeAction({ daemon, actionId });
      if (!attempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          `Packed action '${actionId}' was not available through the daemon`,
        );
      }
      const actionResult = attempt.result;
      if (!actionResult.ok) {
        return failure(
          projectRoot,
          'plugin_packed_invocation_failed',
          actionResult.error,
        );
      }
      invocation = Object.freeze({
        actionId,
        result: actionResult.result,
      });
    }

    if (params.connectedAccountPurposeRemovalReaddActionLocalId) {
      const removed = await requestDaemonPluginChange({
        kind: 'uninstall',
        pluginId: packed.pluginId,
      }, { target: daemon.target });
      if (
        removed.kind !== 'committed'
        || removed.desiredGeneration !== null
        || removed.appliedGeneration !== null
      ) {
        return failure(
          projectRoot,
          'plugin_packed_removal_failed',
          `Disposable daemon did not commit and publish plugin removal (${removed.kind})`,
        );
      }
      const removedCatalog = await readDaemonPluginCatalog({ target: daemon.target });
      if (
        removedCatalog.kind !== 'available'
        || removedCatalog.plugins.some((entry) => entry.pluginId === packed.pluginId)
      ) {
        return failure(
          projectRoot,
          'plugin_packed_removal_currentness_failed',
          'Removed plugin remained present in the daemon-owned catalog',
        );
      }

      const readdRequested = await requestDaemonPluginChange({
        kind: 'installArchive',
        locator: packed.archivePath,
        expectedIntegrity: packed.archiveIntegrity,
      }, { target: daemon.target });
      const readded = readdRequested.kind === 'reviewRequired'
        ? await decideDaemonPluginChange({
            pendingChangeId: readdRequested.pendingChangeId,
            decision: 'installAndTrust',
            actorEvidence: {
              kind: 'authenticatedLocalUser',
              interactionId: randomUUID(),
              occurredAtMs: Date.now(),
            },
            optionalSelections: readdRequested.review.optionalHostAccess.map((access) => ({
              accessId: access.id,
              selected: false,
            })),
          }, { target: daemon.target })
        : readdRequested;
      if (
        readded.kind !== 'committed'
        || readded.desiredGeneration === null
        || readded.appliedGeneration !== readded.desiredGeneration
      ) {
        return failure(
          projectRoot,
          'plugin_packed_readd_failed',
          `Disposable daemon did not commit and publish plugin re-add (${readded.kind})`,
        );
      }

      const actionId =
        `${packed.pluginId}/${params.connectedAccountPurposeRemovalReaddActionLocalId}`;
      const readdAttempt = await invokeAction({ daemon, actionId });
      if (!readdAttempt.matched) {
        return failure(
          projectRoot,
          'plugin_packed_readd_invocation_failed',
          `Re-added packed action '${actionId}' was unavailable`,
        );
      }
      if (!readdAttempt.result.ok) {
        return failure(
          projectRoot,
          'plugin_packed_readd_invocation_failed',
          readdAttempt.result.error,
        );
      }
      publicationRemovalReadd = Object.freeze({
        removed: true,
        readded: true,
        invocation: Object.freeze({
          actionId,
          result: readdAttempt.result.result,
        }),
      });
    }

    const restartedReady = daemon.ready;
    if ((params.expectedRedactedValues?.length ?? 0) > 0) {
      await daemon.stop();
      daemon = null;
      const logsDir = join(happyHomeDir, 'logs');
      const logNames = await readdir(logsDir).catch(() => []);
      const logText = (
        await Promise.all(logNames.map(async (name) => (
          await readFile(join(logsDir, name), 'utf8').catch(() => '')
        )))
      ).join('\n');
      const leakedValue = params.expectedRedactedValues?.find((value) => logText.includes(value));
      if (leakedValue) {
        return failure(
          projectRoot,
          'plugin_packed_secret_redaction_failed',
          'A Connected Accounts materialization value remained visible in plugin invocation logs',
        );
      }
      if (!logText.includes('[REDACTED]')) {
        return failure(
          projectRoot,
          'plugin_packed_secret_redaction_missing',
          'Packed Connected Accounts invocation logs did not contain a redacted materialization value',
        );
      }
    }

    return Object.freeze({
      ok: true,
      mode: 'packed',
      projectRoot,
      pluginId: packed.pluginId,
      archiveDigest: packed.archiveDigest,
      invocation,
      ...(publicationRemovalReadd ? { publicationRemovalReadd } : {}),
      daemon: Object.freeze({
        authenticatedControl: true,
        initialPid: initialDaemon.ready.pid,
        restartedPid: restartedReady.pid,
        initialIncarnationId: initialDaemon.ready.incarnationId,
        restartedIncarnationId: restartedReady.incarnationId,
        staleIncarnationRejected: true,
      }),
    });
  } catch (error) {
    return failure(
      projectRoot,
      'plugin_packed_test_failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await daemon?.stop();
    await rm(operationRoot, { recursive: true, force: true });
  }
}
