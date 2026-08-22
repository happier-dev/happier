import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildV2ZeroInventoryReportEntries,
  collectV2ZeroInventory,
  collectV2ZeroSourceFiles,
  formatV2ZeroInventoryMarkdown,
  runV2ZeroInventory,
} from './v2ZeroInventory.ts';
import { collectFileInventory } from './collectFileInventory.ts';
import {
  buildV2ZeroLaneRewriteApplyPacket,
  buildV2ZeroLaneRewriteBatchApplyPacket,
  buildV2ZeroLaneRewriteExecutionPacket,
  buildV2ZeroLaneRewriteDryRunPacket,
  collectV2ZeroLaneExtractReports,
  collectV2ZeroLaneExtractFiles,
  planV2ZeroLaneImportRewrites,
  formatV2ZeroLaneExtractMarkdown,
} from './v2ZeroLaneExtracts.ts';

const repoRootDir = fileURLToPath(new URL('../../../../', import.meta.url));
const legacyRuntimeLoopAliasName = ['Runtime', 'For', 'Loop'].join('');
const legacyBackendAliasName = ['Agent', 'Backend'].join('');
const legacyBackendAliasOperationName = `${legacyBackendAliasName}Operation`;

function legacyBackendAliasImport(modulePathWithoutAlias: string): string {
  return `import type { ${legacyBackendAliasName} } from '${modulePathWithoutAlias}/${legacyBackendAliasName}';`;
}

test('collectV2ZeroInventory is deterministic and deduplicates file paths per category', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/daemon/backendTargetRouting.ts',
      content: 'export function routeBackendTarget() { return null; }',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts',
      content: 'resolveBackendExecutionSurfacesFromEngine',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts',
      content: 'resolveBackendExecutionSurfacesFromEngine',
    },
    {
      filePath: 'packages/protocol/src/plugins/backendDefinitionV1.ts',
      content: 'export const BackendDefinitionV1Schema = {};',
    },
  ]);

  assert.deepEqual(report.categories.map((category) => category.id), [
    'builtin-cli-catalog-consumers',
    'implicit-abi-surfaces',
  ]);
  assert.equal(report.filesMatched, 3);
  assert.deepEqual(report.categories[0]?.files, ['apps/cli/src/daemon/backendTargetRouting.ts']);
  assert.deepEqual(report.categories[1]?.files, [
    'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts',
    'packages/protocol/src/plugins/backendDefinitionV1.ts',
  ]);
});

