import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { readPiSessionHeader } from '../directSessions/readPiSessionHeader';

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
  // MUST stay byte-identical to pi-coding-agent's `getDefaultSessionDir` encoding
  // (vendor: `resolvePath(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')`), so session
  // files Happier imports/links land in the exact directory Pi scans on resume. Diverging
  // (mapping spaces/unicode, collapsing repeated dashes, trimming) writes to a folder Pi never
  // reads -> resume miss / "Pi process exited". See piSessionFiles.test.ts for the contract.
  //
  // VENDOR DIVERGENCE RISK (P3-2): the encoding logic above was transcribed from
  // @earendil-works/pi-coding-agent v0.75.5 (`getDefaultSessionDir`). If the managed installer
  // bumps the vendor package and Pi's algorithm changes (e.g. it starts normalising spaces or
  // collapsing repeated dashes), this encoder will silently produce the wrong directory name and
  // every native→connected resume will fail with "Pi process exited".
  //
  // FOLLOW-UP (tracked in .reviews/2026-05-29-connected-services-deep-qa-audit): a CI diff-check
  // that, when the managed installer is present, compares this encoder's output for a fixed set of
  // cwd fixtures against the live vendor's actual session directory layout. Until that exists, any
  // bump to @earendil-works/pi-coding-agent
  // should be manually verified by running `pi` in a test project and confirming the session
  // directory name matches what this encoder produces.
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

/** Validate native resume against the file's own identity when a header is available. */
export async function resolveExpectedPiSessionIdForResume(reference: string): Promise<string | null> {
  if (isAbsolute(reference) && await pathExistsAsFile(reference)) {
    const header = await readPiSessionHeader(reference);
    if (header) return header.id;
  }
  return resolvePiSessionIdFromResumeReference(reference);
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

export async function matchesPiSessionFileIdentity(
  path: string,
  sessionId: string,
  options: { requireHeader?: boolean } = {},
): Promise<boolean> {
  if (!isAbsolute(path) || !await pathExistsAsFile(path)) return false;
  const header = await readPiSessionHeader(path);
  if (header) return header.id === sessionId;
  return options.requireHeader !== true && doesPiSessionFileNameMatchSessionId(basename(path), sessionId);
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
      const header = await readPiSessionHeader(path);
      if (header && header.id !== params.sessionId) continue;
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

/**
 * THE single ordered, deduped set of directories where a Pi vendor session file for `cwd` may
 * live. Used by BOTH the connected-service reachability gate (`verifyResumeReachablePi`) and the
 * runtime metadata publisher (`resolvePiSessionFileForRuntimeSession`) so they cannot diverge.
 *
 * Order (first match wins): persisted-file dir → inherited/current `PI_CODING_AGENT_DIR/sessions`
 * (materialized home at runtime; native/empty at switch-gate time) → NATIVE `~/.pi/agent/sessions`
 * (the root the switch gate was structurally blind to — VG-8) → legacy `PI_CODING_AGENT_SESSION_DIR`
 * → connected-service materialized-home layouts (incl. one-release legacy `pi-sessions`).
 *
 * The native root is the load-bearing addition: for a native→connected switch, the vendor file
 * exists under `~/.pi/agent/sessions/--<cwd>--` and the switch path will import it before spawn, so
 * its presence there is valid resume-reachability proof (D8). Encoding matches the vendor exactly
 * via `formatPiSessionDirectoryForCwd` (see `encodePiSessionDirectoryCwd`).
 *
 * TARGET-STRICT mode (`targetStrict: true`): used by the post-materialization §2 spawn gate, which
 * must prove the EXACT final path Pi reads — `PI_CODING_AGENT_DIR/sessions/--<cwd>--` (this follows
 * the shared-state symlink into the native store). In strict mode the search set is EXACTLY that one
 * path: native `~/.pi`, legacy `PI_CODING_AGENT_SESSION_DIR`, and `pi-sessions`/`.local-*` staging are
 * all EXCLUDED so a file present only in a source/staging location cannot yield a false-positive
 * (CS-FINDING-6 / plan §2). The early continuity check leaves `targetStrict` unset to keep the broad
 * source-proof search above.
 */
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
