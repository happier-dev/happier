import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * @param {{ from: string; to: string }} params
 */
export async function copyArtifactFile(params) {
  const from = String(params?.from ?? '').trim();
  const to = String(params?.to ?? '').trim();
  if (!from) throw new Error('copyArtifactFile: missing "from"');
  if (!to) throw new Error('copyArtifactFile: missing "to"');
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

function readFlagValue(argv, name) {
  const key = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === key) return String(argv[i + 1] ?? '').trim();
    if (a.startsWith(`${key}=`)) return String(a.slice(key.length + 1)).trim();
  }
  return '';
}

async function main() {
  const argv = process.argv.slice(2);
  const from = readFlagValue(argv, 'from');
  const to = readFlagValue(argv, 'to');
  if (!from || !to) {
    process.stderr.write('[copy-artifact] usage: node copy_artifact.mjs --from <path> --to <path>\n');
    process.exit(2);
  }
  await copyArtifactFile({ from, to });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((e) => {
    process.stderr.write(`[copy-artifact] ${String(e?.stack ?? e)}\n`);
    process.exit(1);
  });
}
