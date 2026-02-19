import { dirname } from 'node:path';

function splitPath(p: string): string[] {
  return String(p ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Builds a PATH string for a daemon service by merging the node binary directory,
 * the caller's current PATH, and platform-appropriate defaults. Deduplicates entries
 * while preserving order (node dir first, then user PATH, then defaults).
 */
export function buildServicePath(params: Readonly<{
  execPath?: string;
  basePath?: string;
  defaultPath?: string;
}> = {}): string {
  const execPath = params.execPath ?? process.execPath;
  const basePath = params.basePath ?? process.env.PATH ?? '';
  const nodeDir = execPath ? dirname(execPath) : '';
  const defaults = splitPath(params.defaultPath ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  const fromNode = nodeDir ? [nodeDir] : [];
  const fromEnv = splitPath(basePath);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...fromNode, ...fromEnv, ...defaults]) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
}
