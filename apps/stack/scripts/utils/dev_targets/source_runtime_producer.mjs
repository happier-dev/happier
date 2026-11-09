import { pathToFileURL } from 'node:url';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';
import { emitSourceReloadRefusal, formatSourceReloadRefusal, parseSourceReloadRefusalLine } from '../../runtime/shared/source_reload_refusal.mjs';
import { emitSourceRuntimeSourceTimes } from '../../runtime/shared/source_bundle_record.mjs';
import { resolveSourceComponentWatchPaths } from '../dev/devReloadCoordinator.mjs';
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
  producerStackName, components, sourceCapturedAfter, env = process.env, signal, logger = console }, executorDependencies) {
  const paths = resolveRemoteStackStatePaths(target, { stackName: producerStackName, runtimeMode: 'source-snapshot' });
  let result;
  let refusal;
  try {
    result = await runDevTargetCommand({ target, stackBaseDir: producerStackBaseDir, sourceDir: repoDir,
      commandArgs: ['node', '--conditions=happier-source', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
        `./${workerPath}`, '--worker', JSON.stringify({ repoDir: target.repoDir, stackBaseDir: paths.stackBaseDir,
          components, sourceCapturedAfter })],
      environment: { HAPPIER_STACK_REPO_DIR: target.repoDir, HAPPIER_STACK_STACK: producerStackName,
        HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: producerStackName,
        HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
        HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
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
  localComponents, remoteComponents, env = process.env, signal, logger = console }, executorDependencies) {
  const authority = resolveRuntimeBuildAuthority({ rootDir: getRootDir(import.meta.url), consumerStackName: stackName,
    env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir }, createRepoIdentityIfMissing: false });
  if (authority.producerStackName !== stackName) return null;
  const targets = servicePlans.filter(plan => plan.commands || plan.services.server || plan.services.daemon)
    .map(plan => plan.target).sort((left, right) => Number(right.name === 'nl3') - Number(left.name === 'nl3'));
  const components = [...new Set([...localComponents, ...remoteComponents].map(value => value.component))];
  const descriptors = await Promise.all(components.map(async component => ({
    id: `source-producer:${component}`, target: 'source-runtime',
    paths: await resolveSourceComponentWatchPaths({ repoDir, target: component }),
  })));
  return {
    descriptors,
    executor: {
      target: 'source-runtime',
      async build() {
        const sourceCapturedAfter = Date.now();
        const requests = targets.map(target => ({ target: target.name, prepare: () => prepareSourceRuntimeProducerOnTarget({
          target, repoDir, producerStackBaseDir: authority.producerStackBaseDir, producerStackName: authority.producerStackName,
          components: remoteComponents, sourceCapturedAfter, env, signal, logger }, executorDependencies) }));
        if (localComponents.length) requests.push({ target: 'local', prepare: async () => {
          const { prepareSourceRuntimeProducer } = await import('../../build/build_source_runtime.mjs');
          return await prepareSourceRuntimeProducer({ repoDir, stackBaseDir, components: localComponents, env, signal,
            sourceCapturedAfter, logger });
        } });
        // Hosts are independent; an unavailable optional target cannot hold the
        // local last-green runtime or prevent another host's publication.
        await Promise.all(requests.map(async request => {
          try { await request.prepare(); }
          catch (error) {
            if (signal?.aborted) throw error;
            logger.error(`[source-producer:${request.target}]${formatSourceReloadRefusal(error, env)} ${redactFailureDiagnostic(error.message, env)}`);
          }
        }));
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--worker') {
  try {
    const { prepareSourceRuntimeProducer } = await import('../../build/build_source_runtime.mjs');
    const prepared = await prepareSourceRuntimeProducer({ ...JSON.parse(process.argv[3]), env: process.env });
    const sourceCaptures = Object.fromEntries(Object.entries(prepared).map(([component, built]) => [component, built.sourceCapture]));
    emitSourceRuntimeSourceTimes(Object.fromEntries(Object.entries(sourceCaptures).map(([component, capture]) => [component, capture?.capturedAt])), sourceCaptures);
  } catch (error) {
    emitSourceReloadRefusal(error);
    console.error(error);
    process.exitCode = 1;
  }
}
