import { readGreenSourceRuntimeCandidateGroups, sourceRuntimeCaptureUnavailable } from './source_runtime_last_green.mjs';
import { removeOwnedDirectorySync } from '../utils/fs/fs.mjs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { captureSourceWebBuildInputs, readWorkspacePackages, resolveWorkspaceSource,
  sourceBundleBuildLockPath, withSourceBundlePublication,
  adoptReusableSourceBundle, publishSourceBundleCandidate, resolveSourceRuntimeProducerContext,
  sourceRuntimeProducerBuildLockPath, normalizeSourceCapturedAfter, sourceRuntimeProducerUnavailable, setBundleReadOnly } from './build_source_runtime.mjs';
import { resolveExpoBin, prepareExpoCommandEnv } from '../utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../utils/expo/expoNodeHeapEnv.mjs';
import { run } from '../utils/proc/proc.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';
import { precompressUiWebAssets } from './precompress_ui_web_assets.mjs';
import { listBundledPluginUiArtifactExports } from '../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { assertBuildInputDependencies, buildInputDependencyIdentityMatches, readBuildInputDependencies, readBuildInputIdentity, readTerminalBuildFailure, serializeTerminalBuildFailure, withBuildInputDependencies, withSingleTrailingBuildPass } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { runWorkspaceBuildAdmission } from '../utils/proc/workspace_build_admission.mjs';
import { retainPendingSourcePreparation, updatePendingSourcePreparationPhase } from '../runtime/shared/pending_source_start.mjs';
import { emitSourceReloadRefusal, parseSourceReloadRefusalLine } from '../runtime/shared/source_reload_refusal.mjs';
import { readCachedFileDigest } from '../utils/fs/cached_file_digest.mjs';
import { sourceWebExportArgs } from './sourceWebExportArgs.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { SOURCE_WEB_EXPORT_ADMISSION_CLASS } from '../utils/dev_targets/remote_commands.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { rememberSourceCaptureFailure, withSourceCaptureRetry } from './source_capture_retry.mjs';
import { resolveSourceRevisionIdentity, sourceRevisionKey, writeSourceRevisionDescriptor } from './source_revision.mjs';
import { readJsonIfExists } from '../utils/fs/json.mjs';

/** Default QA adopts a matching publication; only explicit export requests
 * admit producer work. Consumers keep the selected result through publication. */
export async function prepareSourceQaWebUi({ mode, retainsSelection = false, ...options }) {
  if (mode === 'disabled' || mode === 'borrowed') return { mode, built: null };
  const built = await exportSourceWebUi({ ...options, reuseOnly: mode === 'auto' });
  if (built) return { mode: 'export', built };
  const unmatched = `no completed shared export matches ${options.revision ? `revision ${sourceRevisionKey(options.revision)} and these options` : 'the source inputs, options and capture boundary'}`;
  // A reload that requested an export keeps the Stack's selected export (its
  // selection is not replaced); every other caller serves live Expo. Say which.
  const retained = retainsSelection && mode === 'export' ? await readJsonIfExists(join(options.baseDir, 'selected-ui.json')) : null;
  if (retained?.uiDir) {
    console.error(`[source-ui] ${unmatched}; keeping the selected export rev=${retained.sourceCapture?.revision ?? 'checkout'} capturedAt=${retained.sourceCapture?.capturedAt ?? 'unknown'} (${retained.uiDir})`);
    return { mode: 'export', built: null };
  }
  console.error(`[source-ui] ${unmatched}; serving live (borrowed) Expo`);
  return { mode: 'borrowed', built: null };
}

/** Stack starts reuse completed account-free exports through source publication.
 * Explicit outputDir callers keep their private finite producer boundary. */
export async function exportSourceWebUi({ repoDir, baseDir, outputDir, stackBaseDir, pending,
  replaceUiDir = null, env = process.env, signal = pending?.signal, runImpl, sourceCapturedAfter, requireLastGreen = false, reuseOnly = false,
  sourceRevision, revision }) {
  if (stackBaseDir && !pending?.requestId) throw new Error('[source-ui] shared export requires its pending Stack start');
  if (stackBaseDir) {
    let built = await exportSharedSourceWebUi({ repoDir, stackBaseDir, requestId: pending.requestId,
      env, signal, sourceCapturedAfter, requireLastGreen, reuseOnly, sourceRevision, revision });
    if (!built) return null;
    if (replaceUiDir) built = await pending.publishPreparation(() =>
      replaceSourceWebUi({ built, replaceUiDir, repoDir, env, signal }));
    await pending.setPhase({ phase: 'prepared', component: 'ui' });
    return built;
  }
  let createdOutput = false;
  const built = await prepareSourceWebComponent({ repoDir, env, signal, preparation: pending, stackBaseDir,
    prepare: async () => {
      // This call's private partial export is never selected or served. A retry
      // must rerun preparation in an empty directory, preserving EEXIST for a
      // directory that predated this call.
      if (createdOutput) removeOwnedDirectorySync(outputDir);
      await mkdir(dirname(outputDir), { recursive: true });
      await mkdir(outputDir);
      createdOutput = true;
      await pending?.setPhase({ phase: 'queued', component: 'ui' });
      const built = await exportSourceWebUiOnce({ repoDir, baseDir, outputDir, env, signal, runImpl }).catch(async error => {
          if (error.code === 'BUILD_INPUTS_CHANGED') removeOwnedDirectorySync(outputDir);
          throw error;
        });
      if (!replaceUiDir) return built;
      return await replaceSourceWebUi({ built, replaceUiDir, repoDir, env, signal });
    } });
  await pending?.setPhase({ phase: 'prepared', component: 'ui' });
  return built;
}

