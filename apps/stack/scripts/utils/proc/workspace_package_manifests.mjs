import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';

async function readJsonIfExists(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  return JSON.parse(await readFile(path, 'utf-8'));
}

function readWorkspacePatterns(pkgJson) {
  const workspaces = pkgJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces;
  }
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages;
  }
  return [];
}

function workspacePatternToSegments(pattern) {
  const value = String(pattern ?? '').trim();
  if (!value || value.startsWith('!')) return null;
  return value
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

function wildcardSegmentRegex(segment) {
  const escaped = String(segment)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

async function expandWorkspacePatternSegments(baseDir, segments, index = 0) {
  if (index >= segments.length) {
    return [baseDir];
  }

  const segment = segments[index];
  if (!segment || segment === '**') {
    return [];
  }

  if (!segment.includes('*')) {
    return await expandWorkspacePatternSegments(join(baseDir, segment), segments, index + 1);
  }

  let entries = [];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matcher = wildcardSegmentRegex(segment);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!matcher.test(entry.name)) continue;
    out.push(...await expandWorkspacePatternSegments(join(baseDir, entry.name), segments, index + 1));
  }
  return out;
}

export async function collectWorkspacePackageJsonPaths(monorepoRoot) {
  const rootPkgJson = await readJsonIfExists(join(monorepoRoot, 'package.json'));
  const patterns = readWorkspacePatterns(rootPkgJson);
  const out = new Set();

  for (const pattern of patterns) {
    const segments = workspacePatternToSegments(pattern);
    if (!segments?.length) continue;
    for (const workspaceDir of await expandWorkspacePatternSegments(monorepoRoot, segments)) {
      const pkgJsonPath = join(workspaceDir, 'package.json');
      if (await pathExists(pkgJsonPath)) {
        out.add(pkgJsonPath);
      }
    }
  }

  if (out.size === 0) {
    for (const bucket of ['apps', 'packages']) {
      const bucketDir = join(monorepoRoot, bucket);
      let entries = [];
      try {
        entries = await readdir(bucketDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgJsonPath = join(bucketDir, entry.name, 'package.json');
        if (await pathExists(pkgJsonPath)) {
          out.add(pkgJsonPath);
        }
      }
    }
  }

  return Array.from(out);
}
