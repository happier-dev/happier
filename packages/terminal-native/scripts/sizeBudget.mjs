import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const artifactPath = process.env.HAPPIER_TERMINAL_NATIVE_ARTIFACT;
const maxBytes = Number(process.env.HAPPIER_TERMINAL_NATIVE_MAX_BYTES ?? '0');

if (!artifactPath) {
  writeJsonLine({ status: 'skipped', reason: 'missing-artifact-path' });
  process.exit(0);
}

const bytes = await getArtifactByteSize(artifactPath);
const withinBudget = maxBytes <= 0 || bytes <= maxBytes;

writeJsonLine({
  status: withinBudget ? 'ok' : 'over-budget',
  artifactPath,
  bytes,
  maxBytes,
});

if (!withinBudget) {
  process.exitCode = 1;
}

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function getArtifactByteSize(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;

  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await getArtifactByteSize(join(path, entry.name));
  }
  return total;
}
