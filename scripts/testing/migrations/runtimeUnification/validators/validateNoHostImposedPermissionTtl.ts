import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const VALIDATOR_ID = 'J.X-no-host-imposed-permission-ttl';
export const LOCAL_PERMISSION_BRIDGE_ALLOWLIST_MARKER =
  '// L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency';

const ACCEPTED_ALLOWLIST_PATHS = [
  'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
  'packages/plugins/claude/src/agent/permissions/bridge/localPermissionBridge.ts',
] as const;

const SCAN_ROOTS = [
  'apps/cli/src/agent/permissions',
  'packages/plugins',
  'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
] as const;

const PERMISSION_CONTEXT_PATTERN =
  /permission|request|waiter|lateDecision|lateDecisions|agentState|coordinator|pendingRequests|cachedDecisions/i;
const TIMER_PATTERN = /\b(setTimeout|setInterval)\s*\(/;
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DIST_PATH_PATTERN = /(^|\/)dist\//;
const CLOCK_PATTERN = /\b(?:Date\.now|performance\.now)\s*\(/;
const CLOCK_ARITHMETIC_PATTERN =
  /(?:Date\.now|performance\.now)\s*\(\s*\)\s*[-+]|[-+]\s*(?:Date\.now|performance\.now)\s*\(\s*\)/;
const EXPIRATION_DEADLINE_PATTERN = /\b(?:expiresAt|deadline|timeoutAt|maxAge|ageMs|ttl)\b/i;
const COMPARISON_PATTERN = /[<>]=?/;

export interface PermissionTtlValidatorFile {
  filePath: string;
  content: string;
}

export interface NoHostImposedPermissionTtlValidationResult {
  ok: boolean;
  errors: readonly string[];
  scannedFiles: readonly string[];
}

export function validateNoHostImposedPermissionTtl(options?: Readonly<{
  rootDir?: string;
  files?: readonly PermissionTtlValidatorFile[];
}>): NoHostImposedPermissionTtlValidationResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const files = (options?.files ?? collectSourceFiles(rootDir)).map((file) => ({
    filePath: normalizeRepoPath(file.filePath),
    content: file.content,
  }));
  const errors: string[] = [];

  errors.push(...validateAllowlistMarker(files));

  for (const file of files) {
    errors.push(...validateTimers(file));
    errors.push(...validateWallClockExpiration(file));
  }

  return {
    ok: errors.length === 0,
    errors,
    scannedFiles: files.map((file) => file.filePath).sort((left, right) => left.localeCompare(right)),
  };
}

function collectSourceFiles(rootDir: string): PermissionTtlValidatorFile[] {
  const files: PermissionTtlValidatorFile[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const absolutePath = resolve(rootDir, scanRoot);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (shouldScanFile(scanRoot)) {
        files.push({
          filePath: scanRoot,
          content: readFileSync(absolutePath, 'utf8'),
        });
      }
      continue;
    }
    collectSourceFilesFromDirectory({
      rootDir,
      directory: absolutePath,
      files,
    });
  }

  return dedupeFiles(files);
}

