import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const PROVIDER_SETTINGS_SINGLE_OWNER_VALIDATOR_ID = 'PROVIDER-SETTINGS-SDK-1-single-owner';

export interface ProviderSettingsSingleOwnerResult {
  validatorId: typeof PROVIDER_SETTINGS_SINGLE_OWNER_VALIDATOR_ID;
  ok: boolean;
  errors: readonly string[];
  scannedFiles: readonly string[];
}

interface ProviderSettingsSingleOwnerFile {
  path: string;
  content: string;
}

type ProviderSettingsContributionOwner = Readonly<{
  pluginId: string;
  filePath: string;
  contributionConst: string;
  descriptorId: string;
}>;

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN = /^packages\/plugins\/([^/]+)\/src\/providerSettings\/definition\.ts$/;
const PLUGIN_SOURCE_PATH_PATTERN = /^packages\/plugins\/[^/]+\/src\//;
const HOST_PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN = /^packages\/agents\/src\/providerSettings\/definitions\/[^/]+\.ts$/;
const HOST_PROVIDER_SETTINGS_SOURCE_PATH_PATTERN = /^packages\/agents\/src\/providerSettings\/(?!generated\/)/;
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'package-dist',
]);

const HAND_AUTHORED_PROVIDER_SETTINGS_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bkind\s*:\s*['"]providerSettings\.v1['"][\s\S]*\bsettings\s*:\s*\{[\s\S]{0,1000}\bschema\s*:/,
  /\bkind\s*:\s*['"]providerSettings\.v1['"][\s\S]*\buiSections\s*:\s*\[/,
  /\b(?:booleanSetting|enumSetting|jsonObjectStringSetting|stringProviderSetting|defineProviderSettingsContribution)\s*\(/,
]);

const HOST_PROVIDER_ID_BRANCH_PATTERN = /\b(?:providerId|backendId|agentId)\s*[=!]==?\s*['"][^'"]+['"]/;
const PROVIDER_SETTINGS_DESCRIPTOR_ID_PATTERN = /\bdescriptorId\s*:\s*['"]([^'"]+\.providerSettings\.v1)['"]/g;
const PROVIDER_SETTINGS_CONTRIBUTION_ID_PATTERN = /\bid\s*:\s*['"]([^'"]+\.providerSettings\.v1)['"]/;
const GENERATED_PROVIDER_SETTINGS_ID_PATTERN = /\bid["']?\s*:\s*["']([^"']+\.providerSettings\.v1)["']/g;

const HOST_PROVIDER_SETTINGS_FORBIDDEN_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bbuildSettingArtifacts\b/,
  /\b[A-Z0-9_]+_PROVIDER_FIELDS\s*(?::[^=]+)?=\s*(?:Object\.freeze\s*\(\s*)?\{/,
  /\bschema:\s*z\.(?:boolean|string|enum|array|number|union)\s*\(/,
]);

export function validateProviderSettingsSingleOwner(options?: Readonly<{
  rootDir?: string;
  files?: readonly Readonly<{ path: string; content: string }>[];
}>): ProviderSettingsSingleOwnerResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const files = collectProviderSettingsFiles(rootDir, options?.files);
  const fileByPath = new Map(files.map((file) => [file.path, file.content]));
  const errors: string[] = [];
  const scannedFiles = files.map((file) => file.path).sort((left, right) => left.localeCompare(right));

  const contributionOwners = collectContributionOwners(files, errors);
  validateContributionManifests(fileByPath, contributionOwners, errors);
  validateGeneratedBundledProviderSettings(fileByPath, contributionOwners, errors);
  validateHostProviderSettingsDefinitions(files, errors);
  validateNoHandAuthoredProviderSettingsDefinitions(files, errors);
  validateNoOwnerlessRuntimeAffectingDescriptorLeaves(files, contributionOwners, errors);

  return {
    validatorId: PROVIDER_SETTINGS_SINGLE_OWNER_VALIDATOR_ID,
    ok: errors.length === 0,
    errors,
    scannedFiles,
  };
}

function collectProviderSettingsFiles(
  rootDir: string,
  files: readonly Readonly<{ path: string; content: string }>[] | undefined,
): ProviderSettingsSingleOwnerFile[] {
  if (files) {
    return dedupeFiles(files.map((file) => ({
      path: normalizeRepoPath(file.path),
      content: file.content,
    })));
  }

  return collectRepoFiles(rootDir, [
    'packages/plugins',
    'packages/agents/src/providerSettings',
  ]);
}

function collectRepoFiles(rootDir: string, roots: readonly string[]): ProviderSettingsSingleOwnerFile[] {
  const collected: ProviderSettingsSingleOwnerFile[] = [];
  for (const scanRoot of roots) {
    const absolutePath = resolve(rootDir, scanRoot);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (shouldScanSourceFile(scanRoot)) {
        collected.push({ path: normalizeRepoPath(scanRoot), content: readFileSync(absolutePath, 'utf8') });
      }
      continue;
    }
    collectRepoFilesFromDirectory(rootDir, absolutePath, collected);
  }
  return dedupeFiles(collected);
}

