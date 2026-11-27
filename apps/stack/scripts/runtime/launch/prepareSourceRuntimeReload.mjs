import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { format } from 'node:util';
import { probeRuntimeImport } from '../../utils/proc/runtimeImportProbe.mjs';
import { sourceBuildNodeArgs } from '../../utils/proc/runSourceBuildCommand.mjs';

import { prepareSourceRuntimeProducer, admitSourceRuntimeReload, normalizeSourceCapturedAfter, readLatestBuiltSourceRevision } from '../../build/build_source_runtime.mjs';
import { canResolveSourceRevisions, parseSourceOverlayPaths, readSourceRevisionDescriptor, resolveSourceRevisionIdentity, sourceRevisionIdentity, writeSourceRevisionDescriptor } from '../../build/source_revision.mjs';
import { prepareSourceQaWebUi } from '../../build/build_source_web_ui.mjs';
import { prepareSourceTreeRuntimeComponents, recordSourceTreeBases, resolveSourceTreeRevision, selectsSourceTreeReload, sourceRevisionTreesRoot } from '../../build/source_revision_tree.mjs';
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
import { resolveRevisionDependencyRoot } from '../../build/source_revision_install.mjs';
import { recordSourceSelectionRollback } from '../shared/source_selection_rollback.mjs';
import { emitSourceRuntimeSourceTimes, formatSourceRuntimeSourceTimes } from '../shared/source_bundle_record.mjs';
import { redactFailureDiagnostic } from '../../utils/proc/proc.mjs';

/** Normalize once at the reload boundary, before dispatch to execution hosts. */
export function resolveSourceRuntimeReloadArguments({ args }) {
  const { flags, kv } = parseArgs(args);
  const requestedBoundary = normalizeSourceCapturedAfter(kv.get('--source-after'));
  // Plain reloads use the producer's last-green capture. Only an explicit fix
  // boundary requests newer source, unchanged across execution hosts.
  const sourceCapturedAfter = requestedBoundary;
  if (sourceCapturedAfter != null) args = [...(args ?? []), `--source-after=${new Date(sourceCapturedAfter).toISOString()}`];
  // QA runs one committed revision plus this Stack's declared overlay (owner 2026-11-14).
  // An execution host receives the controller's description instead (`--source-revision`).
  const revisionDescriptorPath = kv.get('--source-revision') || undefined;
  const rev = kv.get('--rev') || undefined;
  const overlayValue = kv.get('--overlay');
  return { args, flags, kv, sourceCapturedAfter, revisionDescriptorPath, rev,
    overlay: overlayValue == null ? undefined : parseSourceOverlayPaths(overlayValue) };
}

/** `--rev` (default: the latest revision this controller's producer built, else HEAD)
 * plus `--overlay` / the Stack's `HAPPIER_STACK_SOURCE_OVERLAY`. An overlay layers on HEAD
 * unless `--rev` names another revision. Every host then prepares this exact revision. */
async function resolveReloadSourceRevision({ request, repoDir, stackBaseDir, env, green }) {
  // Without the controller's Git there is no revision to select; the producer logs its checkout capture.
  if (!canResolveSourceRevisions({ repoDir, env })) return null;
  const overlay = request.overlay ?? parseSourceOverlayPaths(env.HAPPIER_STACK_SOURCE_OVERLAY ?? '');
  const rev = selectReloadSourceRevision({ rev: request.rev, overlay, green,
    latestBuilt: request.rev || overlay.length || green ? null : await readLatestBuiltSourceRevision({ repoDir, stackBaseDir }) });
  return await resolveSourceRevisionIdentity({ repoDir, rev, overlay });
}

/** A plain QA reload takes the green commit (stack/qa_green.mjs): the newest commit whose own reload
 * built, loaded its server and daemon and started an Agent. `--rev` names any commit; an overlay is a
 * lane's uncommitted edit written against HEAD, so it stays on HEAD. */
export function selectReloadSourceRevision({ rev, overlay, green, latestBuilt }) {
  return rev ?? (overlay.length ? 'HEAD' : green?.revision ?? latestBuilt ?? 'HEAD');
}

/** The green pointer only where this controller resolves revisions itself, and (QA train canary, owner 2026-11-18)
 * only for Stacks in the canary (`HAPPIER_STACK_QA_TRAIN=1`) until P03 ORCH makes it the fleet default. */