async function replaceSourceWebUi({ built, replaceUiDir, repoDir, env, signal }) {
  signal?.throwIfAborted();
  // Older loaded servers retain a private directory. Copy the completed
  // producer output through the existing atomic directory publication owner.
  await buildIntoTempThenReplace(replaceUiDir, async stagedDir => {
    await cp(built.uiDir, stagedDir, { recursive: true });
    // A revision-tree export consumed a pinned installation, not the checkout's.
    if (built.dependencyPublication) await assertBuildInputDependencies({ sourceDir: repoDir, env, state: built.dependencyPublication });
  });
  return { ...built, uiDir: replaceUiDir };
}

/** A running server retains one Stack-owned path. Change its link, never the
 * immutable shared export (which another Stack may still serve). */
export async function publishSourceWebUi({ built, uiDir, pending }) {
  const exportDir = await realpath(built.exportDir ?? built.uiDir);
  await assertWebArtifactPayload({ payloadDir: exportDir, entrypoint: built.entrypoint ?? 'index.html' });
  await pending.retainPreparation(exportDir);
  return await pending.publishPreparation(async () => {
    await mkdir(dirname(uiDir), { recursive: true });
    await buildIntoTempThenReplace(uiDir, async stagedDir => {
      removeOwnedDirectorySync(stagedDir, { force: false });
      await symlink(exportDir, stagedDir, process.platform === 'win32' ? 'junction' : 'dir');
    });
    return { ...built, uiDir, exportDir };
  });
}

function sourceWebExportEnv(env) {
  return { ...buildStackWebExportEnv({ baseEnv: env,
    enableDebugRoutes: env.EXPO_PUBLIC_DEBUG === undefined || env.EXPO_PUBLIC_DEBUG === '1' }), CI: '1' };
}

async function sourceWebBuildOptions({ repoDir, env }) {
  const effective = sourceWebExportEnv(env);
  const options = Object.entries(effective).filter(([key]) =>
    /^(?:EXPO_|HAPPIER_UI_|HAPPIER_APP_|HAPPIER_EXPO_|HAPPIER_TERMINAL_NATIVE_|HAPPIER_ANDROID_|HAPPY_STACKS_|EAS_)/.test(key)
    || ['APP_ENV', 'NODE_ENV', 'BABEL_ENV', 'CI', 'EX_UPDATES_NATIVE_DEBUG', 'HAPPIER_ENABLE_TERMINAL_NATIVE', 'HAPPIER_SYNC_TUNING_JSON'].includes(key))
    // Source-map content is represented by sourceWebExportArgs below.
    .filter(([key]) => key !== 'HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY' && key !== 'HAPPIER_UI_EXPORT_SOURCE_MAPS')
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify([process.version, process.platform, process.arch, options,
    // Worker fanout is execution policy, not bundle content. Lookup happens
    // before admission and must not need or hash a job's transient CPU budget.
    sourceWebExportArgs({ ...effective, HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '0' })]))
    .digest('hex');
}

async function sourceWebInputIdentity({ repoDir }) {
  const { files } = await readSourceComponentBuildInputs({ repoDir, component: 'expo' });
  return await readBuildInputIdentity({ sourceDir: repoDir, files });
}

function sourceWebBuildFingerprint({ inputIdentity, buildOptions }) {
  return createHash('sha256').update(inputIdentity).update(buildOptions).digest('hex');
}

function sourceWebCandidateKey({ repoDir, buildOptions }) {
  return `web-${createHash('sha256').update(JSON.stringify([repoDir, buildOptions])).digest('hex')}`;
}

/** The export of one revision (+overlay): every Stack on that revision adopts it.
 * Orchestrator decision (11-13 ruling): a Stack's own UI build options never fork
 * the shared export, so revision and UI-input keys carry no build options. */
function sourceWebRevisionCandidateKey({ repoDir, revisionKey }) {
  return `web-rev-${createHash('sha256').update(JSON.stringify([repoDir, revisionKey])).digest('hex')}`;
}

/** The export of one UI-input digest: later revisions with identical UI inputs reuse it. */
function sourceWebUiInputCandidateKey({ repoDir, uiInputDigest }) {
  return `web-ui-${createHash('sha256').update(JSON.stringify([repoDir, uiInputDigest])).digest('hex')}`;
}