function collectRepoFilesFromDirectory(
  rootDir: string,
  directory: string,
  collected: ProviderSettingsSingleOwnerFile[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        collectRepoFilesFromDirectory(rootDir, absolutePath, collected);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const filePath = normalizeRepoPath(relative(rootDir, absolutePath));
    if (!shouldScanSourceFile(filePath)) {
      continue;
    }
    collected.push({ path: filePath, content: readFileSync(absolutePath, 'utf8') });
  }
}

function collectContributionOwners(
  files: readonly ProviderSettingsSingleOwnerFile[],
  errors: string[],
): ProviderSettingsContributionOwner[] {
  const owners: ProviderSettingsContributionOwner[] = [];
  for (const file of files) {
    const definitionPathMatch = PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN.exec(file.path);
    if (!definitionPathMatch || !/defineProviderSettingsContribution/.test(file.content)) {
      continue;
    }

    const contributionConstMatch = /\bexport\s+const\s+([A-Z0-9_]+_PROVIDER_SETTINGS_CONTRIBUTION)\s*=\s*defineProviderSettingsContribution\b/.exec(file.content);
    const pluginId = definitionPathMatch[1] ?? '<unknown>';
    if (!contributionConstMatch) {
      errors.push(`${file.path}: missing required single-owner evidence exported *_PROVIDER_SETTINGS_CONTRIBUTION.`);
      continue;
    }
    const contributionConst = contributionConstMatch[1]!;
    const descriptorId = PROVIDER_SETTINGS_CONTRIBUTION_ID_PATTERN.exec(file.content)?.[1] ?? `${pluginId}.providerSettings.v1`;
    const owner = { pluginId, filePath: file.path, contributionConst, descriptorId };
    owners.push(owner);

    validateRequiredPattern(file, /@happier-dev\/plugin-sdk\/manifest\/providerSettings/, errors);
    validateRequiredPattern(file, /\bdefineProviderSettingsContribution\b/, errors);
    validateRequiredPattern(file, new RegExp(`\\bbuildProviderSettingsDefaults\\s*\\(\\s*${escapeRegExp(contributionConst)}`), errors);
    validateRequiredPattern(file, new RegExp(`\\bproviderSettingsContributionToUiDescriptor\\s*\\(\\s*${escapeRegExp(contributionConst)}`), errors);
    validateForbiddenPattern(file, /@happier-dev\/agents/, errors);
  }
  return owners;
}

function validateContributionManifests(
  fileByPath: ReadonlyMap<string, string>,
  contributionOwners: readonly ProviderSettingsContributionOwner[],
  errors: string[],
): void {
  for (const owner of contributionOwners) {
    const manifestPath = `packages/plugins/${owner.pluginId}/src/manifest.ts`;
    const manifest = fileByPath.get(manifestPath);
    if (!manifest) {
      errors.push(`${manifestPath}: missing required provider-settings manifest owner for ${owner.contributionConst}.`);
      continue;
    }
    const providerSettingsPattern = new RegExp(`\\bproviderSettings\\s*:\\s*\\[\\s*${escapeRegExp(owner.contributionConst)}\\s*\\]`);
    if (!providerSettingsPattern.test(manifest)) {
      errors.push(`${manifestPath}: missing required single-owner evidence providerSettings: [${owner.contributionConst}].`);
    }
  }
}

function validateGeneratedBundledProviderSettings(
  fileByPath: ReadonlyMap<string, string>,
  contributionOwners: readonly ProviderSettingsContributionOwner[],
  errors: string[],
): void {
  const generatedPath = 'packages/agents/src/providerSettings/generated/bundledProviderSettings.ts';
  const generated = fileByPath.get(generatedPath);
  if (!generated && contributionOwners.length === 0) {
    return;
  }
  if (!generated) {
    errors.push(`${generatedPath}: missing required generated provider-settings contribution projection.`);
    return;
  }
  validateRequiredPattern({ path: generatedPath, content: generated }, /BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS/, errors);
  const ownerDescriptorIds = new Set(contributionOwners.map((owner) => owner.descriptorId));
  for (const descriptorId of readGeneratedProviderSettingsDescriptorIds(generated)) {
    if (!ownerDescriptorIds.has(descriptorId)) {
      errors.push(`${generatedPath}: ${descriptorId}: generated provider-settings projection has no canonical plugin contribution owner.`);
    }
  }
  for (const owner of contributionOwners) {
    validateRequiredPattern(
      { path: generatedPath, content: generated },
      new RegExp(`\\bproviderId["']?\\s*:\\s*["']${escapeRegExp(owner.pluginId)}["']`),
      errors,
    );
    validateRequiredPattern(
      { path: generatedPath, content: generated },
      new RegExp(`${escapeRegExp(owner.pluginId)}\\.providerSettings\\.v1`),
      errors,
    );
  }
}

