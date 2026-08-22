import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CROSS_CUTTING_FORBIDDEN_FAMILIES,
  CROSS_CUTTING_REQUIRED_EVIDENCE_FAMILIES,
  type ForbiddenFamily,
  type RequiredEvidenceFamily,
  type RuntimeUnificationFamilyId,
} from './runtimeUnificationValidatorConfig.ts';

export const VALIDATOR_ID = 'F.5-cross-cutting-duplicate-closure';

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_SUPPORT_FILE_PATTERN = /\.test-support\.[cm]?[jt]sx?$/;
const DIST_PATH_PATTERN = /(^|\/)dist\//;
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
const DEFAULT_FORBIDDEN_FAMILY_IDS = CROSS_CUTTING_FORBIDDEN_FAMILIES
  .map((family) => family.id);
const PERMISSION_HOST_TTL_CONTEXT_PATTERN =
  /permission|lateDecision|lateDecisions|agentState|cachedDecisions|PermissionRequestCoordinator/i;
const APPROVED_PROVIDER_TREE_COMPATIBILITY_REEXPORTS = new Map<string, ReadonlySet<string>>([
  [
    'packages/protocol/src/agents/agentProviderIdsV1.ts',
    new Set(['../generated/providers/agentProviderIdsV1.js']),
  ],
  [
    'packages/protocol/src/agents/runtimeDescriptorContributionsV1.ts',
    new Set(['./generated/runtime/descriptorContributionsV1.js']),
  ],
]);

export const DEFAULT_REQUIRED_EVIDENCE_FAMILY_IDS: readonly RuntimeUnificationFamilyId[] = Object.freeze(
  CROSS_CUTTING_REQUIRED_EVIDENCE_FAMILIES.map((family) => family.id),
);

export interface RuntimeUnificationValidatorFile {
  filePath: string;
  content: string;
}

export interface CrossCuttingDuplicateViolation {
  familyId: RuntimeUnificationFamilyId;
  filePath: string;
  line: number;
  match: string;
  canonicalOwner: string;
  owningPacket: string;
  message: string;
}

export interface CrossCuttingDuplicateClosureResult {
  ok: boolean;
  validatorId: typeof VALIDATOR_ID;
  violations: readonly CrossCuttingDuplicateViolation[];
  scannedFiles: readonly string[];
}

export function validateCrossCuttingDuplicateClosure(options?: Readonly<{
  rootDir?: string;
  files?: readonly RuntimeUnificationValidatorFile[];
  enabledForbiddenFamilies?: readonly RuntimeUnificationFamilyId[];
  enabledRequiredFamilies?: readonly RuntimeUnificationFamilyId[];
}>): CrossCuttingDuplicateClosureResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const forbiddenFamilies = filterFamilies(
    CROSS_CUTTING_FORBIDDEN_FAMILIES,
    options?.enabledForbiddenFamilies ?? DEFAULT_FORBIDDEN_FAMILY_IDS,
  );
  const requiredFamilies = filterFamilies(
    CROSS_CUTTING_REQUIRED_EVIDENCE_FAMILIES,
    options?.enabledRequiredFamilies ?? DEFAULT_REQUIRED_EVIDENCE_FAMILY_IDS,
  );
  const roots = [...new Set([...forbiddenFamilies.flatMap((family) => family.roots), ...requiredFamilies.flatMap((family) => family.roots)])];
  const files = (options?.files ?? collectSourceFiles(rootDir, roots)).map((file) => ({
    filePath: normalizeRepoPath(file.filePath),
    content: file.content,
  }));
  const violations: CrossCuttingDuplicateViolation[] = [];

  for (const family of forbiddenFamilies) {
    violations.push(...validateForbiddenFamily(family, files));
  }

  for (const family of requiredFamilies) {
    violations.push(...validateRequiredEvidenceFamily(family, files));
  }

  return {
    ok: violations.length === 0,
    validatorId: VALIDATOR_ID,
    violations,
    scannedFiles: files.map((file) => file.filePath).sort((left, right) => left.localeCompare(right)),
  };
}

