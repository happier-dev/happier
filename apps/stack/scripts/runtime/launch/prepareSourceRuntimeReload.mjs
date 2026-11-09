import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { format } from 'node:util';

import { prepareSourceRuntimeProducer, admitSourceRuntimeReload, normalizeSourceCapturedAfter } from '../../build/build_source_runtime.mjs';
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
import { emitSourceReloadRefusal, formatSourceReloadRefusal, recordSourceReloadRefusal } from '../shared/source_reload_refusal.mjs';
import { preflightSourceRuntimeMigrations } from './preflightSourceRuntimeMigrations.mjs';
import { emitSourceRuntimeSourceTimes, formatSourceRuntimeSourceTimes } from '../shared/source_bundle_record.mjs';
import { redactFailureDiagnostic } from '../../utils/proc/proc.mjs';

/** Normalize once at the reload boundary, before dispatch to execution hosts. */
export function resolveSourceRuntimeReloadArguments({ args, requestStartedAt = Date.now() }) {
  const { flags, kv } = parseArgs(args);
  const requestedBoundary = normalizeSourceCapturedAfter(kv.get('--source-after'));
  // An explicit fix time permits fast adoption of a completed rolling prebuild.
  // The same boundary travels to every worker instead of advancing its clock.
  const sourceCapturedAfter = requestedBoundary ?? (flags.has('--allow-older-source') ? undefined : requestStartedAt);
  if (sourceCapturedAfter != null) args = [...(args ?? []), `--source-after=${new Date(sourceCapturedAfter).toISOString()}`];
  return { args, flags, kv, sourceCapturedAfter };
}

/** Called by the existing restart owner before any incumbent retirement. */
export async function prepareSourceRuntimeReload({ stackName, stackBaseDir, repoDir, args, env,
  activation = Promise.resolve(true), onPrepared = async () => {}, onHost = false, onPhase, sourceStartRequestId }) {
  const request = resolveSourceRuntimeReloadArguments({ args });
  const { flags, kv, sourceCapturedAfter } = request;
  args = request.args;
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
    await log(`[reload] source capture boundary: ${sourceCapturedAfter == null ? 'newest completed compatible capture' : new Date(sourceCapturedAfter).toISOString()}; fast adoption: --source-after=<ISO fix time> can reuse a completed rolling prebuild`);
    if (placement?.target && !connection.startServer) {
      throw new Error('[reload] remote server placement cannot be activated with an external-server source start; incumbent retained');
    }
    let remote = null;
    let preparations = [];
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
      const localComponents = [
        ...(connection.startServer && !placement?.target ? [{ component: 'server', serverComponent, dbProvider }] : []),
        ...(daemonRequested ? [{ component: 'daemon' }] : []),
      ];
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
      const localPreparation = localComponents.length ? prepareSourceRuntimeProducer({ repoDir, stackBaseDir,
        components: localComponents, pending, env: serverEnv, signal: pending.signal,
        sourceCapturedAfter, logger, stderrStream }) : Promise.resolve({});
      // Finite producers retain their own joint host/resource admission. The
      // coordinator holds no capacity while the independent preparations run.
      preparations = [localPreparation, remotePreparation];
      const [{ server, daemon }] = await Promise.all(preparations);
      if (server) components.server = server;
      if (daemon) components.daemon = daemon;
      const ui = components.server && uiMode === 'export' ? await exportSourceWebUi({ repoDir, baseDir: sourceRoot,
        stackBaseDir, pending, env, signal: pending.signal, sourceCapturedAfter }) : null;
      await log('[reload] producer capture adopted; checking replacement daemon loader, server health and UI boot');
      await pending.setPhase({ phase: 'checking' });
      const admitted = await admitSourceRuntimeReload({ stackBaseDir, components, ui, pending,
        env: { ...serverEnv, HAPPIER_STACK_REPO_DIR: repoDir } });
      if (components.server) await preflightSourceRuntimeMigrations({ server: components.server,
        env: serverEnv, stackBaseDir, signal: pending.signal });
      const sourceCaptures = { ...remote?.sourceCaptures, ...Object.fromEntries(Object.entries(components)
        .map(([component, built]) => [component, built.sourceCapture ?? null])) };
      if (ui) sourceCaptures.ui = ui.sourceCapture ?? null;
      const sourceTimes = { ...remote?.sourceTimes, ...Object.fromEntries(Object.entries(sourceCaptures)
        .map(([component, capture]) => [component, capture?.capturedAt ?? null])) };
      await pending.setPhase({ phase: 'prepared' });
      await onPrepared({ ui, sourceTimes, sourceCaptures });
      if (!await activation) throw new Error('[reload] preparation cancelled before selection; incumbent retained');
      pending.signal.throwIfAborted();
      await remote?.activate();
      await admitted.activate();
      // Successful selection is already authoritative. A diagnostic write must
      // not mislabel a validated graph as a failed preparation afterwards.
      await writeJsonAtomic(statusPath, { status: 'ready', logPath, sourceTimes, sourceCaptures }).catch(error => console.error('[reload] diagnostic publication failed:', error));
      await log(`[reload] PREPARED${Object.keys(sourceTimes).length ? ` ${formatSourceRuntimeSourceTimes(sourceTimes, sourceCaptures)}` : ''}; replacement smoke passed; incumbent may now be retired by the restart owner; runtime readiness is still pending`)
        .catch(error => console.error('[reload] log publication failed:', error));
      return { ui, remote: Boolean(remote), remoteDaemon: Boolean(placement?.daemonTarget) };
    } catch (error) {
      pending.abort(error);
      throw error;
    } finally {
      await Promise.allSettled(preparations);
      await remote?.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSourceReloadRefusal({ stackBaseDir, error, env, logPath });
    await log(`[reload] replacement refused; incumbent retained:${formatSourceReloadRefusal(error, env)} ${message.replaceAll('\n', ' ')}`)
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
      onPrepared: ({ sourceTimes, sourceCaptures }) => {
        emitSourceRuntimeSourceTimes(sourceTimes, sourceCaptures);
        process.stdout.write('HSTACK_SOURCE_RELOAD_PREPARED\n');
      } });
  } catch (error) {
    emitSourceReloadRefusal(error);
    console.error(error);
    process.exitCode = 1;
  } finally { control.close(); }
}
