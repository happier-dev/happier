import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter as pathDelimiter, join, win32 } from 'node:path';

import { resolveWindowsCommandOnPath } from '../process/windows/resolveWindowsCommandInvocation.js';
import { buildServicePath } from '../service/path.js';
import { readHappierCliChoiceSync } from './happierCliChoice.js';

/**
 * PATH exposure for the managed Happier CLI, with provenance.
 *
 * The policy is a transcription of `apps/website/public/install.sh` (`append_path_hint`) and
 * `install.ps1` (user PATH update) so that Desktop and the shell installers deduplicate against
 * the same exact line / entry. Desktop marks only what it created and removes only that.
 * PATH exposure never gates readiness: every failure is returned as a message, never thrown.
 */

export interface HappierCliPathExposureResult {
  changed: boolean;
  shellReloadHint: string | null;
  failure: string | null;
  /**
   * Another `happier` resolves on PATH (or, after "Keep my own", the CLI this computer chose).
   * Without a recorded choice nothing was added: putting the managed CLI in front of it would
   * silently change which CLI the user's terminal runs. After "Let Happier manage it" the line is
   * written anyway and this names the old copy the user may remove (R12). `null` when nothing else
   * resolves (or what resolves is the managed shim itself).
   */
  existingCommand: string | null;
}

export interface HappierCliPathRemovalResult {
  removed: boolean;
  failure: string | null;
}

export const HAPPIER_DESKTOP_PATH_MARKER_LINE = '# Added by Happier Desktop';

/** User-scoped environment variable holding the PATH entries Desktop added on Windows. */
export const HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE = 'HAPPIER_DESKTOP_PATH_ENTRIES';

/**
 * User-scoped environment variable holding the moves Desktop made in the user PATH on Windows
 * (R13 b): one record per moved entry, `;`-separated, each `<entry>|<entry it was moved ahead of>|…`.
 * `|` cannot occur in a Windows path, and `;` cannot occur in a PATH entry.
 */
export const HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE = 'HAPPIER_DESKTOP_PATH_MOVES';

const DESKTOP_EXPORT_LINE_PATTERN = /^export PATH="[^"\n]+:\$PATH"$/u;

export function renderHappierCliPathExportLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH"`;
}

export function resolveHappierCliShellProfilePlan(params: Readonly<{
  shell: string | undefined;
  homeDir: string;
  fileExists: (path: string) => boolean;
}>): Readonly<{ rcFiles: readonly string[]; reloadFile: string }> {
  const shellName = basename(String(params.shell ?? '').trim());
  const home = params.homeDir;
  if (shellName === 'zsh') {
    return { rcFiles: [join(home, '.zshrc'), join(home, '.zprofile')], reloadFile: join(home, '.zshrc') };
  }
  if (shellName === 'bash') {
    const bashProfile = join(home, '.bash_profile');
    return {
      rcFiles: [join(home, '.bashrc'), params.fileExists(bashProfile) ? bashProfile : join(home, '.profile')],
      reloadFile: join(home, '.bashrc'),
    };
  }
  return { rcFiles: [join(home, '.profile')], reloadFile: join(home, '.profile') };
}

/**
 * Every profile file the table above can target, for any supported shell.
 *
 * `ensure` writes for the shell the user runs today; `remove` must undo what Desktop wrote under
 * whatever shell was current then, so it works over this union instead. `fileExists: () => true`
 * yields the maximal set (`.bash_profile` and `.profile` both appear); removal skips files that
 * are absent, so no probe is needed here.
 */
function resolveHappierCliShellProfileUnion(homeDir: string): readonly string[] {
  const files = new Set<string>();
  for (const shell of ['zsh', 'bash', '']) {
    for (const rcFile of resolveHappierCliShellProfilePlan({ shell, homeDir, fileExists: () => true }).rcFiles) {
      files.add(rcFile);
    }
  }
  return [...files];
}