function filterFamilies<T extends { id: RuntimeUnificationFamilyId }>(
  families: readonly T[],
  enabledIds: readonly RuntimeUnificationFamilyId[] | undefined,
): readonly T[] {
  if (!enabledIds) {
    return families;
  }
  const enabled = new Set(enabledIds);
  return families.filter((family) => enabled.has(family.id));
}

function validateForbiddenFamily(
  family: ForbiddenFamily,
  files: readonly RuntimeUnificationValidatorFile[],
): CrossCuttingDuplicateViolation[] {
  const violations: CrossCuttingDuplicateViolation[] = [];
  for (const file of files) {
    if (
      !isFileInRoots(file.filePath, family.roots)
      || isIgnoredPath(file.filePath, family.ignoredPaths)
      || (family.filePathPattern && !family.filePathPattern.test(file.filePath))
    ) {
      continue;
    }
    if (
      family.pathPattern?.test(file.filePath)
      && !isProviderTreeCompatibilityReExport(family, file)
    ) {
      violations.push(createViolation({
        family,
        file,
        lineIndex: 0,
        match: 'path',
      }));
    }
    for (const pattern of family.patterns ?? []) {
      for (const match of findLineMatches(file.content, pattern.pattern)) {
        if (family.id === 'F5-permission-host-ttl' && !isPermissionHostTtlCandidate(file, match.lineIndex)) {
          continue;
        }
        violations.push(createViolation({
          family,
          file,
          lineIndex: match.lineIndex,
          match: pattern.label,
        }));
      }
    }
  }
  return violations;
}

function isProviderTreeCompatibilityReExport(
  family: ForbiddenFamily,
  file: RuntimeUnificationValidatorFile,
): boolean {
  if (family.id !== 'F5-provider-keyed-owner-tree') {
    return false;
  }
  return isApprovedProviderTreeCompatibilityReExport(file);
}

function isApprovedProviderTreeCompatibilityReExport(file: RuntimeUnificationValidatorFile): boolean {
  const approvedSpecifiers = APPROVED_PROVIDER_TREE_COMPATIBILITY_REEXPORTS.get(normalizeRepoPath(file.filePath));
  if (!approvedSpecifiers) {
    return false;
  }
  return isPureCompatibilityReExport(file.content, approvedSpecifiers);
}

function isPureCompatibilityReExport(content: string, approvedSpecifiers: ReadonlySet<string>): boolean {
  const executableLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !line.startsWith('//')
      && !line.startsWith('/*')
      && !line.startsWith('*')
    );

  return executableLines.length > 0
    && executableLines.every((line) => {
      const match = /^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"];?$/.exec(line);
      return match?.[1] ? approvedSpecifiers.has(match[1]) : false;
    });
}

function isPermissionHostTtlCandidate(file: RuntimeUnificationValidatorFile, lineIndex: number): boolean {
  if (isPermissionOwnedPath(file.filePath)) {
    return true;
  }
  const lines = file.content.split(/\r?\n/);
  const start = Math.max(0, lineIndex - 5);
  const end = Math.min(lines.length, lineIndex + 6);
  return PERMISSION_HOST_TTL_CONTEXT_PATTERN.test(lines.slice(start, end).join('\n'));
}

function isPermissionOwnedPath(filePath: string): boolean {
  const normalizedPath = normalizeRepoPath(filePath).toLowerCase();
  return normalizedPath.includes('/permissions/') || normalizedPath.includes('permission');
}

