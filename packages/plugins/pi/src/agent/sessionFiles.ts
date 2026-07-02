import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const LEGACY_PI_WORKDIR_SEGMENT = '--workdir--';

export function doesPiSessionFileNameMatchSessionId(fileName: string, sessionId: string): boolean {
  if (!fileName.endsWith('.jsonl')) return false;
  const stem = fileName.slice(0, -'.jsonl'.length);
  if (stem === sessionId) return true;
  if (stem === `session-${sessionId}`) return true;
  return stem.endsWith(`_${sessionId}`);
}

export function isBarePiSessionId(value: string): boolean {
  return (
    value.length > 0
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.toLowerCase().endsWith('.jsonl')
  );
}

export function encodePiSessionDirectoryCwd(cwd: string): string {
  return resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
}

export function formatPiSessionDirectoryForCwd(cwd: string): string {
  return `--${encodePiSessionDirectoryCwd(cwd)}--`;
}

export function resolvePiSessionIdFromResumeReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isBarePiSessionId(trimmed)) return trimmed;
  if (!trimmed.toLowerCase().endsWith('.jsonl')) return null;

  const fileName = basename(trimmed);
  const stem = fileName.slice(0, -'.jsonl'.length);
  const lastUnderscore = stem.lastIndexOf('_');
  if (lastUnderscore >= 0 && lastUnderscore < stem.length - 1) {
    return stem.slice(lastUnderscore + 1) || null;
  }
  if (stem.startsWith('session-') && stem.length > 'session-'.length) {
    return stem.slice('session-'.length) || null;
  }
  return stem || null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function pathExistsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findNewestPiSessionFileInDir(params: Readonly<{
  sessionId: string;
  dir: string;
}>): Promise<string | null> {
  let entries: ReadonlyArray<Readonly<{ name: string; isFile: () => boolean }>>;
  try {
    entries = await readdir(params.dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!doesPiSessionFileNameMatchSessionId(entry.name, params.sessionId)) continue;
    const path = join(params.dir, entry.name);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      matches.push({
        path,
        mtimeMs: typeof metadata.mtimeMs === 'number' && Number.isFinite(metadata.mtimeMs)
          ? metadata.mtimeMs
          : 0,
      });
    } catch {
      // Ignore files that disappear between read and stat.
    }
  }

  matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path));
  return matches[0]?.path ?? null;
}

export function buildPiResumeSearchRoots(params: Readonly<{
  cwd: string;
  env?: Readonly<Record<string, string | undefined>> | null;
  targetMaterializedRoot?: string | null;
  candidatePersistedSessionFile?: string | null;
  targetStrict?: boolean;
}>): string[] {
  const encodedCwdDir = formatPiSessionDirectoryForCwd(params.cwd);
  const env = params.env ?? {};
  const piAgentDir = nonEmptyString(env.PI_CODING_AGENT_DIR);
  const legacySessionDir = nonEmptyString(env.PI_CODING_AGENT_SESSION_DIR);
  const persisted = nonEmptyString(params.candidatePersistedSessionFile);
  const persistedDir = persisted && isAbsolute(persisted) ? dirname(persisted) : null;
  const targetRoot = nonEmptyString(params.targetMaterializedRoot);

  if (params.targetStrict) {
    return piAgentDir ? [join(piAgentDir, 'sessions', encodedCwdDir)] : [];
  }

  const roots = [
    ...(persistedDir ? [persistedDir] : []),
    ...(piAgentDir ? [join(piAgentDir, 'sessions', encodedCwdDir), join(piAgentDir, 'sessions')] : []),
    join(homedir(), '.pi', 'agent', 'sessions', encodedCwdDir),
    join(homedir(), '.pi', 'agent', 'sessions'),
    ...(legacySessionDir ? [join(legacySessionDir, LEGACY_PI_WORKDIR_SEGMENT), legacySessionDir] : []),
    ...(targetRoot ? [
      join(targetRoot, 'pi-agent-dir', 'sessions', encodedCwdDir),
      join(targetRoot, 'pi-sessions', LEGACY_PI_WORKDIR_SEGMENT),
      join(targetRoot, 'pi-sessions'),
    ] : []),
  ];

  return Array.from(new Set(roots));
}

export async function findPiSessionFileForId(params: Readonly<{
  sessionId: string;
  roots: readonly string[];
}>): Promise<string | null> {
  for (const dir of params.roots) {
    const found = await findNewestPiSessionFileInDir({ sessionId: params.sessionId, dir });
    if (found) return found;
  }
  return null;
}
