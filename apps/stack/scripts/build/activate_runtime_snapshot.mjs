import { constants } from 'node:fs';
import { cp, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { artifactPayloadDir, validateArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { writeRuntimeManifest, writeRuntimePointer } from '../runtime/shared/runtime_manifest.mjs';
import { resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { pruneRuntimeSnapshots } from './runtime_retention.mjs';

const RUNTIME_DIRECTORY_COPY_OPTIONS = Object.freeze({
  recursive: true,
  // Prefer filesystem clone-on-write when available so partial runtime activation
  // does not byte-copy large unchanged server/daemon payloads on every web-only swap.
  mode: constants.COPYFILE_FICLONE,
});

const RUNTIME_FILE_COPY_OPTIONS = Object.freeze({
  mode: constants.COPYFILE_FICLONE,
});

function resolveComponentDirectoryName(component) {
  return component === 'web' ? 'ui' : component === 'server' ? 'server' : 'cli';
}

async function materializeRuntimeComponent({
  targetDir,
  sourceDir,
  reusedSnapshotId = null,
}) {
  if (reusedSnapshotId) {
    await symlink(sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  await cp(sourceDir, targetDir, RUNTIME_DIRECTORY_COPY_OPTIONS);
}

async function validateRuntimeArtifact({ component, artifact }) {
  const validation = validateArtifactManifest(artifact?.manifest);
  if (!validation.ok) {
    throw new Error(`[build] invalid ${component} artifact manifest: ${validation.errors.join('; ')}`);
  }

  const entrypointPath = join(artifactPayloadDir(artifact.artifactDir), validation.manifest.entrypoint);
  if (!(await pathExists(entrypointPath))) {
    throw new Error(`[build] ${component} artifact entrypoint is missing: ${entrypointPath}`);
  }

  return validation.manifest;
}

function readServerFlavor(value) {
  const serverComponent = String(value ?? '').trim();
  return serverComponent === 'happier-server' || serverComponent === 'happier-server-light'
    ? serverComponent
    : '';
}

function assertCompatibleServerFlavor({ sourceMetadata, reuseSource, sourceLabel }) {
  const expectedServerFlavor = readServerFlavor(sourceMetadata?.serverComponent);
  const actualServerFlavor = readServerFlavor(reuseSource?.serverComponent);
  if (!expectedServerFlavor || !actualServerFlavor || expectedServerFlavor === actualServerFlavor) {
    return;
  }

  throw new Error(
    `[build] cannot reuse the ${sourceLabel} across server flavors: stack expects ${expectedServerFlavor}, but the runtime snapshot has ${actualServerFlavor}. Build/activate the server artifact for the requested flavor first.`,
  );
}

async function resolveComponentSource({ stackBaseDir, component, artifact, currentSnapshot, sourceMetadata }) {
  const componentDirName = resolveComponentDirectoryName(component);
  if (artifact) {
    const manifest = await validateRuntimeArtifact({ component, artifact });
    if (component === 'server') {
      assertCompatibleServerFlavor({
        sourceMetadata,
        reuseSource: manifest.source,
        sourceLabel: 'server artifact',
      });
    }
    return {
      artifactFingerprint: manifest.artifactFingerprint,
      sourceDir: artifactPayloadDir(artifact.artifactDir),
      entrypoint:
        component === 'web'
          ? `ui/${manifest.entrypoint}`
          : component === 'server'
            ? `server/${manifest.entrypoint}`
            : `cli/${manifest.entrypoint}`,
      reusedSnapshotId: null,
    };
  }

  if (!currentSnapshot?.manifest?.components?.[component]?.entrypoint) {
    throw new Error(`[build] cannot activate runtime: missing ${component} artifact and no valid active runtime snapshot to reuse.`);
  }

  if (component === 'server') {
    assertCompatibleServerFlavor({
      sourceMetadata,
      reuseSource: currentSnapshot.manifest.source,
      sourceLabel: 'active runtime server artifact',
    });
  }

  return {
    artifactFingerprint: String(currentSnapshot.manifest.components[component].artifactFingerprint ?? '').trim(),
    sourceDir: join(currentSnapshot.snapshotPath, componentDirName),
    entrypoint: String(currentSnapshot.manifest.components[component].entrypoint ?? '').trim(),
    reusedSnapshotId: currentSnapshot.snapshotId,
  };
}

export async function activateRuntimeSnapshot({
  stackBaseDir,
  snapshotId,
  sourceMetadata,
  artifacts,
  runtimeSnapshotKeepCount = 2,
}) {
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir, snapshotId });
  await mkdir(runtimePaths.buildsDir, { recursive: true });
  const currentInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir });
  const currentSnapshot = currentInspection.snapshot;
  const webSource = await resolveComponentSource({ stackBaseDir, component: 'web', artifact: artifacts.web, currentSnapshot, sourceMetadata });
  const serverSource = await resolveComponentSource({ stackBaseDir, component: 'server', artifact: artifacts.server, currentSnapshot, sourceMetadata });
  const daemonSource = await resolveComponentSource({ stackBaseDir, component: 'daemon', artifact: artifacts.daemon, currentSnapshot, sourceMetadata });
  const reusedSnapshotIds = [...new Set([
    webSource.reusedSnapshotId,
    serverSource.reusedSnapshotId,
    daemonSource.reusedSnapshotId,
  ].filter((value) => typeof value === 'string' && value.trim() && value !== snapshotId))];

  await buildIntoTempThenReplace(runtimePaths.snapshotDir, async (tmpSnapshotDir) => {
    await materializeRuntimeComponent({
      sourceDir: webSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'ui'),
      reusedSnapshotId: webSource.reusedSnapshotId,
    });
    await materializeRuntimeComponent({
      sourceDir: serverSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'server'),
      reusedSnapshotId: serverSource.reusedSnapshotId,
    });
    await materializeRuntimeComponent({
      sourceDir: daemonSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'cli'),
      reusedSnapshotId: daemonSource.reusedSnapshotId,
    });

    await writeRuntimeManifest({
      manifestPath: join(tmpSnapshotDir, 'manifest.json'),
      manifest: {
        version: 1,
        snapshotId,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        reusedSnapshotIds,
        components: {
          web: {
            artifactFingerprint: webSource.artifactFingerprint,
            entrypoint: webSource.entrypoint,
          },
          server: {
            artifactFingerprint: serverSource.artifactFingerprint,
            entrypoint: serverSource.entrypoint,
          },
          daemon: {
            artifactFingerprint: daemonSource.artifactFingerprint,
            entrypoint: daemonSource.entrypoint,
          },
        },
      },
    });
  });

  await buildIntoTempThenReplace(runtimePaths.currentDir, async (tmpCurrentDir) => {
    await symlink(join(runtimePaths.snapshotDir, 'ui'), join(tmpCurrentDir, 'ui'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(runtimePaths.snapshotDir, 'server'), join(tmpCurrentDir, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(runtimePaths.snapshotDir, 'cli'), join(tmpCurrentDir, 'cli'), process.platform === 'win32' ? 'junction' : 'dir');
    await cp(join(runtimePaths.snapshotDir, 'manifest.json'), join(tmpCurrentDir, 'manifest.json'), RUNTIME_FILE_COPY_OPTIONS);
  });

  await writeRuntimePointer({
    currentPath: runtimePaths.currentPath,
    pointer: {
      version: 1,
      snapshotId,
      snapshotPath: runtimePaths.snapshotDir,
      sourceFingerprint: sourceMetadata.sourceFingerprint,
      updatedAt: sourceMetadata.builtAt,
    },
  });

  await pruneRuntimeSnapshots({
    stackBaseDir,
    keepCount: runtimeSnapshotKeepCount,
    preserveSnapshotIds: [snapshotId],
  });

  return {
    snapshotId,
    snapshotPath: runtimePaths.snapshotDir,
    currentPath: runtimePaths.currentPath,
  };
}
