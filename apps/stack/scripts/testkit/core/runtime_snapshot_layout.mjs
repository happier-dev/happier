import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function defaultArtifactFingerprint(prefix, snapshotId) {
  return `${prefix}-${snapshotId}`;
}

async function writeRuntimeArtifact(rootDir, entrypoint, content, { executable = false } = {}) {
  const artifactPath = join(rootDir, entrypoint);
  await mkdir(join(rootDir, ...entrypoint.split('/').slice(0, -1)), { recursive: true });
  await writeFile(artifactPath, content, 'utf-8');
  if (executable) {
    await chmod(artifactPath, 0o755);
  }
}

function buildRuntimeSnapshotManifest({
  snapshotId,
  sourceFingerprint,
  webEntrypoint,
  webArtifactFingerprint,
  serverEntrypoint,
  serverArtifactFingerprint,
  daemonEntrypoint,
  daemonArtifactFingerprint,
  createdAt,
  source,
}) {
  const manifest = {
    version: 1,
    snapshotId,
    sourceFingerprint,
    components: {
      web: { artifactFingerprint: webArtifactFingerprint, entrypoint: webEntrypoint },
      server: { artifactFingerprint: serverArtifactFingerprint, entrypoint: serverEntrypoint },
      daemon: { artifactFingerprint: daemonArtifactFingerprint, entrypoint: daemonEntrypoint },
    },
  };

  if (createdAt) {
    manifest.createdAt = createdAt;
  }

  if (source) {
    manifest.source = source;
  }

  return manifest;
}

export function resolveRuntimeSnapshotLayoutPaths({ stackDir, snapshotId }) {
  const runtimeDir = join(stackDir, 'runtime');
  const snapshotDir = join(runtimeDir, 'builds', snapshotId);
  const currentDir = join(runtimeDir, 'current');
  return {
    runtimeDir,
    snapshotDir,
    currentDir,
    currentPath: join(runtimeDir, 'current.json'),
  };
}

export async function writeRuntimeSnapshotLayout({
  stackDir,
  snapshotId,
  sourceFingerprint = `src-${snapshotId}`,
  web = {},
  server = {},
  daemon = {},
  writeCurrentMirror = false,
  currentSnapshotPath,
  currentUpdatedAt,
  createdAt,
  source,
} = {}) {
  const paths = resolveRuntimeSnapshotLayoutPaths({ stackDir, snapshotId });
  const resolvedCurrentSnapshotPath = currentSnapshotPath ?? paths.snapshotDir;
  const webEntrypoint = web.entrypoint ?? 'ui/index.html';
  const serverEntrypoint = server.entrypoint ?? 'server/happier-server';
  const daemonEntrypoint = daemon.entrypoint ?? 'cli/happier';
  const daemonNodeEntrypoint = daemon.nodeEntrypoint ?? null;
  const manifest = buildRuntimeSnapshotManifest({
    snapshotId,
    sourceFingerprint,
    webEntrypoint,
    webArtifactFingerprint: web.artifactFingerprint ?? defaultArtifactFingerprint('web', snapshotId),
    serverEntrypoint,
    serverArtifactFingerprint: server.artifactFingerprint ?? defaultArtifactFingerprint('srv', snapshotId),
    daemonEntrypoint,
    daemonArtifactFingerprint: daemon.artifactFingerprint ?? defaultArtifactFingerprint('cli', snapshotId),
    createdAt,
    source,
  });

  await mkdir(paths.snapshotDir, { recursive: true });
  await writeRuntimeArtifact(paths.snapshotDir, webEntrypoint, web.content ?? '<html></html>\n');
  await writeRuntimeArtifact(paths.snapshotDir, serverEntrypoint, server.content ?? '#!/bin/sh\nexit 0\n', {
    executable: server.executable ?? true,
  });
  await writeRuntimeArtifact(paths.snapshotDir, daemonEntrypoint, daemon.content ?? '#!/bin/sh\nexit 0\n', {
    executable: daemon.executable ?? true,
  });
  if (daemonNodeEntrypoint && typeof daemon.nodeContent !== 'undefined') {
    await writeRuntimeArtifact(paths.snapshotDir, daemonNodeEntrypoint, daemon.nodeContent);
  }
  await writeFile(join(paths.snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  if (writeCurrentMirror) {
    await mkdir(paths.currentDir, { recursive: true });
    await writeRuntimeArtifact(paths.currentDir, webEntrypoint, web.content ?? '<html></html>\n');
    await writeRuntimeArtifact(paths.currentDir, serverEntrypoint, server.content ?? '#!/bin/sh\nexit 0\n', {
      executable: server.executable ?? true,
    });
    await writeRuntimeArtifact(paths.currentDir, daemonEntrypoint, daemon.content ?? '#!/bin/sh\nexit 0\n', {
      executable: daemon.executable ?? true,
    });
    if (daemonNodeEntrypoint && typeof daemon.nodeContent !== 'undefined') {
      await writeRuntimeArtifact(paths.currentDir, daemonNodeEntrypoint, daemon.nodeContent);
    }
    await writeFile(join(paths.currentDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  const currentPayload = {
    version: 1,
    snapshotId,
    snapshotPath: resolvedCurrentSnapshotPath,
    sourceFingerprint,
  };
  if (currentUpdatedAt) {
    currentPayload.updatedAt = currentUpdatedAt;
  }
  await writeFile(paths.currentPath, JSON.stringify(currentPayload, null, 2) + '\n', 'utf-8');

  return paths;
}