function isPathUpdateDisabled(processEnv: NodeJS.ProcessEnv): boolean {
  return String(processEnv.HAPPIER_NO_PATH_UPDATE ?? '').trim() === '1';
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

export async function ensureHappierCliPathExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathExposureResult> {
  if (isPathUpdateDisabled(params.processEnv)) {
    return { changed: false, shellReloadHint: null, failure: null, existingCommand: null };
  }
  const choice = readHappierCliChoiceSync({ processEnv: params.processEnv });
  if (choice?.mode === 'own') {
    // R12 "Keep my own": the terminal keeps the user's CLI, so no line puts ours in front of it.
    return { changed: false, shellReloadHint: null, failure: null, existingCommand: choice.command };
  }
  const resolved = resolveHappierOnPath(params.processEnv);
  const existingCommand = resolved && !isManagedShim(resolved, params.binDir) ? resolved : null;
  if (resolved && !existingCommand) {
    // Already the managed shim (for example the installer's `~/.local/bin/happier` link to it):
    // there is nothing to expose, and a second export line would only duplicate it.
    return { changed: false, shellReloadHint: null, failure: null, existingCommand: null };
  }
  if (existingCommand && choice?.mode !== 'managed') {
    return { changed: false, shellReloadHint: null, failure: null, existingCommand };
  }
  // No other `happier`, or this computer chose "Let Happier manage it" (R12 amends INV5): the line
  // is written even though another CLI resolves, so a new terminal runs the managed CLI first.
  const exposed = process.platform === 'win32'
    ? await ensureWindowsUserPathExposure({ ...params, putFirst: existingCommand !== null })
    : await ensurePosixProfileExposure(params);
  return { ...exposed, existingCommand };
}

/**
 * A `happier` on PATH that is not this Happier home's managed shim — one the user installed
 * (npm, Homebrew, a manual copy) — or `null` when every `happier` found is the managed shim
 * (including the installer's `~/.local/bin` link to it). The same search path the PATH exposure
 * above uses, walked past the managed shim (R13 b): after "Let Happier manage it" the managed shim
 * answers first, and the old copy the person may still remove sits behind it. So "another CLI
 * exists" means one thing everywhere — the question, the resolver and Settings (R12).
 */
export function resolveForeignHappierCli(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  return resolveHappierOnPath(params.processEnv, (candidate) => !isManagedShim(candidate, params.binDir));
}

/**
 * The `happier` a new terminal runs first, as opposed to every other copy on the search path
 * (`resolveForeignHappierCli`, which feeds Settings): the R12 question is about this one, because
 * only it is what the person's terminal actually runs (RV3-1). `managed` when it is this Happier
 * home's managed CLI; `desktopExposed` when it got there through what Desktop wrote and "Keep my
 * own" takes back (`removeHappierCliPathExposure`) — the managed bin dir itself on POSIX (the
 * shell installer exposes `~/.local/bin` instead), and on Windows that dir only while Desktop's
 * records (`HAPPIER_DESKTOP_PATH_ENTRIES` / `_MOVES`, user-scoped, so in a launched app's env) name
 * it. A managed CLI first by any other route (the installer's link or entry) keeps answering first
 * whatever the person keeps.
 */
export type TerminalHappierCli = Readonly<{ command: string; managed: boolean; desktopExposed: boolean }>;

export function resolveTerminalHappierCli(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): TerminalHappierCli | null {
  const command = resolveHappierOnPath(params.processEnv);
  if (!command) return null;
  if (!isManagedShim(command, params.binDir)) return { command, managed: false, desktopExposed: false };
  const shimPath = join(params.binDir, process.platform === 'win32' ? 'happier.exe' : 'happier');
  const direct = process.platform === 'win32' ? sameWindowsPathEntry(command, shimPath) : command === shimPath;
  const recordedByDesktop = process.platform !== 'win32' || [
    ...splitWindowsPathEntries(readEnvCaseInsensitive(params.processEnv, HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE)),
    ...parseWindowsPathMoves(readEnvCaseInsensitive(params.processEnv, HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE)).map((move) => move.entry),
  ].some((entry) => sameWindowsPathEntry(entry, params.binDir));
  return { command, managed: true, desktopExposed: direct && recordedByDesktop };
}

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | null {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' ? value : null;
}

function isManagedShim(candidate: string, binDir: string): boolean {
  return isSameFile(candidate, join(binDir, process.platform === 'win32' ? 'happier.exe' : 'happier'));
}

/**
 * The `happier` a new terminal would run, or `null` when none resolves.
 *
 * On macOS an app opened from the Dock or Finder gets launchd's PATH (`/usr/bin:/bin:…`), which
 * leaves out Homebrew, the npm-global default and the per-user bins where a user's own `happier`
 * lives. The search there is the service PATH owner's (`buildServicePath`: this PATH, then the
 * per-user bins, then its fixed macOS list). A version manager's shim directory (nvm, fnm, volta)
 * is only on the login shell's PATH and is not detected (INV5). `accept` skips matches, so a caller
 * looking for a particular kind of `happier` gets the first one of that kind.
 */
function resolveHappierOnPath(
  processEnv: NodeJS.ProcessEnv,
  accept: (candidate: string) => boolean = () => true,
): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath('happier', processEnv, accept);
  }
  for (const dir of resolveHappierCliSearchPath(processEnv).split(pathDelimiter)) {
    if (!dir.trim()) continue;
    const candidate = join(dir, 'happier');
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile() && accept(candidate)) return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

