import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';
import { emitSourceReloadRefusal, formatSourceReloadRefusal, parseSourceReloadRefusalLine } from '../../runtime/shared/source_reload_refusal.mjs';
import { emitSourceRuntimeSourceTimes } from '../../runtime/shared/source_bundle_record.mjs';
import { resolveDependencyRefreshMarkerPath } from '../proc/dependency_refresh.mjs';
import { resolveHeadReflogPath, resolveSourceRevisionIdentity, writeSourceRevisionDescriptor } from '../../build/source_revision.mjs';
import { transferRuntimeFile } from './runtime_artifact_transfer.mjs';
import { getRootDir } from '../paths/paths.mjs';
import { redactFailureDiagnostic } from '../proc/proc.mjs';
import { runDevTargetCommand } from './executor.mjs';
import { projectRemoteGuestCliPayloadEnvironment, resolveRemoteStackStatePaths } from './remote_commands.mjs';

const workerPath = 'apps/stack/scripts/utils/dev_targets/source_runtime_producer.mjs';

function unavailableTarget({ target, producerStackName, reason, cause, refusal }) {
  return Object.assign(new Error(
    `[source-producer] ${target.name} unavailable (${reason}); restore target source synchronization/producer inputs and retry the Stack reload`, { cause }), {
    code: 'source_runtime_producer_unavailable', reason, phase: 'source-producer', retryable: true,
    sourceStack: producerStackName, target: target.name,
    nextAction: 'Restore target source synchronization/producer inputs and retry the Stack reload',
    ...refusal,
  });
}

/** Use the existing source mirror/transport; the execution host's producer
 * owns compilation, matching and publication in its existing source-bundles. */
export async function prepareSourceRuntimeProducerOnTarget({ target, repoDir, producerStackBaseDir,
  producerStackName, components, sourceCapturedAfter, sourceRevisionDescriptorPath, web, env = process.env, signal, logger = console },
  executorDependencies, { transferFile = transferRuntimeFile } = {}) {
  const paths = resolveRemoteStackStatePaths(target, { stackName: producerStackName, runtimeMode: 'source-snapshot' });
  let result;
  let refusal;
  let sourceRevision;
  try {
    if (sourceRevisionDescriptorPath) {
      // The mirror has no Git metadata; the worker deletes this description after use.
      const descriptorPath = `${dirname(paths.stackBaseDir)}/source-revision-${randomUUID()}.json.gz`;
      await transferFile({ target, direction: 'upload', localPath: sourceRevisionDescriptorPath, remotePath: descriptorPath, signal });
      sourceRevision = { descriptorPath };
    }
    result = await runDevTargetCommand({ target, stackBaseDir: producerStackBaseDir, sourceDir: repoDir,
      commandArgs: ['node', '--conditions=happier-source', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
        `./${workerPath}`, '--worker', JSON.stringify({ repoDir: target.repoDir, stackBaseDir: paths.stackBaseDir,
          components, sourceCapturedAfter, sourceRevision, web })],
      environment: { HAPPIER_STACK_REPO_DIR: target.repoDir, HAPPIER_STACK_STACK: producerStackName,
        HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: producerStackName,
        HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
        HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', HAPPIER_STACK_SOURCE_MIRROR: '1',
        ...projectRemoteGuestCliPayloadEnvironment(env) },
      dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip',
      env: { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: repoDir, HAPPIER_STACK_PROCESS_KIND: 'infra' },
      signal, silent: true, onLine: ({ stream, line }) => {
        if (stream === 'stderr') refusal ??= parseSourceReloadRefusalLine(line, env);
        logger[stream === 'stderr' ? 'error' : 'log']?.(`[source-producer:${target.name}] ${redactFailureDiagnostic(line, env)}`);
      },
    }, executorDependencies);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw unavailableTarget({ target, producerStackName, reason: cause.code ?? 'source_sync_or_transport_unavailable', cause });
  }
  if (result.code !== 0) throw unavailableTarget({ target, producerStackName, refusal,
    reason: result.error?.code ?? result.signal ?? `exit_${result.code}`, cause: result.error });
  return result;
}

/** Register one executor with dev's existing source watcher. Commands-only
 * hosts are actual execution hosts; configured targets outside its eligible
 * service plans remain on-demand rather than speculative cold producers. */
