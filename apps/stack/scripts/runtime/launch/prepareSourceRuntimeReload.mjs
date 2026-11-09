import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { format } from 'node:util';

import { buildSourceRuntimeBundle, admitSourceRuntimeReload, captureSourceRuntimeSharedInputs } from '../../build/build_source_runtime.mjs';
import { exportSourceWebUi } from '../../build/build_source_web_ui.mjs';
import { parseArgs } from '../../utils/cli/args.mjs';
import { resolveSourceQaUiMode } from '../shared/borrowed_expo.mjs';
import { beginPendingSourceStart, emitSourcePreparationPhase } from '../shared/pending_source_start.mjs';
import { resolveControlledRuntimePlacement } from '../../utils/dev_targets/service_placement.mjs';
import { applyServerHostDatabaseProviderEnv } from '../../utils/server/apply_runtime_server_database_env.mjs';
import { applyEffectiveDbProviderEnv } from '../../utils/server/effective_db_provider.mjs';
import { resolveStackDaemonStartRequested } from '../../utils/auth/daemon_gate.mjs';
import { writeJsonAtomic } from '../../utils/fs/json.mjs';
import { getServerComponentName } from '../../utils/server/server.mjs';
import { resolveDevServerConnection } from '../../utils/dev/resolveDevServerConnection.mjs';
import { resolveStackServerEndpoint } from '../../utils/server/urls.mjs';
import { redactFailureDiagnostic } from '../../utils/proc/proc.mjs';