async function prepareSourceWebComponent({ repoDir, env, signal, prepare, preparation, stackBaseDir }) {
  return await prepareSourceComponent({ repoDir, target: 'expo', env, signal, preparation, stackBaseDir, prepare: () => withSingleTrailingBuildPass({ run: async () => {
    try {
      return await prepare();
    } catch (error) {
      if (error.code === 'BUILD_INPUTS_CHANGED') throw error;
      // The capture owner has already decided and exhausted any source retry.
      // Do not start another episode from unrelated input edits or diagnostics.
      error.sourceDrift = false;
      throw error;
    }
  } }) });
}

async function webOutputDigests(directory, prefix = '') {
  const digests = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(digests, await webOutputDigests(path, key));
    else if (entry.isFile()) {
      const digest = await readCachedFileDigest(path, await lstat(path, { bigint: true }));
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`[source-ui] exported asset is unreadable: ${key}`);
      digests[key] = digest;
    }
    else throw new Error('[source-ui] web output must contain only exported files and directories');
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)));
}

async function readReusableSourceWebUi({ repoDir, outputDir, record, buildOptions, env, inputIdentity, requireCurrentSource, sourceCapturedAfter, revision,
  candidate, uiInputDigest }) {
  const dependencyPublication = await readBuildInputDependencies({ sourceDir: repoDir, env });
  // The producer's revision export serves every Stack on that revision with the
  // producer's options; checkout-keyed exports still match the caller's options.
  if (record.component !== 'web' || (!revision && !uiInputDigest && record.buildOptions !== buildOptions)
    || (inputIdentity && record.inputIdentity !== inputIdentity)
    || record.uiDir !== join(outputDir, 'web') || !record.outputDigests) return null;
  if (sourceCapturedAfter !== undefined && !(Date.parse(record.sourceCapture?.capturedAt) >= sourceCapturedAfter)) return null;
  // A revision export matches by revision, never by the moving checkout, or by
  // the producer's alias for a later revision whose UI inputs are identical.
  const aliased = revision && !revision.overlayDigest && !record.sourceCapture?.overlayDigest && record.uiInputDigest
    && candidate?.alias?.revision === revision.revision && candidate.alias.uiInputDigest === record.uiInputDigest;
  if (revision && !aliased && (record.sourceCapture?.revision !== revision.revision
    || (record.sourceCapture.overlayDigest ?? null) !== (revision.overlayDigest ?? null))) return null;
  if (uiInputDigest && (record.uiInputDigest !== uiInputDigest || record.sourceCapture?.overlayDigest)) return null;
  // Only the repository producer's refresh compares authored inputs. QA
  // consumers adopt completed captures while the shared checkout keeps moving.
  if (!revision && requireCurrentSource && !inputIdentity && record.inputIdentity !== await sourceWebInputIdentity({ repoDir })) return null;
  if (!buildInputDependencyIdentityMatches(record.dependencyPublication, dependencyPublication)) return null;
  try {
    await assertWebArtifactPayload({ payloadDir: record.uiDir, entrypoint: 'index.html' });
    if (JSON.stringify(await webOutputDigests(record.uiDir)) !== JSON.stringify(record.outputDigests)) return null;
  } catch (error) {
    if (error.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return null;
  }
  return { outputDir, built: { uiDir: record.uiDir, entrypoint: 'index.html', runtimeMode: 'source', dependencyPublication,
    ...(record.sourceCapture ? { sourceCapture: record.sourceCapture } : {}),
    ...(record.uiInputDigest ? { uiInputDigest: record.uiInputDigest } : {}), buildOptions: record.buildOptions } };
}

async function pinSourceWebUi({ stackBaseDir, requestId, outputDir, signal }) {
  await retainPendingSourcePreparation({ stackBaseDir, requestId, preparationDir: outputDir, signal });
}

async function adoptReusableSourceWebUi({ repoDir, bundleRoot, stackBaseDir, requestId, inputIdentity, buildOptions, env, signal,
  sourceCapturedAfter, requireCurrentSource = false, requireLastGreen = false, revision, uiInputDigest, aliasRevision }) {
  const adopt = publishedCandidate => adoptReusableSourceBundle({ bundleRoot, component: 'web', env, signal, publishedCandidate,
    candidateKey: uiInputDigest ? sourceWebUiInputCandidateKey({ repoDir, uiInputDigest })
      : revision ? sourceWebRevisionCandidateKey({ repoDir, revisionKey: sourceRevisionKey(revision) })
      : inputIdentity ? sourceWebBuildFingerprint({ inputIdentity, buildOptions }) : sourceWebCandidateKey({ repoDir, buildOptions }),
    verify: async ({ record, outputDir, candidate }) => {
      const reusable = await readReusableSourceWebUi({ repoDir, record, outputDir, buildOptions, env,
        inputIdentity, requireCurrentSource, sourceCapturedAfter, revision, candidate, uiInputDigest });
      if (!reusable) return null;
      await assertBuildInputDependencies({ sourceDir: repoDir, env, state: reusable.built.dependencyPublication });
      return reusable;
    },
    publish: async ({ built, outputDir, record }) => {
      if (inputIdentity && !revision) await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
        candidateKey: sourceWebCandidateKey({ repoDir, buildOptions }) });
      if (aliasRevision) await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
        candidateKey: sourceWebRevisionCandidateKey({ repoDir, revisionKey: sourceRevisionKey(aliasRevision) }),
        alias: { revision: aliasRevision.revision, uiInputDigest: record.uiInputDigest } });
      if (requestId) await pinSourceWebUi({ stackBaseDir, requestId, outputDir, signal });
      return built;
    },
  });
  if (!requireLastGreen || revision || uiInputDigest) return await adopt();
  const key = sourceWebCandidateKey({ repoDir, buildOptions });
  const groups = await readGreenSourceRuntimeCandidateGroups({ bundleRoot });
  for (const group of groups) {
    const candidate = group.candidates.get(key);
    if (!candidate) continue;
    const reusable = await adopt(candidate);
    if (reusable) return reusable;
  }
  return null;
}