function collectSourceFilesFromDirectory(params: Readonly<{
  rootDir: string;
  directory: string;
  files: PermissionTtlValidatorFile[];
}>): void {
  for (const entry of readdirSync(params.directory, { withFileTypes: true })) {
    const absolutePath = join(params.directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFilesFromDirectory({
        ...params,
        directory: absolutePath,
      });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizeRepoPath(relative(params.rootDir, absolutePath));
    if (!shouldScanFile(filePath)) {
      continue;
    }
    params.files.push({
      filePath,
      content: readFileSync(absolutePath, 'utf8'),
    });
  }
}

function shouldScanFile(filePath: string): boolean {
  const normalizedPath = normalizeRepoPath(filePath);
  if (!SOURCE_FILE_PATTERN.test(normalizedPath)) {
    return false;
  }
  if (TEST_FILE_PATTERN.test(normalizedPath) || DIST_PATH_PATTERN.test(normalizedPath)) {
    return false;
  }
  if (isAcceptedAllowlistPath(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith('apps/cli/src/agent/permissions/')) {
    return true;
  }
  return /^packages\/plugins\/[^/]+\/src\/agent\/permissions\//.test(normalizedPath);
}

function dedupeFiles(files: readonly PermissionTtlValidatorFile[]): PermissionTtlValidatorFile[] {
  const byPath = new Map<string, PermissionTtlValidatorFile>();
  for (const file of files) {
    byPath.set(normalizeRepoPath(file.filePath), {
      filePath: normalizeRepoPath(file.filePath),
      content: file.content,
    });
  }
  return [...byPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function validateAllowlistMarker(files: readonly PermissionTtlValidatorFile[]): string[] {
  const acceptedFiles = files.filter((file) => isAcceptedAllowlistPath(file.filePath));
  const acceptedMarkerFiles = acceptedFiles.filter((file) => file.content.includes(LOCAL_PERMISSION_BRIDGE_ALLOWLIST_MARKER));
  if (acceptedMarkerFiles.length > 0) {
    return [];
  }

  return [
    `${VALIDATOR_ID}: at least one accepted localPermissionBridge allowlist marker must exist in ${ACCEPTED_ALLOWLIST_PATHS.join(
      ' or ',
    )}; marker copies elsewhere do not satisfy L-25 proof.`,
  ];
}

function validateTimers(file: PermissionTtlValidatorFile): string[] {
  const errors: string[] = [];
  const lines = splitLines(file.content);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(TIMER_PATTERN);
    if (!match) {
      continue;
    }
    if (!isPermissionTimerCandidate(lines, index)) {
      continue;
    }
    if (isAcceptedAllowlistPath(file.filePath) && hasAllowlistMarkerWithinThreeLines(lines, index)) {
      continue;
    }
    errors.push(
      `${formatLocation(file.filePath, index)}: forbidden ${match[1]} permission lifecycle timer near ${summarizeContext(
        lines,
        index,
      )}.`,
    );
  }

  return errors;
}

function validateWallClockExpiration(file: PermissionTtlValidatorFile): string[] {
  const errors: string[] = [];
  const lines = splitLines(file.content);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!CLOCK_PATTERN.test(line)) {
      continue;
    }

    const context = contextLines(lines, index, 3).join('\n');
    if (!PERMISSION_CONTEXT_PATTERN.test(context)) {
      continue;
    }
    if (!isWallClockExpirationContext(context)) {
      continue;
    }
    errors.push(
      `${formatLocation(file.filePath, index)}: forbidden Date.now/performance.now permission expiration logic near ${summarizeContext(
        lines,
        index,
      )}.`,
    );
  }

  return errors;
}

function isWallClockExpirationContext(context: string): boolean {
  if (!COMPARISON_PATTERN.test(context)) {
    return false;
  }
  return CLOCK_ARITHMETIC_PATTERN.test(context) || (CLOCK_PATTERN.test(context) && EXPIRATION_DEADLINE_PATTERN.test(context));
}

function isPermissionTimerCandidate(lines: readonly string[], index: number): boolean {
  return PERMISSION_CONTEXT_PATTERN.test(contextLines(lines, index, 5).join('\n'));
}

function hasAllowlistMarkerWithinThreeLines(lines: readonly string[], index: number): boolean {
  const start = Math.max(0, index - 3);
  return lines.slice(start, index).some((line) => line.trim() === LOCAL_PERMISSION_BRIDGE_ALLOWLIST_MARKER);
}

function contextLines(lines: readonly string[], index: number, radius: number): readonly string[] {
  return lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1));
}

function formatLocation(filePath: string, lineIndex: number): string {
  return `${filePath}:${lineIndex + 1}`;
}

function summarizeContext(lines: readonly string[], index: number): string {
  const context = contextLines(lines, index, 2).join(' ');
  const match = context.match(
    /lateDecisions|cachedDecisions|pendingRequests|PermissionRequestCoordinator|permission|request|waiter|agentState/i,
  );
  return match?.[0] ?? 'permission state';
}

function splitLines(content: string): readonly string[] {
  return content.split(/\r?\n/);
}

function isAcceptedAllowlistPath(filePath: string): boolean {
  return ACCEPTED_ALLOWLIST_PATHS.includes(normalizeRepoPath(filePath) as (typeof ACCEPTED_ALLOWLIST_PATHS)[number]);
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}