/**
 * The PATH a new terminal's `happier` is looked up in, as above: the process PATH, extended on
 * macOS by the service PATH owner's list because a Dock-launched app gets launchd's PATH. A CLI
 * found here is also run with it (R12): an npm `happier` is `#!/usr/bin/env node`, and the `node`
 * beside it (Homebrew, `/usr/local/bin`) is only on that same list.
 */
export function resolveHappierCliSearchPath(processEnv: NodeJS.ProcessEnv): string {
  return process.platform === 'darwin'
    ? buildServicePath({ basePath: String(processEnv.PATH ?? ''), homeDir: resolvePosixHomeDir(processEnv), platform: 'darwin' })
    : String(processEnv.PATH ?? '');
}

function isSameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export async function removeHappierCliPathExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  /** Remove only this installation's exposure; omitted for the existing remove-all action. */
  binDir?: string;
}>): Promise<HappierCliPathRemovalResult> {
  if (process.platform === 'win32') {
    return await removeWindowsUserPathExposure(params);
  }
  return await removePosixProfileExposure(params);
}

// POSIX: shell profiles ------------------------------------------------------------------------

function resolvePosixHomeDir(processEnv: NodeJS.ProcessEnv): string {
  return String(processEnv.HOME ?? '').trim() || homedir();
}

function resolvePosixProfilePlan(processEnv: NodeJS.ProcessEnv) {
  // A desktop app launched from a launcher may not inherit $SHELL; the login shell is the same
  // fact `$SHELL` carries in a terminal, so it is the equivalent input for the installer's table.
  const shell = String(processEnv.SHELL ?? '').trim() || readLoginShell();
  return resolveHappierCliShellProfilePlan({ shell, homeDir: resolvePosixHomeDir(processEnv), fileExists: existsSync });
}

function readLoginShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function profileContainsLine(content: string, line: string): boolean {
  return content.split('\n').some((candidate) => candidate.trim() === line);
}