/** Called by the existing restart owner before any incumbent retirement. */
export async function prepareSourceRuntimeReload({ stackName, stackBaseDir, repoDir, args, env,
  activation = Promise.resolve(true), onPrepared = async () => {}, onHost = false, onPhase, sourceStartRequestId }) {
  const { flags, kv } = parseArgs(args);
  const uiMode = resolveSourceQaUiMode({ uiMode: kv.get('--ui') ?? (flags.has('--ui') ? '' : undefined),
    noUi: flags.has('--no-ui'), consumerStackName: stackName, producerStackName: env.HAPPIER_STACK_EXPO_SOURCE_STACK });
  const serverComponent = getServerComponentName({ kv, env });
  const connection = resolveDevServerConnection({ flags, kv, env,
    resolvedLocalUrls: { internalServerUrl: '', publicServerUrl: '' } });
  const placement = onHost || flags.has('--no-dev-targets') ? null : await resolveControlledRuntimePlacement({
    stackName, stackBaseDir, sourceDir: repoDir, env });
  const pending = await beginPendingSourceStart({ stackBaseDir, onPhase, repoDir, env,
    requestId: sourceStartRequestId ?? kv.get('--source-start-request-id'),
    ...(onHost ? { replacePending: true } : {}) });
  const cancel = () => pending.abort(new Error('[reload] source preparation interrupted; incumbent retained'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const statusPath = join(sourceRoot, 'reload.json');
  const logDir = join(stackBaseDir, 'logs');
  const logPath = join(logDir, `run.reload.${Date.now()}.log`);
  let logWrites = Promise.resolve();
  const retainLog = text => {
    const write = logWrites.then(() => appendFile(logPath, text));
    logWrites = write.catch(error => console.error('[reload] log publication failed:', error));
    return write;
  };
  const log = async message => { console.log(message); await retainLog(`${message}\n`); };
  const diagnosticInput = new PassThrough();
  const diagnosticLines = createInterface({ input: diagnosticInput });
  const diagnosticsClosed = new Promise(resolve => diagnosticLines.once('close', resolve));
  diagnosticLines.on('line', line => { retainLog(`${redactFailureDiagnostic(line, env)}\n`); });
  const stderrStream = { write: chunk => {
    process.stderr.write(chunk);
    return diagnosticInput.write(chunk);
  } };
  const logger = { ...console, error: (...values) => stderrStream.write(`${format(...values)}\n`) };
  try {
    await mkdir(logDir, { recursive: true });
    // The live pending marker owns preparation, including a failed attempt
    // waiting for an edit. This record carries logs and terminal outcomes.
    await writeJsonAtomic(statusPath, { logPath });
    await log('[reload] preparing replacement while incumbent runtime remains loaded');
    if (placement?.target && !connection.startServer) {
      throw new Error('[reload] remote server placement cannot be activated with an external-server source start; incumbent retained');
    }
    let remote = null;
    let preparations = [];
    let sharedSourceInputDir = null;
    try {
      if (serverComponent !== 'happier-server-light' && connection.startServer) {
        throw new Error('[reload] full-server smoke requires isolated managed infrastructure; incumbent retained');
      }
      const serverEnv = { ...env };
      const dbProvider = connection.startServer && !placement?.target
        ? applyServerHostDatabaseProviderEnv({ serverComponentName: serverComponent, env: serverEnv })
        : applyEffectiveDbProviderEnv({ serverComponentName: serverComponent, env: serverEnv });
      const components = {};
      const daemonRequested = !placement?.daemonTarget
        && resolveStackDaemonStartRequested({ env, noDaemon: flags.has('--no-daemon') });
      const remotePreparation = (async () => {
        if (placement?.target || placement?.daemonTarget) {
          remote = await (await import('../../utils/dev_targets/supervisor.mjs')).prepareStackDevTargetSourceReload({
            stackName, stackBaseDir, repoDir, placement, args, serverRequested: connection.startServer,
            env: { ...env, HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
              HAPPIER_SERVER_URL: connection.startServer
                ? (await resolveStackServerEndpoint({ env, stackName })).internalServerUrl : connection.internalServerUrl },
            sourceStartRequestId: pending.requestId,
            signal: pending.signal, onPhase: (target, phase) => pending.setPhase(phase, target),
            onLog: message => { retainLog(`${message}\n`); } });
        }
        return remote;
      })();
      const sharedSourceInputs = (async () => {
        if (!connection.startServer || placement?.target || !daemonRequested) return null;
        sharedSourceInputDir = await mkdtemp(join(sourceRoot, 'shared-inputs-'));
        return await captureSourceRuntimeSharedInputs({ repoDir,
          outputDir: sharedSourceInputDir, signal: pending.signal });
      })();
      // Finite producers retain their own joint host/resource admission. The
      // coordinator holds no capacity while the independent preparations run.
      const serverPreparation = sharedSourceInputs.then(shared => connection.startServer && !placement?.target
        ? buildSourceRuntimeBundle({ repoDir, stackBaseDir, pending, component: 'server', serverComponent,
          dbProvider, env: serverEnv, signal: pending.signal, sharedSourceInputs: shared, logger, stderrStream }) : null);
      const daemonPreparation = sharedSourceInputs.then(shared => daemonRequested
        ? buildSourceRuntimeBundle({ repoDir, stackBaseDir, pending, component: 'daemon',
          env, signal: pending.signal, sharedSourceInputs: shared, logger, stderrStream }) : null);
      preparations = [serverPreparation, daemonPreparation, remotePreparation];
      const [server, daemon] = await Promise.all(preparations);
      if (server) components.server = server;
      if (daemon) components.daemon = daemon;
      const ui = components.server && uiMode === 'export' ? await exportSourceWebUi({ repoDir, baseDir: sourceRoot,
        stackBaseDir, pending, env, signal: pending.signal }) : null;
      await log('[reload] build complete; checking replacement daemon loader, server health and UI boot');
      await pending.setPhase({ phase: 'checking' });
      const admitted = await admitSourceRuntimeReload({ stackBaseDir, components, ui, pending,
        env: { ...serverEnv, HAPPIER_STACK_REPO_DIR: repoDir } });
      await pending.setPhase({ phase: 'prepared' });
      await onPrepared({ ui });
      if (!await activation) throw new Error('[reload] preparation cancelled before selection; incumbent retained');
      pending.signal.throwIfAborted();
      await remote?.activate();
      await admitted.activate();
      // Successful selection is already authoritative. A diagnostic write must
      // not mislabel a validated graph as a failed preparation afterwards.
      await writeJsonAtomic(statusPath, { status: 'ready', logPath }).catch(error => console.error('[reload] diagnostic publication failed:', error));
      await log('[reload] replacement smoke passed; incumbent may now be retired by the restart owner')
        .catch(error => console.error('[reload] log publication failed:', error));
      return { ui, remote: Boolean(remote), remoteDaemon: Boolean(placement?.daemonTarget) };
    } catch (error) {
      pending.abort(error);
      throw error;
    } finally {
      await Promise.allSettled(preparations);
      try { await remote?.close(); }
      finally { if (sharedSourceInputDir) await rm(sharedSourceInputDir, { recursive: true, force: true }); }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(statusPath, { status: 'failed', message, logPath })
      .catch(diagnostic => console.error('[reload] failure diagnostic publication failed:', diagnostic));
    await log(`[reload] replacement refused; incumbent retained: ${message}`)
      .catch(diagnostic => console.error('[reload] failure log publication failed:', diagnostic));
    throw error;
  } finally {
    diagnosticInput.end();
    await diagnosticsClosed;
    await logWrites;
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await pending.dispose();
  }
}

// The existing remote executor owns this worker and its control pipe. It only
// prepares/selects source bytes; Stack retirement stays with the restart owner.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  const request = JSON.parse(process.argv[3]);
  const control = createInterface({ input: process.stdin });
  let decide;
  const activation = new Promise(resolve => { decide = resolve; });
  control.on('line', line => { if (line === 'activate') decide(true); else if (line === 'cancel') decide(false); });
  control.on('close', () => decide(false));
  try {
    await prepareSourceRuntimeReload({ ...request, env: process.env, onHost: true, activation,
      onPhase: emitSourcePreparationPhase,
      onPrepared: () => process.stdout.write('HSTACK_SOURCE_RELOAD_PREPARED\n') });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { control.close(); }
}