test('collectV2ZeroInventory classifies representative current surfaces', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/cli/buildRootHelpText.ts',
      content: "import { listRootHelpCommands } from './commandSurfaceManifest';",
    },
    {
      filePath: 'apps/ui/sources/agents/registry/registryCore.ts',
      content: "import { registryUi } from './registryUi';",
    },
    {
      filePath: 'apps/cli/src/agent/voice/agent/VoiceAgentManager.ts',
      content: "export const voiceAgent = 'voice_agent';",
    },
    {
      filePath: 'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts',
      content: "export function publishRuntimeIdentity() { return null; }",
    },
    {
      filePath: 'packages/agents/src/runtime/preferences/index.ts',
      content: 'export const runtimePreferences = {};',
    },
    {
      filePath: 'packages/agents/src/runtime/discovery/runtimeDiscovery.ts',
      content: 'export const runtimeDiscovery = {};',
    },
    {
      filePath: 'packages/agents/src/definitions/types.ts',
      content: 'export const backendCatalogDefinition = {};',
    },
    {
      filePath: 'packages/agents/src/runtime/engine/specs.ts',
      content: 'export const engineSpec = {};',
    },
    {
      filePath: 'packages/protocol/src/sessionMetadata/runtimeDescriptorV1.ts',
      content: 'export const runtimeDescriptorV1 = {};',
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.ts',
      content: 'export const ReviewProfile = {};',
    },
    {
      filePath: 'packages/protocol/src/actions/actionIds.ts',
      content: "export const ACTION_IDS = ['review'];",
    },
    {
      filePath: 'packages/agents/src/runtime/adjunctAdapters/types.ts',
      content: 'export type ProviderConnectedServicesAdapter = Readonly<Record<string, unknown>>;',
    },
    {
      filePath: 'apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.ts',
      content: 'export function dispatchPluginHookEvent() {}',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/hostSessionRuntimeRetirement.ts',
      content: 'export type HostSessionRuntimeRetirement = { createSessionRuntime: () => unknown };',
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/runCatalogDefinedAcpAgent.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export async function runCatalogDefinedAcpAgent(opts: unknown) {
  await runHostSessionRuntimePlan(createCatalogHostSessionRuntimePlan({ opts } as never));
}
`,
    },
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: "import { requireCatalogEntry } from '@/backends/catalog';\nif (agentId === 'customAcp') throw new Error('no');",
    },
  ]);

  assert.ok(report.categories.some((category) => category.id === 'static-ui-registry-consumers'));
  assert.ok(report.categories.some((category) => category.id === 'voice-runtime-entrypoints'));
  assert.ok(report.categories.some((category) => category.id === 'runtime-identity-publication-read'));
  assert.ok(report.categories.some((category) => category.id === 'shared-session-retirement-compatibility-surfaces'));
  assert.ok(report.categories.some((category) => category.id === 'acp-shared-session-compatibility-surfaces'));
  assert.ok(report.categories.some((category) => category.id === 'hook-emission-sites'));
  assert.ok(report.categories.some((category) => category.id === 'customacp-sentinel-consumers'));
});

test('collectV2ZeroInventory keeps shared-core provider branching focused on branch sites', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts',
      content: "export const providerId = 'claude';",
    },
    {
      filePath: 'apps/cli/package-dist/providerBranching-compiled.cjs',
      content: "if (providerId === 'claude') return 'generated';",
    },
    {
      filePath: 'apps/cli/.dist.hstack-backup/providerBranching-compiled.cjs',
      content: "if (providerId === 'claude') return 'generated';",
    },
    {
      filePath: 'apps/cli/src/backends/claude/start.ts',
      content: "if (providerId === 'claude') return 'claude';",
    },
    {
      filePath: 'apps/cli/src/session/services/providerBranching.ts',
      content: [
        "export function resolveBackend(providerId: string) {",
        "  if (providerId === 'claude') return 'claude';",
        "  return providerId === 'codex' ? 'codex' : 'fallback';",
        '}',
      ].join('\n'),
    },
  ]);

  const branching = report.categories.find((category) => category.id === 'shared-core-provider-branching');
  assert.deepEqual(branching?.files, ['apps/cli/src/session/services/providerBranching.ts']);
});

test('collectV2ZeroInventory keeps shared-core provider branching inside its declared scope', () => {
  // Byte-identical branching content in four places: two inside the declared
  // shared/core scope and two outside it. Only the declared scope is inventory.
  const content = [
    "export function resolveBackend(providerId: string) {",
    "  if (providerId === 'claude') return 'claude';",
    "  return providerId === 'codex' ? 'codex' : 'fallback';",
    '}',
  ].join('\n');
  const report = collectV2ZeroInventory([
    { filePath: 'apps/cli/src/session/services/providerBranching.ts', content },
    { filePath: 'packages/cli-common/src/agents/install/managedInstall.ts', content },
    { filePath: 'apps/website/src/data/agents.ts', content },
    { filePath: 'scripts/testing/migrations/lib/v2ZeroInventory.ts', content },
  ]);

  const branching = report.categories.find((category) => category.id === 'shared-core-provider-branching');
  assert.deepEqual(branching?.files, [
    'apps/cli/src/session/services/providerBranching.ts',
    'packages/cli-common/src/agents/install/managedInstall.ts',
  ]);
});

test('collectV2ZeroInventory reports Voice V3-F V2 media residue by semantic owner and positive test identifiers', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'packages/protocol/src/machines/peer/mediation/renamedApplicationKinds.ts',
      content: [
        "export const mediaKinds = ['speech_transcription', 'agent_realtime'];",
        "export const mediaFrame = z.object({ encoding: z.literal('pcm_s16le'), sampleRateHz: z.number() });",
      ].join('\n'),
    },
    {
      filePath: 'packages/protocol/src/machines/peer/mediation/renamedPcmFrames.ts',
      content: 'export const VoiceMediaAgentRealtimeFrameV1Schema = z.union([]);',
    },
    {
      filePath: 'apps/cli/src/daemon/voiceMedia/renamedAuthority.ts',
      content: 'export function admitAgentRealtimeAttempt() { return true; }',
    },
    {
      filePath: 'apps/cli/src/daemon/voiceMedia/renamedDispatcher.ts',
      content: 'export function dispatchVoiceMediaAgentRealtimeBinaryFrame() {}',
    },
    {
      filePath: 'apps/cli/src/daemon/voiceMedia/renamedEncryption.ts',
      content: 'export type VoiceMediaAgentRealtimeEncryptionAdmissionResult = { ok: true };',
    },
    {
      filePath: 'apps/cli/src/daemon/peer/mediation/tunnel/renamedTunnel.ts',
      content: 'const voiceMediaAgentRealtimeConsumer = createConsumer();',
    },
    {
      filePath: 'packages/protocol/src/machines/peer/mediation/renamedPositiveCoverage.test.ts',
      content: [
        "import { VoiceMediaAgentRealtimeFrameV1Schema } from './renamedPcmFrames.js';",
        "test('round-trips retired Agent realtime PCM', () => VoiceMediaAgentRealtimeFrameV1Schema.parse({}));",
      ].join('\n'),
    },
    {
      filePath: 'packages/protocol/src/machines/peer/mediation/retainedSpeech.ts',
      content: "export const retainedApplicationKind = z.literal('speech_transcription');",
    },
    {
      filePath: 'apps/ui/sources/voice/runtime/agentRealtime/retainedV3Control.ts',
      content: "export const diagnostic = 'agent_realtime_start_failed';",
    },
    {
      filePath: 'apps/cli/src/daemon/machine/negativeAbsence.test.ts',
      content: "expect(source).not.toContain('voiceMediaAgentRealtimeConsumer');",
    },
  ]);

  const residue = report.categories.find((category) => category.id === 'voice-v3-f-v2-media-residue');
  assert.deepEqual(residue?.files, [
    'apps/cli/src/daemon/peer/mediation/tunnel/renamedTunnel.ts',
    'apps/cli/src/daemon/voiceMedia/renamedAuthority.ts',
    'apps/cli/src/daemon/voiceMedia/renamedDispatcher.ts',
    'apps/cli/src/daemon/voiceMedia/renamedEncryption.ts',
    'packages/protocol/src/machines/peer/mediation/renamedApplicationKinds.ts',
    'packages/protocol/src/machines/peer/mediation/renamedPcmFrames.ts',
    'packages/protocol/src/machines/peer/mediation/renamedPositiveCoverage.test.ts',
  ]);
});

test('collectV2ZeroInventory inventories the OP-I1 governance scanner drift surfaces', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/codex/runCodexSessionCommand.ts',
      content: "import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';",
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtime/createCodexSessionRuntime.ts',
      content: "import { runCodex } from '../runCodexSessionCommand';\nawait runCodex({ credentials: {} } as never);",
    },
    {
      filePath: 'apps/cli/src/backends/opencode/runtimeCore/openCodeRuntimeCore.ts',
      content: [
        "import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';",
        "import { resolveBackendIsolationBundle } from '@/runtime/isolation/resolveBackendIsolationBundle';",
        'backend.dispose = async () => {};',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/openCodeFamily/permission/openCodeFamilyPermissionPolicy.ts',
      content: [
        "import { SHARED_ALWAYS_AUTO_APPROVE_TOOL_NAME_TOKENS } from '@/agent/permissions/permissionTaxonomy';",
        'const OPENCODE_ALWAYS_ALLOW_PERMISSIONS = [',
        '  ...SHARED_ALWAYS_AUTO_APPROVE_TOOL_NAME_TOKENS,',
        '] as const;',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/policy/executionRunPermissionDecision.ts',
      content: [
        "const ALWAYS_AUTO_APPROVE_TOKENS = ['think'] as const;",
        "const EXTRA_WRITE_LIKE = new Set(['write']);",
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunPermissionPromptStore.ts',
      content: "import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';",
    },
    {
      filePath: 'apps/cli/src/agent/permissions/permissionTaxonomy.ts',
      content: [
        "export const SHARED_ALWAYS_AUTO_APPROVE_TOOL_NAME_TOKENS = ['think'] as const;",
        "export const SHARED_PERMISSION_GUARD_TOOL_NAMES = ['external_directory'] as const;",
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/permissions/CodexLikePermissionHandler.ts',
      content: [
        "import { SHARED_ALWAYS_AUTO_APPROVE_TOOL_NAME_TOKENS } from './permissionTaxonomy';",
        'const AUTO_APPROVE_HAPPIER_SHELL_BRIDGE_TOOLS = new Set<string>([',
        "  'change_title',",
        '  ...SHARED_ALWAYS_AUTO_APPROVE_TOOL_NAME_TOKENS,',
        ']);',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/permissions/ProviderEnforcedPermissionHandler.ts',
      content: [
        'const DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_NAME_INCLUDES = [',
        "  'action_execute',",
        "  'save_memory',",
        '] as const;',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: 'export type LegacyRuntimeForLoopCompatibility = RuntimeTurnOperations;',
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts',
      content: `const narrowed = backend as ${legacyBackendAliasName} & { dispose(): Promise<void> };`,
    },
    {
      filePath: 'apps/cli/src/session/reintroduceCodexLegacyRunner.ts',
      content: "import { runCodex } from '@/backends/codex/runCodexSessionCommand';\nawait runCodex({ credentials: {} } as never);",
    },
  ]);

  assert.ok(report.categories.some((category) => category.id === 'provider-session-loop-primitive-imports'));
  assert.ok(report.categories.some((category) => category.id === 'codex-legacy-direct-session-runner-imports'));
  assert.ok(report.categories.some((category) => category.id === 'provider-execution-run-policy-plumbing'));
  assert.ok(report.categories.some((category) => category.id === 'opencode-family-permission-policy-drift'));
  assert.ok(report.categories.some((category) => category.id === 'permission-taxonomy-forks'));
  assert.ok(report.categories.some((category) => category.id === 'execution-run-permission-interaction-centralization'));
  assert.ok(report.categories.some((category) => category.id === 'runtimeforloop-agentbackend-shrink-only'));

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/codex/runtime/createCodexSessionRuntime.ts',
  ]);

  const codexLegacyRunnerImports = report.categories.find((category) => category.id === 'codex-legacy-direct-session-runner-imports');
  assert.deepEqual(codexLegacyRunnerImports?.files, [
    'apps/cli/src/backends/codex/runtime/createCodexSessionRuntime.ts',
    'apps/cli/src/session/reintroduceCodexLegacyRunner.ts',
  ]);

  const permissionTaxonomyForks = report.categories.find((category) => category.id === 'permission-taxonomy-forks');
  assert.deepEqual(permissionTaxonomyForks?.files, [
    'apps/cli/src/agent/executionRuns/policy/executionRunPermissionDecision.ts',
    'apps/cli/src/agent/permissions/CodexLikePermissionHandler.ts',
    'apps/cli/src/agent/permissions/ProviderEnforcedPermissionHandler.ts',
    'apps/cli/src/backends/openCodeFamily/permission/openCodeFamilyPermissionPolicy.ts',
  ]);
});

test('collectV2ZeroInventory flags OpenCode permission mapping-table drift outside the canonical opencode owner only', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/opencode/permission/openCodePermissionPolicy.ts',
      content: [
        "const OPENCODE_READ_PERMISSIONS = ['read'] as const;",
        "const OPENCODE_EDIT_PERMISSIONS = ['edit'] as const;",
        "const OPENCODE_SAFE_ALLOW_PERMISSIONS = ['change_title'] as const;",
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/kilo/acp/rederivedPermissionPolicy.ts',
      content: [
        "const OPENCODE_READ_PERMISSIONS = ['read'] as const;",
        "const OPENCODE_EDIT_PERMISSIONS = ['edit'] as const;",
      ].join('\n'),
    },
  ]);

  const category = report.categories.find((entry) => entry.id === 'opencode-family-permission-policy-drift');
  assert.deepEqual(category?.files, ['apps/cli/src/backends/kilo/acp/rederivedPermissionPolicy.ts']);
});

test('collectV2ZeroInventory flags renamed-local OpenCode permission policy re-derivation outside the canonical owner', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/opencode/permission/openCodePermissionPolicy.ts',
      content: `
export function resolveOpenCodePermissionConfig() {
  return { '*': 'ask' };
}
`,
    },
    {
      filePath: 'apps/cli/src/backends/kilo/acp/kiloPermissionShape.ts',
      content: `
import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

const READ_SCOPE = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const EDIT_SCOPE = ['edit', 'write'] as const;
const ALWAYS_ALLOW_SCOPE = ['change_title', 'save_memory', 'think'] as const;

function asDecisionMap(perms: ReadonlyArray<string>, value: 'allow' | 'ask' | 'deny') {
  return Object.fromEntries(perms.map((permission) => [permission, value] as const));
}

export function resolveKiloPermissionShape(permissionMode: PermissionMode | null | undefined) {
  const intent = normalizePermissionModeToIntent(permissionMode ?? 'default') ?? 'default';

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    return { '*': 'allow', ...asDecisionMap(READ_SCOPE, 'allow'), ...asDecisionMap(EDIT_SCOPE, 'allow') };
  }

  if (intent === 'safe-yolo') {
    return {
      '*': 'ask',
      ...asDecisionMap(READ_SCOPE, 'allow'),
      ...asDecisionMap(EDIT_SCOPE, 'allow'),
      ...asDecisionMap(ALWAYS_ALLOW_SCOPE, 'allow'),
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return { '*': 'deny', ...asDecisionMap(READ_SCOPE, 'allow'), ...asDecisionMap(EDIT_SCOPE, 'deny') };
  }

  return { '*': 'ask', ...asDecisionMap(READ_SCOPE, 'allow') };
}
`,
    },
  ]);

  const category = report.categories.find((entry) => entry.id === 'opencode-family-permission-policy-drift');
  assert.deepEqual(category?.files, ['apps/cli/src/backends/kilo/acp/kiloPermissionShape.ts']);
});

test('collectV2ZeroInventory catches shared-session retirement regrowth while ACP compatibility remains separately tracked', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: `
import { createRetiredHostSessionRuntime, type HostSessionRuntimeRetirement } from './hostSessionRuntimeRetirement';
export type HostSessionRuntimeConfig = { retirement?: HostSessionRuntimeRetirement };
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/runCatalogDefinedAcpAgent.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
export async function runCatalogDefinedAcpAgent() {
  await runHostSessionRuntimePlan(createCatalogHostSessionRuntimePlan({} as never));
}
`,
    },
  ]);

  const retirementCompatibility = report.categories.find(
    (category) => category.id === 'shared-session-retirement-compatibility-surfaces',
  );
  assert.deepEqual(retirementCompatibility?.files, [
    'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
  ]);

  const acpSharedCompatibility = report.categories.find(
    (category) => category.id === 'acp-shared-session-compatibility-surfaces',
  );
  assert.deepEqual(acpSharedCompatibility?.files, [
    'apps/cli/src/agent/acp/catalog/runCatalogDefinedAcpAgent.ts',
  ]);
});

test('collectV2ZeroInventory keeps the current shared session loop off retirement compatibility inventory after seam deletion', () => {
  const inventory = collectV2ZeroSourceFiles()
    .filter((file) => file.filePath === 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts');

  const report = collectV2ZeroInventory(inventory);
  const retirementCompatibility = report.categories.find(
    (category) => category.id === 'shared-session-retirement-compatibility-surfaces',
  );

  assert.equal(retirementCompatibility, undefined);
});

test('collectV2ZeroInventory keeps Claude runtimeCore files off whole-runner delegation', () => {
  const report = collectV2ZeroInventory(
    collectV2ZeroSourceFiles()
      .filter((file) => file.filePath.startsWith('apps/cli/src/backends/claude/runtimeCore/')),
  );

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.equal(wholeRunnerDelegation, undefined);
});

test('collectV2ZeroInventory catches constructor-executor indirection for session runtimeCore', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/createCodexRuntimeCore.ts',
      content: [
        'export function createCodexRuntimeCore() {',
        '  return {',
        '    async createSessionRuntime(params: unknown) {',
        '      const runtime = createCodexSessionRuntime(params);',
        '      await runtime.run();',
        '      return runtime;',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/gemini/runtimeCore/geminiRuntimeCore.ts',
      content: [
        'export const geminiRuntimeCore = {',
        '  async createSessionRuntime(params: unknown) {',
        '    await runGeminiSessionRuntime(params);',
        '  },',
        '};',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtime/createCodexSessionRuntime.ts',
      content: [
        "import { runCodex } from '../runCodexSessionCommand';",
        'export function createCodexSessionRuntime(params: unknown) {',
        '  return {',
        '    async run() {',
        '      await runCodex(params);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtime/localModePass.ts',
      content: [
        'export async function runCodexLocalModePass() {',
        "  return 'provider leaf helper';",
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/codex/runtime/createCodexSessionRuntime.ts',
    'apps/cli/src/backends/codex/runtimeCore/createCodexRuntimeCore.ts',
    'apps/cli/src/backends/gemini/runtimeCore/geminiRuntimeCore.ts',
  ]);
});

test('collectV2ZeroInventory catches nested runtimeCore helper delegation inside runtimeCore folders', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/createCodexRuntimeCore.ts',
      content: [
        'import { createCodexRuntimeFromHelper } from "./helpers/createCodexRuntimeFromHelper";',
        'export function createCodexRuntimeCore() {',
        '  return {',
        '    async createSessionRuntime(params: unknown) {',
        '      return createCodexRuntimeFromHelper(params);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/helpers/createCodexRuntimeFromHelper.ts',
      content: [
        "import { runCodex } from '../../runCodexSessionCommand';",
        'export async function createCodexRuntimeFromHelper(params: unknown) {',
        '  await runCodex(params);',
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/codex/runtimeCore/helpers/createCodexRuntimeFromHelper.ts',
  ]);
});

test('collectV2ZeroInventory catches multi-hop runtimeCore helper delegation beyond one import depth', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/createCodexRuntimeCore.ts',
      content: [
        'import { createCodexRuntimeFromHelper } from "./helpers/createCodexRuntimeFromHelper";',
        'export function createCodexRuntimeCore() {',
        '  return {',
        '    async createSessionRuntime(params: unknown) {',
        '      return createCodexRuntimeFromHelper(params);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/helpers/createCodexRuntimeFromHelper.ts',
      content: [
        'import { launchCodexFromLeaf } from "./launchCodexFromLeaf";',
        'export async function createCodexRuntimeFromHelper(params: unknown) {',
        '  return launchCodexFromLeaf(params);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/helpers/launchCodexFromLeaf.ts',
      content: [
        "import { runCodex } from '../../runCodexSessionCommand';",
        'export async function launchCodexFromLeaf(params: unknown) {',
        '  await runCodex(params);',
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/codex/runtimeCore/helpers/launchCodexFromLeaf.ts',
  ]);
});

test('collectV2ZeroInventory catches multi-hop provider runtime wrapper delegation beyond one import depth', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/gemini/runtime/createGeminiSessionRuntime.ts',
      content: [
        'import { runGeminiFromHelper } from "./helpers/runGeminiFromHelper";',
        'export async function createGeminiSessionRuntime(params: unknown) {',
        '  return runGeminiFromHelper(params);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/gemini/runtime/helpers/runGeminiFromHelper.ts',
      content: [
        'import { runGeminiFromLeaf } from "./runGeminiFromLeaf";',
        'export async function runGeminiFromHelper(params: unknown) {',
        '  return runGeminiFromLeaf(params);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/gemini/runtime/helpers/runGeminiFromLeaf.ts',
      content: [
        "import { runGeminiSessionRuntime } from '../../runGeminiSessionRuntime';",
        'export async function runGeminiFromLeaf(params: unknown) {',
        '  await runGeminiSessionRuntime(params);',
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/gemini/runtime/helpers/runGeminiFromLeaf.ts',
  ]);
});

test('collectV2ZeroInventory catches runtimeCore delegation that escapes runtimeCore folders through imported provider helpers', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/codex/runtimeCore/createCodexRuntimeCore.ts',
      content: [
        'import { createCodexRuntimeFromLeaf } from "../shared/createCodexRuntimeFromLeaf";',
        'export function createCodexRuntimeCore() {',
        '  return {',
        '    async createSessionRuntime(params: unknown) {',
        '      return createCodexRuntimeFromLeaf(params);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/codex/shared/createCodexRuntimeFromLeaf.ts',
      content: [
        "import { runCodex } from '../runCodexSessionCommand';",
        'export async function createCodexRuntimeFromLeaf(params: unknown) {',
        '  await runCodex(params);',
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/codex/shared/createCodexRuntimeFromLeaf.ts',
  ]);
});

test('collectV2ZeroInventory catches provider runtime delegation that escapes runtime folders through imported provider helpers', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/gemini/runtime/createGeminiSessionRuntime.ts',
      content: [
        'import { runGeminiFromLeaf } from "../shared/runGeminiFromLeaf";',
        'export async function createGeminiSessionRuntime(params: unknown) {',
        '  return runGeminiFromLeaf(params);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/gemini/shared/runGeminiFromLeaf.ts',
      content: [
        "import { runGeminiSessionRuntime } from '../runGeminiSessionRuntime';",
        'export async function runGeminiFromLeaf(params: unknown) {',
        '  await runGeminiSessionRuntime(params);',
        '}',
      ].join('\n'),
    },
  ]);

  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');
  assert.deepEqual(wholeRunnerDelegation?.files, [
    'apps/cli/src/backends/gemini/shared/runGeminiFromLeaf.ts',
  ]);
});

test('collectV2ZeroInventory excludes the bridge design packet from the shrink-only consumer count', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/acp/runtime/createAcpRuntime.ts',
      content: `const narrowed = backend as ${legacyBackendAliasName} & { dispose(): Promise<void> };`,
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts',
      content: `const narrowed = backend as ${legacyBackendAliasName} & { dispose(): Promise<void> };`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
      content: [
        `type Legacy${legacyRuntimeLoopAliasName}Operation = 'beginTurn' | 'startOrLoad';`,
        `type ${legacyBackendAliasOperationName} = keyof ${legacyBackendAliasName};`,
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: 'const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(adapter);',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/lifecycle.ts',
      content: 'type SessionLoopRuntime = RuntimeTurnOperations;',
    },
  ]);

  const shrinkOnly = report.categories.find((category) => category.id === 'runtimeforloop-agentbackend-shrink-only');
  assert.equal(shrinkOnly?.count, 2);
  assert.deepEqual(shrinkOnly?.files, [
    'apps/cli/src/agent/acp/runtime/createAcpRuntime.ts',
    'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts',
  ]);
});

test('collectV2ZeroInventory keeps current Gemini runtimeCore off constructor-executor debt', () => {
  const inventory = collectFileInventory({
    rootDir: process.cwd(),
    searchRoots: ['apps/cli/src/backends/gemini/runtimeCore'],
    include: /\.ts$/,
  });

  const report = collectV2ZeroInventory(inventory);
  const wholeRunnerDelegation = report.categories.find((category) => category.id === 'runtimecore-create-session-runtime-whole-runner-delegation');

  assert.equal(wholeRunnerDelegation, undefined);
});

test('collectV2ZeroInventory classifies provider execution-run policy plumbing debt', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/gemini/runtimeCore/geminiRuntimeCore.ts',
      content: [
        'export function createGeminiExecutionRunBackend() {',
        '  return wrapExecutionRunBackendWithCleanup(',
        '    createBackend(),',
        "    createExecutionRunPermissionHandler({ backendId: 'gemini', permissionMode: 'default' }),",
        '  );',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/opencode/runtimeCore/openCodeRuntimeCore.ts',
      content: [
        'export function createOpenCodeExecutionRunBackend() {',
        '  return resolveBackendIsolationBundle({ backendId: "opencode" });',
        '}',
      ].join('\n'),
    },
  ]);

  const providerExecutionRunPolicy = report.categories.find((category) => category.id === 'provider-execution-run-policy-plumbing');

  assert.deepEqual(providerExecutionRunPolicy?.files, [
    'apps/cli/src/backends/gemini/runtimeCore/geminiRuntimeCore.ts',
    'apps/cli/src/backends/opencode/runtimeCore/openCodeRuntimeCore.ts',
  ]);
});

test('collectV2ZeroInventory keeps current Gemini/OpenCode runtimeCore off provider execution-run policy plumbing', () => {
  const inventory = collectFileInventory({
    rootDir: process.cwd(),
    searchRoots: [
      'apps/cli/src/backends/gemini/runtimeCore',
      'apps/cli/src/backends/opencode/runtimeCore',
    ],
    include: /\.ts$/,
  });

  const report = collectV2ZeroInventory(inventory);
  const providerExecutionRunPolicy = report.categories.find((category) => category.id === 'provider-execution-run-policy-plumbing');

  assert.equal(providerExecutionRunPolicy, undefined);
});

test('collectV2ZeroInventory keeps dead Codex remote conductor residue off provider session-loop primitive imports', () => {
  const inventory = collectV2ZeroSourceFiles()
    .filter((file) => file.filePath === 'apps/cli/src/backends/codex/runtime/createCodexRemoteSessionConductor.ts');

  const report = collectV2ZeroInventory(inventory);
  const providerSessionLoopImports = report.categories.find(
    (category) => category.id === 'provider-session-loop-primitive-imports',
  );

  assert.equal(providerSessionLoopImports, undefined);
});

test('collectV2ZeroInventory keeps runHostSessionRuntime off shrink-only legacy loop inventory after D3 narrowing', () => {
  const inventory = collectV2ZeroSourceFiles()
    .filter((file) => file.filePath === 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts');

  const report = collectV2ZeroInventory(inventory);
  const shrinkOnly = report.categories.find((category) => category.id === 'runtimeforloop-agentbackend-shrink-only');

  assert.equal(shrinkOnly, undefined);
});

test('collectV2ZeroInventory keeps shared-owner ACP and execution-run runtime files off shrink-only inventory', () => {
  const inventory = collectV2ZeroSourceFiles()
    .filter((file) => (
      file.filePath === 'apps/cli/src/agent/acp/runtime/createAcpRuntime.ts'
    ));

  const report = collectV2ZeroInventory(inventory);
  const shrinkOnly = report.categories.find((category) => category.id === 'runtimeforloop-agentbackend-shrink-only');

  assert.equal(shrinkOnly, undefined);
});

test('collectV2ZeroInventory keeps live execution-run retired backend adapter debt at zero after shell deletion', () => {
  const inventory = collectV2ZeroSourceFiles()
    .filter((file) => (
      file.filePath === 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts'
      || file.filePath === 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.testkit.ts'
    ));

  const report = collectV2ZeroInventory(inventory);
  const semanticDebt = report.categories.find((category) => category.id === 'execution-run-agentbackend-semantic-debt');

  assert.equal(semanticDebt, undefined);
});

test('collectV2ZeroInventory retires provider-leaf execution-run semantic debt after Pi ACP contract narrowing', () => {
  const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const inventory = collectV2ZeroSourceFiles(rootDir)
    .filter((file) => (
      file.filePath === 'apps/cli/src/backends/pi/rpc/PiRpcBackend.ts'
      || file.filePath === 'apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.ts'
    ));

  const report = collectV2ZeroInventory(inventory);
  const semanticDebt = report.categories.find((category) => category.id === 'execution-run-agentbackend-semantic-debt');

  assert.equal(semanticDebt, undefined);
});

test('collectV2ZeroInventory catches retired backend adapter semantic debt in execution-run host ownership', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/backendLongLivedSend.ts',
      content: [
        legacyBackendAliasImport('../../core'),
        'export async function sendBackendLongLivedRun(args: {',
        `  createBackend: (opts: { backendId: string; permissionMode: string }) => ${legacyBackendAliasName};`,
        '}) {}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/executionRunManager/startExecutionRun.ts',
      content: [
        legacyBackendAliasImport('../../../core'),
        'export async function startExecutionRun(args: {',
        `  createBackend: (opts: { backendId: string; permissionMode: string }) => ${legacyBackendAliasName};`,
        '}) {}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import { createAgentBackendFromExecutionRunHostRuntime } from './executionRunAgentBackendRetirementAdapters';",
        `export function createExecutionRunBackend(): ${legacyBackendAliasName} {`,
        '  return createAgentBackendFromExecutionRunHostRuntime({} as never);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/executionRunAgentBackendRetirementAdapters.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        `export function createExecutionRunHostRuntimeFromAgentBackend(backend: ${legacyBackendAliasName}) {`,
        '  return backend;',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunRuntime.ts',
      content: [
        "import { withExecutionRunRuntimeIdentityPublication } from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';",
        'export async function createExecutionRunRuntime(runtime: unknown, identity: unknown) {',
        '  return withExecutionRunRuntimeIdentityPublication({ runtime, identity });',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
      content: `type ${legacyBackendAliasOperationName} = keyof ${legacyBackendAliasName};`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/createCliRuntimeCore.ts',
      content: [
        "import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from '@/agent/runtime/bridges/executionRun/createExecutionRunHostRuntimeFromRuntimeTurnOperations';",
        'export function createCliRuntimeCore(runtime: unknown) {',
        '  return createExecutionRunHostRuntimeFromRuntimeTurnOperations(runtime);',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/engineRegistryTypes.ts',
      content: [
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        'export type CreateCliExecutionRunBackend = () => ExecutionRunHostRuntime;',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createLazyExecutionRunHostRuntime.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        'export function createLazyExecutionRunHostRuntime(args: {',
        `  resolveBackend: () => Promise<${legacyBackendAliasName}>;`,
        '}) {}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createDescriptorExecutionRunHostRuntime.ts',
      content: [
        "import { requireExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        'export function createDescriptorExecutionRunHostRuntime() {',
        '  return requireExecutionRunHostRuntime({});',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/identity/executionRunRuntimeIdentityPublication.ts',
      content: [
        "import type { AgentMessage } from '@/agent/core';",
        'export function withExecutionRunRuntimeIdentityPublication(args: { runtime: { subscribeMessages: (handler: (message: AgentMessage) => void) => () => void } }) {',
        '  return args.runtime;',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/executionRun/createExecutionRunHostRuntimeFromRuntimeTurnOperations.ts',
      content: [
        "import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';",
        'export function createExecutionRunHostRuntimeFromRuntimeTurnOperations(runtime: RuntimeTurnOperations) {',
        '  return runtime;',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunHostRuntime.ts',
      content: `export function createAgentBackendFromExecutionRunHostRuntime(): ${legacyBackendAliasName} { throw new Error("adapter"); }`,
    },
  ]);

  const semanticDebt = report.categories.find((category) => category.id === 'execution-run-agentbackend-semantic-debt');
  assert.equal(semanticDebt?.count, 4);
  assert.deepEqual(semanticDebt?.files, [
    'apps/cli/src/agent/executionRuns/runtime/backendLongLivedSend.ts',
    'apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.ts',
    'apps/cli/src/agent/executionRuns/runtime/executionRunAgentBackendRetirementAdapters.ts',
    'apps/cli/src/agent/executionRuns/runtime/executionRunManager/startExecutionRun.ts',
  ]);
});

test('collectV2ZeroInventory catches retired backend adapter semantic debt in provider execution-run leaves and review backends', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class CodeRabbitReviewBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/pi/rpc/PiRpcBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class PiRpcBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class ClaudeSdkAgentBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
  ]);

  const semanticDebt = report.categories.find((category) => category.id === 'execution-run-agentbackend-semantic-debt');
  assert.equal(semanticDebt?.count, 3);
  assert.deepEqual(semanticDebt?.files, [
    'apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.ts',
    'apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts',
    'apps/cli/src/backends/pi/rpc/PiRpcBackend.ts',
  ]);
});

test('collectV2ZeroLaneExtractReports projects execution-run retired backend adapter semantic debt into lane v2-3', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class CodeRabbitReviewBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class ClaudeSdkAgentBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/opencode/executionRuns/createOpenCodeServerExecutionRunBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export function createOpenCodeServerExecutionRunBackend(): ${legacyBackendAliasName} & ExecutionRunHostRuntime {`,
        '  return {} as never;',
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/backends/pi/rpc/PiRpcBackend.ts',
      content: [
        legacyBackendAliasImport('@/agent/core'),
        "import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';",
        `export class PiRpcBackend implements ${legacyBackendAliasName}, ExecutionRunHostRuntime {}`,
      ].join('\n'),
    },
  ]);

  const laneReports = collectV2ZeroLaneExtractReports(report);
  const v23 = laneReports.find((laneReport) => laneReport.laneId === 'v2-3');

  assert.deepEqual(v23?.categories.map((category) => category.id), [
    'execution-run-agentbackend-semantic-debt',
  ]);
  assert.deepEqual(v23?.files, [
    'apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.ts',
    'apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts',
    'apps/cli/src/backends/opencode/executionRuns/createOpenCodeServerExecutionRunBackend.ts',
    'apps/cli/src/backends/pi/rpc/PiRpcBackend.ts',
  ]);
});

