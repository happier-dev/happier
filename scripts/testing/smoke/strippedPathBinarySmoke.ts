import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCAN_ROOTS = Object.freeze([
  'packages/plugins',
  'apps/cli/src/plugins',
  'apps/cli/src/agent',
  'packages/tests/fixtures/plugins/representative-runtime/src',
]);

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_SUPPORT_FILE_PATTERN = /\.test-support\.[cm]?[jt]sx?$/;
const DIST_PATH_PATTERN = /(^|\/)(?:dist|generated)\//;
const IGNORED_DIRECTORY_NAMES = new Set([
  '.expo',
  '.next',
  '.project',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'package-dist',
]);

const DENIED_RUNTIME_NAMES = Object.freeze([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'bunx',
]);

const DENIED_RUNTIME_NAME_PATTERN = DENIED_RUNTIME_NAMES
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const DIRECT_INVOCATION_PATTERNS = Object.freeze([
  new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync|fork)\\s*\\(\\s*['"](${DENIED_RUNTIME_NAME_PATTERN})(?:\\.(?:exe|cmd|bat|ps1))?['"]`, 'i'),
  new RegExp(`\\b(?:exec|execSync)\\s*\\(\\s*['"](${DENIED_RUNTIME_NAME_PATTERN})(?:\\.(?:exe|cmd|bat|ps1))?(?:\\s|['"])`, 'i'),
]);

const ALLOWED_POLICY_FILES = new Set([
  'apps/cli/src/plugins/runtime/context/exec/system/tools/runtimeDeny.ts',
]);

const REPRESENTATIVE_RUNTIME_CHILD_ARG = '--representative-runtime-child';
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

export interface StrippedPathBinarySmokeViolation {
  filePath: string;
  line: number;
  runtimeName: string;
  message: string;
}

export interface StrippedPathBinarySmokeResult {
  ok: boolean;
  scannedFiles: readonly string[];
  violations: readonly StrippedPathBinarySmokeViolation[];
}

export interface RepresentativeRuntimeFixtureResult {
  ok: boolean;
  processId: number;
  processEnv: Readonly<{ PATH: string | undefined; Path: string | undefined }>;
  ctxEnv: Readonly<{ PATH: string | undefined; Path: string | undefined }>;
  spawnClientCalls: readonly RepresentativeExecClientSpec[];
  fetchRequests: readonly RepresentativeFetchRequest[];
  actionIds: readonly string[];
  subagentIds: readonly string[];
  secretKeys: readonly string[];
  errors: readonly string[];
}

interface RepresentativeExecClientSpec {
  launch: {
    kind?: string;
    installableId?: string;
    executableName?: string;
    args?: readonly string[];
  };
  protocol?: { kind?: string };
  transport?: { kind?: string };
}

interface RepresentativeFetchRequest {
  input: string;
  init?: unknown;
}

interface RuntimeSourceFile {
  filePath: string;
  content: string;
}

export function runStrippedPathBinarySmoke(options?: Readonly<{
  rootDir?: string;
  scanRoots?: readonly string[];
}>): StrippedPathBinarySmokeResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const scanRoots = options?.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const files = collectRuntimeSourceFiles(rootDir, scanRoots);
  const violations = files.flatMap((file) => validateFile(file));
  return {
    ok: violations.length === 0,
    scannedFiles: files.map((file) => file.filePath),
    violations,
  };
}

