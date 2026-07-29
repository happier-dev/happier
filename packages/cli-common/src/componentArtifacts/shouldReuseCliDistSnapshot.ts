import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

async function findNewestInputMtimeMs(path: string): Promise<number> {
  let pathStat;
  try {
    pathStat = await stat(path);
  } catch {
    return 0;
  }

  if (!pathStat.isDirectory()) {
    return pathStat.mtimeMs;
  }

  let newestMtimeMs = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    newestMtimeMs = Math.max(
      newestMtimeMs,
      await findNewestInputMtimeMs(join(path, entry.name)),
    );
  }
  return newestMtimeMs;
}
export async function shouldReuseCliDistSnapshot(params: Readonly<{
  distEntrypointPath: string;
  inputPaths: readonly string[];
  requiredInputFingerprint?: string;
}>): Promise<boolean> {
  if (params.requiredInputFingerprint !== undefined) {
    const requiredInputFingerprint = params.requiredInputFingerprint
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(requiredInputFingerprint)) {
      return false;
    }
    const distManifest = cliDistBuildManifest.readCliDistBuildManifest(
      params.distEntrypointPath,
    );
    return distManifest.ok
      && distManifest.manifest?.inputFingerprint === requiredInputFingerprint;
  }

  let distEntrypointStat;
  try {
    distEntrypointStat = await stat(params.distEntrypointPath);
  } catch {
    return false;
  }

  const distEntrypointMtimeMs = distEntrypointStat.mtimeMs;
  for (const inputPath of params.inputPaths) {
    if (await findNewestInputMtimeMs(inputPath) > distEntrypointMtimeMs) {
      return false;
    }
  }

  return true;
}