test('collectV2ZeroInventory does not count customAcp translation strings as sentinel consumers', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/ui/sources/text/translations/en.ts',
      content: "export const en = { foo: 'customAcp' };",
    },
    {
      filePath: 'apps/ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries.ts',
      content: "export const backend = 'customAcp';",
    },
  ]);

  const category = report.categories.find((entry) => entry.id === 'customacp-sentinel-consumers');
  assert.deepEqual(category?.files, [
    'apps/ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries.ts',
  ]);
});

test('collectV2ZeroInventory does not count customAcp prose comments as sentinel consumers', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/cli/commands/documented.ts',
      content: "/**\n * Explains the `customAcp` compatibility family for readers.\n */\nexport const documented = true;\n",
    },
    {
      filePath: 'apps/cli/src/cli/commands/lineComment.ts',
      content: "// customAcp is handled elsewhere.\nexport const lineComment = true;\n",
    },
    {
      filePath: 'apps/cli/src/cli/commands/behavioral.ts',
      content: "export const routed = (id: string) => id === 'customAcp';\n",
    },
  ]);

  const category = report.categories.find((entry) => entry.id === 'customacp-sentinel-consumers');
  assert.deepEqual(category?.files, ['apps/cli/src/cli/commands/behavioral.ts']);
});


test('collectV2ZeroInventory keeps provider-enforced action auto-approvals off permission taxonomy fork inventory', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/agent/permissions/providerEnforced/handler.ts',
      content: `
const ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS = new Set([
  'session.title.set',
  'action.spec.search',
]);
`,
    },
  ]);

  assert.equal(report.categories.find((entry) => entry.id === 'permission-taxonomy-forks'), undefined);
});

