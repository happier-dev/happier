import './utils/env/env.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir, getStacksStorageRoot, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { collectBuildSourceMetadata } from './build/collect_build_source_metadata.mjs';
import {
  composeRuntimePublicationResult,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './build/activate_runtime_snapshot.mjs';
import { resolveLatestComponentArtifact } from './build/resolve_latest_component_artifact.mjs';
import { pruneRuntimeSnapshots, resolveRuntimeRetentionPolicy } from './build/runtime_retention.mjs';
import { resolveStackRuntimePaths } from './runtime/shared/runtime_paths.mjs';
import { inspectActiveRuntimeSnapshot } from './runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { ensureStackRuntimeModePrefer } from './runtime/shared/ensureStackRuntimeModePrefer.mjs';
import { resolveRuntimeBuildAuthority } from './runtime/shared/runtime_build_authority.mjs';
import { createRuntimeSnapshotId } from './runtime/shared/runtime_snapshot_identity.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';

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

async function resolveActivationAuthority({ authority, selectedComponents }) {
  if (authority.producerStackBaseDir === authority.consumerStackBaseDir) return authority;

  const selected = Object.entries(selectedComponents)
    .filter(([, enabled]) => enabled)
    .map(([component]) => component);
  const producerArtifacts = await Promise.all(
    selected.map((component) => resolveLatestComponentArtifact({
      stackBaseDir: authority.producerStackBaseDir,
      component,
    })),
  );
  if (producerArtifacts.every(Boolean)) return authority;

  const legacyConsumerArtifacts = await Promise.all(
    selected.map((component) => resolveLatestComponentArtifact({
      stackBaseDir: authority.consumerStackBaseDir,
      component,
    })),
  );
  if (!legacyConsumerArtifacts.every(Boolean)) return authority;

  return {
    ...authority,
    producerStackName: authority.consumerStackName,
    producerStackBaseDir: authority.consumerStackBaseDir,
    legacyConsumerStore: true,
  };
}

function resolveActivationComponentFingerprints({ artifacts, currentInspection }) {
  const componentFingerprints = {};
  for (const component of ['web', 'server', 'daemon']) {
    const artifactFingerprint = String(
      artifacts[component]?.manifest?.artifactFingerprint
      ?? (currentInspection.valid ? currentInspection.manifest?.components?.[component]?.artifactFingerprint : '')
      ?? '',
    ).trim();
    if (!artifactFingerprint) {
      throw new Error(`[runtime] cannot activate a complete runtime: ${component} has no selected or current artifact.`);
    }
    componentFingerprints[component] = artifactFingerprint;
  }
  return componentFingerprints;
}

/**
 * Artifact discovery is deliberately outside the producer snapshot lock. The
 * lock covers only validating the final graph, writing its manifest/reference
 * snapshot, and advancing the producer/explicit consumer pointers.
 */
export async function activateRuntimeForAuthority({
  rootDir,
  stackName,
  selectedComponents,
  authority,
  env = process.env,
  retentionPolicy = resolveRuntimeRetentionPolicy({ env }),
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  resolveLatestComponentArtifactImpl = resolveLatestComponentArtifact,
  inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  publishRuntimeSnapshotImpl = publishRuntimeSnapshot,
  selectRuntimeSnapshotImpl = selectRuntimeSnapshot,
  pruneRuntimeSnapshotsImpl = pruneRuntimeSnapshots,
  ensureStackRuntimeModePreferImpl = ensureStackRuntimeModePrefer,
}) {
  const stackBaseDir = authority.producerStackBaseDir;
  const sourceMetadata = await collectBuildSourceMetadataImpl({ rootDir, env });
  const resolveSelectedArtifacts = async () => {
    const resolvedArtifacts = {};
    for (const component of ['web', 'server', 'daemon']) {
      if (!selectedComponents[component]) continue;
      const artifact = await resolveLatestComponentArtifactImpl({ stackBaseDir, component });
      if (!artifact) {
        throw new Error(`[runtime] no ${component} artifact is available for activation. Build it first.`);
      }
      resolvedArtifacts[component] = artifact;
    }
    return resolvedArtifacts;
  };
  let artifacts = await resolveSelectedArtifacts();

  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const publication = await withWorkspaceBundleLockImpl(async () => {
    // The outside lookup avoids holding the snapshot lock during availability
    // checks. Re-read the selected artifact at commit time so a completed
    // publisher cannot be overwritten with the stale pre-lock selection.
    artifacts = await resolveSelectedArtifacts();
    const currentInspection = await inspectActiveRuntimeSnapshotImpl({ stackBaseDir });
    const componentFingerprints = resolveActivationComponentFingerprints({ artifacts, currentInspection });
    const snapshotId = createRuntimeSnapshotId({ sourceMetadata, componentFingerprints });
    const published = await publishRuntimeSnapshotImpl({
      producerStackBaseDir: stackBaseDir,
      snapshotId,
      sourceMetadata,
      artifacts,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      externalReferenceStorageRoot: getStacksStorageRoot(env),
      pruneAfterPublish: false,
    });
    await selectRuntimeSnapshotImpl({
      consumerStackBaseDir: stackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: authority.producerStackName,
      snapshotId: published.snapshotId,
    });
    const selectedRuntime = await selectRuntimeSnapshotImpl({
      consumerStackBaseDir: authority.consumerStackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: authority.producerStackName,
      snapshotId: published.snapshotId,
    });
    return {
      published,
      runtime: composeRuntimePublicationResult({
        consumerStackName: authority.consumerStackName,
        producerStackName: authority.producerStackName,
        published,
        selectedRuntime,
      }),
    };
  }, {
    lockPath: runtimePaths.lockPath,
    errorLabel: 'runtime snapshot build lock',
    timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
  });

  await pruneRuntimeSnapshotsImpl({
    stackBaseDir,
    keepCount: retentionPolicy.runtimeSnapshotKeepCount,
    preserveSnapshotIds: [publication.published.snapshotId],
    externalReferenceStorageRoot: getStacksStorageRoot(env),
  });
  const { envPath } = resolveStackEnvPath(stackName, env);
  await ensureStackRuntimeModePreferImpl({ envPath });
  return {
    stackBaseDir,
    sourceMetadata,
    artifacts,
    runtime: publication.runtime,
  };
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
  const authority = await resolveActivationAuthority({
    authority: resolvedAuthority,
    selectedComponents,
  });
  const activation = await activateRuntimeForAuthority({
    rootDir,
    stackName,
    selectedComponents,
    authority,
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
