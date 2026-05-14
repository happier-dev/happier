/**
 * Pure path-segment helpers for the browse path picker.
 *
 * Scope: SEGMENT PARSING ONLY. This module does not expand `~/` or format
 * paths for display — those belong to:
 *   - `apps/ui/sources/utils/path/pathUtils.ts` (`resolveAbsolutePath`)
 *   - `apps/ui/sources/utils/sessions/sessionUtils.ts` (`formatPathRelativeToHome`)
 *
 * Every public function accepts an optional `targetPlatform` hint. When
 * omitted (or `'auto'`), the helpers infer the platform from the input
 * string shape. Pass `'windows'` explicitly when the adapter is bound to a
 * remote machine of known platform (e.g. a Mac client browsing a Windows
 * host MUST pass `'windows'` — never use `navigator.platform`).
 *
 * Implementation note: Reimplemented from first principles. No third-party
 * code copied; the contract is the spec.
 */

/** Path-domain target platform. OWNED here, NOT exported by generic SelectionList types. */
export type PathTargetPlatform = 'unix' | 'windows' | 'auto';

// -- Internal detection helpers ------------------------------------------------

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]?/;
const UNC_RE = /^\\\\[^\\]+\\[^\\]+/;

function isWindowsDrivePath(value: string): boolean {
    return WINDOWS_DRIVE_RE.test(value);
}

function isUncPath(value: string): boolean {
    return UNC_RE.test(value);
}

function isWindowsAbsolutePath(value: string): boolean {
    return isWindowsDrivePath(value) || isUncPath(value);
}

/**
 * Infer whether to treat the input as Windows-shaped.
 *
 * Heuristics for `'auto'`:
 *   - Drive letter prefix (`C:`, `c:\`)
 *   - UNC prefix (`\\server\share`)
 *   - Contains a backslash anywhere
 */
function isWindowsShape(input: string, targetPlatform: PathTargetPlatform): boolean {
    if (targetPlatform === 'windows') return true;
    if (targetPlatform === 'unix') return false;
    if (isWindowsAbsolutePath(input)) return true;
    return input.includes('\\');
}

/** The set of separator characters considered active for the inferred platform. */
function separatorCharsFor(input: string, targetPlatform: PathTargetPlatform): ReadonlyArray<string> {
    return isWindowsShape(input, targetPlatform) ? ['\\', '/'] : ['/'];
}

function isSeparatorChar(ch: string, separators: ReadonlyArray<string>): boolean {
    return separators.includes(ch);
}

function lastSeparatorIndex(value: string, separators: ReadonlyArray<string>): number {
    let i = value.length - 1;
    while (i >= 0) {
        if (isSeparatorChar(value[i]!, separators)) return i;
        i -= 1;
    }
    return -1;
}

// -- Public API ----------------------------------------------------------------

/**
 * True when the input shape suggests the user is typing a path. Used as a
 * gate for path-style autocomplete suppression and section visibility.
 */
export function isBrowsePathLikeInput(input: string, targetPlatform: PathTargetPlatform = 'auto'): boolean {
    if (input.length === 0) return false;
    if (input.startsWith('/')) return true;
    if (input.startsWith('~/') || input.startsWith('~\\')) return true;
    if (input.startsWith('./') || input.startsWith('../')) return true;
    if (input.startsWith('.\\') || input.startsWith('..\\')) return true;
    if (isWindowsAbsolutePath(input)) return true;
    // Allow plain drive prefixes like `C:` — user is mid-typing.
    if (/^[a-zA-Z]:$/.test(input)) return true;
    // If targetPlatform is windows, accept lone backslash as path-like.
    if (targetPlatform === 'windows' && input.startsWith('\\')) return true;
    return false;
}

/**
 * Split `input` into `{ dir, leaf }` such that `dir + leaf === <canonicalised input>`.
 *
 * - `dir` always includes the trailing separator (or is empty when there is none).
 * - On Windows-shaped input we canonicalise mixed separators in the directory
 *   portion to the preferred separator (`\\`). The leaf is never modified.
 */