test('collectV2ZeroInventory keeps UI provider catalog helpers off the static registry inventory after the catalog split', () => {
  const targetFiles = new Set([
    'apps/ui/sources/agents/backendCatalog/agentCatalogProjection.ts',
    'apps/ui/sources/agents/providers/registry/providerLocalAuthRegistry.ts',
    'apps/ui/sources/agents/providers/registry/providerSettingsRegistry.ts',
    'apps/ui/sources/agents/providers/registry/providerSettingArtifacts.ts',
    'apps/ui/sources/agents/providers/registry/providerSubagentSettingsRegistry.ts',
    'apps/ui/sources/components/settings/agents/setup/AgentSetupFlow.tsx',
  ]);
  const inventory = collectV2ZeroSourceFiles(repoRootDir)
    .filter((file) => targetFiles.has(file.filePath));

  const report = collectV2ZeroInventory(inventory);

  assert.equal(report.categories.find((entry) => entry.id === 'static-ui-registry-consumers'), undefined);
});

test('collectV2ZeroInventory keeps neutral legacy compat UI consumers off customacp sentinel inventory', () => {
  const targetFiles = new Set([
    'apps/ui/sources/agents/backendCatalog/backendTargetRouteParams.ts',
    'apps/ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries.ts',
    'apps/ui/sources/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget.ts',
    'apps/ui/sources/agents/backendCatalog/resolvePreferredBackendTargetFromSettings.ts',
    'apps/ui/sources/voice/tools/actionImpl/agentCatalogList.ts',
    'apps/ui/sources/voice/tools/actionImpl/spawnSessionAgent.ts',
  ]);
  const inventory = collectV2ZeroSourceFiles(repoRootDir)
    .filter((file) => targetFiles.has(file.filePath));

  const report = collectV2ZeroInventory(inventory);

  assert.equal(report.categories.find((entry) => entry.id === 'customacp-sentinel-consumers'), undefined);
});


