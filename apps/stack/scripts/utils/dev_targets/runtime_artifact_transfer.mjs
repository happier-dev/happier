import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { transferOpenSshFile } from '@happier-dev/cli-common/ssh';
import { readReusableArtifactManifest, readComponentArtifactSupportReference } from '../../runtime/shared/artifact_manifest.mjs';
import { resolveStackComponentArtifactDir, resolveStackRuntimePaths } from '../../runtime/shared/runtime_paths.mjs';
import { readRuntimeManifest, validateRuntimeManifest, validateRuntimeTarget, writeRuntimePointer } from '../../runtime/shared/runtime_manifest.mjs';
import { pathExists } from '../fs/fs.mjs';
import { inspectActiveRuntimeSnapshot } from '../../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { buildIntoTempThenReplace } from '../fs/atomic_dir_swap.mjs';
import { spawnProc } from '../proc/proc.mjs';

// Runtime build and controlled placement share this closure transfer owner.
// SSH provides byte transport; the existing manifest/payload owner admits it.
export async function transferRuntimeFile({ target, direction, localPath, remotePath, signal }) {
  await transferOpenSshFile({
    target: target.ssh, sshConfigFile: target.sshConfigFile ?? undefined,
    auth: { mode: 'agent' }, knownHostsMode: 'system', direction,
    localPath, remotePath, signal, timeoutMs: null,
  });
}

export async function removeRemoteRuntimeTransferArchives({ archivePaths, runCommand }) {
  const result = await runCommand(['node', '-e',
    'for (const path of process.argv.slice(1)) require("node:fs").rmSync(path,{force:true})', ...archivePaths]);
  if (result.code !== 0) throw new Error(`exit ${result.code}`);
}

export async function runRuntimeArchiveCommand(args, { cwd, env = process.env } = {}) {
  const child = spawnProc('runtime-transfer', 'tar', args, env, { cwd });
  const result = await child.completion;
  if (result.code !== 0) throw new Error(`[build] runtime archive operation failed (exit ${result.code}).`);
}

export async function resolveRuntimeArtifactClosure({ stackBaseDir, artifacts, target }) {
  const closure = new Map();
  const visit = async (component, fingerprint) => {
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint });
    const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: fingerprint });
    if (!manifest || manifest.component !== component) throw new Error(`[build] invalid transferred ${component} artifact: ${fingerprint}.`);
    if (!manifest.target || !validateRuntimeTarget(manifest, target).ok) {
      throw new Error(`[build] transferred ${component} artifact target does not match ${target.platform}/${target.arch}.`);
    }
    const key = `${component}/${fingerprint}`;
    if (closure.has(key)) return;
    closure.set(key, { artifactDir, manifest });
    const support = readComponentArtifactSupportReference(manifest);
    if (support) await visit(support.supportComponent, support.artifactFingerprint);
  };
  for (const [component, artifact] of Object.entries(artifacts)) {
    await visit(component, artifact.manifest.artifactFingerprint);
  }
  return [...closure.values()].sort((a, b) => Number(b.manifest.component.endsWith('-support')) - Number(a.manifest.component.endsWith('-support')));
}

export async function packRuntimeArtifactClosure({ stackBaseDir, artifacts, target, archivePath, env }) {
  const closure = await resolveRuntimeArtifactClosure({ stackBaseDir, artifacts, target });
  await runRuntimeArchiveCommand(['-cf', archivePath, '--', 'result.json', ...closure.map(({ artifactDir }) => relative(stackBaseDir, artifactDir))], { cwd: stackBaseDir, env });
}

export async function importRuntimeArtifactClosure({ sourceStackBaseDir, stackBaseDir, artifacts, target, snapshotId = null }) {
  // Validate the complete temporary graph before making any imported identity
  // visible. Relative owner-created links survive relocation and atomic rename.
  const closure = await resolveRuntimeArtifactClosure({ stackBaseDir: sourceStackBaseDir, artifacts, target });
  const snapshot = snapshotId ? await inspectTransferredSnapshot({ stackBaseDir: sourceStackBaseDir, snapshotId, target, artifacts }) : null;
  for (const { artifactDir: sourceDir, manifest } of closure) {
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component: manifest.component, fingerprint: manifest.artifactFingerprint });
    const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: manifest.artifactFingerprint });
    if (existing) continue;
    await mkdir(artifactDir, { recursive: true });
    await buildIntoTempThenReplace(artifactDir, async temporary => {
      await cp(sourceDir, temporary, { recursive: true, dereference: false, verbatimSymlinks: true });
    });
  }
  const imported = {};
  for (const [component, artifact] of Object.entries(artifacts)) {
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifact.manifest.artifactFingerprint });
    const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: artifact.manifest.artifactFingerprint });
    if (!manifest) throw new Error(`[build] imported ${component} artifact is incomplete.`);
    imported[component] = { artifactDir, manifest };
  }
  await resolveRuntimeArtifactClosure({ stackBaseDir, artifacts: imported, target });
  if (snapshot) {
    const destination = resolveStackRuntimePaths({ stackBaseDir, snapshotId });
    await mkdir(destination.buildsDir, { recursive: true });
    await buildIntoTempThenReplace(destination.snapshotDir, async temporary => {
      await cp(snapshot.paths.snapshotDir, temporary, { recursive: true, dereference: false, verbatimSymlinks: true });
    });
    await writeRuntimePointer({ currentPath: destination.currentPath, pointer: {
      version: 1, snapshotId, snapshotPath: destination.snapshotDir,
      sourceFingerprint: snapshot.manifest.sourceFingerprint,
    } });
  }
  return imported;
}