async function exportSharedSourceWebUi({ repoDir, stackBaseDir, requestId, env, signal, sourceCapturedAfter, requireLastGreen, reuseOnly,
  sourceRevision, revision }) {
  repoDir = resolve(repoDir);
  stackBaseDir = resolve(stackBaseDir);
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  sourceCapturedAfter = normalizeSourceCapturedAfter(sourceCapturedAfter);
  const context = resolveSourceRuntimeProducerContext({ repoDir, stackBaseDir, env });
  const buildOptions = await sourceWebBuildOptions({ repoDir, env: context.env });
  const requireCurrentSource = reuseOnly || context.consumerStackName === context.producerStackName;
  const adopt = async () => {
    const built = await adoptReusableSourceWebUi({ repoDir, bundleRoot, stackBaseDir, requestId, buildOptions,
      env: context.env, signal, sourceCapturedAfter, requireCurrentSource, requireLastGreen, revision });
    if (built) console.error(`[source-ui] adopted producer=${context.producerStackName} rev=${built.sourceCapture?.revision ?? 'checkout'}${revision && built.sourceCapture?.revision !== revision.revision ? ` for requested rev ${revision.revision} (identical UI inputs)` : ''} capturedAt=${built.sourceCapture?.capturedAt} inputIdentity=${built.sourceCapture?.inputIdentity}${built.buildOptions && built.buildOptions !== buildOptions ? ' (built with the producer\'s UI options; this Stack\'s differ)' : ''}`);
    return built;
  };
  await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase: 'queued', component: 'ui', signal });
  const cached = await adopt();
  if (cached) return cached;
  // Owner 2026-11-13/11-14: one shared web export, built by the repository
  // producer and adopted by every QA Stack. A consumer Stack never compiles its
  // own; by default it adopts the producer's newest completed one, else the
  // caller falls back to the live (borrowed) Expo server. An explicit export
  // request for a revision (`--ui=export`) asks the producer for that
  // revision's one shared export, which runs below as the producer.
  if (context.consumerStackName !== context.producerStackName && !(revision && !reuseOnly)) {
    // A revision request may adopt the shared export of another revision; the
    // capture boundary and last-green requirements still apply.
    const shared = revision ? await adoptReusableSourceWebUi({ repoDir, bundleRoot, stackBaseDir, requestId, buildOptions,
      env: context.env, signal, sourceCapturedAfter, requireLastGreen }) : null;
    if (shared) console.error(`[source-ui] adopted the shared export producer=${context.producerStackName} rev=${shared.sourceCapture?.revision ?? 'checkout'} capturedAt=${shared.sourceCapture?.capturedAt}${revision ? ` (requested rev ${sourceRevisionKey(revision)}; no export for it yet)` : ''}`);
    return shared;
  }
  if (reuseOnly) return null;
  if (requireLastGreen && !revision) throw sourceRuntimeProducerUnavailable(sourceRuntimeCaptureUnavailable(), context);
  const built = await runSharedSourceWebExport({ repoDir, context, signal, inputs: { repoDir,
    baseDir: join(context.producerStackBaseDir, 'source-runtime'), stackBaseDir: context.producerStackBaseDir,
    consumerStackBaseDir: stackBaseDir, requestId, buildOptions, sourceCapturedAfter, requireCurrentSource, sourceRevision, revision } });
  // The admitted producer has validated and pinned this result in our
  // pending request before releasing custody. Consume that owner result.
  console.error(`[source-ui] adopted producer=${context.producerStackName} capturedAt=${built.sourceCapture?.capturedAt} inputIdentity=${built.sourceCapture?.inputIdentity}`);
  return built;
}

const execFileAsync = promisify(execFile);

/** Controller side (needs Git): digest of the revision's tracked UI inputs, from
 * the canonical expo input set. Equal digests mean an equal UI export input. */
