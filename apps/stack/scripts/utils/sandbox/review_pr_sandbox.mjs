import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const REVIEW_PR_MARKER_FILENAME = '.happier-stack-sandbox-marker';
export const REVIEW_PR_META_FILENAME = '.happier-stack-review-pr.json';

export function reviewPrSandboxPrefixBase(baseStackName) {
  const base = String(baseStackName ?? '').trim() || 'pr';
  // Keep prefix stable for listing/reuse; mkdtemp adds a random suffix.
  return `hstack-review-pr-${base}-`;
}

export function reviewPrSandboxPrefixPath(baseStackName) {
  return join(tmpdir(), reviewPrSandboxPrefixBase(baseStackName));
}

async function readJsonBestEffort(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listReviewPrSandboxes({ baseStackName }) {
  const prefixBase = reviewPrSandboxPrefixBase(baseStackName);
  const root = tmpdir();
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(prefixBase)) continue;
    const dir = resolve(join(root, e.name));
    const markerPath = join(dir, REVIEW_PR_MARKER_FILENAME);
    if (!existsSync(markerPath)) continue;

    let markerOk = false;
    try {
      const marker = await readFile(markerPath, 'utf-8');
      markerOk = marker.trim().startsWith('review-pr');
    } catch {
      markerOk = false;
    }
    if (!markerOk) continue;

    const metaPath = join(dir, REVIEW_PR_META_FILENAME);
    const meta = await readJsonBestEffort(metaPath);

    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    out.push({
      dir,
      name: basename(dir),
      markerPath,
      metaPath,
      baseStackName: String(meta?.baseStackName ?? '').trim() || String(baseStackName ?? '').trim() || null,
      stackName: String(meta?.stackName ?? '').trim() || null,
      createdAtMs: typeof meta?.createdAtMs === 'number' ? meta.createdAtMs : null,
      lastTouchedAtMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    });
  }

  out.sort((a, b) => (b.lastTouchedAtMs ?? 0) - (a.lastTouchedAtMs ?? 0));
  return out;
}

export async function writeReviewPrSandboxMeta({ sandboxDir, baseStackName, stackName, argv }) {
  const dir = resolve(String(sandboxDir ?? '').trim());
  const markerPath = join(dir, REVIEW_PR_MARKER_FILENAME);
  const metaPath = join(dir, REVIEW_PR_META_FILENAME);

  // Marker (for safe deletion) + meta (for reuse menu).
  await writeFile(markerPath, 'review-pr\n', 'utf-8');
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        kind: 'review-pr',
        createdAtMs: Date.now(),
        baseStackName: String(baseStackName ?? '').trim() || null,
        stackName: String(stackName ?? '').trim() || null,
        argv: Array.isArray(argv) ? argv : null,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  return { markerPath, metaPath };
}
