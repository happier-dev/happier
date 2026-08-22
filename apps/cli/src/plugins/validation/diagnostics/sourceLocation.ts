import { isAbsolute, relative, resolve, sep } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

/**
 * One author-actionable source location inside a plugin's local development
 * project, expressed relative to that project root with POSIX separators.
 *
 * A location is NEVER an absolute host path. The author's own project root is
 * the only frame of reference a diagnostic sink may publish, so an absolute
 * path is either rebased onto that root or dropped entirely. Callers outside
 * the local-development realm do not resolve a root at all and therefore get no
 * location — the ordinary redacted projection remains their only output.
 */
export type PluginDiagnosticSourceLocation = Readonly<{
  file: string;
  line?: number;
  column?: number;
}>;

/**
 * The file-only fallback has no trailing location marker to bound its path
 * token, so it stops at any character that cannot appear inside a bare
 * diagnostic path reference — whitespace included.
 */
const PATH_TOKEN_STOP = /["'`()[\]{};|<>,\s]/u;

/** `path:LINE:COLUMN` (Node stacks, esbuild) or `path(LINE,COLUMN)` (TypeScript). */
const SOURCE_LOCATION_SUFFIX = /^([^"'`()[\]{};|<>\r\n]*?)(?::(\d+):(\d+)|\((\d+),(\d+)\))/u;

/** A path token only counts as a source file when it carries a file extension. */
const SOURCE_FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/u;

function toForwardSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

/** The comparison form of an author project root: absolute, forward-slashed, unterminated. */
export function normalizePluginDiagnosticSourceRoot(sourceRoot: string): string {
  const normalized = toForwardSlashes(resolve(sourceRoot)).replace(/\/+$/u, '');
  return normalized || '/';
}

/**
 * Containment is decided by the repository's canonical path owner, which is the
 * only implementation that gets sibling-prefix collisions (`…/plugin` versus
 * `…/plugin2`), case identity, and cross-platform roots right. `relative` is
 * used only to render the contained path, never to decide containment.
 */
function toContainedRelativeFile(sourceRoot: string, absolutePath: string): string | null {
  if (!isCanonicalAbsolutePathInsideRoot(sourceRoot, absolutePath)) return null;
  const relativePath = relative(sourceRoot, absolutePath);
  if (relativePath.length === 0 || isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join('/');
}

function toSafeLineNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readLocatedSuffix(rest: string): Readonly<{
  path: string;
  line: number;
  column: number;
}> | null {
  const match = rest.match(SOURCE_LOCATION_SUFFIX);
  if (!match) return null;
  const path = match[1] ?? '';
  const line = toSafeLineNumber(match[2] ?? match[4]);
  const column = toSafeLineNumber(match[3] ?? match[5]);
  if (line === null || column === null || line === 0) return null;
  return { path, line, column };
}

function readPathToken(rest: string, stop: RegExp): string {
  const stopIndex = rest.search(stop);
  const token = stopIndex < 0 ? rest : rest.slice(0, stopIndex);
  return token.replace(/[:.,]+$/u, '');
}

type RootOccurrence = Readonly<{ rest: string }>;

/** Every place `normalizedRoot` is named as a real path prefix inside one text. */
function* readRootOccurrences(text: string, normalizedRoot: string): Generator<RootOccurrence> {
  let index = text.indexOf(normalizedRoot);
  while (index >= 0) {
    const after = text[index + normalizedRoot.length];
    if (after === '/' || after === ':') {
      yield { rest: text.slice(index + normalizedRoot.length) };
    }
    index = text.indexOf(normalizedRoot, index + 1);
  }
}

/**
 * A relative candidate must be the whole leading token of its line and must
 * itself be relative. Whitespace disqualifies it: a stack frame such as
 * `at /elsewhere/file.ts:7:19` would otherwise be re-rooted into the author's
 * project and published as a location that does not exist there. A compiler
 * path containing a space is given up rather than risk that disclosure — the
 * absolute pass above still resolves it whenever the root is named.
 */
function isProjectRelativeSourcePath(path: string): boolean {
  return path.length > 0
    && !/\s/u.test(path)
    && !path.startsWith('/')
    && !/^[A-Za-z]:\//u.test(path);
}

function resolveContainedLocation(params: Readonly<{
  sourceRoot: string;
  normalizedRoot: string;
  path: string;
  line?: number;
  column?: number;
}>): PluginDiagnosticSourceLocation | null {
  const trimmed = params.path.trim();
  if (!trimmed || !SOURCE_FILE_EXTENSION.test(trimmed)) return null;
  const absolute = trimmed.startsWith('/')
    ? resolve(`${params.normalizedRoot}${trimmed}`)
    : resolve(params.sourceRoot, trimmed);
  const file = toContainedRelativeFile(params.sourceRoot, absolute);
  if (!file) return null;
  return Object.freeze({
    file,
    ...(params.line === undefined ? {} : { line: params.line }),
    ...(params.column === undefined ? {} : { column: params.column }),
  });
}

/**
 * Read the first author-actionable source location named by diagnostic text.
 *
 * `texts` are searched in caller-supplied priority order (an error message
 * before its stack, compiler stderr before stdout). Within that order the most
 * actionable answer wins: an absolute path under the author root carrying a
 * line and column, then a line-anchored relative path carrying a line and
 * column (how `tsc` and the Plugin UI builder report from the project cwd),
 * then a bare absolute file under the root — the shape a missing-module failure
 * produces, which names the importer but no position.
 *
 * A relative candidate is only read at the start of a line so a path fragment
 * embedded in an unrelated absolute path can never be re-rooted into the
 * author's project and disclosed as if it belonged there.
 */
export function findPluginDiagnosticSourceLocation(params: Readonly<{
  texts: readonly (string | null | undefined)[];
  sourceRoot: string;
}>): PluginDiagnosticSourceLocation | null {
  try {
    const rootInput = params.sourceRoot.trim();
    if (!rootInput) return null;
    const sourceRoot = resolve(rootInput);
    const normalizedRoot = normalizePluginDiagnosticSourceRoot(sourceRoot);
    const normalizedTexts = params.texts
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .map(toForwardSlashes);

    for (const text of normalizedTexts) {
      for (const { rest } of readRootOccurrences(text, normalizedRoot)) {
        const located = readLocatedSuffix(rest);
        if (!located) continue;
        const location = resolveContainedLocation({
          sourceRoot,
          normalizedRoot,
          path: located.path,
          line: located.line,
          column: located.column,
        });
        if (location) return location;
      }
    }

    for (const text of normalizedTexts) {
      for (const line of text.split('\n')) {
        const rest = line.replace(/^\s+/u, '');
        if (!rest) continue;
        const located = readLocatedSuffix(rest);
        if (!located || !isProjectRelativeSourcePath(located.path)) continue;
        const location = resolveContainedLocation({
          sourceRoot,
          normalizedRoot,
          path: located.path,
          line: located.line,
          column: located.column,
        });
        if (location) return location;
      }
    }

    for (const text of normalizedTexts) {
      for (const { rest } of readRootOccurrences(text, normalizedRoot)) {
        const location = resolveContainedLocation({
          sourceRoot,
          normalizedRoot,
          path: readPathToken(rest, PATH_TOKEN_STOP),
        });
        if (location) return location;
      }
    }
  } catch {
    // A malformed root or path is never worth failing a diagnostic over.
  }
  return null;
}

/** The one author-facing rendering of a source location: `file`, `file:line`, `file:line:column`. */
export function formatPluginDiagnosticSourceLocation(
  location: PluginDiagnosticSourceLocation,
): string {
  if (location.line === undefined) return location.file;
  if (location.column === undefined) return `${location.file}:${location.line}`;
  return `${location.file}:${location.line}:${location.column}`;
}

/**
 * Lead diagnostic text with its location.
 *
 * Used at every seam that carries text but no structure — the daemon change
 * contract's single failure message, the protocol diagnostic record, the
 * `[PLUGIN RUNTIME]` log — so an author still reads the file and line first.
 * Seams that keep the structured `source` render it separately instead and do
 * not call this.
 */
export function prefixPluginDiagnosticSourceLocation(
  location: PluginDiagnosticSourceLocation | null | undefined,
  text: string,
): string {
  if (!location) return text;
  return `${formatPluginDiagnosticSourceLocation(location)}: ${text}`;
}