test('collectV2ZeroInventory keeps provider batch waiters off session-loop primitive imports after shared extraction', () => {
  const inventory = collectV2ZeroSourceFiles(repoRootDir)
    .filter((file) => file.filePath === 'apps/cli/src/backends/claude/runtime/remote/createBatchWaiter.ts');

  const report = collectV2ZeroInventory(inventory);

  assert.equal(report.categories.find((entry) => entry.id === 'provider-session-loop-primitive-imports'), undefined);
});

test('collectV2ZeroSourceFiles excludes vendored/public and generated folders (non-source)', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'v2-zero-sourcefiles-'));
  mkdirSync(join(rootDir, 'apps/ui/public/monaco'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/server/generated/sqlite-client/runtime'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src/agent/runtime'), { recursive: true });

  writeFileSync(join(rootDir, 'apps/ui/public/monaco/worker.js'), "const providerId = 'codex';\n");
  writeFileSync(join(rootDir, 'apps/server/generated/sqlite-client/runtime/edge.js'), "const agentId = 'customAcp';\n");
  writeFileSync(join(rootDir, 'apps/cli/src/agent/runtime/realSource.ts'), "export const agentId = 'customAcp';\n");

  const files = collectV2ZeroSourceFiles(rootDir).map((file) => file.filePath).sort((a, b) => a.localeCompare(b));

  assert.deepEqual(files, [
    'apps/cli/src/agent/runtime/realSource.ts',
  ]);
});

