/**
 * Shared PATH construction utility for daemon service installers.
 *
 * Provides buildServicePath() to merge the node binary directory,
 * the caller's current PATH, and platform-specific defaults with
 * deduplication and order preservation.
 */

import { dirname } from 'node:path';

const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

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
  const defaults = splitPath(params.defaultPath ?? FALLBACK_PATH);
  const fromNode = nodeDir ? [nodeDir] : [];
  const fromEnv = splitPath(basePath);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...fromNode, ...fromEnv, ...defaults]) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':') || FALLBACK_PATH;
}
