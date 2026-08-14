import { access, readdir } from 'node:fs/promises';

import { artifactPayloadDir, readArtifactManifest, validateArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { resolveStackArtifactsDir } from '../runtime/shared/runtime_paths.mjs';
import { join } from 'node:path';

function compareArtifactRecency(left, right) {
  const leftTime = Number(Date.parse(String(left?.manifest?.createdAt ?? ''))) || 0;
  const rightTime = Number(Date.parse(String(right?.manifest?.createdAt ?? ''))) || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right?.manifest?.artifactFingerprint ?? '').localeCompare(String(left?.manifest?.artifactFingerprint ?? ''));
}

async function isCompleteComponentArtifact({ artifactDir, component, manifest }) {
  const entrypoint = component === 'web' ? 'index.html' : manifest.entrypoint;
  if (component === 'web' && manifest.entrypoint !== entrypoint) return false;
  try {
    await access(join(artifactPayloadDir(artifactDir), entrypoint));
    return true;
  } catch {
    return false;
  }
}

export async function resolveLatestComponentArtifact({ stackBaseDir, component }) {
  const componentDir = join(resolveStackArtifactsDir({ stackBaseDir }), String(component ?? '').trim());
  const entries = await readdir(componentDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const artifactDir = join(componentDir, entry.name);
    const manifest = await readArtifactManifest({ artifactDir });
    const validation = validateArtifactManifest(manifest);
    if (!validation.ok) continue;
    if (validation.manifest.component !== component) continue;
    // A manifest alone is not a published artifact: activation and server packaging
    // consume its payload entrypoint as well.
    if (!(await isCompleteComponentArtifact({ artifactDir, component, manifest: validation.manifest }))) continue;
    candidates.push({ artifactDir, manifest: validation.manifest });
  }

  candidates.sort(compareArtifactRecency);
  return candidates[0] ?? null;
}