export async function readSourceWebRevisionInputDigest({ repoDir, revision }) {
  const inputs = new Set((await readSourceComponentBuildInputs({ repoDir, component: 'expo' })).files);
  const { stdout } = await execFileAsync('git', ['-C', repoDir, 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', revision],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const hash = createHash('sha256');
  for (const entry of stdout.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab >= 0 && inputs.has(entry.slice(tab + 1))) hash.update(`${entry}\n`);
  }
  return hash.digest('hex');
}

/** The repository producer publishes one shared web export per revision (rolling
 * producer, on HEAD advance). A revision whose UI-input digest equals an earlier
 * export's is an alias of it (no export); otherwise it exports once. */
export async function publishProducerSourceWebUi({ repoDir, stackBaseDir, revision, uiInputDigest, sourceRevision,
  env = process.env, signal, logger = console }) {
  repoDir = resolve(repoDir);
  stackBaseDir = resolve(stackBaseDir);
  const context = resolveSourceRuntimeProducerContext({ repoDir, stackBaseDir, env });
  if (context.consumerStackName !== context.producerStackName) throw new Error('[source-ui] only the repository producer publishes the shared web export');
  if (!/^[a-f0-9]{64}$/.test(uiInputDigest ?? '')) throw new Error('[source-ui] producer publication requires the revision UI-input digest');
  revision = { revision: revision.revision, overlayDigest: null };
  const lookup = { repoDir, bundleRoot: join(dirname(stackBaseDir), 'source-bundles'), stackBaseDir,
    buildOptions: await sourceWebBuildOptions({ repoDir, env: context.env }), env: context.env, signal };
  const exact = await adoptReusableSourceWebUi({ ...lookup, revision });
  if (exact) {
    logger.error(`[source-ui] producer rev=${revision.revision}: shared export already published (rev=${exact.sourceCapture?.revision})`);
    return { exported: false, built: exact };
  }
  const same = await adoptReusableSourceWebUi({ ...lookup, uiInputDigest, aliasRevision: revision });
  if (same) {
    logger.error(`[source-ui] producer rev=${revision.revision}: UI inputs unchanged; shared export of rev=${same.sourceCapture?.revision} serves it (no export)`);
    return { exported: false, built: same };
  }
  logger.error(`[source-ui] producer rev=${revision.revision}: UI inputs changed; exporting once`);
  const built = await runSharedSourceWebExport({ repoDir, context, signal, inputs: { repoDir,
    baseDir: join(context.producerStackBaseDir, 'source-runtime'), stackBaseDir: context.producerStackBaseDir,
    consumerStackBaseDir: stackBaseDir, buildOptions: lookup.buildOptions, requireCurrentSource: false,
    sourceRevision, revision, uiInputDigest } });
  logger.error(`[source-ui] producer rev=${revision.revision}: published shared export ${built.uiDir}`);
  return { exported: true, built };
}

/** Run the repository producer's one shared web export in its admission class
 * (about 8 GB), under the producer lock; returns the published product. */
async function runSharedSourceWebExport({ repoDir, context, signal, inputs }) {
  try {
    const result = await runWorkspaceBuildAdmission({ repoDir,
      launcherPath: fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url)),
      command: process.execPath, args: [fileURLToPath(import.meta.url), JSON.stringify({ ...inputs, shared: true })],
      locks: [{ path: sourceRuntimeProducerBuildLockPath(context.producerStackBaseDir), kind: 'workspace', timeoutMs: null,
        errorLabel: 'source runtime producer lock' }],
      env: context.env, signal, cwd: repoDir, admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: chunk => process.stderr.write(chunk) });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const refusal = String(result.stderr).split('\n').map(line => parseSourceReloadRefusalLine(line, context.env))
        .find(refusal => refusal?.code);
      const error = new Error(`Source web preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})\n${result.stderr}`);
      throw Object.assign(error, { code: 'source_runtime_producer_failed', signal: result.signal, ...refusal, producerFailed: true });
    }
    signal?.throwIfAborted();
    const built = JSON.parse(result.stdout);
    const failure = readTerminalBuildFailure(built);
    if (failure) throw failure;
    return built;
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw sourceRuntimeProducerUnavailable(cause, context);
  }
}

