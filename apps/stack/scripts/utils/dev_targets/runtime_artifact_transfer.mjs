import { cp, mkdir } from 'node:fs/promises';
import { relative } from 'node:path';

import { transferOpenSshFile } from '@happier-dev/cli-common/ssh';
import { readReusableArtifactManifest, readComponentArtifactSupportReference } from '../../runtime/shared/artifact_manifest.mjs';
import { resolveStackComponentArtifactDir } from '../../runtime/shared/runtime_paths.mjs';
import { validateRuntimeTarget } from '../../runtime/shared/runtime_manifest.mjs';
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

export async function importRuntimeArtifactClosure({ sourceStackBaseDir, stackBaseDir, artifacts, target }) {
  // Validate the complete temporary graph before making any imported identity
  // visible. Relative owner-created links survive relocation and atomic rename.
  const closure = await resolveRuntimeArtifactClosure({ stackBaseDir: sourceStackBaseDir, artifacts, target });
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
  return imported;
}