async function ensurePosixProfileExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathExposureResult> {
  const plan = resolvePosixProfilePlan(params.processEnv);
  const exportLine = renderHappierCliPathExportLine(params.binDir);
  let changed = false;
  const failures: string[] = [];

  for (const rcFile of plan.rcFiles) {
    try {
      const existing = existsSync(rcFile) ? await readFile(rcFile, 'utf8') : null;
      if (existing !== null && profileContainsLine(existing, exportLine)) {
        continue;
      }
      // Same shape as the installer's `printf '\n%s\n'`, with the provenance marker directly above.
      await appendFile(rcFile, `\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${exportLine}\n`, 'utf8');
      changed = true;
    } catch (error) {
      failures.push(`${rcFile}: ${describeError(error)}`);
    }
  }

  return {
    changed,
    shellReloadHint: changed ? `Open a new terminal, or run: source "${plan.reloadFile}"` : null,
    failure: failures.length > 0 ? `Could not update shell profile ${failures.join('; ')}` : null,
    existingCommand: null,
  };
}

function stripDesktopCreatedLines(content: string, binDir?: string): Readonly<{ content: string; removed: boolean }> {
  const lines = content.split('\n');
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const next = lines[index + 1];
    if (line.trim() === HAPPIER_DESKTOP_PATH_MARKER_LINE && next !== undefined
      && DESKTOP_EXPORT_LINE_PATTERN.test(next.trim())
      && (binDir === undefined || next.trim() === renderHappierCliPathExportLine(binDir))) {
      if (kept.length > 0 && kept[kept.length - 1] === '') {
        // Drop the separator blank line the append wrote in front of the marker.
        kept.pop();
      }
      index += 1;
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return { content: removed ? kept.join('\n') : content, removed };
}

async function removePosixProfileExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  binDir?: string;
}>): Promise<HappierCliPathRemovalResult> {
  let removed = false;
  const failures: string[] = [];

  for (const rcFile of resolveHappierCliShellProfileUnion(resolvePosixHomeDir(params.processEnv))) {
    try {
      if (!existsSync(rcFile)) {
        continue;
      }
      const stripped = stripDesktopCreatedLines(await readFile(rcFile, 'utf8'), params.binDir);
      if (!stripped.removed) {
        continue;
      }
      await writeFile(rcFile, stripped.content, 'utf8');
      removed = true;
    } catch (error) {
      failures.push(`${rcFile}: ${describeError(error)}`);
    }
  }

  return {
    removed,
    failure: failures.length > 0 ? `Could not update shell profile ${failures.join('; ')}` : null,
  };
}

// Windows: user PATH in the environment (HKCU\Environment) --------------------------------------

function splitWindowsPathEntries(value: string | null): string[] {
  return String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean);
}

