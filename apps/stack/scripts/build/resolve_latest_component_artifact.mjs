import { readdir } from 'node:fs/promises';

import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { resolveStackArtifactsDir } from '../runtime/shared/runtime_paths.mjs';
import { join } from 'node:path';

function compareArtifactRecency(left, right) {
  const leftTime = Number(Date.parse(String(left?.manifest?.createdAt ?? ''))) || 0;
  const rightTime = Number(Date.parse(String(right?.manifest?.createdAt ?? ''))) || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right?.manifest?.artifactFingerprint ?? '').localeCompare(String(left?.manifest?.artifactFingerprint ?? ''));
}

export async function resolveLatestComponentArtifact({ stackBaseDir, component }) {
  const componentDir = join(resolveStackArtifactsDir({ stackBaseDir }), String(component ?? '').trim());
  const entries = await readdir(componentDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const artifactDir = join(componentDir, entry.name);
    const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: entry.name, stackBaseDir });
    if (!manifest || manifest.component !== component) continue;
    if (component === 'web' && manifest.entrypoint !== 'index.html') continue;
    candidates.push({ artifactDir, manifest });
  }

  candidates.sort(compareArtifactRecency);
  return candidates[0] ?? null;
}