export async function runRepresentativeRuntimeFixture(options?: Readonly<{
  rootDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<RepresentativeRuntimeFixtureResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const childPayload = JSON.stringify({ rootDir, env: createStrippedPathEnv(options?.env ?? process.env) });
  const child = spawnSync(process.execPath, [
    '--experimental-strip-types',
    fileURLToPath(import.meta.url),
    REPRESENTATIVE_RUNTIME_CHILD_ARG,
    childPayload,
  ], {
    cwd: rootDir,
    encoding: 'utf8',
    env: createStrippedPathEnv(process.env),
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    windowsHide: true,
  });

  if (child.error) {
    return createRepresentativeRuntimeFixtureFailure(rootDir, [
      `representative-runtime child process failed to launch: ${child.error.message}`,
    ]);
  }

  if (child.status !== 0) {
    return createRepresentativeRuntimeFixtureFailure(rootDir, [
      `representative-runtime child process exited with status ${child.status ?? 'null'} signal ${child.signal ?? 'null'}`,
      ...formatChildOutputErrors(child.stdout, child.stderr),
    ]);
  }

  const parsed = parseRepresentativeRuntimeFixtureResult(child.stdout);
  if (!parsed.ok) {
    return createRepresentativeRuntimeFixtureFailure(rootDir, [
      `representative-runtime child process did not return a valid proof: ${parsed.error}`,
      ...formatChildOutputErrors(child.stdout, child.stderr),
    ]);
  }

  return parsed.result;
}

async function runRepresentativeRuntimeFixtureInCurrentProcess(options?: Readonly<{
  rootDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<RepresentativeRuntimeFixtureResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const ctxEnv = readPathEnv(createStrippedPathEnv(options?.env ?? process.env));
  const fixturePath = resolve(rootDir, 'packages/tests/fixtures/plugins/representative-runtime/src/runtime.ts');
  const errors: string[] = [];
  const spawnClientCalls: RepresentativeExecClientSpec[] = [];
  const fetchRequests: RepresentativeFetchRequest[] = [];
  const actionIds: string[] = [];
  const subagentIds: string[] = [];
  const secretKeys: string[] = [];

  if (!existsSync(fixturePath)) {
    return {
      ok: false,
      processId: process.pid,
      processEnv: readPathEnv(process.env),
      ctxEnv,
      spawnClientCalls,
      fetchRequests,
      actionIds,
      subagentIds,
      secretKeys,
      errors: [`representative-runtime fixture missing: ${normalizeRepoPath(relative(rootDir, fixturePath))}`],
    };
  }

  try {
    const module = await import(pathToFileURL(fixturePath).href) as {
      runRepresentativeRuntimeProof?: (ctx: unknown) => Promise<void>;
    };
    if (typeof module.runRepresentativeRuntimeProof !== 'function') {
      errors.push('representative-runtime fixture does not export runRepresentativeRuntimeProof');
    } else {
      await module.runRepresentativeRuntimeProof({
        env: ctxEnv,
        exec: {
          async spawnClient(spec: RepresentativeExecClientSpec) {
            spawnClientCalls.push(spec);
            return {
              async dispose() {
                return undefined;
              },
            };
          },
        },
        async fetch(input: string, init?: unknown) {
          fetchRequests.push({ input, init });
          return { ok: true, status: 204 };
        },
        actions: {
          async execute(request: Readonly<{ actionId: string }>) {
            actionIds.push(request.actionId);
            return { ok: true };
          },
        },
        subagents: {
          async run(request: Readonly<{ id: string }>) {
            subagentIds.push(request.id);
            return { ok: true };
          },
        },
        secrets: {
          async get(key: string) {
            secretKeys.push(key);
            return 'fixture-secret';
          },
        },
      });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    ok: errors.length === 0,
    processId: process.pid,
    processEnv: readPathEnv(process.env),
    ctxEnv,
    spawnClientCalls,
    fetchRequests,
    actionIds,
    subagentIds,
    secretKeys,
    errors,
  };
}

function createRepresentativeRuntimeFixtureFailure(rootDir: string, errors: readonly string[]): RepresentativeRuntimeFixtureResult {
  return {
    ok: false,
    processId: process.pid,
    processEnv: readPathEnv(process.env),
    ctxEnv: readPathEnv(createStrippedPathEnv(process.env)),
    spawnClientCalls: [],
    fetchRequests: [],
    actionIds: [],
    subagentIds: [],
    secretKeys: [],
    errors: errors.map((error) => error.replaceAll(rootDir, '.')),
  };
}

function createStrippedPathEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    stripped[key] = value;
  }
  stripped.PATH = '';
  stripped.Path = '';
  return stripped;
}

function readPathEnv(env: Readonly<Record<string, string | undefined>>): Readonly<{ PATH: string | undefined; Path: string | undefined }> {
  return {
    PATH: env.PATH,
    Path: env.Path,
  };
}

function formatChildOutputErrors(stdout: string, stderr: string): string[] {
  const errors: string[] = [];
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  if (trimmedStdout.length > 0) {
    errors.push(`child stdout: ${trimmedStdout}`);
  }
  if (trimmedStderr.length > 0) {
    errors.push(`child stderr: ${trimmedStderr}`);
  }
  return errors;
}

function parseRepresentativeRuntimeFixtureResult(stdout: string): Readonly<
  | { ok: true; result: RepresentativeRuntimeFixtureResult }
  | { ok: false; error: string }
> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRepresentativeRuntimeFixtureResult(parsed)) {
      return { ok: true, result: parsed };
    }
    return { ok: false, error: 'unexpected JSON shape' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRepresentativeRuntimeFixtureResult(value: unknown): value is RepresentativeRuntimeFixtureResult {
  if (!isRecord(value)) return false;
  return typeof value.ok === 'boolean'
    && typeof value.processId === 'number'
    && isPathEnv(value.processEnv)
    && isPathEnv(value.ctxEnv)
    && Array.isArray(value.spawnClientCalls)
    && Array.isArray(value.fetchRequests)
    && Array.isArray(value.actionIds)
    && Array.isArray(value.subagentIds)
    && Array.isArray(value.secretKeys)
    && Array.isArray(value.errors);
}

function isPathEnv(value: unknown): value is Readonly<{ PATH: string | undefined; Path: string | undefined }> {
  return isRecord(value)
    && (value.PATH === undefined || typeof value.PATH === 'string')
    && (value.Path === undefined || typeof value.Path === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateFile(file: RuntimeSourceFile): StrippedPathBinarySmokeViolation[] {
  if (ALLOWED_POLICY_FILES.has(file.filePath)) {
    return [];
  }
  const violations: StrippedPathBinarySmokeViolation[] = [];
  const lines = file.content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of DIRECT_INVOCATION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const runtimeName = (match[1] ?? match[0]).toLowerCase();
      violations.push({
        filePath: file.filePath,
        line: index + 1,
        runtimeName,
        message: `${file.filePath}:${index + 1}: direct '${runtimeName}' runtime/package-manager invocation is not binary-safe; use the managed runtime/installable substrate instead.`,
      });
    }
  }
  return violations;
}

function collectRuntimeSourceFiles(rootDir: string, scanRoots: readonly string[]): RuntimeSourceFile[] {
  const files: RuntimeSourceFile[] = [];
  for (const scanRoot of scanRoots) {
    const absolutePath = resolve(rootDir, scanRoot);
    if (!existsSync(absolutePath)) continue;
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (shouldScanFile(scanRoot)) {
        files.push({ filePath: normalizeRepoPath(scanRoot), content: readFileSync(absolutePath, 'utf8') });
      }
      continue;
    }
    collectRuntimeSourceFilesFromDirectory(rootDir, absolutePath, files);
  }
  return dedupeFiles(files);
}