async function inspectTransferredSnapshot({ stackBaseDir, snapshotId, target, artifacts }) {
  const paths = resolveStackRuntimePaths({ stackBaseDir, snapshotId });
  const validation = validateRuntimeManifest(await readRuntimeManifest({ manifestPath: paths.manifestPath }), { requiredComponents: [] });
  if (!validation.ok || validation.manifest.snapshotId !== snapshotId) throw new Error('[runtime] transferred snapshot manifest is invalid');
  const manifest = validation.manifest;
  if (!manifest.target || !validateRuntimeTarget(manifest, target).ok) throw new Error('[runtime] transferred snapshot target does not match consumer target');
  for (const [component, directory] of [['web', 'ui'], ['server', 'server'], ['daemon', 'cli']]) {
    const entry = manifest.components[component];
    if (!entry) continue;
    if (entry.artifactFingerprint !== artifacts[component]?.manifest.artifactFingerprint) throw new Error(`[runtime] transferred ${component} snapshot reference differs from its artifact`);
    const expected = join(resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: entry.artifactFingerprint }), 'payload');
    if (await realpath(join(paths.snapshotDir, directory)) !== await realpath(expected)
      || !await pathExists(join(paths.snapshotDir, entry.entrypoint))) throw new Error(`[runtime] transferred ${component} snapshot payload is incomplete or not canonical`);
  }
  return { paths, manifest };
}

export async function packControlledRuntimeSnapshot({ snapshot, target, archivePath, env }) {
  const stackBaseDir = snapshot.producerStackBaseDir;
  const artifacts = {};
  for (const [component, entry] of Object.entries(snapshot.manifest.components)) {
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: entry.artifactFingerprint });
    const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: entry.artifactFingerprint });
    if (!manifest) throw new Error(`[runtime] selected ${component} artifact is incomplete`);
    artifacts[component] = { artifactDir, manifest };
  }
  const closure = await resolveRuntimeArtifactClosure({ stackBaseDir, artifacts, target });
  const inspection = await inspectTransferredSnapshot({ stackBaseDir, snapshotId: snapshot.snapshotId, target, artifacts });
  await runRuntimeArchiveCommand(['-cf', archivePath, '--', relative(stackBaseDir, inspection.paths.snapshotDir), ...closure.map(({ artifactDir }) => relative(stackBaseDir, artifactDir))], { cwd: stackBaseDir, env });
}

export async function importControlledRuntimeArchive({ archivePath, stackBaseDir, snapshotId, target = { platform: process.platform, arch: process.arch }, env, requiredComponents }) {
  const temporary = await mkdtemp(join(tmpdir(), 'hstack-runtime-import-'));
  try {
    await runRuntimeArchiveCommand(['-xf', archivePath, '-C', temporary], { env });
    const paths = resolveStackRuntimePaths({ stackBaseDir: temporary, snapshotId });
    const validation = validateRuntimeManifest(await readRuntimeManifest({ manifestPath: paths.manifestPath }), { requiredComponents });
    if (!validation.ok) throw new Error('[runtime] transferred snapshot manifest is invalid');
    await writeRuntimePointer({ currentPath: paths.currentPath, pointer: {
      version: 1, snapshotId, snapshotPath: paths.snapshotDir, sourceFingerprint: validation.manifest.sourceFingerprint,
    } });
    const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: temporary, target, requiredComponents });
    if (!inspection.valid) throw new Error(inspection.errors[0] || '[runtime] transferred snapshot is incomplete');
    const artifacts = {};
    for (const [component, entry] of Object.entries(validation.manifest.components)) {
      const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir: temporary, component, fingerprint: entry.artifactFingerprint });
      const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: entry.artifactFingerprint });
      if (!manifest) throw new Error(`[runtime] transferred ${component} artifact is incomplete`);
      artifacts[component] = { manifest };
    }
    await importRuntimeArtifactClosure({ sourceStackBaseDir: temporary, stackBaseDir, artifacts, target, snapshotId });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.slice(2).find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const requiredComponents = value('--required-components')?.split(',');
  const archivePath = value('--archive');
  try {
    await importControlledRuntimeArchive({ archivePath, stackBaseDir: value('--stack-base-dir'), snapshotId: value('--snapshot-id'), requiredComponents });
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
  }
}