export function splitInputIntoDirectoryAndLeaf(
    input: string,
    targetPlatform: PathTargetPlatform = 'auto',
): { dir: string; leaf: string } {
    if (input.length === 0) return { dir: '', leaf: '' };

    const separators = separatorCharsFor(input, targetPlatform);
    const idx = lastSeparatorIndex(input, separators);

    if (idx < 0) return { dir: '', leaf: input };

    const rawDir = input.slice(0, idx + 1);
    const leaf = input.slice(idx + 1);

    const preferred = preferredSeparatorFor(input, targetPlatform);
    const dir = canonicaliseSeparators(rawDir, separators, preferred);

    return { dir, leaf };
}

/**
 * Walk up one path segment. Returns the parent directory with a trailing
 * separator, or `null` when the input is already at root (or empty).
 *
 * Roots that return `null`:
 *   - `''`
 *   - `'/'` (Unix)
 *   - `'C:\\'`, `'C:/'` (Windows drive)
 *   - `'\\\\server\\share'`, `'\\\\server\\share\\'` (UNC)
 *   - `'~/'` (display-shorthand "home")
 */
export function walkUpOneSegment(
    input: string,
    targetPlatform: PathTargetPlatform = 'auto',
): string | null {
    if (input.length === 0) return null;
    if (isAtRoot(input, targetPlatform)) return null;
    if (input === '~/' || input === '~\\') return null;

    const separators = separatorCharsFor(input, targetPlatform);

    // Strip a single trailing separator if present, then strip the trailing leaf.
    let value = input;
    const lastChar = value[value.length - 1]!;
    if (isSeparatorChar(lastChar, separators)) {
        value = value.slice(0, -1);
    }

    const idx = lastSeparatorIndex(value, separators);
    if (idx < 0) {
        // No separator found; collapsing fully — fall back to root for shorthand.
        return null;
    }

    const rawParent = value.slice(0, idx + 1);
    const preferred = preferredSeparatorFor(input, targetPlatform);
    return canonicaliseSeparators(rawParent, separators, preferred);
}

/**
 * Kind of entry being appended to a path. `'directory'` ensures the result
 * ends with a trailing separator so the input descends into the directory
 * (and the IN THIS FOLDER dynamic section re-fires with the new seed). For
 * files, no trailing separator is added — the path is complete.
 */
export type PathSegmentKind = 'directory' | 'file';

/**
 * Append `name` to `directoryPath` ensuring exactly one separator between
 * them. Preferred separator is derived from `directoryPath`'s shape (or the
 * explicit `targetPlatform`). Strips a leading separator from `name` to
 * avoid double separators.
 *
 * Bug 4b fix: when `kind === 'directory'`, the result MUST end with the
 * preferred separator so accepting a directory autocomplete in the path
 * picker descends into the directory (re-fires IN THIS FOLDER) instead of
 * leaving an ambiguous "stopped at the directory boundary" value. Files do
 * NOT get a trailing separator.
 *
 * If `directoryPath` does not end with a separator, the function uses the
 * leaf of `directoryPath` only as a typing prefix (e.g. `~/Doc` + `Documents`
 * → `~/Documents`). This is the autocomplete contract: the typed leaf is
 * REPLACED by `name`, not appended after.
 *
 * Edge cases:
 *   - Empty `directoryPath` returns `name` unchanged (no leading separator
 *     is fabricated; the caller controls absoluteness). When kind is
 *     `'directory'`, a trailing separator is still appended.
 */
