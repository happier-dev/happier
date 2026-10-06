import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
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
    await writeFile(
      join(paths.snapshotDir, 'cli', 'package-dist', '.build-manifest.json'),
      JSON.stringify({ fingerprint: daemon.distClosureFingerprint ?? '0123456789abcdef', fileCount: 1 }) + '\n',
      'utf8',
    );
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
      await writeFile(
        join(paths.currentDir, 'cli', 'package-dist', '.build-manifest.json'),
        JSON.stringify({ fingerprint: daemon.distClosureFingerprint ?? '0123456789abcdef', fileCount: 1 }) + '\n',
        'utf8',
      );
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

export async function writeManagedRuntimeSnapshotLayout({ stackDir, snapshotId = 'managed-qa', target = { platform: process.platform, arch: process.arch } }) {
  const paths = resolveRuntimeSnapshotLayoutPaths({ stackDir, snapshotId });
  const components = {};
  await mkdir(paths.snapshotDir, { recursive: true });
  for (const [component, directory, entrypoint] of [['web', 'ui', 'index.html'], ['server', 'server', 'happier-server'], ['daemon', 'cli', 'happier']]) {
    const artifactFingerprint = `${component}-${snapshotId}`;
    const artifactDir = join(stackDir, 'artifacts', component, artifactFingerprint);
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeRuntimeArtifact(join(artifactDir, 'payload'), entrypoint, component + '\n');
    if (component === 'daemon') {
      await writeRuntimeArtifact(join(artifactDir, 'payload'), 'package-dist/index.mjs', 'export {};\n');
      await writeRuntimeArtifact(join(artifactDir, 'payload'), 'package-dist/.build-manifest.json', JSON.stringify({ fingerprint: '0123456789abcdef', fileCount: 1 }));
    }
    await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify({ version: 1, component, artifactFingerprint,
      sourceFingerprint: 'managed-source', payloadDir: 'payload', entrypoint, target }));
    await symlink(`../../../artifacts/${component}/${artifactFingerprint}/payload`, join(paths.snapshotDir, directory));
    components[component] = { artifactFingerprint, entrypoint: directory + '/' + entrypoint };
  }
  const manifest = { version: 1, snapshotId, sourceFingerprint: 'managed-source', components, target };
  await writeFile(join(paths.snapshotDir, 'manifest.json'), JSON.stringify(manifest));
  return { ...paths, snapshotId, snapshotPath: paths.snapshotDir, producerStackBaseDir: stackDir,
    sourceFingerprint: 'managed-source', daemonDistClosureFingerprint: '0123456789abcdef', manifest };
}