test('collectFileInventory excludes repository-owned generated artifact trees without hiding source lookalikes', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'migration-inventory-generated-artifacts-'));
  const generatedFiles = [
    'apps/cli/dist.probe.manual/generated.ts',
    'apps/cli/.runner-snapshots/0123456789abcdef/generated.ts',
    'apps/cli/.g3-real-child-fixture/generated.ts',
    'apps/ui/dist-dperf/_expo/static/js/web/generated.ts',
  ];
  const sourceFiles = [
    'apps/cli/src/dist.probe.manual/source.ts',
    'apps/cli/src/.g3-real-child-fixture/source.ts',
    'apps/cli/src/.runner-snapshots-source/source.ts',
    'apps/ui/sources/dist-dperf/source.ts',
    'packages/example/dist.probe.manual/source.ts',
    'packages/example/.g3-real-child-fixture/source.ts',
  ];

  for (const filePath of [...generatedFiles, ...sourceFiles]) {
    const absolutePath = join(rootDir, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'export const proof = true;\n', 'utf8');
  }

  const files = collectFileInventory({
    rootDir,
    include: /\.ts$/,
  }).map((file) => file.filePath);

  assert.deepEqual(files, [...sourceFiles].sort((left, right) => left.localeCompare(right)));
});

test('collectV2ZeroSourceFiles excludes review workspaces from source inventory', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'v2-zero-sourcefiles-reviews-'));
  mkdirSync(join(rootDir, '.reviews/2026-06-23/subagents'), { recursive: true });
  mkdirSync(join(rootDir, '.project/reviews/2026-06-23/subagents'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src/agent/runtime'), { recursive: true });

  writeFileSync(join(rootDir, '.reviews/2026-06-23/subagents/report.js'), "const providerId = 'codex';\n");
  writeFileSync(join(rootDir, '.project/reviews/2026-06-23/subagents/report.ts'), "const providerId = 'claude';\n");
  writeFileSync(join(rootDir, 'apps/cli/src/agent/runtime/realSource.ts'), "export const agentId = 'customAcp';\n");

  const files = collectV2ZeroSourceFiles(rootDir).map((file) => file.filePath).sort((a, b) => a.localeCompare(b));

  assert.deepEqual(files, [
    'apps/cli/src/agent/runtime/realSource.ts',
  ]);
});

test('collectV2ZeroSourceFiles excludes source-side js sidecars when a ts sibling exists', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'v2-zero-sourcefiles-sidecars-'));
  mkdirSync(join(rootDir, 'packages/agents/src'), { recursive: true });

  writeFileSync(join(rootDir, 'packages/agents/src/manifest.ts'), 'export const AGENTS_CORE = {};\n');
  writeFileSync(join(rootDir, 'packages/agents/src/manifest.js'), 'exports.AGENTS_CORE = {};\n');
  writeFileSync(join(rootDir, 'packages/agents/src/types.ts'), "export const agentId = 'customAcp';\n");
  writeFileSync(join(rootDir, 'packages/agents/src/types.js'), "exports.agentId = 'customAcp';\n");

  const files = collectV2ZeroSourceFiles(rootDir).map((file) => file.filePath).sort((a, b) => a.localeCompare(b));

  assert.deepEqual(files, [
    'packages/agents/src/manifest.ts',
    'packages/agents/src/types.ts',
  ]);
});

