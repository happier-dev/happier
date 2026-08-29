import { collectFileInventory, type InventoryFile } from './collectFileInventory.ts';
import { formatSimpleSections } from './formatGovernanceReport.ts';
import { GOVERNANCE_REPORT_PATHS } from './reportPaths.ts';
import { writeGovernanceReports } from '../writeGovernanceReports.ts';
import {
  collectV2ZeroLaneExtractReports,
  formatV2ZeroLaneExtractMarkdown,
} from './v2ZeroLaneExtracts.ts';

export interface V2ZeroInventoryMatcher {
  filePathIncludes?: string;
  filePathExcludes?: string;
  filePathMatches?: RegExp;
  contentIncludes?: string;
  contentMatches?: RegExp;
}

export interface V2ZeroInventoryCategorySpec {
  id: string;
  title: string;
  description: string;
  migrationScaffold: string;
  matchAnyOf: readonly V2ZeroInventoryMatcher[];
  matchStrategy?: 'any' | 'customacp-sentinel-consumers' | 'shared-core-provider-branching' | 'runtimecore-create-session-runtime-whole-runner-delegation' | 'opencode-family-permission-policy-drift' | 'voice-v3-f-v2-media-residue';
}

export interface V2ZeroInventoryCategoryReport {
  id: string;
  title: string;
  description: string;
  migrationScaffold: string;
  count: number;
  files: readonly string[];
}

export interface V2ZeroInventoryReport {
  filesScanned: number;
  filesMatched: number;
  totalMatches: number;
  categories: readonly V2ZeroInventoryCategoryReport[];
}

// Treat vendored/public assets and generated client outputs as non-source for governance scans.
const GENERATED_PATH_FRAGMENT = /(?:^|\/)(?:output|dist|build|coverage|node_modules|out|\.expo|package-dist|\.dist[^/]*|public|generated)(?:\/|$)/;
const NON_PRODUCTION_PATH_FRAGMENT = /(?:^|\/)(?:__tests__|__fixtures__|testkit|trash)(?:\/|$)|\.testkit\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const VOICE_V3_F_V2_MEDIA_RESIDUE_IDENTIFIER_PATTERN =
  /\b(?:VoiceMediaAgentRealtime[A-Za-z0-9_]*|voiceMediaAgentRealtime[A-Za-z0-9_]*|dispatchVoiceMediaAgentRealtimeBinaryFrame|(?:admit|bind|open|close)AgentRealtimeAttempt)\b/;
