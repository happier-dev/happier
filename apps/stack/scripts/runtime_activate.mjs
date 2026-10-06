import './utils/env/env.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { collectBuildSourceMetadata } from './build/collect_build_source_metadata.mjs';
import {
  composeRuntimePublicationResult,
  inspectLatestPublishedRuntimeSnapshot,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './build/activate_runtime_snapshot.mjs';
import { resolveLatestComponentArtifact } from './build/resolve_latest_component_artifact.mjs';
import { pruneRuntimeSnapshots, resolveRuntimeRetentionPolicy } from './build/runtime_retention.mjs';
import { resolveStackRuntimePaths } from './runtime/shared/runtime_paths.mjs';
import { resolveControlledRuntimePlacement } from './utils/dev_targets/service_placement.mjs';
import { ensureStackRuntimeModePrefer } from './runtime/shared/ensureStackRuntimeModePrefer.mjs';
import { resolveRuntimeBuildAuthority } from './runtime/shared/runtime_build_authority.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { publishBuiltRepositoryRuntimeSnapshot, resolveRuntimePublicationRequiredComponents, withRuntimePublicationAdmission } from './build/build_stack_artifacts.mjs';

function resolveSelectedComponents(flags) {
  const explicit = {
    web: flags.has('--web'),
    server: flags.has('--server'),
    daemon: flags.has('--daemon'),
  };
  if (flags.has('--all') || !Object.values(explicit).some(Boolean)) {
    return { web: true, server: true, daemon: true };
  }
  return explicit;
}

function assertNamedStack(env) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  if (stackName === 'main') {
    throw new Error('[runtime] partial runtime activation is supported for named stacks only in v1.');
  }
  return stackName;
}

/**
 * Producer admission covers artifact discovery, publication, selection and pruning.
 * Artifact discovery is deliberately outside the producer snapshot lock. The
 * lock covers only validating the final graph, writing its manifest/reference
 * snapshot, and advancing the producer/explicit consumer pointers.
 */
export async function activateRuntimeForAuthority({
  rootDir,
  stackName,
  selectedComponents,
  authority,
  target = { platform: process.platform, arch: process.arch },
  env = process.env,
  retentionPolicy = resolveRuntimeRetentionPolicy({ env }),
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  resolveLatestComponentArtifactImpl = resolveLatestComponentArtifact,
  inspectActiveRuntimeSnapshotImpl = inspectLatestPublishedRuntimeSnapshot,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  publishRuntimeSnapshotImpl = publishRuntimeSnapshot,
  selectRuntimeSnapshotImpl = selectRuntimeSnapshot,
  pruneRuntimeSnapshotsImpl = pruneRuntimeSnapshots,
  ensureStackRuntimeModePreferImpl = ensureStackRuntimeModePrefer,
}) {
  return await withRuntimePublicationAdmission({ authority, env, withWorkspaceBundleLockImpl, publish: async () => {
    const stackBaseDir = authority.producerStackBaseDir;
    const sourceMetadata = await collectBuildSourceMetadataImpl({ rootDir, env });
    const resolveSelectedArtifacts = async () => {
      const resolvedArtifacts = {};
      for (const component of ['web', 'server', 'daemon']) {
        if (!selectedComponents[component]) continue;
        const artifact = await resolveLatestComponentArtifactImpl({ stackBaseDir, component, target });
        if (!artifact) {
          throw new Error(`[runtime] no ${component} artifact for ${target.platform}/${target.arch} is available for activation. Build it first with hstack stack build ${stackName} --${component} --target=${target.platform === 'win32' ? 'windows' : target.platform}-${target.arch}.`);
        }
        resolvedArtifacts[component] = artifact;
      }
      return resolvedArtifacts;
    };
    // Admission precedes discovery and excludes all producer publishers/pruners,
    // so a second artifact lookup under the snapshot lock cannot be newer.
    const artifacts = await resolveSelectedArtifacts();
    const published = await publishBuiltRepositoryRuntimeSnapshot({
      authority, requestedComponents: Object.keys(artifacts), sourceMetadata, artifacts,
      target, env, retentionPolicy, withWorkspaceBundleLockImpl, inspectActiveRuntimeSnapshotImpl,
      publishRuntimeSnapshotImpl, selectRuntimeSnapshotImpl, pruneRuntimeSnapshotsImpl,
    });
    const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
    const selectedRuntime = await withWorkspaceBundleLockImpl(() => selectRuntimeSnapshotImpl({
      consumerStackBaseDir: authority.consumerStackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: authority.producerStackName,
      snapshotId: published.snapshotId,
      target,
      requiredComponents: resolveRuntimePublicationRequiredComponents({ target, requestedComponents: Object.keys(artifacts) }),
    }), {
      lockPath: runtimePaths.lockPath,
      errorLabel: 'runtime snapshot build lock',
      timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    });

    const { envPath } = resolveStackEnvPath(stackName, env);
    await ensureStackRuntimeModePreferImpl({ envPath });
    return {
      stackBaseDir,
      sourceMetadata,
      artifacts,
      runtime: composeRuntimePublicationResult({
        consumerStackName: authority.consumerStackName,
        producerStackName: authority.producerStackName,
        published,
        selectedRuntime,
      }),
    };
  } });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--web', '--server', '--daemon', '--all'], json: true },
      text: [
        '[runtime] usage:',
        '  hstack stack runtime <name> activate [--web|--server|--daemon|--all] [--json]',
        '',
        'note:',
        '  Reuses the current runtime snapshot for unselected components.',
        '  With no component flags, activates all components from the latest available artifacts.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const stackName = assertNamedStack(process.env);
  const selectedComponents = resolveSelectedComponents(flags);
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env: process.env });
  const resolvedAuthority = resolveRuntimeBuildAuthority({ rootDir, consumerStackName: stackName, env: process.env });
  const placement = await resolveControlledRuntimePlacement({ stackName, stackBaseDir: resolvedAuthority.consumerStackBaseDir,
    sourceDir: resolvedAuthority.repoDir, env: process.env });
  const authority = resolvedAuthority;
  const activation = await activateRuntimeForAuthority({
    rootDir,
    stackName,
    selectedComponents,
    authority,
    target: placement.runtimeTarget,
    env: process.env,
    retentionPolicy,
  });
  const { runtime } = activation;
  printResult({
    json,
    data: {
      ok: true,
      stackName,
      consumerStackName: authority.consumerStackName,
      producerStackName: authority.producerStackName,
      snapshotId: runtime.snapshotId,
      snapshotPath: runtime.snapshotPath,
      reused: runtime.reused,
      selected: runtime.selected,
      activatedComponents: Object.keys(selectedComponents).filter((component) => selectedComponents[component]),
      runtime,
    },
    text: [
      `[runtime] activated ${stackName}`,
      ...Object.keys(selectedComponents)
        .filter((component) => selectedComponents[component])
        .map((component) => `[runtime] ${component}: updated`),
      `[runtime] snapshot: ${runtime.snapshotPath}`,
    ].join('\n'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[runtime] failed:', message);
    if (process.env.DEBUG && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}
