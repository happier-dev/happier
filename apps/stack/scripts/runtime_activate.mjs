import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir, resolveStackBaseDir } from './utils/paths/paths.mjs';
import { collectBuildSourceMetadata } from './build/collect_build_source_metadata.mjs';
import { activateRuntimeSnapshot } from './build/activate_runtime_snapshot.mjs';
import { resolveLatestComponentArtifact } from './build/resolve_latest_component_artifact.mjs';
import { acquireRuntimeBuildLock } from './build/runtime_build_lock.mjs';
import { resolveRuntimeRetentionPolicy } from './build/runtime_retention.mjs';
import { createRuntimeFingerprint } from './runtime/shared/runtime_fingerprint.mjs';
import { resolveStackRuntimePaths } from './runtime/shared/runtime_paths.mjs';
import { inspectActiveRuntimeSnapshot } from './runtime/launch/inspectActiveRuntimeSnapshot.mjs';

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

function createSnapshotId({ sourceMetadata, componentFingerprints }) {
  return createRuntimeFingerprint({
    repoDir: sourceMetadata.repoDir,
    commitSha: sourceMetadata.commitSha,
    dirtyHash: sourceMetadata.dirtyHash,
    serverComponent: sourceMetadata.serverComponent,
    dbProvider: sourceMetadata.dbProvider,
    components: ['runtime-snapshot'],
    buildInputs: Object.entries(componentFingerprints)
      .filter(([, artifactFingerprint]) => String(artifactFingerprint ?? '').trim())
      .map(([component, artifactFingerprint]) => `${component}=${artifactFingerprint}`),
  });
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
  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env: process.env });
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env: process.env });
  const { baseDir: stackBaseDir } = resolveStackBaseDir(stackName, process.env);
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const releaseBuildLock = await acquireRuntimeBuildLock({ lockPath: runtimePaths.lockPath });

  try {
    const currentInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir });
    const artifacts = {};
    for (const component of ['web', 'server', 'daemon']) {
      if (!selectedComponents[component]) continue;
      const artifact = await resolveLatestComponentArtifact({ stackBaseDir, component });
      if (!artifact) {
        throw new Error(`[runtime] no ${component} artifact is available for activation. Build it first.`);
      }
      artifacts[component] = artifact;
    }

    const componentFingerprints = {
      web: artifacts.web?.manifest?.artifactFingerprint ?? currentInspection.manifest?.components?.web?.artifactFingerprint ?? '',
      server: artifacts.server?.manifest?.artifactFingerprint ?? currentInspection.manifest?.components?.server?.artifactFingerprint ?? '',
      daemon: artifacts.daemon?.manifest?.artifactFingerprint ?? currentInspection.manifest?.components?.daemon?.artifactFingerprint ?? '',
    };
    const snapshotId = createSnapshotId({ sourceMetadata, componentFingerprints });
    const runtime = await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId,
      sourceMetadata,
      artifacts,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
    });

    printResult({
      json,
      data: {
        ok: true,
        stackName,
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
  } finally {
    await releaseBuildLock();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[runtime] failed:', message);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