function collectRuntimeSourceFilesFromDirectory(rootDir: string, directory: string, files: RuntimeSourceFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        collectRuntimeSourceFilesFromDirectory(rootDir, absolutePath, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = normalizeRepoPath(relative(rootDir, absolutePath));
    if (!shouldScanFile(filePath)) continue;
    files.push({ filePath, content: readFileSync(absolutePath, 'utf8') });
  }
}

function shouldScanFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return SOURCE_FILE_PATTERN.test(normalized)
    && !TEST_FILE_PATTERN.test(normalized)
    && !TEST_SUPPORT_FILE_PATTERN.test(normalized)
    && !DIST_PATH_PATTERN.test(normalized);
}

function dedupeFiles(files: readonly RuntimeSourceFile[]): RuntimeSourceFile[] {
  const byPath = new Map<string, RuntimeSourceFile>();
  for (const file of files) {
    byPath.set(file.filePath, file);
  }
  return [...byPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function normalizeRepoPath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/');
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

async function main(): Promise<void> {
  if (process.argv[2] === REPRESENTATIVE_RUNTIME_CHILD_ARG) {
    const payload = parseRepresentativeRuntimeChildPayload(process.argv[3]);
    const result = await runRepresentativeRuntimeFixtureInCurrentProcess(payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const result = runStrippedPathBinarySmoke();
  console.log(`stripped-path binary smoke: scanned=${result.scannedFiles.length} violations=${result.violations.length}`);
  for (const violation of result.violations) {
    console.log(violation.message);
  }
  const fixtureResult = await runRepresentativeRuntimeFixture();
  console.log(`representative runtime fixture: ok=${fixtureResult.ok} spawnClient=${fixtureResult.spawnClientCalls.length} fetch=${fixtureResult.fetchRequests.length} actions=${fixtureResult.actionIds.length} subagents=${fixtureResult.subagentIds.length} secrets=${fixtureResult.secretKeys.length}`);
  for (const error of fixtureResult.errors) {
    console.log(`  - ${error}`);
  }
  if (!result.ok || !fixtureResult.ok) {
    process.exitCode = 1;
  }
}

if (isDirectRun()) {
  void main();
}

function parseRepresentativeRuntimeChildPayload(value: string | undefined): Readonly<{
  rootDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return {
      rootDir: typeof parsed.rootDir === 'string' ? parsed.rootDir : undefined,
      env: isRecord(parsed.env) ? Object.fromEntries(
        Object.entries(parsed.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ) : undefined,
    };
  } catch {
    return {};
  }
}