async function prepareSharedSourceWebUi({ repoDir, baseDir, stackBaseDir, consumerStackBaseDir = stackBaseDir, requestId,
  buildOptions, sourceCapturedAfter, requireCurrentSource, sourceRevision, revision, uiInputDigest, env, signal }) {
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  const inputs = { repoDir, bundleRoot, stackBaseDir: consumerStackBaseDir, requestId,
    buildOptions, sourceCapturedAfter, requireCurrentSource, revision, env, signal };
  const current = await adoptReusableSourceWebUi(inputs);
  if (current) return current;
  // A revision export is keyed by its revision; a checkout export by its moving inputs.
  const inputIdentity = revision ? null : await sourceWebInputIdentity({ repoDir });
  if (!revision) {
    const cached = await adoptReusableSourceWebUi({ ...inputs, inputIdentity });
    if (cached) return cached;
  }
  const fingerprint = revision
    ? createHash('sha256').update(sourceRevisionKey(revision)).update(buildOptions).digest('hex')
    : sourceWebBuildFingerprint({ inputIdentity, buildOptions });
  return await withWorkspaceBundleLock(async () => {
    await mkdir(bundleRoot, { recursive: true });
    // Already-loaded runtime retainers enumerate bundle-* without knowing web
    // serving references. Keep web allocations out of that runtime namespace;
    // the shared publication owner still governs both products' custody.
    const outputDir = await mkdtemp(join(bundleRoot, `web-${fingerprint}-`));
    let descriptorDir;
    // A QA Stack's revision tree (the revision's `git archive` plus its commit diff
    // and declared overlay, mounted on a pinned installation) is immutable: an
    // export read from it cannot drift while it waits for admission, unlike a
    // capture that repairs the moving checkout from a revision description.
    const tree = revision && sourceRevision?.treeDir ? { dir: resolve(sourceRevision.treeDir), revision } : null;
    try {
      const descriptorPath = !revision || tree ? undefined : sourceRevision?.descriptorPath ?? await writeSourceRevisionDescriptor({ repoDir,
        identity: await resolveSourceRevisionIdentity({ repoDir, rev: sourceRevision?.rev ?? revision.revision, overlay: sourceRevision?.overlay ?? [] }),
        outputDir: descriptorDir = await mkdtemp(join(await mkdir(baseDir, { recursive: true }).then(() => baseDir), 'revision-')), components: ['expo'] });
      const { built, captured } = await consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal,
        revision: descriptorPath && { descriptorPath }, tree });
      if (revision && (captured.revision?.revision !== revision.revision
        || (captured.revision.overlayDigest ?? null) !== (revision.overlayDigest ?? null))) {
        throw new Error(`[source-ui] export capture revision ${captured.revision?.key} differs from the Stack's ${sourceRevisionKey(revision)}`);
      }
      if (sourceCapturedAfter !== undefined && !(Date.parse(captured.capturedAt) >= sourceCapturedAfter)) {
        throw sourceRuntimeCaptureUnavailable({
          message: 'producer capture predates the requested sourceCapturedAfter boundary',
          nextAction: 'Request a fresh capture with a valid --source-after=<ISO timestamp> boundary',
        });
      }
      // The shared product contains only its serving closure. Compiler candidates
      // belong to the export context; captured source has already been retired.
      const record = { ...built, component: 'web', inputIdentity: captured.inputIdentity, buildOptions,
        outputDigests: await webOutputDigests(built.uiDir), reuseFingerprint: fingerprint,
        ...(uiInputDigest && revision && !revision.overlayDigest ? { uiInputDigest } : {}) };
      return await withSourceBundlePublication({ stackBaseDir, outputDir, record, signal, dependencySourceDir: repoDir, dependencyEnv: env }, async () => {
        signal.throwIfAborted();
        const producerCompletedAt = new Date().toISOString();
        const producerCandidateKey = sourceWebCandidateKey({ repoDir, buildOptions });
        await publishSourceBundleCandidate({ bundleRoot, outputDir, record, producerCompletedAt, producerCandidateKey,
          candidateKey: sourceWebBuildFingerprint({ inputIdentity: captured.inputIdentity, buildOptions }) });
        if (revision) await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
          candidateKey: sourceWebRevisionCandidateKey({ repoDir, revisionKey: sourceRevisionKey(revision) }) });
        if (record.uiInputDigest) await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
          candidateKey: sourceWebUiInputCandidateKey({ repoDir, uiInputDigest }) });
        if (!revision?.overlayDigest) await publishSourceBundleCandidate({ bundleRoot, outputDir, record, producerCompletedAt, producerCandidateKey,
          candidateKey: producerCandidateKey });
        if (requestId) await pinSourceWebUi({ stackBaseDir: consumerStackBaseDir, requestId, outputDir, signal });
        return built;
      });
    } catch (error) {
      const remaining = await lstat(outputDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (remaining) {
        removeOwnedDirectorySync(outputDir);
      }
      throw error;
    } finally { if (descriptorDir) removeOwnedDirectorySync(descriptorDir); }
  }, { lockPath: sourceBundleBuildLockPath(bundleRoot, fingerprint), timeoutMs: Infinity,
    staleAfterMs: Infinity, env, signal, errorLabel: 'source-web build lock' });
}

async function exportSourceWebUiOnce({ repoDir, baseDir, outputDir, env, signal, runImpl }) {
  if (!runImpl) {
    const stdout = await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
      args: [JSON.stringify({ repoDir, baseDir, outputDir, privateExport: true })], env, signal,
      admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStderr: true });
    const built = JSON.parse(stdout);
    const failure = readTerminalBuildFailure(built);
    if (failure) throw failure;
    return built;
  }
  const { built } = await consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal, runImpl });
  return built;
}

async function consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal, runImpl, revision, tree }) {
  const consume = (env, publication) => withSourceWebUiInputs({ repoDir, baseDir, env, signal, revision, tree }, async ({ captured, inventoryPath, uiProjectDir }) => {
    const built = await exportCapturedSourceWebUiInputs({ repoDir, baseDir, outputDir,
      inventoryPath, uiProjectDir, env, signal, runImpl }).catch(error => {
        removeOwnedDirectorySync(resolve(outputDir, 'web'));
        throw error;
      });
    return { built: { ...built, ...(publication ? { dependencyPublication: publication.state } : {}),
      sourceCapture: { inputIdentity: captured.inputIdentity, capturedAt: captured.capturedAt,
        ...(captured.revision ? { revision: captured.revision.revision, overlayDigest: captured.revision.overlayDigest } : {}) } }, captured };
  });
  // A revision tree mounts its pinned installation snapshot, which no refresh of
  // the checkout's installation changes: it needs no dependency custody.
  return tree ? await consume(env, null) : await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, consume);
}

