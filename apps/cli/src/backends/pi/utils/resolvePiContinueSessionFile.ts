import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readPiSessionHeader } from '@/backends/pi/directSessions/readPiSessionHeader';
import { resolvePiAgentDir } from '@/backends/pi/directSessions/resolvePiAgentDir';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';

/**
 * The session file plain `pi --continue` would open in `cwd` (if any) and the directory searched.
 * Mirrors Pi 1.5.2 (`main.js` session-dir selection, `SessionManager.continueRecent`,
 * `findMostRecentSession`):
 * - session dir: `PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` from `<agentDir>/settings.json`
 *   overridden by `<cwd>/.pi/settings.json`, else `<agentDir>/sessions/--<cwd>--`;
 * - newest `*.jsonl` by mtime whose first parsed entry is a session header;
 * - a configured dir other than the default keeps only sessions whose header cwd is `cwd`.
 * Pi's `--session-dir` flag is not forwarded by Happier, so it is not read here.
 */
export async function resolvePiContinueSessionFile(params: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<{ sessionDir: string; sessionFile: string | null }> {
  const cwd = resolve(params.cwd);
  const agentDir = resolve(resolvePiAgentDir({ source: { kind: 'piAgentDir' }, env: params.env }));
  const defaultDir = join(agentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
  const configuredRaw = nonEmptyString(params.env.PI_CODING_AGENT_SESSION_DIR)
    ?? await readPiSettingsSessionDir({ agentDir, cwd });
  const configuredDir = configuredRaw ? resolvePiPath(configuredRaw, cwd, params.env) : null;
  const sessionDir = configuredDir ?? defaultDir;
  const filterCwd = configuredDir !== null && !isSamePath(configuredDir, defaultDir);
  const sessionFile = await findMostRecentPiSessionFile({ dir: sessionDir, cwd: filterCwd ? cwd : null, env: params.env });
  return { sessionDir, sessionFile };
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
  // Pi's stable mtime sort keeps directory enumeration order on ties.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const header = await readPiSessionHeader(candidate.filePath);
    if (!header) continue;
    if (params.cwd !== null) {
      if (!header.cwd) continue;
      const headerCwd = resolvePiPath(header.cwd, params.cwd, params.env);
      if (!isSamePath(headerCwd, params.cwd)) continue;
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

function resolvePiPath(value: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (value === '~') return resolve(resolveHomeDirFromEnvironment(env));
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return resolve(resolveHomeDirFromEnvironment(env), `.${value.slice(1)}`);
  }
  return resolve(cwd, value);
}

function isSamePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