test('collectV2ZeroLaneExtractReports projects the inventory into deterministic lane extracts', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/plugins/registry/createResolvedContributionRegistry.ts',
      content: "export function getResolvedContributionRegistry() { return null; }",
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts',
      content: 'resolveBackendExecutionSurfacesFromEngine',
    },
    {
      filePath: 'packages/agents/src/definitions/types.ts',
      content: 'export const backendCatalogDefinition = {};',
    },
    {
      filePath: 'packages/agents/src/runtime/engine/specs.ts',
      content: 'export const engineSpec = {};',
    },
    {
      filePath: 'packages/protocol/src/sessionMetadata/runtimeDescriptorV1.ts',
      content: 'export const runtimeDescriptorV1 = {};',
    },
    {
      filePath: 'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts',
      content: 'export function publishRuntimeIdentity() {}',
    },
    {
      filePath: 'packages/agents/src/runtime/preferences/index.ts',
      content: 'export const runtimePreferences = {};',
    },
    {
      filePath: 'packages/agents/src/runtime/discovery/runtimeDiscovery.ts',
      content: 'export const runtimeDiscovery = {};',
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.ts',
      content: 'export const ReviewProfile = {};',
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/createExecutionRunPermissionPromptStore.ts',
      content: "import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';",
    },
    {
      filePath: 'apps/cli/src/cli/buildRootHelpText.ts',
      content: 'export const rootHelp = listRootHelpCommands();',
    },
    {
      filePath: 'apps/cli/src/session/services/providerBranching.ts',
      content: [
        "export function resolveBackend(providerId: string) {",
        "  if (providerId === 'claude') return 'claude';",
        "  return providerId === 'codex' ? 'codex' : 'fallback';",
        '}',
      ].join('\n'),
    },
    {
      filePath: 'apps/cli/src/agent/voice/agent/VoiceAgentManager.ts',
      content: "export const voiceAgent = 'voice_agent';",
    },
    {
      filePath: 'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts',
      content: 'export function publishRuntimeIdentity() {}',
    },
    {
      filePath: 'packages/protocol/src/actions/actionIds.ts',
      content: "export const ACTION_IDS = ['review'];",
    },
    {
      filePath: 'apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.ts',
      content: 'export function dispatchPluginHookEvent() {}',
    },
    {
      filePath: 'apps/cli/src/plugins/manifest/validate.ts',
      content: 'export function validatePluginManifest() {}',
    },
    {
      filePath: 'apps/cli/src/plugins/plugins/install/install.ts',
      content: 'export const installPlugin = () => true;',
    },
  ]);

  const laneReports = collectV2ZeroLaneExtractReports(report);

  assert.deepEqual(laneReports.map((laneReport) => laneReport.laneId), [
    'a1',
    'a2-a3',
    'a4',
    'a5',
    'v2-1',
    'v2-2',
    'v2-3',
    'v2-4',
    'v2-5',
    'v2-6',
    'v2-7',
    'b8',
  ]);

  const a1 = laneReports.find((laneReport) => laneReport.laneId === 'a1');
  assert.deepEqual(a1?.categories.map((category) => category.id), [
    'builtin-cli-catalog-consumers',
    'implicit-abi-surfaces',
    'shared-core-provider-branching',
  ]);
  assert.deepEqual(a1?.files, [
    'apps/cli/src/agent/runtime/registry/backendEngineSurfaceBindings.ts',
    'apps/cli/src/plugins/registry/createResolvedContributionRegistry.ts',
    'apps/cli/src/session/services/providerBranching.ts',
  ]);
  assert.deepEqual(a1?.executionCommands.map((command) => command.title), [
    'Print this lane packet',
    'Refresh the live V2-0 inventory',
    'Run the migration policy lane',
  ]);
  assert.deepEqual(a1?.executionCommands[0]?.argv, [
    'node',
    '--experimental-strip-types',
    'scripts/testing/migrations/printV2ZeroLaneExecutionPackets.ts',
    '--lane',
    'a1',
  ]);
  assert.match(formatV2ZeroLaneExtractMarkdown(a1 as NonNullable<typeof a1>), /Lane A1: CLI Registry Convergence/);
  assert.match(formatV2ZeroLaneExtractMarkdown(a1 as NonNullable<typeof a1>), /Execution Commands/);
  assert.deepEqual(
    collectV2ZeroLaneExtractFiles(a1 as NonNullable<typeof a1>),
    a1?.files,
  );

  const v22 = laneReports.find((laneReport) => laneReport.laneId === 'v2-2');
  assert.deepEqual(v22?.categories.map((category) => category.id), [
    'builtin-cli-catalog-consumers',
    'implicit-abi-surfaces',
    'shared-core-provider-branching',
  ]);

  const v21 = laneReports.find((laneReport) => laneReport.laneId === 'v2-1');
  assert.deepEqual(v21?.categories.map((category) => category.id), [
    'runtime-identity-publication-read',
  ]);
  assert.match(formatV2ZeroLaneExtractMarkdown(v21 as NonNullable<typeof v21>), /Lane V2-1: Static Definition Split, Engine Spec, And Runtime Foundation/);
  assert.deepEqual(
    collectV2ZeroLaneExtractFiles(v21 as NonNullable<typeof v21>),
    [
      'packages/agents/src/runtime/identity/runtimeIdentityPublication.ts',
    ],
  );

  const v23 = laneReports.find((laneReport) => laneReport.laneId === 'v2-3');
  assert.deepEqual(v23?.categories.map((category) => category.id), [
    'execution-run-permission-interaction-centralization',
    'implicit-abi-surfaces',
    'runtime-identity-publication-read',
    'shared-core-provider-branching',
    'voice-runtime-entrypoints',
  ]);

  const v24 = laneReports.find((laneReport) => laneReport.laneId === 'v2-4');
  assert.deepEqual(v24?.categories.map((category) => category.id), [
    'implicit-abi-surfaces',
    'runtime-identity-publication-read',
    'shared-core-provider-branching',
  ]);

  const v26 = laneReports.find((laneReport) => laneReport.laneId === 'v2-6');
  assert.deepEqual(v26?.categories.map((category) => category.id), [
    'implicit-abi-surfaces',
    'shared-core-provider-branching',
  ]);

  const v27 = laneReports.find((laneReport) => laneReport.laneId === 'v2-7');
  assert.deepEqual(v27?.categories.map((category) => category.id), [
    'hook-emission-sites',
    'implicit-abi-surfaces',
    'shared-core-provider-branching',
  ]);
});

test('runV2ZeroInventory stays read-only by default', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-'));
  const report = await runV2ZeroInventory({
    rootDir,
    files: [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
    ],
  });

  assert.equal(report.filesScanned, 1);
  assert.equal(existsSync(join(rootDir, '.project/testing/reports/governance/v2-0-inventory.md')), false);
  assert.equal(existsSync(join(rootDir, '.project/testing/reports/governance/v2-0-inventory.json')), false);
});

test('collectV2ZeroSourceFiles includes scripts/testing governance sources', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-scripts-testing-'));
  const filePath = join(rootDir, 'scripts/testing/migrations/nested/proofGuard.ts');
  mkdirSync(join(rootDir, 'scripts/testing/migrations/nested'), { recursive: true });
  writeFileSync(filePath, 'export const proofGuard = true;\n', 'utf8');

  const files = collectV2ZeroSourceFiles(rootDir);
  assert.ok(files.some((file) => file.filePath === 'scripts/testing/migrations/nested/proofGuard.ts'));
});

test('collectV2ZeroSourceFiles includes only Voice V3-F positive-test residue needed by the contraction inventory', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-voice-v3-f-tests-'));
  mkdirSync(join(rootDir, 'packages/protocol/src/machines/peer/mediation'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src/daemon/machine'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/protocol/src/machines/peer/mediation/renamedPositiveCoverage.test.ts'),
    "expect(VoiceMediaAgentRealtimeFrameV1Schema.parse({})).toBeDefined();\n",
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'apps/cli/src/daemon/machine/negativeAbsence.test.ts'),
    "expect(source).not.toContain('voiceMediaAgentRealtimeConsumer');\n",
    'utf8',
  );

  const files = collectV2ZeroSourceFiles(rootDir).map((file) => file.filePath);

  assert.deepEqual(files, [
    'packages/protocol/src/machines/peer/mediation/renamedPositiveCoverage.test.ts',
  ]);
});

