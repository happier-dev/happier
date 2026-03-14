import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, resolveYarnCommand } from '@happier-dev/cli-common/componentArtifacts';

import { resolveStackBaseDir } from '../utils/paths/paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { createRuntimeFingerprint } from '../runtime/shared/runtime_fingerprint.mjs';
import { resolveStackComponentArtifactDir, resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';
import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import { buildWebArtifact } from './build_web_artifact.mjs';
import { buildDaemonArtifact } from './build_daemon_artifact.mjs';
import { buildServerArtifact } from './build_server_artifact.mjs';
import { activateRuntimeSnapshot } from './activate_runtime_snapshot.mjs';
import { parseBuildSelection } from './build_targets.mjs';
import { acquireRuntimeBuildLock } from './runtime_build_lock.mjs';
import { pruneComponentArtifacts, resolveRuntimeRetentionPolicy } from './runtime_retention.mjs';

function assertNamedStack(env) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  if (stackName === 'main') {
    throw new Error('[build] stack-local artifact builds are supported for named stacks only in v1.');
  }
  return stackName;
}

export function assertSelectedBuildPrerequisites({
  selection,
  commandProbe = commandExists,
}) {
  const needsServerBinary = Boolean(selection?.components?.server);
  const needsDaemonBinary = Boolean(selection?.components?.daemon);
  if (needsServerBinary || needsDaemonBinary) {
    if (!commandProbe('bun')) {
      const targetLabel = needsServerBinary && needsDaemonBinary
        ? 'server and daemon'
        : needsServerBinary
          ? 'server'
          : 'daemon';
      throw new Error(`[build] bun is required before starting ${targetLabel} binary artifact builds.`);
    }
  }
  if (needsDaemonBinary) {
    resolveYarnCommand({ commandProbe });
  }
}

export async function buildStackArtifacts({ rootDir, argv = [], env = process.env }) {
  const { flags } = parseArgs(argv);
  const selection = parseBuildSelection({ argv });
  const stackName = assertNamedStack(env);
  if (flags.has('--tauri')) {
    throw new Error('[build] tauri artifact builds are not supported in stack-local runtime snapshots in v1.');
  }
  assertSelectedBuildPrerequisites({ selection });

  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  const { baseDir: stackBaseDir } = resolveStackBaseDir(stackName, env);
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
  await mkdir(runtimePaths.runtimeDir, { recursive: true });
  const releaseBuildLock = await acquireRuntimeBuildLock({ lockPath: runtimePaths.lockPath });

  try {
    const artifacts = {};
    const buildComponent = async (component, builder) => {
      const buildInputs = [];
      if (component === 'server') {
        buildInputs.push(`bunExternals=${String(env.HAPPIER_SERVER_BUN_EXTERNALS ?? 'redis').trim() || 'redis'}`);
        buildInputs.push(`platform=${process.platform}`);
        buildInputs.push(`arch=${process.arch}`);
      }
      if (component === 'daemon') {
        buildInputs.push(`bunExternals=${String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '').trim()}`);
        buildInputs.push(`platform=${process.platform}`);
        buildInputs.push(`arch=${process.arch}`);
      }
      const artifactFingerprint = createRuntimeFingerprint({
        repoDir: sourceMetadata.repoDir,
        commitSha: sourceMetadata.commitSha,
        dirtyHash: sourceMetadata.dirtyHash,
        serverComponent: sourceMetadata.serverComponent,
        dbProvider: sourceMetadata.dbProvider,
        components: [component],
        buildInputs,
      });
      const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifactFingerprint });
      artifacts[component] = await builder({
        rootDir,
        artifactDir,
        artifactFingerprint,
        sourceMetadata,
        forceRebuild: selection.forceRebuild,
      });
      await pruneComponentArtifacts({
        stackBaseDir,
        component,
        keepCount: retentionPolicy.artifactKeepCount,
      });
    };

    if (selection.components.web) await buildComponent('web', buildWebArtifact);
    if (selection.components.server) await buildComponent('server', buildServerArtifact);
    if (selection.components.daemon) await buildComponent('daemon', buildDaemonArtifact);

    let runtime = null;
    if (selection.activateRuntime) {
      runtime = await activateRuntimeSnapshot({
        stackBaseDir,
        snapshotId: sourceMetadata.sourceFingerprint,
        sourceMetadata,
        artifacts,
        runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      });
    }

    return {
      ok: true,
      stackName,
      stackBaseDir,
      source: sourceMetadata,
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([component, value]) => [
          component,
          {
            artifactDir: value.artifactDir,
            manifest: value.manifest,
          },
        ]),
      ),
      runtime,
    };
  } finally {
    await releaseBuildLock();
  }
}
