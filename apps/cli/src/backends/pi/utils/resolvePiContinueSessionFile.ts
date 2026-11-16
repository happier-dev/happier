import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readPiSessionHeader } from '@/backends/pi/directSessions/readPiSessionHeader';
import { resolvePiAgentDir } from '@/backends/pi/directSessions/resolvePiAgentDir';
import { comparePiSessionFilePreference } from '@/backends/pi/directSessions/resolvePiDirectSessionFile';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { normalizePathForComparison } from '@/utils/path/normalizePathForComparison';

/**
 * The session file plain `pi --continue` would open in `cwd`, or null when Pi would start a new
 * one. Mirrors Pi 1.5.2 (`main.js` session-dir selection, `SessionManager.continueRecent`,
 * `findMostRecentSession`):
 * - session dir: `PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` from `<agentDir>/settings.json`
 *   overridden by `<cwd>/.pi/settings.json`, else `<agentDir>/sessions/--<cwd>--`;
 * - newest `*.jsonl` by mtime whose first line is a session header;
 * - a configured dir other than the default keeps only sessions whose header cwd is `cwd`.
 * Pi's `--session-dir` flag is not forwarded by Happier, so it is not read here.
 */
export async function resolvePiContinueSessionFile(params: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const cwd = resolve(params.cwd);
  const agentDir = resolve(resolvePiAgentDir({ source: { kind: 'piAgentDir' }, env: params.env }));
  const defaultDir = join(agentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
  const configuredRaw = nonEmptyString(params.env.PI_CODING_AGENT_SESSION_DIR)
    ?? await readPiSettingsSessionDir({ agentDir, cwd });
  const configuredDir = configuredRaw ? resolve(cwd, expandHomeDirPath(configuredRaw, params.env)) : null;
  const dir = configuredDir ?? defaultDir;
  const filterCwd = configuredDir !== null && !isSamePath(configuredDir, defaultDir, params.env);
  return await findMostRecentPiSessionFile({ dir, cwd: filterCwd ? cwd : null, env: params.env });
}

async function findMostRecentPiSessionFile(params: Readonly<{
  dir: string;
  cwd: string | null;
  env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(params.dir);
  } catch {
    return null;
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const filePath = join(params.dir, name);
    try {
      const metadata = await stat(filePath);
      if (metadata.isFile()) candidates.push({ filePath, mtimeMs: metadata.mtimeMs });
    } catch {
      // A file removed between readdir and stat is not a session.
    }
  }
  candidates.sort(comparePiSessionFilePreference);

  for (const candidate of candidates) {
    const header = await readPiSessionHeader(candidate.filePath);
    if (!header) continue;
    if (params.cwd !== null) {
      if (!header.cwd) continue;
      const headerCwd = resolve(params.cwd, expandHomeDirPath(header.cwd, params.env));
      if (!isSamePath(headerCwd, params.cwd, params.env)) continue;
    }
    return candidate.filePath;
  }
  return null;
}

/** Pi deep-merges project settings over global ones; `sessionDir` is a top-level scalar. */
async function readPiSettingsSessionDir(params: Readonly<{ agentDir: string; cwd: string }>): Promise<string | null> {
  const [globalSettings, projectSettings] = await Promise.all([
    readPiSettingsFile(join(params.agentDir, 'settings.json')),
    readPiSettingsFile(join(params.cwd, '.pi', 'settings.json')),
  ]);
  return nonEmptyString({ ...globalSettings, ...projectSettings }.sessionDir);
}

/** Pi treats a missing or unparseable settings file as empty settings. */
async function readPiSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isSamePath(left: string, right: string, env: NodeJS.ProcessEnv): boolean {
  return normalizePathForComparison(left, { env }) === normalizePathForComparison(right, { env });
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