function sameWindowsPathEntry(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

type WindowsPathMove = Readonly<{ entry: string; movedAhead: readonly string[] }>;

function parseWindowsPathMoves(value: string | null): WindowsPathMove[] {
  return splitWindowsPathEntries(value).flatMap((record) => {
    const [entry, ...movedAhead] = record.split('|').map((part) => part.trim());
    return entry ? [{ entry, movedAhead: movedAhead.filter(Boolean) }] : [];
  });
}

function renderWindowsPathMoves(moves: readonly WindowsPathMove[]): string | null {
  return moves.length > 0 ? moves.map((move) => [move.entry, ...move.movedAhead].join('|')).join(';') : null;
}

export function planWindowsUserPathExposure(params: Readonly<{
  userPath: string | null;
  provenance: string | null;
  moves: string | null;
  binDir: string;
  /**
   * R12 "Let Happier manage it": the managed dir must come before any other `happier` (an npm
   * global dir), so an entry already present further back is moved to the front — moved, never
   * duplicated, and its provenance unchanged. The move itself is recorded (R13 b), so "Keep my own"
   * can put the entry back where it was.
   */
  putFirst?: boolean;
}>): Readonly<{ changed: boolean; userPath: string; provenance: string | null; moves: string | null }> {
  const currentPath = params.userPath ?? '';
  const entries = splitWindowsPathEntries(currentPath);
  const index = entries.findIndex((entry) => sameWindowsPathEntry(entry, params.binDir));
  const existing = entries[index];
  if (existing !== undefined) {
    if (!params.putFirst || index === 0) {
      return { changed: false, userPath: currentPath, provenance: params.provenance, moves: params.moves };
    }
    const move: WindowsPathMove = { entry: existing, movedAhead: entries.slice(0, index) };
    return {
      changed: true,
      userPath: [existing, ...entries.filter((_, entryIndex) => entryIndex !== index)].join(';'),
      provenance: params.provenance,
      moves: renderWindowsPathMoves([
        ...parseWindowsPathMoves(params.moves).filter((recorded) => !sameWindowsPathEntry(recorded.entry, existing)),
        move,
      ]),
    };
  }
  const provenanceEntries = splitWindowsPathEntries(params.provenance);
  return {
    changed: true,
    userPath: [params.binDir, ...entries].join(';'),
    provenance: [...provenanceEntries, params.binDir].join(';'),
    moves: params.moves,
  };
}

/**
 * Undo what Desktop changed in the user PATH, and only that: the entries it added are removed, and
 * an entry it moved is put back behind the entries it was moved ahead of — only while that move
 * still holds (the entry is still ahead of every one of them that is still there). Anything the
 * person changed since — an entry they added, or putting ours back themselves — is left as it is.
 * Selected records are cleared: what no longer applies is not Desktop's to undo later.
 */
export function planWindowsUserPathRemoval(params: Readonly<{
  userPath: string | null;
  provenance: string | null;
  moves: string | null;
  binDir?: string;
}>): Readonly<{ removed: boolean; userPath: string; provenance: string | null; moves: string | null }> {
  const currentPath = params.userPath ?? '';
  const selected = (entry: string) => params.binDir === undefined || sameWindowsPathEntry(entry, params.binDir);
  const desktopCreated = splitWindowsPathEntries(params.provenance).filter(selected);
  // Filter the raw records so unrelated provenance, including its formatting, stays untouched.
  const provenance = params.provenance?.split(';').filter((entry) => !selected(entry.trim())).join(';') || null;
  const moves = params.moves?.split(';').filter((record) => !selected(record.split('|')[0]?.trim() ?? '')).join(';') || null;
  let entries = splitWindowsPathEntries(currentPath)
    .filter((entry) => !desktopCreated.some((created) => sameWindowsPathEntry(created, entry)));
  let removed = desktopCreated.length > 0;
  for (const move of parseWindowsPathMoves(params.moves).filter((move) => selected(move.entry))) {
    const index = entries.findIndex((entry) => sameWindowsPathEntry(entry, move.entry));
    const aheadIndexes = move.movedAhead
      .map((ahead) => entries.findIndex((entry) => sameWindowsPathEntry(entry, ahead)))
      .filter((aheadIndex) => aheadIndex >= 0);
    if (index < 0 || aheadIndexes.length === 0 || aheadIndexes.some((aheadIndex) => aheadIndex < index)) {
      continue;
    }
    const lastAhead = Math.max(...aheadIndexes);
    const moved = entries[index] ?? move.entry;
    entries = [...entries.slice(0, index), ...entries.slice(index + 1, lastAhead + 1), moved, ...entries.slice(lastAhead + 1)];
    removed = true;
  }
  if (!removed) {
    return { removed: false, userPath: currentPath, provenance, moves };
  }
  return { removed: true, userPath: entries.join(';'), provenance, moves };
}

type WindowsUserEnvironmentSnapshot = Readonly<{
  userPath: string | null;
  userPathKind: 'String' | 'ExpandString';
  provenance: string | null;
  moves: string | null;
}>;

/**
 * Names of the environment variables the PowerShell scripts read their inputs from.
 *
 * The values travel through the child environment, never as argv: `powershell.exe -Command` folds
 * every argument after the script into the command text it parses, and a user `Path` contains `;`
 * — PowerShell's statement separator — so passing it positionally truncates the value and then
 * evaluates the rest as code.
 */
const WINDOWS_SCRIPT_ENV = {
  provenanceName: 'HAPPIER_PATH_PROVENANCE_NAME',
  userPath: 'HAPPIER_PATH_USER_PATH',
  valueKind: 'HAPPIER_PATH_VALUE_KIND',
  provenanceValue: 'HAPPIER_PATH_PROVENANCE_VALUE',
  movesName: 'HAPPIER_PATH_MOVES_NAME',
  movesValue: 'HAPPIER_PATH_MOVES_VALUE',
} as const;

const WINDOWS_READ_USER_ENVIRONMENT_SCRIPT = [
  '& {',
  `$ProvenanceName = $env:${WINDOWS_SCRIPT_ENV.provenanceName}`,
  `$MovesName = $env:${WINDOWS_SCRIPT_ENV.movesName}`,
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  '$userPath = $null',
  "$kind = 'ExpandString'",
  '$provenance = $null',
  '$moves = $null',
  'if ($key) {',
  "  $userPath = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if ($null -ne $userPath -and ($key.GetValueNames() -contains 'Path')) { $kind = $key.GetValueKind('Path').ToString() }",
  '  $provenance = $key.GetValue($ProvenanceName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
  '  $moves = $key.GetValue($MovesName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
  '  $key.Close()',
  '}',
  '[pscustomobject]@{ userPath = $userPath; userPathKind = $kind; provenance = $provenance; moves = $moves } | ConvertTo-Json -Compress',
  '}',
].join('\n');

// Writes Path with its existing registry kind (so %VAR% entries keep expanding), then writes the
// provenance variable through [Environment], whose user-scope write broadcasts WM_SETTINGCHANGE so
// new terminals see both values.
const WINDOWS_WRITE_USER_ENVIRONMENT_SCRIPT = [
  '& {',
  `$UserPath = $env:${WINDOWS_SCRIPT_ENV.userPath}`,
  `$Kind = $env:${WINDOWS_SCRIPT_ENV.valueKind}`,
  `$ProvenanceName = $env:${WINDOWS_SCRIPT_ENV.provenanceName}`,
  `$Provenance = $env:${WINDOWS_SCRIPT_ENV.provenanceValue}`,
  `$MovesName = $env:${WINDOWS_SCRIPT_ENV.movesName}`,
  `$Moves = $env:${WINDOWS_SCRIPT_ENV.movesValue}`,
  // Refuse to write rather than clear the user PATH if the value did not arrive.
  `if (-not $UserPath) { throw '${WINDOWS_SCRIPT_ENV.userPath} is not set.' }`,
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
  "$valueKind = if ($Kind -eq 'String') { [Microsoft.Win32.RegistryValueKind]::String } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
  "$key.SetValue('Path', $UserPath, $valueKind)",
  '$key.Close()',
  "if ($Provenance) { [Environment]::SetEnvironmentVariable($ProvenanceName, $Provenance, [EnvironmentVariableTarget]::User) }",
  "else { [Environment]::SetEnvironmentVariable($ProvenanceName, $null, [EnvironmentVariableTarget]::User) }",
  "if ($Moves) { [Environment]::SetEnvironmentVariable($MovesName, $Moves, [EnvironmentVariableTarget]::User) }",
  "else { [Environment]::SetEnvironmentVariable($MovesName, $null, [EnvironmentVariableTarget]::User) }",
  '}',
].join('\n');

function parseWindowsUserEnvironmentSnapshot(stdout: string): WindowsUserEnvironmentSnapshot {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unexpected user environment snapshot shape.');
  }
  const record = parsed as Record<string, unknown>;
  return {
    userPath: typeof record.userPath === 'string' ? record.userPath : null,
    userPathKind: record.userPathKind === 'String' ? 'String' : 'ExpandString',
    provenance: typeof record.provenance === 'string' && record.provenance.trim() ? record.provenance : null,
    moves: typeof record.moves === 'string' && record.moves.trim() ? record.moves : null,
  };
}

