import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type {
  PromptBundleBodyV1,
  PromptBundleEntryV1,
} from '@happier-dev/protocol';

type CollectedPromptBundleEntry = Readonly<{
  entry: PromptBundleEntryV1;
  createdAtMs: number;
  updatedAtMs: number;
}>;

function assertNoSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`symlinks are not supported: ${path}`);
  }
}

function detectPromptBundleContentKind(buffer: Buffer): PromptBundleEntryV1['contentKind'] {
  const utf8 = buffer.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(buffer) ? 'utf8' : 'binary';
}

function collectPromptBundleEntryMetadata(rootDirectory: string): CollectedPromptBundleEntry[] {
  const output: CollectedPromptBundleEntry[] = [];
  const stack = [rootDirectory];

  while (stack.length > 0) {
    const current = stack.pop()!;
    assertNoSymlink(current);
    const dirents = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      const absolutePath = join(current, dirent.name);
      assertNoSymlink(absolutePath);
      if (dirent.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!dirent.isFile()) continue;

      const relativePath = relative(rootDirectory, absolutePath).split(sep).join('/');
      const buffer = readFileSync(absolutePath);
      const stat = statSync(absolutePath);

      output.push({
        entry: {
          path: relativePath,
          contentBase64: buffer.toString('base64'),
          contentKind: detectPromptBundleContentKind(buffer),
          unixMode: stat.mode & 0o7777,
        },
        createdAtMs: Math.max(0, Math.trunc(Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : stat.mtimeMs)),
        updatedAtMs: Math.max(0, Math.trunc(stat.mtimeMs)),
      });
    }
  }

  return output.sort((left, right) => left.entry.path.localeCompare(right.entry.path));
}

function orderPromptBundleEntries(
  entries: readonly PromptBundleEntryV1[],
  preferredFirstPath?: string | null,
): PromptBundleEntryV1[] {
  const preferredPath = typeof preferredFirstPath === 'string' ? preferredFirstPath.trim() : '';
  if (!preferredPath) return [...entries];

  const preferred = entries.filter((entry) => entry.path === preferredPath);
  const remaining = entries.filter((entry) => entry.path !== preferredPath);
  return [...preferred, ...remaining];
}

export function collectPromptBundleDirectoryEntries(rootDirectory: string): PromptBundleEntryV1[] {
  return collectPromptBundleEntryMetadata(rootDirectory).map((item) => item.entry);
}

export function buildPromptBundleBodyFromDirectory(params: Readonly<{
  rootDirectory: string;
  preferredFirstPath?: string | null;
}>): PromptBundleBodyV1 {
  const collected = collectPromptBundleEntryMetadata(params.rootDirectory);
  const timestamps = collected.length > 0
    ? {
        createdAtMs: Math.min(...collected.map((item) => item.createdAtMs)),
        updatedAtMs: Math.max(...collected.map((item) => item.updatedAtMs)),
      }
    : {
        createdAtMs: 0,
        updatedAtMs: 0,
      };

  return {
    v: 1,
    entries: orderPromptBundleEntries(
      collected.map((item) => item.entry),
      params.preferredFirstPath ?? null,
    ),
    createdAtMs: timestamps.createdAtMs,
    updatedAtMs: timestamps.updatedAtMs,
  };
}

export function computePromptBundleDigest(bundleBody: PromptBundleBodyV1): string {
  const hash = createHash('sha256');
  const normalizedEntries = [...bundleBody.entries]
    .map((entry) => ({
      path: entry.path,
      contentBase64: entry.contentBase64,
      contentKind: entry.contentKind,
      unixMode: entry.unixMode ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  hash.update(JSON.stringify({
    v: bundleBody.v,
    entries: normalizedEntries,
  }));
  return `sha256:${hash.digest('hex')}`;
}
