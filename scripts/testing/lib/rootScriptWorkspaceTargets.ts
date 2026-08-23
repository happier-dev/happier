/**
 * Derives which workspaces a root script actually executes.
 *
 * The repository used to keep several hand-maintained copies of "which workspaces run in the root
 * unit lane" (the root script body, the CI job body, the parity table, and the lane classifier).
 * They drifted. This module is the single reader: every consumer resolves the workspace set from
 * the root script body itself, so a workspace added to (or removed from) the executor is picked up
 * everywhere without editing a second list.
 */
export interface WorkspaceScriptTarget {
  /** Yarn workspace package name for `yarn workspace <name> <script>` invocations. */
  packageName: string | null;
  /** Repo-relative directory for `yarn --cwd <dir> <script>` invocations. */
  workspaceDirectory: string | null;
  scriptName: string;
}

export interface YarnInvocationScan {
  workspaceTargets: readonly WorkspaceScriptTarget[];
  /** Root script names this command delegates to (`yarn <script>` / `hstack-exec --script=<name>`). */
  rootScriptRefs: readonly string[];
}

const HSTACK_SCRIPT_FLAG_RE = /--script=([A-Za-z0-9:._-]+)/g;
const PACKAGE_MANAGER_RUNNER_TOKENS = new Set(['$npm_execpath', '${npm_execpath}', 'npm', 'pnpm']);
const TEST_FILE_ARGUMENT_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

function tokenize(commandText: string): string[] {
  return commandText
    .split(/[\s&|;()`]+/u)
    .map((token) => token.replace(/^['"]+|['"]+$/gu, ''))
    .filter((token) => token !== '');
}

export function scanYarnInvocations(commandText: string): YarnInvocationScan {
  const workspaceTargets: WorkspaceScriptTarget[] = [];
  const rootScriptRefs: string[] = [];

  for (const match of commandText.matchAll(HSTACK_SCRIPT_FLAG_RE)) {
    rootScriptRefs.push(match[1]!);
  }

  const tokens = tokenize(commandText);
  for (let index = 0; index < tokens.length; index += 1) {
    // `$npm_execpath run <script>` is the package-manager-agnostic delegation form several
    // workspaces use in place of `yarn <script>` (`apps/cli`'s `test:local` is exactly this).
    // Skipping it makes the whole lane behind the wrapper invisible.
    if (PACKAGE_MANAGER_RUNNER_TOKENS.has(tokens[index]!) && tokens[index + 1] === 'run') {
      const scriptName = tokens[index + 2];
      if (scriptName !== undefined && !isFlag(scriptName)) {
        rootScriptRefs.push(scriptName);
        index += 2;
      }
      continue;
    }

    if (tokens[index] !== 'yarn') continue;

    let cursor = index + 1;
    let workspaceDirectory: string | null = null;
    let packageName: string | null = null;

    while (cursor < tokens.length) {
      const token = tokens[cursor]!;
      if (token === '--cwd') {
        workspaceDirectory = tokens[cursor + 1] ?? null;
        cursor += 2;
        continue;
      }
      if (token === 'workspace') {
        packageName = tokens[cursor + 1] ?? null;
        cursor += 2;
        continue;
      }
      if (isFlag(token)) {
        cursor += 1;
        continue;
      }
      break;
    }

    const scriptName = tokens[cursor];
    if (scriptName === undefined) continue;

    if (workspaceDirectory !== null || packageName !== null) {
      workspaceTargets.push({ packageName, workspaceDirectory, scriptName });
      continue;
    }

    rootScriptRefs.push(scriptName);
  }

  return { workspaceTargets, rootScriptRefs };
}

/**
 * Test files a `node --test <files…>` invocation names one by one.
 *
 * `node --test` takes a positional file list, so such a command runs exactly those files and no
 * neighbour of theirs. Glob arguments are omitted deliberately: a pattern is not a name, and the
 * callers use this to answer "does this script name *this* file", which a pattern cannot settle
 * without a matcher. A script that switches to a glob therefore reports its files as unwired —
 * loudly — instead of silently crediting a runner that may not open them.
 */
export function scanNodeTestFileArguments(commandText: string): readonly string[] {
  const tokens = tokenize(commandText);
  const files: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'node') continue;

    let cursor = index + 1;
    let runsNodeTestRunner = false;
    while (cursor < tokens.length && isFlag(tokens[cursor]!)) {
      if (tokens[cursor] === '--test') runsNodeTestRunner = true;
      cursor += 1;
    }

    if (runsNodeTestRunner) {
      for (; cursor < tokens.length && !isFlag(tokens[cursor]!); cursor += 1) {
        const token = tokens[cursor]!;
        if (!token.includes('*') && TEST_FILE_ARGUMENT_RE.test(token)) {
          files.push(token);
        }
      }
    }

    index = cursor - 1;
  }

  return files;
}

/**
 * Bodies of every script reachable from `entryScriptName`, following delegation through other
 * scripts in the same manifest (`yarn -s <script>`) and through the Stack executor
 * (`hstack-exec --script=<script>:local`).
 */
function collectReachableScriptBodies(
  scripts: Readonly<Record<string, string>>,
  entryScriptName: string,
): readonly string[] {
  const bodies: string[] = [];
  const seen = new Set<string>();
  const queue = [entryScriptName];

  while (queue.length > 0) {
    const scriptName = queue.shift()!;
    if (seen.has(scriptName)) continue;
    seen.add(scriptName);

    const body = scripts[scriptName];
    if (typeof body !== 'string' || body.trim() === '') continue;

    bodies.push(body);
    for (const ref of scanYarnInvocations(body).rootScriptRefs) {
      if (!seen.has(ref) && typeof scripts[ref] === 'string') {
        queue.push(ref);
      }
    }
  }

  return bodies;
}

/**
 * Resolve every workspace a root script executes, following delegation through other root scripts
 * (`yarn -s <script>`) and through the Stack executor (`hstack-exec --script=<script>:local`).
 */
export function resolveRootScriptWorkspaceTargets(
  scripts: Readonly<Record<string, string>>,
  rootScriptName: string,
): readonly WorkspaceScriptTarget[] {
  return collectReachableScriptBodies(scripts, rootScriptName)
    .flatMap((body) => scanYarnInvocations(body).workspaceTargets);
}

/**
 * Resolve every test file the script chain rooted at `entryScriptName` names one by one.
 *
 * Paths stay exactly as the script writes them, so callers resolve them against the manifest the
 * scripts belong to.
 */
export function resolveScriptNodeTestFiles(
  scripts: Readonly<Record<string, string>>,
  entryScriptName: string,
): readonly string[] {
  return collectReachableScriptBodies(scripts, entryScriptName).flatMap((body) => scanNodeTestFileArguments(body));
}

export function describeWorkspaceScriptTarget(target: WorkspaceScriptTarget): string {
  return target.packageName ?? target.workspaceDirectory ?? '<unknown workspace>';
}

/** True when `candidate` addresses the same workspace as `target`. */
export function matchesWorkspaceScriptTarget(
  target: WorkspaceScriptTarget,
  candidate: WorkspaceScriptTarget,
): boolean {
  if (target.packageName !== null && candidate.packageName === target.packageName) return true;
  if (target.workspaceDirectory !== null && candidate.workspaceDirectory === target.workspaceDirectory) return true;
  return false;
}