function validateNoOwnerlessRuntimeAffectingDescriptorLeaves(
  files: readonly ProviderSettingsSingleOwnerFile[],
  contributionOwners: readonly ProviderSettingsContributionOwner[],
  errors: string[],
): void {
  const ownerDescriptorIds = new Set(contributionOwners.map((owner) => owner.descriptorId));
  for (const file of files) {
    if (!PLUGIN_SOURCE_PATH_PATTERN.test(file.path) || PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN.test(file.path)) {
      continue;
    }
    if (!isRuntimeAffectingProviderSettingsLeaf(file.content)) {
      continue;
    }
    for (const descriptorId of readProviderSettingsDescriptorIds(file.content)) {
      if (!ownerDescriptorIds.has(descriptorId)) {
        errors.push(`${file.path}: ${descriptorId}: provider-settings descriptor has no canonical contribution owner.`);
      }
    }
  }
}

function isRuntimeAffectingProviderSettingsLeaf(content: string): boolean {
  return /\b(?:uiSections|schema|settings)\s*:/.test(content);
}

function readProviderSettingsDescriptorIds(content: string): string[] {
  return readUniqueMatches(content, PROVIDER_SETTINGS_DESCRIPTOR_ID_PATTERN);
}

function readGeneratedProviderSettingsDescriptorIds(content: string): string[] {
  return readUniqueMatches(content, GENERATED_PROVIDER_SETTINGS_ID_PATTERN);
}

function readUniqueMatches(content: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const values = new Set<string>();
  let match = pattern.exec(content);
  while (match) {
    if (match[1]) {
      values.add(match[1]);
    }
    match = pattern.exec(content);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function validateHostProviderSettingsDefinitions(
  files: readonly ProviderSettingsSingleOwnerFile[],
  errors: string[],
): void {
  for (const file of files) {
    if (HOST_PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN.test(file.path)) {
      errors.push(`${file.path}: per-provider host provider-settings definitions are forbidden; use the generated bundled provider-settings registry as the single host projection owner.`);
    }
    if (!HOST_PROVIDER_SETTINGS_SOURCE_PATH_PATTERN.test(file.path)) {
      continue;
    }
    if (HOST_PROVIDER_ID_BRANCH_PATTERN.test(file.content)) {
      errors.push(`${file.path}: provider-id branching is forbidden in shared provider-settings projections; use the generated bundled provider-settings registry instead.`);
    }
    for (const pattern of HOST_PROVIDER_SETTINGS_FORBIDDEN_PATTERNS) {
      validateForbiddenPattern(file, pattern, errors);
    }
  }
}

function validateNoHandAuthoredProviderSettingsDefinitions(
  files: readonly ProviderSettingsSingleOwnerFile[],
  errors: string[],
): void {
  for (const file of files) {
    if (!PLUGIN_SOURCE_PATH_PATTERN.test(file.path) || PROVIDER_SETTINGS_DEFINITION_PATH_PATTERN.test(file.path)) {
      continue;
    }
    for (const pattern of HAND_AUTHORED_PROVIDER_SETTINGS_PATTERNS) {
      if (pattern.test(file.content)) {
        errors.push(`${file.path}: hand-authored provider-settings definition is forbidden; define fields once via packages/plugins/<id>/src/providerSettings/definition.ts.`);
        break;
      }
    }
  }
}

function validateRequiredPattern(
  file: Readonly<{ path: string; content: string }>,
  pattern: RegExp,
  errors: string[],
): void {
  if (!pattern.test(file.content)) {
    errors.push(`${file.path}: missing required single-owner evidence ${String(pattern)}`);
  }
}

function validateForbiddenPattern(
  file: Readonly<{ path: string; content: string }>,
  pattern: RegExp,
  errors: string[],
): void {
  if (pattern.test(file.content)) {
    errors.push(`${file.path}: found forbidden duplicate provider-settings ownership pattern ${String(pattern)}`);
  }
}

function shouldScanSourceFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return SOURCE_FILE_PATTERN.test(normalized) && !TEST_FILE_PATTERN.test(normalized);
}

function shouldSkipDirectory(directoryName: string): boolean {
  return directoryName.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(directoryName);
}

function dedupeFiles(files: readonly ProviderSettingsSingleOwnerFile[]): ProviderSettingsSingleOwnerFile[] {
  const byPath = new Map<string, ProviderSettingsSingleOwnerFile>();
  for (const file of files) {
    const normalizedPath = normalizeRepoPath(file.path);
    byPath.set(normalizedPath, { path: normalizedPath, content: file.content });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRepoPath(path: string): string {
  return path.split('\\').join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