export async function createSourceRuntimeProducerReload({ repoDir, stackBaseDir, stackName, servicePlans,
  localComponents, remoteComponents, env = process.env, signal, logger = console }, executorDependencies, transport) {
  const authority = resolveRuntimeBuildAuthority({ rootDir: getRootDir(import.meta.url), consumerStackName: stackName,
    env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir }, createRepoIdentityIfMissing: false });
  if (authority.producerStackName !== stackName) return null;
  const targets = servicePlans.filter(plan => plan.commands || plan.services.server || plan.services.daemon)
    .map(plan => plan.target).sort((left, right) => Number(right.name === 'nl3') - Number(left.name === 'nl3'));
  // QA runs committed revisions (owner 2026-11-14): the producer follows HEAD and
  // installed dependencies, never other lanes' uncommitted edits. The existing
  // reload coordinator coalesces bursts, so it builds only the newest HEAD.
  const headLog = await resolveHeadReflogPath(repoDir);
  const descriptors = [{ id: 'source-producer:revision', target: 'source-runtime',
    paths: [headLog, resolveDependencyRefreshMarkerPath(repoDir)] }];
  return {
    descriptors,
    executor: {
      target: 'source-runtime',
      async build() {
        const revision = await resolveSourceRevisionIdentity({ repoDir });
        logger.error(`[source-producer] revision ${revision.revision}`);
        // One shared web export per revision (owner 2026-11-13/11-14), on the primary
        // producer host where QA Stacks serve it; digest-keyed, so a revision with
        // unchanged UI inputs exports nothing. Git lives here, so the digest does too.
        const { publishProducerSourceWebUi, readSourceWebRevisionInputDigest } = await import('../../build/build_source_web_ui.mjs');
        // The runtime bundles do not depend on the web publication: a digest failure
        // is reported and skips only the web export for this revision.
        const web = await readSourceWebRevisionInputDigest({ repoDir, revision: revision.revision })
          .then(uiInputDigest => ({ revision: revision.revision, uiInputDigest }), error => {
            if (signal?.aborted) throw error;
            logger.error(`[source-producer] shared web export skipped for ${revision.revision}: ${redactFailureDiagnostic(error.message, env)}`);
            return null;
          });
        const webTarget = web ? targets[0]?.name ?? 'local' : null;
        const descriptorDir = targets.length ? await mkdtemp(join(tmpdir(), 'hstack-source-revision-')) : null;
        try {
          const sourceRevisionDescriptorPath = descriptorDir
            ? await writeSourceRevisionDescriptor({ repoDir, identity: revision, outputDir: descriptorDir,
              components: ['server', 'daemon', 'expo'] }) : undefined;
          const requests = targets.map(target => ({ target: target.name, prepare: () => prepareSourceRuntimeProducerOnTarget({
            target, repoDir, producerStackBaseDir: authority.producerStackBaseDir, producerStackName: authority.producerStackName,
            components: remoteComponents, sourceRevisionDescriptorPath, web: target.name === webTarget ? web : undefined,
            env, signal, logger }, executorDependencies, transport) }));
          if (localComponents.length || webTarget === 'local') requests.push({ target: 'local', prepare: async () => {
            const { prepareSourceRuntimeProducer } = await import('../../build/build_source_runtime.mjs');
            if (localComponents.length) await prepareSourceRuntimeProducer({ repoDir, stackBaseDir, components: localComponents, env, signal,
              sourceRevision: { rev: revision.revision }, logger });
            if (webTarget === 'local') await publishProducerSourceWebUi({ repoDir, stackBaseDir, revision: web,
              uiInputDigest: web.uiInputDigest, sourceRevision: { rev: revision.revision }, env, signal, logger });
          } });
          // Hosts are independent; an unavailable optional target cannot hold the
          // local runtime or prevent another host's publication.
          await Promise.all(requests.map(async request => {
            try { await request.prepare(); }
            catch (error) {
              if (signal?.aborted) throw error;
              logger.error(`[source-producer:${request.target}]${formatSourceReloadRefusal(error, env)} ${redactFailureDiagnostic(error.message, env)}`);
            }
          }));
        } finally { if (descriptorDir) await rm(descriptorDir, { recursive: true, force: true }); }
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--worker') {
  try {
    const { prepareSourceRuntimeProducer } = await import('../../build/build_source_runtime.mjs');
    const request = JSON.parse(process.argv[3]);
    let prepared = {};
    let failure;
    try {
      try { if (request.components?.length) prepared = await prepareSourceRuntimeProducer({ ...request, env: process.env }); }
      catch (error) { failure = error; }
      // The web export follows the runtime bundles in this same worker, so the two
      // heavyweight admissions run one after the other, never side by side; a
      // runtime refusal does not withhold the independent web publication.
      if (request.web) await (await import('../../build/build_source_web_ui.mjs')).publishProducerSourceWebUi({
        repoDir: request.repoDir, stackBaseDir: request.stackBaseDir, revision: request.web,
        uiInputDigest: request.web.uiInputDigest, sourceRevision: request.sourceRevision, env: process.env });
    } finally { if (request.sourceRevision?.descriptorPath) await rm(request.sourceRevision.descriptorPath, { force: true }); }
    if (failure) throw failure;
    const sourceCaptures = Object.fromEntries(Object.entries(prepared).map(([component, built]) => [component, built.sourceCapture]));
    emitSourceRuntimeSourceTimes(Object.fromEntries(Object.entries(sourceCaptures).map(([component, capture]) => [component, capture?.capturedAt])), sourceCaptures);
  } catch (error) {
    emitSourceReloadRefusal(error);
    console.error(error);
    process.exitCode = 1;
  }
}
