import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectFileInventory } from '../../lib/collectFileInventory.ts';

export const VALIDATOR_ID = 'J.X-no-host-imposed-permission-ttl';
export const LOCAL_PERMISSION_BRIDGE_ALLOWLIST_MARKER =
  '// L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency';

const ACCEPTED_ALLOWLIST_PATHS = [
  'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
  'packages/plugins/claude/src/agent/permissions/bridge/localPermissionBridge.ts',
] as const;

const SCAN_DIRECTORY_ROOTS = [
  'apps/cli/src/agent/permissions',
  'packages/plugins',
] as const;
const DIRECT_SCAN_FILES = [
  'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
] as const;

// L-25 is about permission and interactive-prompt lifetimes, so the context probe must say
// "permission", not merely "request". A bare `request` substring matches unrelated neighbours
// such as `reconnectRequested` / `requestReconnect()` and turned wire-protocol keepalives into
// phantom violations, which is how a guard stops being believed. Detection is therefore split
// into two tiers: vocabulary that can only mean a permission/interactive-prompt lifetime, and
// generic request-store vocabulary that only counts when the neighbourhood also cancels
// something. The second tier keeps reach over an `agentStateRequestStore.requests` GC timer in
// a file that never spells out "permission".
const PERMISSION_CONTEXT_PATTERN =
  /permission|agentStateRequest|pendingRequests?\b|lateDecisions?\b|cachedDecisions?\b|askUserQuestion|exitPlanMode|canUseTool/i;
const REQUEST_STORE_CONTEXT_PATTERN =
  /\brequests?\b|\bwaiters?\b|\bcoordinator\b|\bagentState\b|\bdecisions?\b/i;
const LIFETIME_CANCELLATION_INTENT_PATTERN =
  /\b(?:abort(?:ed|s)?|cancel(?:led|s)?|delete|evict|expire[sd]?|expiresAt|expiry|prune|reject(?:ed|s)?|revoke[sd]?|timedOut|timeout|ttl)\b/i;
const PERMISSION_CONTEXT_SUMMARY_PATTERN =
  /createdAt|timestamp|lateDecisions?|cachedDecisions?|pendingRequests?|permissionRequests?|PermissionRequestCoordinator|permission|agentStateRequest|askUserQuestion|exitPlanMode|canUseTool|\brequests?\b|\bwaiters?\b|\bagentState\b|\bcoordinator\b/i;