test('runV2ZeroInventory writes report artifacts only when explicitly requested', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-'));
  const report = await runV2ZeroInventory({
    rootDir,
    writeReports: true,
    files: [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
    ],
  });
  const reportDir = join(rootDir, '.project/testing/reports/governance');
  const expectedEntries = buildV2ZeroInventoryReportEntries(report);

  const markdown = readFileSync(join(reportDir, 'v2-0-inventory.md'), 'utf8');
  const json = readFileSync(join(reportDir, 'v2-0-inventory.json'), 'utf8');
  const laneMarkdown = readFileSync(join(reportDir, 'v2-0-lane-a1-extract.md'), 'utf8');
  const laneJson = readFileSync(join(reportDir, 'v2-0-lane-a1-extract.json'), 'utf8');
  const laneMarkdownV21 = readFileSync(join(reportDir, 'v2-0-lane-v2-1-extract.md'), 'utf8');
  const laneJsonV21 = readFileSync(join(reportDir, 'v2-0-lane-v2-1-extract.json'), 'utf8');

  assert.equal(report.filesScanned, 1);
  assert.match(markdown, /unique files matched: 1/);
  assert.match(markdown, /V2-0 Inventory Report/);
  assert.match(json, /builtin-cli-catalog-consumers/);
  assert.match(json, /"files": \[/);
  assert.match(json, /"filesMatched": 1/);
  assert.match(formatV2ZeroInventoryMarkdown(report), /Built-in CLI catalog consumers/);
  assert.match(laneMarkdown, /- files: apps\/cli\/src\/backends\/catalog\.ts/);
  assert.match(laneJson, /"files": \[/);
  assert.match(laneMarkdownV21, /Lane V2-1: Static Definition Split, Engine Spec, And Runtime Foundation/);
  assert.match(laneJsonV21, /"laneId": "v2-1"/);
  assert.match(laneJsonV21, /runtime-identity-publication-read/);
  assert.deepEqual(
    readdirSync(reportDir)
      .filter((entry) => entry.startsWith('v2-0-'))
      .sort(),
    Object.keys(expectedEntries).map((entry) => entry.replace('.project/testing/reports/governance/', '')).sort(),
  );

  for (const [relativePath, expectedContent] of Object.entries(expectedEntries)) {
    const absolutePath = join(rootDir, relativePath);
    assert.ok(existsSync(absolutePath), `expected report artifact to exist: ${relativePath}`);
    assert.equal(readFileSync(absolutePath, 'utf8'), expectedContent, `expected report artifact content to match: ${relativePath}`);
  }
});

test('planV2ZeroLaneImportRewrites scopes codemods to lane-targeted files only', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
    {
      filePath: 'apps/ui/sources/example.tsx',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
  ]);
  const laneReports = collectV2ZeroLaneExtractReports(report);
  const a1 = laneReports.filter((laneReport) => laneReport.laneId === 'a1');

  const plan = planV2ZeroLaneImportRewrites(
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
      {
        filePath: 'apps/ui/sources/example.tsx',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
    ],
    a1,
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/plugins/registry/createResolvedContributionRegistry',
        to: '@/plugins/registry/createResolvedContributionRegistryV2',
      },
    ],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    plan.edits[0]?.after,
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
});

test('buildV2ZeroLaneRewriteExecutionPacket produces lane-scoped rewrite inputs', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
    {
      filePath: 'apps/ui/sources/example.tsx',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
  ]);
  const laneReport = collectV2ZeroLaneExtractReports(report).find((lane) => lane.laneId === 'a1');

  const packet = buildV2ZeroLaneRewriteExecutionPacket(
    laneReport as NonNullable<typeof laneReport>,
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
      {
        filePath: 'apps/ui/sources/example.tsx',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/plugins/registry/createResolvedContributionRegistry',
        to: '@/plugins/registry/createResolvedContributionRegistryV2',
      },
    ],
  );

  assert.equal(packet.laneReport.laneId, 'a1');
  assert.deepEqual(packet.targetFilePaths, ['apps/cli/src/backends/catalog.ts']);
  assert.equal(packet.rewritePlan.edits.length, 1);
  assert.equal(packet.rewritePlan.edits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    packet.rewritePlan.edits[0]?.after,
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
});

test('buildV2ZeroLaneRewriteDryRunPacket validates lane rewrites against live inventory before execution', () => {
  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
    {
      filePath: 'apps/ui/sources/example.tsx',
      content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
    },
  ]);
  const laneReport = collectV2ZeroLaneExtractReports(report).find((lane) => lane.laneId === 'a1');

  const packet = buildV2ZeroLaneRewriteDryRunPacket(
    laneReport as NonNullable<typeof laneReport>,
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
      {
        filePath: 'apps/ui/sources/example.tsx',
        content: "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';",
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/plugins/registry/createResolvedContributionRegistry',
        to: '@/plugins/registry/createResolvedContributionRegistryV2',
      },
    ],
  );

  assert.equal(packet.laneReport.laneId, 'a1');
  assert.equal(packet.canExecute, true);
  assert.deepEqual(packet.missingTargetFilePaths, []);
  assert.deepEqual(packet.wouldChangeFilePaths, ['apps/cli/src/backends/catalog.ts']);
  assert.equal(packet.rewritePlan.edits.length, 1);
  assert.equal(packet.rewritePlan.edits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
});

test('buildV2ZeroLaneRewriteApplyPacket applies lane rewrites when dry-run validation passes', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-apply-'));
  const targetPath = join(rootDir, 'apps/cli/src/backends/catalog.ts');
  const targetContent = "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';";
  mkdirSync(join(rootDir, 'apps/cli/src/backends'), { recursive: true });
  writeFileSync(targetPath, targetContent, 'utf8');

  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: targetContent,
    },
  ]);
  const laneReport = collectV2ZeroLaneExtractReports(report).find((lane) => lane.laneId === 'a1');

  const packet = buildV2ZeroLaneRewriteApplyPacket(
    laneReport as NonNullable<typeof laneReport>,
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: targetContent,
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/plugins/registry/createResolvedContributionRegistry',
        to: '@/plugins/registry/createResolvedContributionRegistryV2',
      },
    ],
    rootDir,
  );

  assert.equal(packet.canExecute, true);
  assert.equal(packet.applyResult?.appliedEdits.length, 1);
  assert.equal(packet.applyResult?.skippedEdits.length, 0);
  assert.equal(
    readFileSync(targetPath, 'utf8'),
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
});

test('buildV2ZeroLaneRewriteBatchApplyPacket deduplicates overlapping lane edits for a repo slice', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-batch-'));
  const targetPath = join(rootDir, 'apps/cli/src/backends/catalog.ts');
  const targetContent = "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';";
  mkdirSync(join(rootDir, 'apps/cli/src/backends'), { recursive: true });
  writeFileSync(targetPath, targetContent, 'utf8');

  const report = collectV2ZeroInventory([
    {
      filePath: 'apps/cli/src/backends/catalog.ts',
      content: targetContent,
    },
  ]);
  const laneReports = collectV2ZeroLaneExtractReports(report).filter((lane) => lane.laneId === 'a1' || lane.laneId === 'v2-2');

  const packet = buildV2ZeroLaneRewriteBatchApplyPacket(
    laneReports,
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: targetContent,
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/plugins/registry/createResolvedContributionRegistry',
        to: '@/plugins/registry/createResolvedContributionRegistryV2',
      },
    ],
    rootDir,
  );

  assert.equal(packet.canExecute, true);
  assert.equal(packet.laneReports.length, 2);
  assert.deepEqual(packet.targetFilePaths, ['apps/cli/src/backends/catalog.ts']);
  assert.equal(packet.applyResult?.appliedEdits.length, 1);
  assert.equal(packet.applyResult?.skippedEdits.length, 0);
  assert.equal(
    readFileSync(targetPath, 'utf8'),
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
});