/** Consume a fresh capture at one context-owned Metro root. Dependency custody
 * belongs to the containing finite producer; capture custody lasts until the
 * consumer has finished reading, while validated compiler candidates remain. */
export async function withSourceWebUiInputs({ repoDir, baseDir, env = process.env, signal, revision, tree,
  stdoutStream = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? process.stderr : process.stdout }, consume) {
  // Router embeds the captured project root in transforms. Keep that root and
  // the existing compiler's retained inventory stable for this export context,
  // while serving products remain private immutable outputs. Only one export
  // may replace this context's captured inputs until Metro has finished reading.
  const contextDir = resolve(baseDir, 'source-web');
  // A revision tree is the capture's source (bytes and installation); the
  // checkout stays the tooling root only.
  const sourceDir = tree?.dir ?? repoDir;
  return await withJsonOwnerFileLock(() => withSourceCaptureRetry({ repoDir: sourceDir, env, signal }, async () => {
    const workspace = join(contextDir, 'workspace');
    removeOwnedDirectorySync(workspace);
    let captured;
    try {
      captured = await captureSourceWebBuildInputs({ repoDir: sourceDir, outputDir: workspace, signal, revision });
      if (tree) {
        // The copies keep the base's read-only modes; Expo rewrites copied public files.
        await setBundleReadOnly(workspace, false);
        captured.revision = { revision: tree.revision.revision, overlayDigest: tree.revision.overlayDigest ?? null,
          key: sourceRevisionKey(tree.revision) };
      }
      await prepareSourcePluginUiInventory({ repoDir, inputRepoDir: captured.repoDir,
        outputDir: contextDir, artifactStoreDir: join(contextDir, 'inputs/artifacts'), env, signal, stdoutStream });
      return await consume({ captured, inventoryPath: join(contextDir, 'inputs/inventory.js'), uiProjectDir: captured.uiProjectDir });
    } catch (error) {
      throw rememberSourceCaptureFailure(error, captured);
    } finally {
      removeOwnedDirectorySync(workspace);
    }
  }), { lockPath: `${contextDir}.lock`, timeoutMs: Infinity, staleAfterMs: Infinity,
    signal, errorLabel: 'source-web capture lock' });
}

async function exportCapturedSourceWebUiInputs({ repoDir, baseDir, outputDir, inventoryPath, uiProjectDir, env, signal, runImpl }) {
  const { env: isolatedEnv } = await prepareExpoCommandEnv({
    baseDir, kind: 'source-web-export', projectDir: join(repoDir, 'apps/ui'),
    baseEnv: sourceWebExportEnv(env),
  });
  const exportEnv = applyExpoNodeHeapEnv({
    ...isolatedEnv, CI: '1', HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath,
    // The containing producer holds dependency custody of the real installation
    // (withBuildInputDependencies). Metro's entry check must never install into
    // the capture: its node_modules are the host's, and a revision capture lacks
    // the checkout's untracked workspaces, so pnpm refuses its frozen lockfile.
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });
  const uiDir = resolve(outputDir, 'web');
  const exportStartedAt = performance.now();
  const expoCommand = await resolveExpoBin(join(repoDir, 'apps/ui'));
  const expoArgs = sourceWebExportArgs(exportEnv, uiDir);
  // The optional runner substitutes only the external Expo boundary in tests.
  // Real finite exports reuse their containing native envelope and dependency
  // custody; injected runners replace only the external Expo boundary.
  if (runImpl) await runImpl(expoCommand, expoArgs, { cwd: uiProjectDir, env: exportEnv, signal });
  else await runSourceBuildCommand({ repoDir, command: expoCommand, args: expoArgs,
    cwd: uiProjectDir, env: exportEnv, signal, captureStdout: false, captureStderr: true,
    admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, stdoutStream: process.stderr });
  await assertWebArtifactPayload({ payloadDir: uiDir, entrypoint: 'index.html' });
  await precompressUiWebAssets({ dir: uiDir });
  console.log(`[source-ui] phase=web-export elapsedMs=${Math.round(performance.now() - exportStartedAt)}`);
  return { uiDir, entrypoint: 'index.html', runtimeMode: 'source' };
}

/** Live Metro and finite exports share source artifact construction. Only a
 * finite export captures inputs; interactive Expo intentionally reads live source. */
export async function prepareSourcePluginUiInventory({ repoDir, inputRepoDir = repoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir, deferSourceAssetsPublication = false, preparePlugins = true, env = process.env, signal,
  stdoutStream = process.stdout, devStartup = false }) {
  await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir: inputRepoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir, deferSourceAssetsPublication, preparePlugins })], env, signal, captureStdout: false, captureStderr: true, stdoutStream, devStartup });
}