function resolveWindowsPowerShellPath(processEnv: NodeJS.ProcessEnv): string {
  const systemRoot = String(processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? processEnv.windir ?? processEnv.WINDIR ?? '').trim();
  if (!systemRoot) {
    throw new Error('SystemRoot is unavailable; cannot locate powershell.exe.');
  }
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runWindowsPowerShell(
  processEnv: NodeJS.ProcessEnv,
  script: string,
  scriptEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const powershell = resolveWindowsPowerShellPath(processEnv);
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      // The script is the last token on purpose — see WINDOWS_SCRIPT_ENV.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, env: { ...processEnv, ...scriptEnv } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`powershell.exe failed: ${String(stderr).trim() || error.message}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function readWindowsUserEnvironment(processEnv: NodeJS.ProcessEnv): Promise<WindowsUserEnvironmentSnapshot> {
  const stdout = await runWindowsPowerShell(processEnv, WINDOWS_READ_USER_ENVIRONMENT_SCRIPT, {
    [WINDOWS_SCRIPT_ENV.provenanceName]: HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
    [WINDOWS_SCRIPT_ENV.movesName]: HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE,
  });
  return parseWindowsUserEnvironmentSnapshot(stdout);
}

async function writeWindowsUserEnvironment(processEnv: NodeJS.ProcessEnv, value: Readonly<{
  userPath: string;
  userPathKind: WindowsUserEnvironmentSnapshot['userPathKind'];
  provenance: string | null;
  moves: string | null;
}>): Promise<void> {
  await runWindowsPowerShell(processEnv, WINDOWS_WRITE_USER_ENVIRONMENT_SCRIPT, {
    [WINDOWS_SCRIPT_ENV.userPath]: value.userPath,
    [WINDOWS_SCRIPT_ENV.valueKind]: value.userPathKind,
    [WINDOWS_SCRIPT_ENV.provenanceName]: HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
    [WINDOWS_SCRIPT_ENV.provenanceValue]: value.provenance ?? '',
    [WINDOWS_SCRIPT_ENV.movesName]: HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE,
    [WINDOWS_SCRIPT_ENV.movesValue]: value.moves ?? '',
  });
}

async function ensureWindowsUserPathExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
  putFirst: boolean;
}>): Promise<HappierCliPathExposureResult> {
  try {
    const snapshot = await readWindowsUserEnvironment(params.processEnv);
    const planned = planWindowsUserPathExposure({
      userPath: snapshot.userPath,
      provenance: snapshot.provenance,
      moves: snapshot.moves,
      binDir: params.binDir,
      putFirst: params.putFirst,
    });
    if (!planned.changed) {
      return { changed: false, shellReloadHint: null, failure: null, existingCommand: null };
    }
    await writeWindowsUserEnvironment(params.processEnv, {
      userPath: planned.userPath,
      userPathKind: snapshot.userPathKind,
      provenance: planned.provenance,
      moves: planned.moves,
    });
    return { changed: true, shellReloadHint: 'Open a new terminal to use happier.', failure: null, existingCommand: null };
  } catch (error) {
    return { changed: false, shellReloadHint: null, failure: `Could not update the user PATH: ${describeError(error)}`, existingCommand: null };
  }
}

async function removeWindowsUserPathExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  binDir?: string;
}>): Promise<HappierCliPathRemovalResult> {
  try {
    const snapshot = await readWindowsUserEnvironment(params.processEnv);
    const planned = planWindowsUserPathRemoval({ userPath: snapshot.userPath, provenance: snapshot.provenance, moves: snapshot.moves, binDir: params.binDir });
    // A record that no longer applies is still cleared, so a later removal cannot act on it.
    if (!planned.removed && snapshot.provenance === planned.provenance && snapshot.moves === planned.moves) {
      return { removed: false, failure: null };
    }
    await writeWindowsUserEnvironment(params.processEnv, {
      userPath: planned.userPath,
      userPathKind: snapshot.userPathKind,
      provenance: planned.provenance,
      moves: planned.moves,
    });
    return { removed: true, failure: null };
  } catch (error) {
    return { removed: false, failure: `Could not update the user PATH: ${describeError(error)}` };
  }
}