function validateRequiredEvidenceFamily(
  family: RequiredEvidenceFamily,
  files: readonly RuntimeUnificationValidatorFile[],
): CrossCuttingDuplicateViolation[] {
  const matchingFiles = files.filter((file) => isFileInRoots(file.filePath, family.roots));
  let count = 0;
  for (const file of matchingFiles) {
    count += countPatternMatches(file.content, family.pattern);
  }
  if (count >= family.minimumMatches) {
    return [];
  }
  return [
    {
      familyId: family.id,
      filePath: '<repository>',
      line: 1,
      match: 'required evidence',
      canonicalOwner: family.canonicalOwner,
      owningPacket: family.owningPacket,
      message: `${family.id}: required evidence count ${count} < ${family.minimumMatches}; canonical_owner=${family.canonicalOwner}; owning_packet=${family.owningPacket}.`,
    },
  ];
}

function createViolation(input: Readonly<{
  family: ForbiddenFamily;
  file: RuntimeUnificationValidatorFile;
  lineIndex: number;
  match: string;
}>): CrossCuttingDuplicateViolation {
  const line = input.lineIndex + 1;
  return {
    familyId: input.family.id,
    filePath: input.file.filePath,
    line,
    match: input.match,
    canonicalOwner: input.family.canonicalOwner,
    owningPacket: input.family.owningPacket,
    message: `${input.file.filePath}:${line}: ${input.family.id}: forbidden ${input.match}; canonical_owner=${input.family.canonicalOwner}; owning_packet=${input.family.owningPacket}.`,
  };
}

function collectSourceFiles(rootDir: string, roots: readonly string[]): RuntimeUnificationValidatorFile[] {
  const files: RuntimeUnificationValidatorFile[] = [];
  for (const scanRoot of roots) {
    const absolutePath = resolve(rootDir, scanRoot);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (shouldScanFile(scanRoot)) {
        files.push({ filePath: scanRoot, content: readFileSync(absolutePath, 'utf8') });
      }
      continue;
    }
    collectSourceFilesFromDirectory(rootDir, absolutePath, files);
  }
  return dedupeFiles(files);
}

function collectSourceFilesFromDirectory(
  rootDir: string,
  directory: string,
  files: RuntimeUnificationValidatorFile[],
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        collectSourceFilesFromDirectory(rootDir, absolutePath, files);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const filePath = normalizeRepoPath(relative(rootDir, absolutePath));
    if (!shouldScanFile(filePath)) {
      continue;
    }
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

function shouldSkipDirectory(directoryName: string): boolean {
  return directoryName.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(directoryName);
}

function dedupeFiles(files: readonly RuntimeUnificationValidatorFile[]): RuntimeUnificationValidatorFile[] {
  const byPath = new Map<string, RuntimeUnificationValidatorFile>();
  for (const file of files) {
    byPath.set(normalizeRepoPath(file.filePath), {
      filePath: normalizeRepoPath(file.filePath),
      content: file.content,
    });
  }
  return [...byPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function findLineMatches(content: string, pattern: RegExp): ReadonlyArray<Readonly<{ lineIndex: number }>> {
  const matches: Array<Readonly<{ lineIndex: number }>> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const regex = cloneRegex(pattern);
    if (regex.test(lines[index] ?? '')) {
      matches.push({ lineIndex: index });
    }
  }
  return matches;
}

function countPatternMatches(content: string, pattern: RegExp): number {
  const regex = cloneRegex(pattern, true);
  return Array.from(content.matchAll(regex)).length;
}

function cloneRegex(pattern: RegExp, global = false): RegExp {
  const flags = new Set(pattern.flags.split(''));
  if (global) {
    flags.add('g');
  } else {
    flags.delete('g');
  }
  return new RegExp(pattern.source, [...flags].join(''));
}

function isFileInRoots(filePath: string, roots: readonly string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isIgnoredPath(filePath: string, ignoredPaths: readonly string[] | undefined): boolean {
  if (!ignoredPaths) {
    return false;
  }
  const normalized = normalizeRepoPath(filePath);
  return ignoredPaths.some((ignoredPath) => normalized === ignoredPath);
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  const result = validateCrossCuttingDuplicateClosure();
  if (!result.ok) {
    console.error(result.violations.map((violation) => violation.message).join('\n'));
    process.exitCode = 1;
  }
}
