import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VALIDATOR_ID = 'A.X-agent-ids-codegen';

const SCAN_ROOTS = [
  'packages/agents/src',
  'packages/protocol/src',
  'apps/cli/src',
  'apps/ui/sources',
] as const;

const GENERATED_AGENT_PROVIDER_ID_PATHS = [
  'packages/agents/src/generated/agentProviderIds.ts',
  'packages/protocol/src/providers/agentProviderIdsV1.ts',
] as const;

const GENERATED_AGENT_IDS_MARKER = 'GENERATED FILE CONTRACT (A.X-agent-ids-codegen)';
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DIST_PATH_PATTERN = /(^|\/)dist\//;
const MANUAL_AGENT_ID_ARRAY_PATTERN =
  /\b(?:export\s+)?const\s+(CANONICAL_AGENT_IDS|AGENT_PROVIDER_IDS(?:_V1)?)\s*(?::[^=]+)?=\s*(?:Object\.freeze\s*\(\s*)?\[/;

export interface AgentIdsGeneratedValidatorFile {
  filePath: string;
  content: string;
}

export interface AgentIdsGeneratedValidationResult {
  ok: boolean;
  errors: readonly string[];
  scannedFiles: readonly string[];
}

export function validateAgentIdsGenerated(options?: Readonly<{
  rootDir?: string;
  files?: readonly AgentIdsGeneratedValidatorFile[];
}>): AgentIdsGeneratedValidationResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const files = (options?.files ?? collectSourceFiles(rootDir)).map((file) => ({
    filePath: normalizeRepoPath(file.filePath),
    content: file.content,
  }));
  const errors: string[] = [];

  for (const file of files) {
    errors.push(...validateManualAgentIdArrays(file));
  }

  return {
    ok: errors.length === 0,
    errors,
    scannedFiles: files.map((file) => file.filePath).sort((left, right) => left.localeCompare(right)),
  };
}

function collectSourceFiles(rootDir: string): AgentIdsGeneratedValidatorFile[] {
  const files: AgentIdsGeneratedValidatorFile[] = [];

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
  files: AgentIdsGeneratedValidatorFile[];
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
  return SCAN_ROOTS.some((scanRoot) => normalizedPath === scanRoot || normalizedPath.startsWith(`${scanRoot}/`));
}

function dedupeFiles(files: readonly AgentIdsGeneratedValidatorFile[]): AgentIdsGeneratedValidatorFile[] {
  const byPath = new Map<string, AgentIdsGeneratedValidatorFile>();
  for (const file of files) {
    byPath.set(normalizeRepoPath(file.filePath), {
      filePath: normalizeRepoPath(file.filePath),
      content: file.content,
    });
  }
  return [...byPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function validateManualAgentIdArrays(file: AgentIdsGeneratedValidatorFile): string[] {
  if (isAcceptedGeneratedAgentProviderIdsFile(file)) {
    return [];
  }

  const errors: string[] = [];
  const lines = splitLines(file.content);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(MANUAL_AGENT_ID_ARRAY_PATTERN);
    const symbol = match?.[1];
    if (!symbol) {
      continue;
    }
    errors.push(
      `${formatLocation(file.filePath, index)}: ${VALIDATOR_ID}: ${symbol} must be generated from bundled plugin AGENT_DEFINITION.id values; do not keep production hand-maintained agent id arrays.`,
    );
  }
  return errors;
}

function isAcceptedGeneratedAgentProviderIdsFile(file: AgentIdsGeneratedValidatorFile): boolean {
  const normalizedPath = normalizeRepoPath(file.filePath);
  if (!GENERATED_AGENT_PROVIDER_ID_PATHS.includes(normalizedPath as (typeof GENERATED_AGENT_PROVIDER_ID_PATHS)[number])) {
    return false;
  }
  return file.content.includes(GENERATED_AGENT_IDS_MARKER);
}

function splitLines(content: string): readonly string[] {
  return content.split(/\r?\n/);
}

function formatLocation(filePath: string, lineIndex: number): string {
  return `${filePath}:${lineIndex + 1}`;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  const result = validateAgentIdsGenerated();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  }
}