const VOICE_V3_F_V2_MEDIA_APPLICATION_KIND_PATTERN =
  /(?:\bz\.literal\s*\(\s*|\bapplicationKind\s*(?::|===|!==)\s*)['"]agent_realtime['"]/;
const VOICE_V3_F_V2_MEDIA_KIND_LITERAL_PATTERN = /['"]agent_realtime['"]/;
const VOICE_V3_F_V2_PCM_FRAME_PATTERN =
  /\b(?:pcm_s16le|PCM|Pcm|input_audio|output_audio|sampleRateHz|bytesPerSample)\b/;
const VOICE_V3_F_NON_PRODUCT_PATH_FRAGMENT =
  /(?:^|\/)(?:scripts\/testing\/migrations|\.(?:restore|tmp)[^/]*)(?:\/|$)/;
const CUSTOM_ACP_NEUTRAL_COMPAT_PATHS = new Set([
  'apps/ui/sources/voice/tools/actionImpl/agentCatalogList.ts',
  'apps/ui/sources/voice/tools/actionImpl/spawnSessionAgent.ts',
]);

const PROVIDER_IDS = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'copilot',
  'customAcp',
  'pi',
  'ohMyPi',
] as const;

function matchesMatcher(file: InventoryFile, matcher: V2ZeroInventoryMatcher): boolean {
  if (matcher.filePathIncludes && !file.filePath.includes(matcher.filePathIncludes)) {
    return false;
  }

  if (matcher.filePathExcludes && file.filePath.includes(matcher.filePathExcludes)) {
    return false;
  }

  if (matcher.filePathMatches && !matcher.filePathMatches.test(file.filePath)) {
    return false;
  }

  if (matcher.contentIncludes && !file.content.includes(matcher.contentIncludes)) {
    return false;
  }

  if (matcher.contentMatches && !matcher.contentMatches.test(file.content)) {
    return false;
  }

  return true;
}

function matchesAny(file: InventoryFile, matchAnyOf: readonly V2ZeroInventoryMatcher[]): boolean {
  return matchAnyOf.some((matcher) => matchesMatcher(file, matcher));
}

const SHARED_CORE_PROVIDER_BRANCHING_PATH_EXCLUDES = /(?:^|\/)(?:backends|providers|plugins|voice)(?:\/|$)/;
const SHARED_CORE_PROVIDER_BRANCHING_PROVIDER_PATTERN = new RegExp(`\\b(?:${PROVIDER_IDS.join('|')})\\b`);
const SHARED_CORE_PROVIDER_BRANCHING_DECISION_PATTERN = /\b(?:if|else|switch|case|return|throw)\b|(?:===|!==|==|!=)|(?:\?\s)|(?:&&|\|\|)|(?:includes|startsWith|endsWith)\s*\(/;
const RUNTIME_CORE_FILE_PATTERN = /^apps\/cli\/src\/backends\/[^/]+\/runtimeCore\/.+\.ts$/;
const PROVIDER_RUNTIME_FILE_PATTERN = /^apps\/cli\/src\/backends\/[^/]+\/runtime\/.+\.ts$/;
const WHOLE_SESSION_RUNNER_CALL_PATTERN = /\b(?:runCodex|runClaude|runOpenCode|runGemini|runPi|runQwen|runKimi|runKilo|runCopilot|runAuggie|run[A-Z][A-Za-z]+Session(?:Command|Runtime))\s*\(/;
const WHOLE_SESSION_RUNNER_DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:runCodex|runClaude|runOpenCode|runGemini|runPi|runQwen|runKimi|runKilo|runCopilot|runAuggie|run[A-Z][A-Za-z]+Session(?:Command|Runtime))\s*\(/;
const NON_TYPE_LEGACY_PROVIDER_RUNNER_IMPORT_PATTERN = /^\s*import\s+(?!type\b)[^\n]*\bfrom\s+['"]\.\.\/run[A-Z][A-Za-z]*(?:SessionCommand|SessionLifecycle)?['"]/m;
const CREATE_SESSION_RUNTIME_PATTERN = /\bcreateSessionRuntime\b/;
const RUNTIME_RUN_CALL_PATTERN = /\b[\w$]+\s*\.\s*run\s*\(/;
const LEGACY_RUNTIME_LOOP_ALIAS_NAME = ['Runtime', 'For', 'Loop'].join('');
const LEGACY_BACKEND_ALIAS_NAME = ['Agent', 'Backend'].join('');
const LEGACY_RUNTIME_LOOP_ALIAS_WORD = String.raw`\b${LEGACY_RUNTIME_LOOP_ALIAS_NAME}\b`;
const LEGACY_BACKEND_ALIAS_WORD = String.raw`\b${LEGACY_BACKEND_ALIAS_NAME}\b`;
const AGENT_BACKEND_SEMANTIC_USAGE_PATTERN = new RegExp(String.raw`(?:import\s+type\s*\{[^}]*${LEGACY_BACKEND_ALIAS_WORD}[^}]*\}|:\s*${LEGACY_BACKEND_ALIAS_WORD}|=>\s*${LEGACY_BACKEND_ALIAS_WORD}|\bextends\s+${LEGACY_BACKEND_ALIAS_WORD}|\bas\s+${LEGACY_BACKEND_ALIAS_WORD}|\bkeyof\s+${LEGACY_BACKEND_ALIAS_WORD})`);
const AGENT_BACKEND_SURFACE_GROWTH_PATTERN = new RegExp(String.raw`\b(?:extends\s+${LEGACY_BACKEND_ALIAS_WORD}|${LEGACY_BACKEND_ALIAS_NAME}\s*&\s*\{|as\s+${LEGACY_BACKEND_ALIAS_NAME}\s*&\s*\{|keyof\s+${LEGACY_BACKEND_ALIAS_WORD})`);
const EXECUTION_RUN_HOST_AGENTBACKEND_FILE_PATTERN = /^apps\/cli\/src\/agent\/(?:runtime\/bridges\/executionRun\/ExecutionRunHostBridge\.ts|executionRuns\/(?:runtime\/(?:backendLongLivedSend|resumeBackendController|runEphemeralExecutionRunTextPrompt)\.ts|runtime\/executionRunManager\/(?:startExecutionRun|ensureExecutionRun)\.ts|tasks\/createExecutionRunTextPromptBackendForTarget\.ts))$/;
const EXECUTION_RUN_AGENTBACKEND_RETIREMENT_OWNER_FILE_PATTERN = /^apps\/cli\/src\/agent\/executionRuns\/runtime\/(?:createExecutionRunBackend|executionRunAgentBackendRetirementAdapters)\.ts$/;
const EXECUTION_RUN_AGENTBACKEND_RETIREMENT_OWNER_PATTERN = new RegExp(String.raw`(?:import\s+type\s*\{[^}]*${LEGACY_BACKEND_ALIAS_WORD}[^}]*\}|:\s*${LEGACY_BACKEND_ALIAS_WORD}|=>\s*${LEGACY_BACKEND_ALIAS_WORD})|\b(?:createAgentBackendFromExecutionRunHostRuntime|createExecutionRunHostRuntimeFromAgentBackend)\b`);
const EXECUTION_RUN_PROVIDER_AGENTBACKEND_FILE_PATTERN =
  /^apps\/cli\/src\/(?:backends\/[^/]+\/(?:executionRuns\/.+|rpc\/[^/]+|sdkAgentBackend\/[^/]+)\.[cm]?[jt]sx?|agent\/reviews\/engines\/coderabbit\/CodeRabbitReviewBackend\.ts)$/;
const EXECUTION_RUN_PROVIDER_AGENTBACKEND_PATTERN = new RegExp(String.raw`\b(?:implements\s+${LEGACY_BACKEND_ALIAS_NAME}\s*,\s*ExecutionRunHostRuntime|${LEGACY_BACKEND_ALIAS_NAME}\s*&\s*ExecutionRunHostRuntime)\b`);
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const OPENCODE_PERMISSION_OWNER_PATH = 'apps/cli/src/backends/opencode/permission/';
const OPENCODE_PERMISSION_IDENTIFIER_PATTERN = /\bOPENCODE_(?:READ|EDIT|SAFE_ALLOW|ALWAYS_ALLOW)_PERMISSIONS\b/;
const OPENCODE_PERMISSION_INTENT_LITERALS = ['yolo', 'bypassPermissions', 'safe-yolo', 'read-only', 'plan'] as const;
const OPENCODE_PERMISSION_READ_LITERALS = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const OPENCODE_PERMISSION_EDIT_LITERALS = ['edit', 'write'] as const;
const OPENCODE_PERMISSION_ALWAYS_ALLOW_LITERALS = ['change_title', 'save_memory', 'think'] as const;
const OPENCODE_PERMISSION_DECISION_LITERALS = ['allow', 'ask', 'deny'] as const;

function stripCommentsOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function stripVoiceV3FNegativeTestAssertions(content: string): string {
  return content
    .replace(/\.\s*not\s*\.\s*toContain\s*\([^)]*\)/g, ' ')
    .replace(/\bassert\.doesNotMatch\s*\([^;]*;?/g, ' ');
}

function matchesVoiceV3FV2MediaResidue(file: InventoryFile): boolean {
  if (VOICE_V3_F_NON_PRODUCT_PATH_FRAGMENT.test(file.filePath)) {
    return false;
  }

  const content = stripCommentsOnly(
    TEST_FILE_PATTERN.test(file.filePath)
      ? stripVoiceV3FNegativeTestAssertions(file.content)
      : file.content,
  );

  return VOICE_V3_F_V2_MEDIA_RESIDUE_IDENTIFIER_PATTERN.test(content)
    || VOICE_V3_F_V2_MEDIA_APPLICATION_KIND_PATTERN.test(content)
    || (
      VOICE_V3_F_V2_MEDIA_KIND_LITERAL_PATTERN.test(content)
      && VOICE_V3_F_V2_PCM_FRAME_PATTERN.test(content)
    );
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countQuotedLiteralMatches(codeText: string, literals: readonly string[]): number {
  return literals.filter((literal) => new RegExp(`['"\`]${escapeForRegExp(literal)}['"\`]`).test(codeText)).length;
}

function countUniqueWildcardDecisionValues(codeText: string): number {
  const values = new Set<string>();

  for (const match of codeText.matchAll(/['"]\*['"]\s*:\s*['"](allow|ask|deny)['"]/g)) {
    const value = match[1];
    if (value) {
      values.add(value);
    }
  }

  return values.size;
}

/**
 * The declared `matchAnyOf` scope is the category's contract: shared/core
 * product code. The strategy only *refines* it, by keeping a file when a single
 * line both names a provider and makes a decision on it. Without the scope
 * check this counted scripts, marketing data, test fixtures and its own source
 * as shared-core provider branching.
 */
function matchesSharedCoreProviderBranching(
  file: InventoryFile,
  matchAnyOf: readonly V2ZeroInventoryMatcher[],
): boolean {
  if (!matchesAny(file, matchAnyOf)) {
    return false;
  }
  if (SHARED_CORE_PROVIDER_BRANCHING_PATH_EXCLUDES.test(file.filePath)) {
    return false;
  }

  const codeText = stripCommentsOnly(file.content);
  return codeText
    .split(/\r?\n/)
    .some((line) => SHARED_CORE_PROVIDER_BRANCHING_PROVIDER_PATTERN.test(line) && SHARED_CORE_PROVIDER_BRANCHING_DECISION_PATTERN.test(line));
}

function hasWholeSessionRunnerCall(codeText: string): boolean {
  return codeText
    .split(/\r?\n/)
    .some((line) =>
      WHOLE_SESSION_RUNNER_CALL_PATTERN.test(line)
      && !WHOLE_SESSION_RUNNER_DECLARATION_PATTERN.test(line)
      && !/^\s*import\b/.test(line)
    );
}

function matchesRuntimeCoreCreateSessionRuntimeWholeRunnerDelegation(file: InventoryFile): boolean {
  const codeText = stripCommentsOnly(file.content);

  if (RUNTIME_CORE_FILE_PATTERN.test(file.filePath)) {
    const isTopLevelRuntimeCoreOwner = /^apps\/cli\/src\/backends\/[^/]+\/runtimeCore\/[^/]+\.ts$/.test(file.filePath);
    if (isTopLevelRuntimeCoreOwner && !CREATE_SESSION_RUNTIME_PATTERN.test(codeText)) {
      return false;
    }

    return RUNTIME_RUN_CALL_PATTERN.test(codeText) || hasWholeSessionRunnerCall(codeText);
  }

  if (!PROVIDER_RUNTIME_FILE_PATTERN.test(file.filePath)) {
    return false;
  }

  return NON_TYPE_LEGACY_PROVIDER_RUNNER_IMPORT_PATTERN.test(codeText) || hasWholeSessionRunnerCall(codeText);
}

function matchesOpenCodePermissionPolicyDrift(file: InventoryFile): boolean {
  if (!file.filePath.startsWith('apps/cli/src/backends/')) {
    return false;
  }

  if (file.filePath.startsWith(OPENCODE_PERMISSION_OWNER_PATH)) {
    return false;
  }

  if (!SOURCE_FILE_PATTERN.test(file.filePath)) {
    return false;
  }

  const codeText = stripCommentsOnly(file.content);
  if (OPENCODE_PERMISSION_IDENTIFIER_PATTERN.test(codeText)) {
    return true;
  }

  const intentCount = countQuotedLiteralMatches(codeText, OPENCODE_PERMISSION_INTENT_LITERALS);
  const readCount = countQuotedLiteralMatches(codeText, OPENCODE_PERMISSION_READ_LITERALS);
  const editCount = countQuotedLiteralMatches(codeText, OPENCODE_PERMISSION_EDIT_LITERALS);
  const alwaysAllowCount = countQuotedLiteralMatches(codeText, OPENCODE_PERMISSION_ALWAYS_ALLOW_LITERALS);
  const decisionCount = countQuotedLiteralMatches(codeText, OPENCODE_PERMISSION_DECISION_LITERALS);
  const wildcardDecisionCount = countUniqueWildcardDecisionValues(codeText);
  const hasPermissionModeBranching = /\bPermissionMode\b|\bnormalizePermissionModeToIntent\b/.test(codeText);

  return hasPermissionModeBranching
    && intentCount >= 4
    && readCount >= 4
    && editCount === OPENCODE_PERMISSION_EDIT_LITERALS.length
    && alwaysAllowCount >= 2
    && decisionCount === OPENCODE_PERMISSION_DECISION_LITERALS.length
    && wildcardDecisionCount === OPENCODE_PERMISSION_DECISION_LITERALS.length;
}

function matchesCustomAcpSentinelConsumer(file: InventoryFile): boolean {
  if (CUSTOM_ACP_NEUTRAL_COMPAT_PATHS.has(file.filePath)) {
    return false;
  }

  // Keep this signal focused on behavior-bearing code paths, not translation copy or prose that
  // merely documents the sentinel: a comment cannot consume it, and counting comments would make
  // deleting an explanatory comment look like a migration win.
  const codeOnly: InventoryFile = { ...file, content: stripCommentsOnly(file.content) };

  return matchesAny(codeOnly, [
    { filePathIncludes: 'apps/cli/src/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'packages/agents/src/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'packages/protocol/src/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'apps/ui/sources/app/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'apps/ui/sources/agents/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'apps/ui/sources/components/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'apps/ui/sources/sync/', contentMatches: /\bcustomAcp\b/ },
    { filePathIncludes: 'apps/ui/sources/voice/', contentMatches: /\bcustomAcp\b/ },
  ]);
}

function extractNonTypeRelativeImportSpecifiers(content: string): readonly string[] {
  const specifiers = new Set<string>();

  for (const match of content.matchAll(/^\s*import\s+(?!type\b)[^\n]*?\bfrom\s+['"](\.[^'"]+)['"]/gm)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  for (const match of content.matchAll(/^\s*export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  for (const match of content.matchAll(/^\s*export\s+\{[^}]*\}\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function normalizeRelativePathSegments(path: string): string {
  const normalized: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

function dirname(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf('/');
  return separatorIndex === -1 ? '' : filePath.slice(0, separatorIndex);
}

function resolveRelativeImportPath(
  filePath: string,
  specifier: string,
  fileMap: ReadonlyMap<string, InventoryFile>,
): string | null {
  const basePath = normalizeRelativePathSegments(`${dirname(filePath)}/${specifier}`);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
    `${basePath}/index.js`,
    `${basePath}/index.jsx`,
    `${basePath}/index.mts`,
    `${basePath}/index.cts`,
  ];

  for (const candidate of candidates) {
    if (fileMap.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function providerRootForFilePath(filePath: string): string | null {
  const match = /^(apps\/cli\/src\/backends\/[^/]+)\//.exec(filePath);
  return match?.[1] ?? null;
}

function collectRecursiveRuntimeRunnerDelegationMatches(files: readonly InventoryFile[]): Set<string> {
  const fileMap = new Map(files.map((file) => [file.filePath, file] as const));
  const offenders = new Set<string>();
  const entrypoints = files.filter((file) => {
    const codeText = stripCommentsOnly(file.content);
    return (RUNTIME_CORE_FILE_PATTERN.test(file.filePath) && CREATE_SESSION_RUNTIME_PATTERN.test(codeText))
      || PROVIDER_RUNTIME_FILE_PATTERN.test(file.filePath);
  });

  for (const entrypoint of entrypoints) {
    const providerRoot = providerRootForFilePath(entrypoint.filePath);
    if (!providerRoot) {
      continue;
    }

    const visited = new Set<string>();
    const queue = [entrypoint.filePath];

    while (queue.length > 0) {
      const currentFilePath = queue.shift();
      if (!currentFilePath || visited.has(currentFilePath)) {
        continue;
      }
      visited.add(currentFilePath);

      const currentFile = fileMap.get(currentFilePath);
      if (!currentFile) {
        continue;
      }

      const codeText = stripCommentsOnly(currentFile.content);
      if (
        currentFilePath !== entrypoint.filePath
        && (
          NON_TYPE_LEGACY_PROVIDER_RUNNER_IMPORT_PATTERN.test(codeText)
          || RUNTIME_RUN_CALL_PATTERN.test(codeText)
          || hasWholeSessionRunnerCall(codeText)
        )
      ) {
        offenders.add(currentFilePath);
      }

      for (const specifier of extractNonTypeRelativeImportSpecifiers(currentFile.content)) {
        const resolved = resolveRelativeImportPath(currentFilePath, specifier, fileMap);
        if (!resolved || !resolved.startsWith(`${providerRoot}/`)) {
          continue;
        }
        queue.push(resolved);
      }
    }
  }

  return offenders;
}

function matchesCategory(file: InventoryFile, spec: V2ZeroInventoryCategorySpec): boolean {
  if (spec.matchStrategy === 'customacp-sentinel-consumers') {
    return matchesCustomAcpSentinelConsumer(file);
  }

  if (spec.matchStrategy === 'shared-core-provider-branching') {
    return matchesSharedCoreProviderBranching(file, spec.matchAnyOf);
  }

  if (spec.matchStrategy === 'runtimecore-create-session-runtime-whole-runner-delegation') {
    return matchesRuntimeCoreCreateSessionRuntimeWholeRunnerDelegation(file);
  }

  if (spec.matchStrategy === 'opencode-family-permission-policy-drift') {
    return matchesOpenCodePermissionPolicyDrift(file);
  }

  if (spec.matchStrategy === 'voice-v3-f-v2-media-residue') {
    return matchesVoiceV3FV2MediaResidue(file);
  }

  return matchesAny(file, spec.matchAnyOf);
}

function countUniqueFiles(categories: readonly V2ZeroInventoryCategoryReport[]): number {
  return new Set(categories.flatMap((category) => category.files)).size;
}

function createCategorySpec(spec: V2ZeroInventoryCategorySpec): V2ZeroInventoryCategorySpec {
  return spec;
}

export const V2_ZERO_INVENTORY_CATEGORY_SPECS: readonly V2ZeroInventoryCategorySpec[] = Object.freeze([
  createCategorySpec({
    id: 'builtin-cli-catalog-consumers',
    title: 'Built-in CLI catalog consumers',
    description: 'CLI files that still reach into the built-in catalog or the merged contribution shell.',
    migrationScaffold: 'Use this list to rewrite host-owned catalog reads toward the merged contribution registry and then shrink the legacy shell.',
    matchAnyOf: [
      { filePathIncludes: 'apps/cli/src/plugins/registry/createResolvedContributionRegistry.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/registry/resolveBuiltInContributions.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/registry/resolvePluginContributions.ts' },
      { filePathIncludes: 'apps/cli/src/capabilities/registry/toolExecutionRuns.ts' },
      { filePathIncludes: 'apps/cli/src/rpc/handlers/capabilities.ts' },
      { filePathIncludes: 'apps/cli/src/daemon/backendTargetRouting.ts' },
      { filePathIncludes: 'apps/cli/src/session/fork/resolveSessionForkBackendTarget.ts' },
      { filePathIncludes: 'apps/cli/src/session/replay/resolveContinueWithReplayBackendTarget.ts' },
      { filePathIncludes: 'apps/cli/src/session/services/deriveExecutionRunPublicStatesFromHistory.ts' },
      { filePathIncludes: 'apps/cli/src/cli/commands/session/shared/normalizeBackendTargetKeys.ts' },
      { filePathIncludes: 'apps/cli/', contentIncludes: '@/backends/catalog' },
      { filePathIncludes: 'apps/cli/', contentIncludes: 'getResolvedContributionRegistry' },
      { filePathIncludes: 'apps/cli/', contentIncludes: 'resolveBuiltInContributions' },
      { filePathIncludes: 'apps/cli/', contentIncludes: 'resolvePluginContributions' },
      { filePathIncludes: 'apps/cli/', contentIncludes: 'primeResolvedContributionRegistry' },
      { filePathIncludes: 'apps/cli/', contentIncludes: 'requireCatalogEntry' },
    ],
  }),
  createCategorySpec({
    id: 'static-ui-registry-consumers',
    title: 'Static UI provider/backend registry consumers',
    description: 'UI files that still project providers/backends from the current static registry helpers.',
    migrationScaffold: 'Use this list to move UI screens and helpers onto merged descriptor projections instead of static registries.',
    matchAnyOf: [
      { filePathIncludes: 'apps/ui/sources/agents/registry/registryCore.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/registry/registryUi.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/registry/registryUiBehavior.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/backendCatalog/backendTargetRouteParams.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/backendCatalog/resolvePreferredBackendTargetFromSettings.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/providers/registry/providerSettingsRegistry.ts' },
      { filePathIncludes: 'apps/ui/sources/agents/providers/registry/providerLocalAuthRegistry.ts' },
      { filePathIncludes: 'apps/ui/', contentIncludes: '@/agents/registry/registryCore' },
      { filePathIncludes: 'apps/ui/', contentIncludes: '@/agents/registry/registryUi' },
      { filePathIncludes: 'apps/ui/', contentIncludes: '@/agents/registry/registryUiBehavior' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'getResolvedBackendCatalogEntries' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'backendTargetRouteParams' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'resolvePreferredBackendTargetFromSettings' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'resolvePersistedAgentIdForBackendTarget' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'providerSettingsRegistry' },
      { filePathIncludes: 'apps/ui/', contentIncludes: 'providerLocalAuthRegistry' },
    ],
  }),
  createCategorySpec({
    id: 'customacp-sentinel-consumers',
    title: 'customAcp sentinel consumers',
    description: 'Files that still rely on the legacy customAcp sentinel in live behavior or compatibility paths.',
    migrationScaffold: 'Use this list to reduce customAcp to compatibility-only reads and remove new writes or routing decisions.',
    matchStrategy: 'customacp-sentinel-consumers',
    matchAnyOf: [],
  }),
  createCategorySpec({
    id: 'shared-core-provider-branching',
    title: 'Shared/core provider-name branching',
    description: 'Shared code that still branches on provider names or hardcoded provider ids instead of using canonical registry hooks.',
    migrationScaffold: 'Use this list to move provider-specific branching behind registry hooks or provider-owned modules.',
    matchStrategy: 'shared-core-provider-branching',
    matchAnyOf: [
      // `packages/cli-common/src/` is shared product code consumed by the CLI;
      // its provider branching is exactly what this category names, and the
      // pre-scope implementation was already counting it. Declaring it keeps
      // that real debt visible instead of letting a relocation hide it.
      { filePathIncludes: 'packages/cli-common/src/', contentMatches: /\b(?:claude|codex|opencode|gemini|auggie|qwen|kimi|kilo|kiro|copilot|customAcp|pi|ohMyPi)\b/ },
      { filePathIncludes: 'packages/agents/src/', contentMatches: /\b(?:claude|codex|opencode|gemini|auggie|qwen|kimi|kilo|kiro|copilot|customAcp|pi|ohMyPi)\b/ },
      { filePathIncludes: 'packages/protocol/src/', contentMatches: /\b(?:claude|codex|opencode|gemini|auggie|qwen|kimi|kilo|kiro|copilot|customAcp|pi|ohMyPi)\b/ },
      { filePathIncludes: 'apps/cli/src/', contentMatches: /\b(?:claude|codex|opencode|gemini|auggie|qwen|kimi|kilo|kiro|copilot|customAcp|pi|ohMyPi)\b/ },
      { filePathIncludes: 'apps/ui/sources/', contentMatches: /\b(?:claude|codex|opencode|gemini|auggie|qwen|kimi|kilo|kiro|copilot|customAcp|pi|ohMyPi)\b/ },
    ],
  }),
  createCategorySpec({
    id: 'hook-emission-sites',
    title: 'Current hook emission sites',
    description: 'Files that currently define, dispatch, or materialize lifecycle hook behavior.',
    migrationScaffold: 'Use this list to centralize lifecycle emission points before external hook families are promoted.',
    matchAnyOf: [
      { filePathIncludes: 'packages/protocol/src/hooks/hookExecutionSemantics.ts' },
      { filePathIncludes: 'packages/protocol/src/plugins/hookEventEnvelopeV1.ts' },
      { filePathIncludes: 'packages/protocol/src/plugins/hookRegistrationV1.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/manifest/validate.ts' },
      { filePathIncludes: 'apps/cli/src/daemon/spawnHooks.ts' },
      { filePathIncludes: 'apps/cli/src/backends/claude/startup/tasks/startHookServerTask.ts' },
      { filePathIncludes: 'apps/cli/src/backends/claude/utils/startHookServer.ts' },
      { filePathIncludes: 'apps/cli/src/backends/claude/remote/agentSdk/buildClaudeAgentSdkHooks.ts' },
      { filePathIncludes: 'apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts' },
      { filePathIncludes: 'apps/cli/src/backends/claude/remote/claudeRemoteMetaState.ts' },
      { filePathIncludes: 'apps/cli/src/backends/opencode/acp/runtime.ts' },
      { filePathIncludes: 'apps/cli/src/backends/codex/acp/runtime.ts' },
    ],
  }),
  createCategorySpec({
    id: 'voice-runtime-entrypoints',
    title: 'Current voice runtime entrypoints',
    description: 'CLI and UI files that still own the first-party voice runtime path directly.',
    migrationScaffold: 'Use this list to keep the daemon voice path on the unified execution-run substrate while leaving broader voice parity for the delayed closure lane.',
    matchAnyOf: [
      { filePathIncludes: 'apps/cli/src/cli/commands/session/voiceAgent/start.ts' },
      { filePathIncludes: 'apps/cli/src/agent/executionRuns/profiles/voiceAgent/VoiceAgentProfile.ts' },
      { filePathIncludes: 'apps/cli/src/agent/executionRuns/runtime/voiceAgentTurnStreams.ts' },
      { filePathIncludes: 'apps/cli/src/agent/voice/agent/VoiceAgentManager.ts' },
      { filePathIncludes: 'apps/cli/src/agent/voice/agent/voiceAgentPrompts.ts' },
      { filePathIncludes: 'apps/cli/src/agent/voice/agent/voiceAgentTypes.ts' },
      { filePathIncludes: 'apps/cli/src/agent/voice/agent/voiceAgentStreamingDeltas.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/agent/initializeVoiceAgentHandle.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/agent/daemonVoiceAgentClient.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/agent/openaiCompatVoiceAgentClient.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/adapters/registerBuiltinVoiceAdapters.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/session/voiceSessionManager.ts' },
      { filePathIncludes: 'apps/ui/sources/voice/surface/VoiceSurface.tsx' },
    ],
  }),
  createCategorySpec({
    id: 'voice-v3-f-v2-media-residue',
    title: 'Voice V3-F V2 media contraction residue',
    description: 'Production owners and positive tests that retain voice_media(agent_realtime), its PCM/frame schemas, media authority, dispatcher, encryption, or tunnel consumers.',
    migrationScaffold: 'Keep this hard-zero release category red until the approved V3-F contraction gate authorizes atomic deletion; retain voice_media(speech_transcription).',
    matchStrategy: 'voice-v3-f-v2-media-residue',
    matchAnyOf: [],
  }),
  createCategorySpec({
    id: 'shared-session-retirement-compatibility-surfaces',
    title: 'Shared-session retirement compatibility surfaces',
    description: 'Files that still carry the explicit host-session retirement seam while OP-B/G remains in progress.',
    migrationScaffold: 'Use this list to keep the retirement seam narrow, visible, and shrinking until the shared-session neutralization lane closes.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/',
        contentMatches: /\bHostSessionRuntimeRetirement\b|\bcreateRetiredHostSessionRuntime\b|\bcreateAcpHostSessionRuntimeRetirement\b/,
      },
    ],
  }),
  createCategorySpec({
    id: 'acp-shared-session-compatibility-surfaces',
    title: 'ACP shared-session compatibility surfaces',
    description: 'ACP-owned files that still touch the neutral host-session scaffolding while configured/catalog ACP remain on compatibility adapters.',
    migrationScaffold: 'Use this list to prevent new ACP-named shared helpers from regrowing outside the exact compatibility allowlist.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/agent/acp/',
        contentMatches: /@\/agent\/runtime\/sessionLoop\/|(?:\.\.\/)+agent\/runtime\/sessionLoop\/|\bHostSessionRuntime(?:Plan|RunOptions|Retirement)\b|\brunHostSessionRuntime(?:Plan)?\b|\bcreateCatalogHostSessionRuntimePlan\b/,
      },
    ],
  }),
  createCategorySpec({
    id: 'provider-session-loop-primitive-imports',
    title: 'Provider session-loop primitive imports',
    description: 'Provider-owned files that still import queue, wait, startup, ready, archive, or termination primitives owned by the shared session loop.',
    migrationScaffold: 'Use this list to move provider files off session-loop primitives and into the shared session loop owner below SessionHostBridge.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/backends/',
        contentMatches: /@\/agent\/runtime\/(?:modeMessageQueue|waitForMessagesOrPending|waitForNextPermissionModeMessage|createPermissionModeQueueState|initializeBackendRunSession|initializeBackendApiContext|createSessionMetadata|createStartupMetadataOverrides|runnerTerminationHandlers|runPermissionModePromptLoop|cleanupBackendRunResources|resolveRunnerMcpServers|createRuntimeOverrideSynchronizers|sendReadyWithPushNotification)|@\/rpc\/handlers\/killSession|@\/session\/services\/archiveAndCloseRuntimeSession/,
      },
    ],
  }),
  createCategorySpec({
    id: 'codex-legacy-direct-session-runner-imports',
    title: 'Codex legacy direct-session runner imports',
    description: 'Production files that re-import the retirement-only Codex direct runner instead of routing through runCodex.ts or the shared session bridge.',
    migrationScaffold: 'Use this list to keep runCodexSessionCommand.ts hard-isolated as retirement debt only and prevent new production callers from bypassing the host-owned Codex seam.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/',
        contentMatches: /from ['"][^'"]*runCodexSessionCommand(?:\.[cm]?[jt]s)?['"]/,
      },
    ],
  }),
  createCategorySpec({
    id: 'runtimecore-create-session-runtime-whole-runner-delegation',
    title: 'runtimeCore.createSessionRuntime constructor-executor delegation',
    description: 'runtimeCore session constructors and provider runtime wrappers that still execute whole-provider session runners instead of returning the lower session operation surface.',
    migrationScaffold: 'Use this list to keep runtimeCore.createSessionRuntime(...) as a constructor only and prevent whole-runner execution from being hidden behind runtime.run() or provider runtime wrappers.',
    matchStrategy: 'runtimecore-create-session-runtime-whole-runner-delegation',
    matchAnyOf: [],
  }),
  createCategorySpec({
    id: 'provider-execution-run-policy-plumbing',
    title: 'Provider execution-run policy plumbing',
    description: 'Provider-owned execution-run leaves that still decide isolation bundles, permission handlers, or cleanup wrapping.',
    migrationScaffold: 'Use this list to move execution-run policy decisions into the host/execution-run core and keep provider folders on leaf behavior only.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/backends/',
        contentMatches: /resolveBackendIsolationBundle|createExecutionRunPermissionHandler|backend\.dispose\s*=\s*async/,
      },
    ],
  }),
  createCategorySpec({
    id: 'execution-run-permission-interaction-centralization',
    title: 'Execution-run permission interaction centralization',
    description: 'Execution-run code that still imports the interactive permission prompt loop instead of routing through the shared host policy.',
    migrationScaffold: 'Use this list to keep execution-run permission interaction owned by the shared host policy and to prevent prompt-loop imports from reappearing in execution-run or provider-owned code.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/agent/executionRuns/',
        contentMatches: /\brunPermissionModePromptLoop\b/,
      },
      {
        filePathIncludes: 'apps/cli/src/backends/',
        contentMatches: /\brunPermissionModePromptLoop\b/,
      },
    ],
  }),
  createCategorySpec({
    id: 'opencode-family-permission-policy-drift',
    title: 'OpenCode-family permission policy drift',
    description: 'OpenCode-family permission policy tokens that must stay single-sourced in the OpenCode-family policy module.',
    migrationScaffold: 'Use this list to keep OpenCode-family permission policy mapped through the shared policy owner and to spot any new token-table drift.',
    matchStrategy: 'opencode-family-permission-policy-drift',
    matchAnyOf: [],
  }),
  createCategorySpec({
    id: 'permission-taxonomy-forks',
    title: 'Permission taxonomy forks',
    description: 'Shared permission taxonomy tokens that still appear in multiple owner files and must converge.',
    migrationScaffold: 'Use this list to converge the shared auto-approve/write-like taxonomy into one owner and remove provider-local forks.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/',
        filePathExcludes: 'apps/cli/src/agent/permissions/permissionTaxonomy.ts',
        contentMatches: /(?:\bALWAYS_APPROVE\b|\bEXTRA_WRITE_LIKE\b|ALWAYS_AUTO_APPROVE_(?:TOOL|PERMISSION|COMMAND|MCP)(?:_|\b))/,
      },
    ],
  }),
  createCategorySpec({
    id: 'runtimeforloop-agentbackend-shrink-only',
    title: 'Legacy runtime adapter shrink-only surfaces',
    description: 'Compatibility-only references to retired runtime adapter names that must shrink rather than become new architecture.',
    migrationScaffold: 'Use this list to keep legacy runtime shapes shrinking and to prevent them from becoming new native APIs.',
    matchAnyOf: [
      {
        filePathIncludes: 'apps/cli/src/',
        filePathExcludes: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
        contentMatches: new RegExp(LEGACY_RUNTIME_LOOP_ALIAS_WORD),
      },
      {
        filePathIncludes: 'apps/cli/src/',
        filePathExcludes: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
        contentMatches: new RegExp(String.raw`${LEGACY_BACKEND_ALIAS_WORD}\s*&\s*\{`),
      },
      {
        filePathIncludes: 'apps/cli/src/',
        filePathExcludes: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
        contentMatches: new RegExp(String.raw`\bas\s+${LEGACY_BACKEND_ALIAS_NAME}\s*&\s*\{`),
      },
    ],
  }),
  createCategorySpec({
    id: 'execution-run-agentbackend-semantic-debt',
    title: 'Execution-run retired adapter semantic debt',
    description: 'Shared execution-run host files, provider-leaf execution-run backends, and review-engine backends that still keep the retired backend adapter semantically live after lexical shrink debt has been reduced.',
    migrationScaffold: 'Use this list to distinguish real shared-owner adapter retirement from lexical disappearance. Host/orchestrator files must stop typing against the retired backend adapter, and provider-leaf or review-engine compatibility seams must not grow new retired-backend-adapter-only surface until the canonical execution-run host runtime fully owns the path.',
    matchAnyOf: [
      {
        filePathMatches: EXECUTION_RUN_HOST_AGENTBACKEND_FILE_PATTERN,
        contentMatches: AGENT_BACKEND_SEMANTIC_USAGE_PATTERN,
      },
      {
        filePathMatches: EXECUTION_RUN_AGENTBACKEND_RETIREMENT_OWNER_FILE_PATTERN,
        contentMatches: EXECUTION_RUN_AGENTBACKEND_RETIREMENT_OWNER_PATTERN,
      },
      {
        filePathMatches: EXECUTION_RUN_PROVIDER_AGENTBACKEND_FILE_PATTERN,
        contentMatches: EXECUTION_RUN_PROVIDER_AGENTBACKEND_PATTERN,
      },
    ],
  }),
  createCategorySpec({
    id: 'runtime-identity-publication-read',
    title: 'Runtime identity publication and read split ownership',
    description: 'Files that publish runtime identity or read it back from session and provider metadata.',
    migrationScaffold: 'Use this list to keep identity publication owned by the runtime identity layer and reads owned by host consumers.',
    matchAnyOf: [
      { filePathIncludes: 'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts' },
      { filePathIncludes: 'packages/agents/src/runtime/identity/runtimeDescriptorReaderRegistry.ts' },
      { filePathIncludes: 'packages/agents/src/runtime/identity/runtimeDescriptor.ts' },
      { filePathIncludes: 'packages/agents/src/runtime/identity/runtimeDescriptorTypes.ts' },
      { filePathIncludes: 'packages/agents/src/session/state/bindings/runtimeDescriptor.ts' },
      { filePathIncludes: 'packages/agents/src/runtime/identity/runtimeDescriptorTypes.ts' },
      { filePathIncludes: 'packages/agents/src/session/controls/runtimeControlSurface.ts' },
      { filePathIncludes: 'packages/agents/src/session/controls/runtimeKindOverride.ts' },
      { filePathIncludes: 'packages/agents/src/session/controls/providerBackendModes.ts' },
      { filePathIncludes: 'packages/agents/src/runtime/identity/readSessionMetadataRuntimeDescriptor.ts' },
      { filePathIncludes: 'apps/cli/src/session/services/deriveExecutionRunPublicStatesFromHistory.ts' },
    ],
  }),
  createCategorySpec({
    id: 'implicit-abi-surfaces',
    title: 'Implicit ABI surfaces',
    description: 'Files that currently harden merged catalogEntry shapes or runtime-adapter operation ids into the host contract.',
    migrationScaffold: 'Use this list to narrow or replace implicit ABI surfaces before later plugin-authored backend claims are made.',
    matchAnyOf: [
      { filePathIncludes: 'apps/cli/src/plugins/registry/createResolvedContributionRegistry.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/registry/types.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/registry/resolveBuiltInContributions.ts' },
      { filePathIncludes: 'apps/cli/src/plugins/registry/resolvePluginContributions.ts' },
      { filePathIncludes: 'packages/protocol/src/plugins/backendDefinitionV1.ts' },
      { filePathIncludes: 'packages/protocol/src/plugins/contractsV1.test.ts' },
      { filePathIncludes: 'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts' },
    ],
  }),
]);

function normalizeSourceFiles(files: readonly InventoryFile[]): readonly InventoryFile[] {
  const productionFiles = files.filter((file) => {
    if (TEST_FILE_PATTERN.test(file.filePath)) return false;
    if (GENERATED_PATH_FRAGMENT.test(file.filePath)) return false;
    if (NON_PRODUCTION_PATH_FRAGMENT.test(file.filePath)) return false;
    return true;
  });

  const productionPaths = new Set(productionFiles.map((file) => file.filePath));

  return productionFiles.filter((file) => !isTranspiledSourceSidecar(file.filePath, productionPaths));
}

function normalizeVoiceV3FPositiveTestFiles(files: readonly InventoryFile[]): readonly InventoryFile[] {
  const candidateFiles = files.filter((file) => {
    if (!TEST_FILE_PATTERN.test(file.filePath)) return false;
    if (GENERATED_PATH_FRAGMENT.test(file.filePath)) return false;
    if (NON_PRODUCTION_PATH_FRAGMENT.test(file.filePath)) return false;
    return matchesVoiceV3FV2MediaResidue(file);
  });
  const candidatePaths = new Set(candidateFiles.map((file) => file.filePath));

  return candidateFiles.filter((file) => !isTranspiledSourceSidecar(file.filePath, candidatePaths));
}

function collectVoiceV3FInventoryFiles(files: readonly InventoryFile[]): readonly InventoryFile[] {
  return [
    ...new Map(
      [
        ...normalizeSourceFiles(files).filter(matchesVoiceV3FV2MediaResidue),
        ...normalizeVoiceV3FPositiveTestFiles(files),
      ].map((file) => [file.filePath, file] as const),
    ).values(),
  ].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function isTranspiledSourceSidecar(
  filePath: string,
  availablePaths: ReadonlySet<string>,
): boolean {
  const match = filePath.match(/^(.*)\.(cjs|mjs|js|jsx)$/);
  if (!match) {
    return false;
  }

  const basePath = match[1];
  if (!basePath) {
    return false;
  }

  return [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.cts`,
    `${basePath}.mts`,
  ].some((candidatePath) => availablePaths.has(candidatePath));
}

export function collectV2ZeroSourceFiles(rootDir: string = process.cwd()): InventoryFile[] {
  const collectedFiles = collectFileInventory({
    rootDir,
    include: /\.[cm]?[jt]sx?$/,
  });

  return [
    ...new Map(
      [
        ...normalizeSourceFiles(collectedFiles),
        ...normalizeVoiceV3FPositiveTestFiles(collectedFiles),
      ].map((file) => [file.filePath, file] as const),
    ).values(),
  ].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function collectV2ZeroInventory(files: readonly InventoryFile[]): V2ZeroInventoryReport {
  const normalizedFiles = normalizeSourceFiles(files);
  const voiceV3FInventoryFiles = collectVoiceV3FInventoryFiles(files);
  const recursiveWholeRunnerDelegationMatches = collectRecursiveRuntimeRunnerDelegationMatches(normalizedFiles);
  const categories = V2_ZERO_INVENTORY_CATEGORY_SPECS.flatMap((spec) => {
    const categoryFiles =
      spec.matchStrategy === 'voice-v3-f-v2-media-residue'
        ? voiceV3FInventoryFiles
        : normalizedFiles;
    const matchingFiles = [...new Set(
      categoryFiles
        .filter((file) =>
          spec.matchStrategy === 'runtimecore-create-session-runtime-whole-runner-delegation'
            ? recursiveWholeRunnerDelegationMatches.has(file.filePath) || matchesCategory(file, spec)
            : matchesCategory(file, spec)
        )
        .map((file) => file.filePath),
    )].sort((left, right) => left.localeCompare(right));

    if (matchingFiles.length === 0) {
      return [];
    }

    return [
      {
        id: spec.id,
        title: spec.title,
        description: spec.description,
        migrationScaffold: spec.migrationScaffold,
        count: matchingFiles.length,
        files: matchingFiles,
      },
    ] satisfies V2ZeroInventoryCategoryReport[];
  });

  return {
    filesScanned: new Set([
      ...normalizedFiles.map((file) => file.filePath),
      ...voiceV3FInventoryFiles.map((file) => file.filePath),
    ]).size,
    filesMatched: countUniqueFiles(categories),
    totalMatches: categories.reduce((sum, category) => sum + category.count, 0),
    categories,
  };
}

export function formatV2ZeroInventoryMarkdown(report: V2ZeroInventoryReport): string {
  const sections = [
    `- files scanned: ${report.filesScanned}`,
    `- unique files matched: ${report.filesMatched}`,
    `- category matches: ${report.totalMatches}`,
  ];

  for (const category of report.categories) {
    sections.push(
      '',
      `## ${category.title}`,
      '',
      `- id: ${category.id}`,
      `- matches: ${category.count}`,
      `- migration scaffold: ${category.migrationScaffold}`,
      `- files: ${category.files.join(', ')}`,
    );
  }

  return formatSimpleSections('V2-0 Inventory Report', sections);
}

export function buildV2ZeroInventoryReportEntries(report: V2ZeroInventoryReport): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {
    [GOVERNANCE_REPORT_PATHS.v2ZeroInventoryMarkdown]: formatV2ZeroInventoryMarkdown(report),
    [GOVERNANCE_REPORT_PATHS.v2ZeroInventoryJson]: `${JSON.stringify(report, null, 2)}\n`,
  };

  for (const laneReport of collectV2ZeroLaneExtractReports(report)) {
    const laneBase = `${GOVERNANCE_REPORT_PATHS.v2ZeroInventoryMarkdown.replace(/v2-0-inventory\.md$/, `v2-0-lane-${laneReport.laneId}-extract`)}`;
    entries[`${laneBase}.md`] = formatV2ZeroLaneExtractMarkdown(laneReport);
    entries[`${laneBase}.json`] = `${JSON.stringify(laneReport, null, 2)}\n`;
  }

  return entries;
}

export function writeV2ZeroInventoryReports(report: V2ZeroInventoryReport, rootDir: string = process.cwd()): void {
  writeGovernanceReports(buildV2ZeroInventoryReportEntries(report), rootDir);
}

export async function runV2ZeroInventory(params: Readonly<{
  rootDir?: string;
  files?: readonly InventoryFile[];
  writeReports?: boolean;
}> = {}): Promise<V2ZeroInventoryReport> {
  const files = params.files ?? collectV2ZeroSourceFiles(params.rootDir ?? process.cwd());
  const report = collectV2ZeroInventory(files);
  if (params.writeReports === true) {
    writeV2ZeroInventoryReports(report, params.rootDir ?? process.cwd());
  }
  return report;
}