async function readReloadGreen({ request, repoDir, env }) {
  if (env.HAPPIER_STACK_QA_TRAIN !== '1') return null;
  if (request.rev || request.revisionDescriptorPath || !canResolveSourceRevisions({ repoDir, env })) return null;
  const { readQaGreen, resolveQaGreenStateDir } = await import('../../stack/qa_green.mjs');
  try { return await readQaGreen({ stateDir: await resolveQaGreenStateDir({ repoDir, env }) }); }
  catch (error) { console.error(`[reload] green pointer unreadable (${error?.code ?? error?.message}); selecting as before`); return null; }
}

/** Called by the existing restart owner before any incumbent retirement. */
export async function prepareSourceRuntimeReload({ stackName, stackBaseDir, repoDir, args, env,
  activation = Promise.resolve(true), onPrepared = async () => {}, onHost = false, onPhase, sourceStartRequestId,
  requestBaseArchive }) {
  const started = performance.now();
  const request = resolveSourceRuntimeReloadArguments({ args });
  const { flags, kv, sourceCapturedAfter } = request;
  let revisionDir;
  args = request.args;
  const uiMode = resolveSourceQaUiMode({ uiMode: kv.get('--ui') ?? (flags.has('--ui') ? '' : undefined),
    noUi: flags.has('--no-ui'), consumerStackName: stackName, producerStackName: env.HAPPIER_STACK_EXPO_SOURCE_STACK });
  const serverComponent = getServerComponentName({ kv, env });
  const connection = resolveDevServerConnection({ flags, kv, env,
    resolvedLocalUrls: { internalServerUrl: '', publicServerUrl: '' } });
  const placement = onHost || flags.has('--no-dev-targets') ? null : await resolveControlledRuntimePlacement({
    stackName, stackBaseDir, sourceDir: repoDir, env,
    daemonLaunchRequested: resolveStackDaemonStartRequested({ env, noDaemon: flags.has('--no-daemon') }) });
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
  let phaseStarted = started;
  const finishPhase = phase => {
    const now = performance.now();
    logger.error(`[source-reload] phase=${phase} elapsedMs=${Math.round(now - phaseStarted)}`);
    phaseStarted = now;
  };
  try {
    await mkdir(logDir, { recursive: true });
    // The live pending marker owns preparation, including a failed attempt
    // waiting for an edit. This record carries logs and terminal outcomes.
    await writeJsonAtomic(statusPath, { logPath });
    await log('[reload] preparing replacement while incumbent runtime remains loaded');
    // Activation starts this live launcher after incumbent retirement. Exercise
    // its real load now, while refusal can still preserve the incumbent.
    const launcher = join(repoDir, 'apps/stack/scripts/stack.mjs');
    const launcherLoad = await probeRuntimeImport({ entrypoint: launcher, args: ['--help'],
      nodeArgs: sourceBuildNodeArgs({ repoDir, scriptPath: launcher }).slice(0, -1),
      cwd: repoDir, env, signal: pending.signal });
    if (launcherLoad.status === 'failed') {
      throw Object.assign(new Error(`[reload] activation launcher failed to load: ${launcherLoad.loadError.message}`), {
        entryGraph: 'stack-launcher', firstFailingModule: launcherLoad.firstFailingModule,
        loadError: launcherLoad.loadError,
      });
    }
    // The controller records authored-tree opt-in in the descriptor so a
    // placed host prepares the same representation. Checkout captures and
    // revision reloads default to the shared compiled publication.
    const hostTreeDescriptor = request.revisionDescriptorPath
      ? (await readSourceRevisionDescriptor(request.revisionDescriptorPath)).fullTree === true : false;
    const sourceTree = hostTreeDescriptor || (!request.revisionDescriptorPath && sourceCapturedAfter == null
      && selectsSourceTreeReload({ env }) && canResolveSourceRevisions({ repoDir, env }));
    let treeRevision = null;
    const green = await readReloadGreen({ request, repoDir, env });
    if (sourceTree && !request.revisionDescriptorPath) {
      const overlay = request.overlay ?? parseSourceOverlayPaths(env.HAPPIER_STACK_SOURCE_OVERLAY ?? '');
      treeRevision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir),
        rev: selectReloadSourceRevision({ rev: request.rev, overlay, green }), overlay,
        outputDir: revisionDir = await mkdtemp(join(await mkdir(sourceRoot, { recursive: true }).then(() => sourceRoot), 'revision-')) });
      await log(`[reload] source tree ${treeRevision.revision} = base ${treeRevision.base} + ${treeRevision.commitPaths} committed path(s); no bundle build`);
    }
    const revision = request.revisionDescriptorPath || sourceTree ? null
      : await resolveReloadSourceRevision({ request, repoDir, stackBaseDir, env, green });
    if (green && !request.rev && [treeRevision?.revision, revision?.revision].includes(green.revision)) {
      await log(`[reload] green commit ${green.revision} (proven ${green.checkedAt}); --rev=HEAD selects HEAD instead`);
    }
    let sourceRevision = request.revisionDescriptorPath ? { descriptorPath: request.revisionDescriptorPath }
      : revision ? { rev: revision.revision, overlay: Object.keys(revision.overlay) } : undefined;
    if (uiMode === 'export' && connection.startServer && !placement?.target && !sourceTree && sourceRevision) {
      // Provision the selected installation before the finite producers, including
      // mirrors that obtain their revision archive from the controller.
      if (!sourceRevision.descriptorPath) {
        sourceRevision = { descriptorPath: await writeSourceRevisionDescriptor({ repoDir, identity: revision,
          outputDir: revisionDir = await mkdtemp(join(sourceRoot, 'revision-')),
          components: ['server', 'daemon', 'expo'] }) };
      }
      await resolveRevisionDependencyRoot({ repoDir,
        descriptor: await readSourceRevisionDescriptor(sourceRevision.descriptorPath),
        treesRoot: sourceRevisionTreesRoot(stackBaseDir), requestBaseArchive, env, signal: pending.signal });
    }
    if (revision) await log(`[reload] source revision ${revision.revision}${revision.overlayDigest ? ` + overlay ${revision.overlayDigest} (${Object.keys(revision.overlay).length} declared files)` : ''}; select another with --rev=<sha>, layer this Stack's uncommitted files with --overlay=<paths>`);
    if (sourceCapturedAfter != null) await log(`[reload] source capture boundary: ${new Date(sourceCapturedAfter).toISOString()}`);
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
      finishPhase('setup');
      const remotePreparation = (async () => {
        if (placement?.target || placement?.daemonTarget) {
          // Hosts without Git metadata receive one description of the revision.
          const sourceRevisionDescriptorPath = treeRevision?.descriptorPath ?? sourceRevision?.descriptorPath ?? (revision ? await writeSourceRevisionDescriptor({ repoDir, identity: revision,
            outputDir: revisionDir = await mkdtemp(join(sourceRoot, 'revision-')),
            components: ['server', 'daemon', ...(uiMode === 'export' ? ['expo'] : [])] }) : undefined);
          remote = await (await import('../../utils/dev_targets/supervisor.mjs')).prepareStackDevTargetSourceReload({
            stackName, stackBaseDir, repoDir, placement, args, serverRequested: connection.startServer, sourceRevisionDescriptorPath,
            env: { ...env, HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
              HAPPIER_SERVER_URL: connection.startServer
                ? (await resolveStackServerEndpoint({ env, stackName })).internalServerUrl : connection.internalServerUrl },
            sourceStartRequestId: pending.requestId,
            signal: pending.signal, onPhase: (target, phase) => pending.setPhase(phase, target),
            onLog: message => { retainLog(`${message}\n`); } });
        }
        return remote;
      })();
      const localPreparation = !localComponents.length ? Promise.resolve({})
        : sourceTree ? prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir, components: localComponents, requestBaseArchive,
          descriptorPath: treeRevision?.descriptorPath ?? request.revisionDescriptorPath, env: serverEnv, signal: pending.signal, logger })
        : prepareSourceRuntimeProducer({ repoDir, stackBaseDir,
        components: localComponents, pending, env: serverEnv, signal: pending.signal,
        sourceCapturedAfter, sourceRevision, requireLastGreen: sourceCapturedAfter == null,
        requestBaseArchive, logger, stderrStream });
      // Finite producers retain their own joint host/resource admission. The
      // coordinator holds no capacity while the independent preparations run.
      preparations = [localPreparation, remotePreparation];
      const [{ server, daemon }] = await Promise.all(preparations);
      finishPhase('component-preparation');
      if (server) components.server = server;
      if (daemon) components.daemon = daemon;
      // Later revisions reuse only bases a preparation built (after a failed ancestor, the requested revision).
      if (treeRevision) await recordSourceTreeBases({ treesRoot: sourceRevisionTreesRoot(stackBaseDir),
        bases: [...Object.values(remote?.sourceCaptures ?? {}), server?.sourceCapture, daemon?.sourceCapture].map(capture => capture?.base) });
      // The web export follows the server's revision, so this Stack serves one revision.
      // On a source tree it is built from that server tree, never the moving checkout.
      const serverTree = sourceTree ? components.server : null;
      const ui = components.server ? (await prepareSourceQaWebUi({ mode: uiMode, repoDir, baseDir: sourceRoot,
        stackBaseDir, pending, retainsSelection: true, env, signal: pending.signal, sourceCapturedAfter,
        sourceRevision: serverTree ? { ...sourceRevision, treeDir: serverTree.sourceTree.dir } : sourceRevision,
        requireLastGreen: sourceCapturedAfter == null,
        revision: serverTree ? { revision: serverTree.sourceCapture.revision, overlayDigest: serverTree.sourceCapture.overlayDigest ?? null }
          : request.revisionDescriptorPath ? sourceRevisionIdentity(await readSourceRevisionDescriptor(request.revisionDescriptorPath))
          : revision })).built : null;
      finishPhase('web-selection');
      await log('[reload] producer capture adopted; checking replacement daemon loader, server health and UI boot');
      await pending.setPhase({ phase: 'checking' });
      // An automatic miss must replace the old UI selection as part of the server swap.
      const uiSelection = ui ?? (components.server && uiMode === 'auto' ? null : undefined);
      const check = () => admitSourceRuntimeReload({ stackBaseDir, components, ui: uiSelection, pending,
        env: { ...serverEnv, HAPPIER_STACK_REPO_DIR: repoDir }, logger });
      let admitted;
      try {
        admitted = await check();
      } catch (error) {
        pending.signal.throwIfAborted();
        // Readiness retries the finished capture, never producer preparation.
        // The probes keep their existing budget and cancellation signal.
        await log(`[reload] readiness failed; retrying adoption of the same producer capture:${formatSourceReloadRefusal(error, env)}`);
        admitted = await check();
      }
      finishPhase('replacement-checks');
      if (components.server && !String(serverEnv.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()) {
        await preflightSourceRuntimeMigrations({ server: components.server, env: serverEnv, stackBaseDir, signal: pending.signal });
        finishPhase('retained-db-preflight');
      }
      const sourceCaptures = { ...remote?.sourceCaptures, ...Object.fromEntries(Object.entries(components)
        .map(([component, built]) => [component, built.sourceCapture ?? null])) };
      if (ui) sourceCaptures.ui = ui.sourceCapture ?? null;
      const sourceTimes = { ...remote?.sourceTimes, ...Object.fromEntries(Object.entries(sourceCaptures)
        .map(([component, capture]) => [component, capture?.capturedAt ?? null])) };
      await pending.setPhase({ phase: 'prepared' });
      await onPrepared({ ui, sourceTimes, sourceCaptures });
      const selected = await activation;
      finishPhase('activation-wait');
      if (!selected) throw new Error('[reload] preparation cancelled before selection; incumbent retained');
      pending.signal.throwIfAborted();
      // The selection this activation replaces is the incumbent's revision. Its
      // restart owner restarts it if the replacement fails after retirement.
      await pending.publishPreparation(() => recordSourceSelectionRollback({ stackBaseDir, env }));
      await remote?.activate();
      await admitted.activate();
      finishPhase('selection');
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
    if (revisionDir) await rm(revisionDir, { recursive: true, force: true });
    if (onHost && request.revisionDescriptorPath) await rm(request.revisionDescriptorPath, { force: true });
    logger.error(`[source-reload] phase=total elapsedMs=${Math.round(performance.now() - started)}`);
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
  // A mirror without Git objects asks the controller for the revision archive of a
  // base it lacks; the controller uploads it to `path` and answers on this pipe.
  const archiveRequests = new Map();
  const answerArchive = (path, error) => { archiveRequests.get(path)?.(error); archiveRequests.delete(path); };
  control.on('line', line => {
    if (line === 'activate') decide(true);
    else if (line === 'cancel') decide(false);
    else if (line.startsWith('base-archive ')) { const { path, error } = JSON.parse(line.slice('base-archive '.length)); answerArchive(path, error); }
  });
  control.on('close', () => {
    decide(false);
    for (const path of [...archiveRequests.keys()]) answerArchive(path, 'control pipe closed before the revision archive arrived');
  });
  const requestBaseArchive = ({ revision, path }) => new Promise((resolveArchive, reject) => {
    archiveRequests.set(path, error => error ? reject(new Error(`[source-tree] revision archive for ${revision} unavailable: ${error}`)) : resolveArchive());
    process.stdout.write(`HSTACK_SOURCE_TREE_BASE_ARCHIVE ${JSON.stringify({ revision, path })}\n`);
  });
  try {
    await prepareSourceRuntimeReload({ ...request, env: process.env, onHost: true, activation, requestBaseArchive,
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
