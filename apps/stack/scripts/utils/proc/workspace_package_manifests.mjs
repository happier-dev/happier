import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';

export function isYarnWorkspace(manifest) {
  return typeof manifest?.packageManager === 'string' && manifest.packageManager.startsWith('yarn@');
}

function readWorkspaceString(item, unsupported) {
  const doubleQuoted = item.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u);
  const singleQuoted = item.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/u);
  let value;
  if (doubleQuoted) {
    try { value = JSON.parse(doubleQuoted[1]); } catch { throw unsupported(); }
  } else if (singleQuoted) {
    value = singleQuoted[1].replaceAll("''", "'");
  } else {
    value = item.replace(/\s+#.*$/u, '').trim();
    if (/^["'&*!\[\]{}>|%@`]/u.test(value) || /:\s/u.test(value)
      || /^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/iu.test(value)) throw unsupported();
  }
  if (!value) throw unsupported();
  return value;
}

// This reader runs before installation. Both workspace membership and patch
// inputs consume block-string YAML and empty collections without installed parsers.
async function readWorkspaceStringBlock(monorepoRoot, field, { mapping = false, optional = false } = {}) {
  const workspacePath = join(monorepoRoot, 'pnpm-workspace.yaml');
  let contents;
  try { contents = await readFile(workspacePath, 'utf-8'); } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = contents.split(/\r?\n/u);
  const header = lines.findIndex(line => line.startsWith(`${field}:`));
  const unsupported = () => new Error(`Unsupported ${field} syntax in ${workspacePath}: expected a block ${mapping ? 'mapping of string paths' : 'sequence of string globs'}.`);
  if (header < 0 && optional) return [];
  if (mapping && header >= 0 && /^patchedDependencies:\s*\{\}\s*(?:#.*)?$/u.test(lines[header])) return [];
  if (!mapping && header >= 0 && /^packages:\s*\[\s*\]\s*(?:#.*)?$/u.test(lines[header])) return [];
  if (header < 0 || !new RegExp(`^${field}:\\s*(?:#.*)?$`, 'u').test(lines[header])) throw unsupported();
  const values = [];
  for (const line of lines.slice(header + 1)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;
    const item = mapping
      ? line.match(/^ +("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'][^:]*):[ \t]+(.+)$/u)
      : line.match(/^ +-[ \t]+(.+)$/u);
    if (!item) throw unsupported();
    if (mapping) readWorkspaceString(item[1], unsupported);
    values.push(readWorkspaceString(item[mapping ? 2 : 1], unsupported));
  }
  return values;
}

export async function readWorkspacePatchPaths(monorepoRoot) {
  return await readWorkspaceStringBlock(monorepoRoot, 'patchedDependencies', { mapping: true, optional: true });
}

export async function readWorkspacePatterns(monorepoRoot) {
  // The executor also serves the supported Yarn predecessor checkout. Its
  // declared workspace set remains owned by package.json, never pnpm's YAML.
  const manifestPath = join(monorepoRoot, 'package.json');
  if (await pathExists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    if (isYarnWorkspace(manifest)) {
      const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
        throw new Error(`Invalid Yarn workspace patterns in ${manifestPath}`);
      }
      return patterns;
    }
  }
  return await readWorkspaceStringBlock(monorepoRoot, 'packages');
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
  const raw = String(segment ?? '');
  let out = '^';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const end = raw.indexOf(']', i + 1);
      if (end > i + 1) {
        out += raw.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  out += '$';
  return new RegExp(out);
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
  const patterns = await readWorkspacePatterns(monorepoRoot);
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

  return Array.from(out);
}