async function prepareSourceWebUiInputs({ repoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir, deferSourceAssetsPublication, preparePlugins = true }) {
  const uiProjectDir = join(repoDir, 'apps/ui');
  const packages = await readWorkspacePackages(repoDir);
  const uiPackage = JSON.parse(await readFile(join(uiProjectDir, 'package.json'), 'utf8'));
  const cliPackage = JSON.parse(await readFile(join(repoDir, 'apps/cli/package.json'), 'utf8'));
  // The canonical membership publisher owns this generated dependency census.
  // Brand-only packages need their manifests, without compiling unrelated UI.
  const bundledPackageNames = new Set(cliPackage.bundledDependencies);
  const plugins = [...packages].filter(([name]) => (
    name.startsWith('@happier-dev/plugins-') && bundledPackageNames.has(name)
  )).sort(([left], [right]) => left.localeCompare(right));
  const inputsDir = join(outputDir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  const toolsDir = join(outputDir, 'tools');
  await mkdir(toolsDir, { recursive: true });
  // The canonical source loader resolves each manifest on demand inside the
  // compiler's per-plugin failure boundary. A static aggregate import would
  // abort every plugin before that boundary on one malformed declaration.
  const preparationPath = join(toolsDir, 'prepare.mjs');
  const source = [
    ...(preparePlugins ? [`import { prepareSourcePluginUiArtifacts } from ${JSON.stringify(join(uiProjectDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'))};`] : []),
    `import { prepareSourceUiAssets, resolveSourceUiAssetsRecordPath } from ${JSON.stringify(join(uiProjectDir, 'scripts/prepareSourceUiAssets.mjs'))};`,
    `import { readWorkspacePackages, resolveWorkspaceSource } from ${JSON.stringify(join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs'))};`,
    `import { pathToFileURL } from 'node:url';`,
    `import { copyFile, mkdir } from 'node:fs/promises';`,
    `import { dirname } from 'node:path';`,
    `const workspaces = await readWorkspacePackages(${JSON.stringify(repoDir)});`,
    ...(preparePlugins ? [`await prepareSourcePluginUiArtifacts({repoRoot:${JSON.stringify(repoDir)},outputDir:${JSON.stringify(inputsDir)},outputPath:${JSON.stringify(inventoryPath)},retainedInventoryPath:${JSON.stringify(retainedInventoryPath)},artifactStoreDir:${JSON.stringify(artifactStoreDir)},plugins:[${plugins.map(([name]) => (
      `{directory:${JSON.stringify(name.slice('@happier-dev/plugins-'.length))},loadManifest:async()=> (await import(pathToFileURL(resolveWorkspaceSource(workspaces,${JSON.stringify(`${name}/manifest`)})).href)).PLUGIN_MANIFEST,uiArtifacts:${Boolean(uiPackage.dependencies?.[name] && listBundledPluginUiArtifactExports(packages.get(name).manifest).length > 0)}}`
    )).join(',')}]});`] : [
      `await mkdir(dirname(${JSON.stringify(inventoryPath)}), {recursive:true});`,
      `await copyFile(${JSON.stringify(retainedInventoryPath)}, ${JSON.stringify(inventoryPath)});`,
    ]),
    `await prepareSourceUiAssets({uiPackageDir:${JSON.stringify(uiProjectDir)},outputDir:${JSON.stringify(inputsDir)},recordPath:resolveSourceUiAssetsRecordPath(${JSON.stringify(inventoryPath ?? join(inputsDir, 'inventory.js'))}),retainedRecordPath:resolveSourceUiAssetsRecordPath(${JSON.stringify(retainedInventoryPath ?? inventoryPath ?? join(inputsDir, 'inventory.js'))}),deferPublication:${Boolean(deferSourceAssetsPublication)}});`,
  ].join('\n');
  await writeFile(preparationPath, source);
  const preparationStartedAt = performance.now();
  // Match the daemon's managed source compiler, including synchronous
  // require(esm) dependencies that do not pass through ESM loader hooks.
  await run(process.execPath, ['--conditions=happier-source', '--import', join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'), preparationPath],
    { cwd: uiProjectDir, env: process.env });
  console.log(`[source-ui] phase=${preparePlugins ? 'plugin-ui-preparation' : 'source-assets-preparation'} elapsedMs=${Math.round(performance.now() - preparationStartedAt)} plugins=${preparePlugins ? plugins.length : 0}`);
}

// Finite preparation and Expo reuse one containing native admission envelope.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.argv[2]);
  if (options.shared || options.privateExport) {
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    console.log = console.error;
    try {
      const built = options.shared
        ? await withSingleTrailingBuildPass({ run: () => prepareSharedSourceWebUi({ ...options, env: process.env, signal: cancellation.signal }) })
        : (await consumeSourceWebUiInputs({ ...options, env: process.env, signal: cancellation.signal })).built;
      process.stdout.write(JSON.stringify(built));
    } catch (error) {
      if (options.shared) {
        Object.assign(error, { sourceStack: process.env.HAPPIER_STACK_STACK,
          phase: error.phase ?? 'source-producer', retryable: error.retryable ?? true,
          code: error.code ?? 'source_runtime_producer_failed' });
        emitSourceReloadRefusal(error);
      }
      const failure = serializeTerminalBuildFailure(error, { includeRetryableDrift: true });
      if (!failure) throw error;
      process.stdout.write(JSON.stringify(failure));
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } else await prepareSourceWebUiInputs(options);
}