export function appendSegment(
    directoryPath: string,
    name: string,
    targetPlatform: PathTargetPlatform = 'auto',
    kind?: PathSegmentKind,
): string {
    const separators = separatorCharsFor(directoryPath, targetPlatform);
    const preferred = preferredSeparatorFor(directoryPath, targetPlatform);

    // Strip a single leading separator from name so we never double up.
    let cleanedName = name;
    if (cleanedName.length > 0 && isSeparatorChar(cleanedName[0]!, separators)) {
        cleanedName = cleanedName.slice(1);
    }

    let joined: string;
    if (directoryPath.length === 0) {
        joined = cleanedName;
    } else {
        const dirEndsWithSep = isSeparatorChar(
            directoryPath[directoryPath.length - 1]!,
            separators,
        );
        if (dirEndsWithSep) {
            joined = directoryPath + cleanedName;
        } else {
            joined = directoryPath + preferred + cleanedName;
        }
    }

    if (kind === 'directory') {
        // Ensure trailing separator so the path descends into the directory.
        if (joined.length === 0 || !isSeparatorChar(joined[joined.length - 1]!, separators)) {
            return joined + preferred;
        }
    }
    return joined;
}

/**
 * Last non-empty segment of `path`. Used to title a project from its path.
 *
 * Derives the separator set purely from string shape — no `targetPlatform`
 * parameter (the caller typically does not know the source machine when
 * inferring a project title from a previously-saved absolute path).
 */
export function inferProjectTitleFromPath(path: string): string {
    if (path.length === 0) return '';
    // Use both separator chars if the string contains any backslash; else unix only.
    const separators = path.includes('\\') ? ['\\', '/'] : ['/'];
    const segments = path.split(new RegExp(`[${separators.map(escapeForRegex).join('')}]+`));
    for (let i = segments.length - 1; i >= 0; i -= 1) {
        const seg = segments[i]!;
        if (seg.length === 0) continue;
        // Skip drive letter / UNC server segments at the head of the path
        // when they are the only thing left.
        if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return '';
        return seg;
    }
    return '';
}

/** Preferred separator: `'\\'` for Windows-shaped input/target, `'/'` otherwise. */
export function preferredSeparatorFor(
    input: string,
    targetPlatform: PathTargetPlatform = 'auto',
): '/' | '\\' {
    return isWindowsShape(input, targetPlatform) ? '\\' : '/';
}

/** True when input ends with an active separator character. */
export function hasTrailingSeparator(
    input: string,
    targetPlatform: PathTargetPlatform = 'auto',
): boolean {
    if (input.length === 0) return false;
    const separators = separatorCharsFor(input, targetPlatform);
    return isSeparatorChar(input[input.length - 1]!, separators);
}

/**
 * True when input represents a path that has no parent to walk up to.
 *
 * Roots:
 *   - `'/'` (Unix)
 *   - `'C:\\'`, `'C:/'`, `'C:'` followed by single sep (Windows drive)
 *   - `'\\\\server\\share'` and `'\\\\server\\share\\'` (UNC)
 */
export function isAtRoot(input: string, targetPlatform: PathTargetPlatform = 'auto'): boolean {
    if (input.length === 0) return false;

    if (targetPlatform !== 'windows') {
        if (input === '/') return true;
    }

    if (targetPlatform !== 'unix') {
        // Windows drive root: `C:\`, `c:/`
        if (/^[a-zA-Z]:[\\/]$/.test(input)) return true;
        // UNC root: \\server\share or \\server\share\
        if (/^\\\\[^\\/]+\\[^\\/]+\\?$/.test(input)) return true;
    }

    return false;
}

// -- Internal helpers ----------------------------------------------------------

function canonicaliseSeparators(
    value: string,
    separators: ReadonlyArray<string>,
    preferred: '/' | '\\',
): string {
    if (separators.length <= 1) return value;
    // Replace any non-preferred separator with the preferred one.
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i]!;
        if (isSeparatorChar(ch, separators) && ch !== preferred) {
            out += preferred;
        } else {
            out += ch;
        }
    }
    return out;
}

function escapeForRegex(ch: string): string {
    return ch.replace(/[\\\]\-]/g, '\\$&');
}