const PERMISSION_WALL_CLOCK_STATEMENT_PATTERN =
  /permission|waiter|lateDecision|lateDecisions|agentState|coordinator|pendingRequests|cachedDecisions/i;
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
  const files: PermissionTtlValidatorFile[] = collectFileInventory({
    rootDir,
    searchRoots: SCAN_DIRECTORY_ROOTS,
    include: SOURCE_FILE_PATTERN,
  }).filter((file) => shouldScanFile(file.filePath));

  for (const filePath of DIRECT_SCAN_FILES) {
    const absolutePath = resolve(rootDir, filePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (shouldScanFile(filePath)) {
        files.push({
          filePath,
          content: readFileSync(absolutePath, 'utf8'),
        });
      }
      continue;
    }
  }

  return dedupeFiles(files);
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
  return normalizedPath.startsWith('packages/plugins/');
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
  const acceptedMarkerFiles = acceptedFiles.filter((file) => {
    const lines = splitLines(file.content);
    return lines.some((line, index) => TIMER_PATTERN.test(line) && hasAllowlistMarkerWithinThreeLines(lines, index));
  });
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
    if (!isPermissionOwnedPath(file.filePath) && !isPermissionTimerCandidate(lines, index)) {
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

    const pathIsPermissionOwned = isPermissionOwnedPath(file.filePath);
    const statementContext = statementContextLines(lines, index).join('\n');
    if (!pathIsPermissionOwned && !PERMISSION_WALL_CLOCK_STATEMENT_PATTERN.test(statementContext)) {
      continue;
    }
    const context = pathIsPermissionOwned
      ? contextLines(lines, index, 3).join('\n')
      : statementContext;
    const splitClockExpiration = findSplitClockExpiration(lines, index);
    if (splitClockExpiration) {
      errors.push(
        `${formatLocation(file.filePath, index)}: forbidden Date.now/performance.now split-clock permission expiration logic using ${splitClockExpiration.fieldName}.`,
      );
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

function findSplitClockExpiration(
  lines: readonly string[],
  clockLineIndex: number,
): Readonly<{ fieldName: string }> | null {
  const clockLine = lines[clockLineIndex] ?? '';
  const directAgeAssignment = extractDirectClockAgeAssignment(clockLine);
  if (directAgeAssignment) {
    const forwardContext = lines.slice(clockLineIndex, Math.min(lines.length, clockLineIndex + 12)).join('\n');
    const directAgeComparisonPattern = new RegExp(
      `\\b${escapeRegExp(directAgeAssignment.ageVariable)}\\b\\s*(?:[<>]=?)\\s*[^;\\n]*(?:TTL|TIMEOUT|MAX_?AGE|MAX_PERMISSION_AGE|AGE_MS|\\d)`,
      'i',
    );
    if (directAgeComparisonPattern.test(forwardContext)) {
      return { fieldName: directAgeAssignment.fieldName };
    }
  }

  const clockVariable = extractAssignedVariable(clockLine, CLOCK_PATTERN);
  if (!clockVariable) {
    return null;
  }

  const forwardContext = lines.slice(clockLineIndex, Math.min(lines.length, clockLineIndex + 12)).join('\n');
  const clockVariablePattern = escapeRegExp(clockVariable);
  const directAgeComparisonPattern = new RegExp(
    `\\b${clockVariablePattern}\\b\\s*-\\s*[^;\\n]*(createdAt|timestamp|requestedAt|startedAt)\\b[^;\\n]*(?:[<>]=?)`,
    'i',
  );
  const directMatch = forwardContext.match(directAgeComparisonPattern);
  if (directMatch?.[1]) {
    return { fieldName: directMatch[1] };
  }

  const ageVariablePattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\b${clockVariablePattern}\\b\\s*-\\s*[^;\\n]*(createdAt|timestamp|requestedAt|startedAt)\\b`,
    'i',
  );
  const ageVariableMatch = forwardContext.match(ageVariablePattern);
  const ageVariable = ageVariableMatch?.[1];
  const fieldName = ageVariableMatch?.[2];
  if (!ageVariable || !fieldName) {
    return null;
  }

  const ageComparisonPattern = new RegExp(
    `\\b${escapeRegExp(ageVariable)}\\b\\s*(?:[<>]=?)\\s*[^;\\n]*(?:TTL|TIMEOUT|MAX_?AGE|MAX_PERMISSION_AGE|AGE_MS|\\d)`,
    'i',
  );
  if (!ageComparisonPattern.test(forwardContext)) {
    return null;
  }
  return { fieldName };
}

function extractDirectClockAgeAssignment(line: string): Readonly<{ ageVariable: string; fieldName: string }> | null {
  const match = line.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Date\.now|performance\.now)\s*\(\s*\)\s*-\s*[^;\n]*(createdAt|timestamp|requestedAt|startedAt)\b/i,
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    ageVariable: match[1],
    fieldName: match[2],
  };
}

function extractAssignedVariable(line: string, valuePattern: RegExp): string | null {
  const match = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  if (!match?.[1] || !valuePattern.test(line)) {
    return null;
  }
  valuePattern.lastIndex = 0;
  return match[1];
}

function isPermissionTimerCandidate(lines: readonly string[], index: number): boolean {
  const context = contextLines(lines, index, 5).join('\n');
  if (PERMISSION_CONTEXT_PATTERN.test(context)) {
    return true;
  }
  return REQUEST_STORE_CONTEXT_PATTERN.test(context) && LIFETIME_CANCELLATION_INTENT_PATTERN.test(context);
}

function hasAllowlistMarkerWithinThreeLines(lines: readonly string[], index: number): boolean {
  const start = Math.max(0, index - 3);
  return lines.slice(start, index).some((line) => line.trim() === LOCAL_PERMISSION_BRIDGE_ALLOWLIST_MARKER);
}

function contextLines(lines: readonly string[], index: number, radius: number): readonly string[] {
  return lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1));
}

function statementContextLines(lines: readonly string[], index: number): readonly string[] {
  let start = index;
  while (start > 0 && !isStatementStart(lines[start] ?? '')) {
    const previousLine = lines[start - 1] ?? '';
    if (isStatementEnd(previousLine)) {
      break;
    }
    start -= 1;
  }

  let end = index;
  while (end + 1 < lines.length && !isStatementEnd(lines[end] ?? '')) {
    end += 1;
  }
  return lines.slice(start, end + 1);
}

function isStatementStart(line: string): boolean {
  return /^\s*(?:const|if|let|return|throw|var|while)\b/.test(line);
}

function isStatementEnd(line: string): boolean {
  return /[;{}]\s*$/.test(line);
}

function formatLocation(filePath: string, lineIndex: number): string {
  return `${filePath}:${lineIndex + 1}`;
}

// Summarize over the same window the decision used, so the reported reason is a token that
// actually triggered the finding rather than an unrelated word two lines away.
function summarizeContext(lines: readonly string[], index: number): string {
  const context = contextLines(lines, index, 5).join(' ');
  const match = context.match(PERMISSION_CONTEXT_SUMMARY_PATTERN);
  return match?.[0] ?? 'permission state';
}

function splitLines(content: string): readonly string[] {
  return content.split(/\r?\n/);
}

function isAcceptedAllowlistPath(filePath: string): boolean {
  return ACCEPTED_ALLOWLIST_PATHS.includes(normalizeRepoPath(filePath) as (typeof ACCEPTED_ALLOWLIST_PATHS)[number]);
}

function isPermissionOwnedPath(filePath: string): boolean {
  const normalizedPath = normalizeRepoPath(filePath).toLowerCase();
  if (isAcceptedAllowlistPath(filePath)) {
    return false;
  }
  if (normalizedPath.startsWith('apps/cli/src/agent/permissions/')) {
    return true;
  }
  return normalizedPath.includes('/permissions/') || normalizedPath.includes('permission');
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
