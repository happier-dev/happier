import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type CrossCuttingModule = typeof import('./crossCuttingDuplicateClosure.ts');

async function loadValidator(): Promise<CrossCuttingModule> {
  try {
    return await import('./crossCuttingDuplicateClosure.ts');
  } catch (error) {
    assert.fail(`validator module should load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-cross-cutting-closure-validator-'));
}

function writeRepoFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

test('validateCrossCuttingDuplicateClosure rejects plugin permission lifecycle clones with owner evidence', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/codex/src/agent/utils/permissionHandler.ts',
    [
      'const pendingPermissionRequests = new Map<string, unknown>();',
      'export function cancelAll() {',
      '  pendingPermissionRequests.clear();',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, false);
  const message = result.violations.map((violation) => violation.message).join('\n');
  assert.match(message, /F5-permission-lifecycle/);
  assert.match(message, /packages\/plugins\/codex\/src\/agent\/utils\/permissionHandler\.ts:1/);
  assert.match(message, /A\.5c\/A\.5d shared permission lifecycle/);
  assert.match(message, /owning_packet=A\.5c-cancel-by-plugin,A\.5d-permission-lifecycle-guardrail/);
});

test('validateCrossCuttingDuplicateClosure rejects local JSONL/readline clients and ACP factories', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/pi/src/agent/runtime/jsonlClient.ts',
    [
      "import readline from 'node:readline';",
      'const pendingRequests = new Map<string, unknown>();',
      'export const reader = readline;',
      'void pendingRequests;',
      '',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/copilot/src/agent/acp/runtime.ts',
    [
      "import { AcpBackend } from '@/agent/acp/AcpBackend';",
      'export function createRuntime() {',
      '  return new AcpBackend({});',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, false);
  const message = result.violations.map((violation) => violation.message).join('\n');
  assert.match(message, /F5-jsonl-readline-client/);
  assert.match(message, /canonical_owner=A\.13e strict-LF JSONL substrate/);
  assert.match(message, /F5-tier2-acp-factory/);
  assert.match(message, /canonical_owner=canonical Agent contributions through activate\(api\)/);
});

test('validateCrossCuttingDuplicateClosure rejects final plugin src backend folders', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/scm-sapling/src/backend/runtime.ts',
    'export const duplicateBackendOwner = true;\n',
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, false);
  const violation = result.violations.find((item) => item.familyId === 'F5-no-plugin-src-backend');
  assert.ok(violation);
  assert.equal(violation.owningPacket, 'FD-0064,F.5');
  assert.equal(violation.canonicalOwner, 'plugin concern folders under packages/plugins/<id>/src/agent/** or a specific non-agent contribution folder');
});

test('validateCrossCuttingDuplicateClosure rejects provider-local MCP detector symbols', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/opencode/src/agent/mcp/configDetector.ts',
    'export function detectOpenCodeMcpServers() { return []; }\n',
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.familyId, 'F5-mcp-discovery-duplicate');
  assert.match(result.violations[0]?.message ?? '', /manifest-first MCP contribution substrate/);
});

test('validateCrossCuttingDuplicateClosure accepts first-party MCP config reader leaves after manifest-first registration', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();

  const result = validateCrossCuttingDuplicateClosure({
    rootDir: process.cwd(),
    enabledForbiddenFamilies: ['F5-mcp-discovery-duplicate'],
    enabledRequiredFamilies: [],
  });

  const targetedViolations = result.violations.filter((violation) =>
    /packages\/plugins\/(?:claude|codex|opencode)\//.test(violation.filePath),
  );

  assert.deepEqual(targetedViolations, []);
});

test('validateCrossCuttingDuplicateClosure allows public SDK exec spawn while rejecting raw plugin process spawns', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/review-coderabbit/src/agent/reviews/run.ts',
    [
      'export async function runWithSdkExec(ctx, launch) {',
      '  return await ctx.exec.spawn(launch);',
      '}',
      '',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/example/src/agent/runtime/rawSpawn.ts',
    [
      "import { spawn } from 'node:child_process';",
      'export function runRaw(command) {',
      '  return spawn(command, []);',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-process-spawn-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    [...new Set(result.violations.map((violation) => violation.filePath))],
    ['packages/plugins/example/src/agent/runtime/rawSpawn.ts'],
  );
  assert.match(result.violations[0]?.message ?? '', /F5-process-spawn-duplicate/);
});

test('validateCrossCuttingDuplicateClosure excludes explicit test-support harnesses from production duplicate fences', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support.ts',
    [
      "import { execFileSync } from 'node:child_process';",
      "export function runGit() { return execFileSync('git', ['status']); }",
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-process-spawn-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.scannedFiles, []);
});

test('validateCrossCuttingDuplicateClosure rejects host TTL residue by default', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/opencode/src/agent/server/startManagedServer.ts',
    [
      'export async function waitForServerReady() {',
      '  await new Promise((resolve) => setTimeout(resolve, 50));',
      '}',
      '',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/opencode/src/agent/permissions/permissionWaiter.ts',
    [
      'export function expirePendingPermissionRequest(cancelPermissionRequest) {',
      '  setTimeout(() => cancelPermissionRequest(), 50);',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, false);
  const hostTtlViolations = result.violations.filter((violation) => violation.familyId === 'F5-permission-host-ttl');
  assert.deepEqual(
    hostTtlViolations.map((violation) => `${violation.filePath}:${violation.line}`),
    ['packages/plugins/opencode/src/agent/permissions/permissionWaiter.ts:2'],
  );
  assert.match(hostTtlViolations[0]?.message ?? '', /host-imposed permission timer/);
});

test('validateCrossCuttingDuplicateClosure enables every F5 forbidden family by default', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/ui/sources/agents/providers/codex/sessionMediaRenderer.tsx',
    'export const CodexSessionMediaRenderer = () => null;\n',
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/example/src/manifest.ts',
    [
      'export const manifest = {',
      '  contributes: { backends: [{ capabilities: { executionRun: { supported: true }, nativeImageGeneration: true } }] },',
      '};',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });
  const familyIds = new Set(result.violations.map((violation) => violation.familyId));

  assert.equal(result.ok, false);
  assert.ok(familyIds.has('F5-provider-keyed-owner-tree'));
  assert.ok(familyIds.has('F5-execution-run-capability-residue'));
  assert.ok(familyIds.has('F5-session-media-capability-overclaim'));
});

test('validateCrossCuttingDuplicateClosure rejects stale message meta registry residue', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();

  const result = validateCrossCuttingDuplicateClosure({
    files: [
      {
        filePath: 'packages/agents/src/runtime/adjunctAdapters/messageMetaRegistry.ts',
        content: 'export const stale = true;\n',
      },
      {
        filePath: 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts',
        content: 'export const stale = true;\n',
      },
      {
        filePath: 'scripts/migrations/extensions/generateBundledPluginEntries.ts',
        content: 'const messageMetaOverridesOutPath = "stale";\n',
      },
    ],
    enabledForbiddenFamilies: ['MESSAGE-META-REGISTRY-1-deletion'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.filePath),
    [
      'packages/agents/src/runtime/adjunctAdapters/messageMetaRegistry.ts',
      'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts',
      'scripts/migrations/extensions/generateBundledPluginEntries.ts',
    ],
  );
  assert.match(result.violations[0]?.message ?? '', /MESSAGE-META-REGISTRY-1-deletion/);
  assert.match(result.violations[0]?.message ?? '', /plugin descriptor\/projection message metadata/);
});

test('validateCrossCuttingDuplicateClosure rejects plugin runtime auth and connected-service substrate duplicates', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/gemini/src/agent/runtime/authService.ts',
    [
      'export async function refreshOauthToken(tokenStore) {',
      '  return tokenStore.connectedServices.oauth.refresh();',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-auth-connected-services-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.familyId, 'F5-auth-connected-services-duplicate');
  assert.match(result.violations[0]?.message ?? '', /auth-and-services descriptors\/materializers/);
});

test('validateCrossCuttingDuplicateClosure rejects stale agent connectedServices auth owners after auth/services rename', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/gemini/src/agent/connectedServices/auth.ts',
    [
      'export function materializeGeminiConnectedServicesAuth(record) {',
      '  return { oauth: record.oauth, tokenStore: record.tokenStore };',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-auth-connected-services-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.familyId, 'F5-auth-connected-services-duplicate');
  assert.match(result.violations[0]?.message ?? '', /packages\/plugins\/gemini\/src\/agent\/connectedServices\/auth\.ts/);
});

test('validateCrossCuttingDuplicateClosure rejects final provider-keyed owner tree and stale capability fixtures when enabled', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/ui/sources/agents/providers/codex/sessionMediaRenderer.tsx',
    'export const CodexSessionMediaRenderer = () => null;\n',
  );
  writeRepoFile(
    rootDir,
    'packages/protocol/src/agents/codex/runtimeDescriptor.ts',
    'export const descriptor = { providerId: "codex" };\n',
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/example/src/manifest.ts',
    [
      'export const manifest = {',
      '  contributes: { backends: [{ capabilities: { executionRun: { supported: true } } }] },',
      '};',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-provider-keyed-owner-tree', 'F5-execution-run-capability-residue'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.familyId === 'F5-provider-keyed-owner-tree'));
  assert.ok(result.violations.some((violation) => violation.familyId === 'F5-execution-run-capability-residue'));
});

test('validateCrossCuttingDuplicateClosure allows only the retained provider-id compatibility re-export', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();

  const result = validateCrossCuttingDuplicateClosure({
    files: [
      {
        filePath: 'packages/protocol/src/agents/runtimeDescriptorContributionsV1.ts',
        content: "export * from './generated/runtime/descriptorContributionsV1.js';\n",
      },
      {
        filePath: 'packages/protocol/src/agents/agentProviderIdsV1.ts',
        content: [
          "export { AGENT_PROVIDER_IDS_V1, AgentProviderIdV1Schema } from '../generated/providers/agentProviderIdsV1.js';",
          "export type { AgentProviderIdV1 } from '../generated/providers/agentProviderIdsV1.js';",
          '',
        ].join('\n'),
      },
      {
        filePath: 'packages/protocol/src/agents/bitbucket/connectedAccountDescriptor.ts',
        content: [
          "export { BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR } from '../../connect/descriptors/bitbucket.js';",
          'const staleOwnerLogic = true;',
          '',
        ].join('\n'),
      },
      {
        filePath: 'packages/protocol/src/agents/codex/runtimeDescriptor.ts',
        content: "export { CODEX_RUNTIME_DESCRIPTOR } from '../../generated/providers/codexRuntimeDescriptor.js';\n",
      },
    ],
    enabledForbiddenFamilies: ['F5-provider-keyed-owner-tree'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.filePath),
    [
      'packages/protocol/src/agents/runtimeDescriptorContributionsV1.ts',
      'packages/protocol/src/agents/bitbucket/connectedAccountDescriptor.ts',
      'packages/protocol/src/agents/codex/runtimeDescriptor.ts',
    ],
  );
});

test('validateCrossCuttingDuplicateClosure rejects legacy native image generation overclaim fixtures', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/example/src/manifest.ts',
    [
      'export const manifest = {',
      '  contributes: { backends: [{ capabilities: { nativeImageGeneration: true } }] },',
      '};',
      '',
    ].join('\n'),
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-session-media-capability-overclaim'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.familyId, 'F5-session-media-capability-overclaim');
  assert.match(result.violations[0]?.message ?? '', /source-real session-media output mapping/);
});

test('validateCrossCuttingDuplicateClosure ignores generated and packaged outputs during repository scans', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/server/generated/mysql-client/runtime.ts',
    'export const lastRuntimeIssue = true;\n',
  );
  writeRepoFile(
    rootDir,
    'apps/cli/package-dist/plugin-cache/runtime.js',
    'export const turn_aborted = true;\n',
  );
  writeRepoFile(
    rootDir,
    'apps/.project/tmp/expo-web-export-smoke/runtime.ts',
    'export const sessionListFailure = true;\n',
  );

  const result = validateCrossCuttingDuplicateClosure({ rootDir, enabledRequiredFamilies: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.scannedFiles, []);
});

test('validateCrossCuttingDuplicateClosure ignores hidden build-swap directories during repository scans', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/cli-common/.dist.build.123.456/runtime.ts',
    'export const leakedRuntimeClone = "turn_aborted";\n',
  );
  writeRepoFile(
    rootDir,
    'packages/cli-common/.dist.backup.123.456/relayHost/runtime.ts',
    'export const leakedRelayRuntimeClone = "turn_aborted";\n',
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-runtime-failure-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.scannedFiles, []);
});

test('validateCrossCuttingDuplicateClosure tolerates scan roots that disappear during collection', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'packages/plugins/example/src/agent/runtime/healthy.ts', 'export const healthy = true;\n');
  rmSync(join(rootDir, 'packages/plugins/example/src/agent/runtime'), { recursive: true, force: true });

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-runtime-failure-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.scannedFiles, []);
});

test('validateCrossCuttingDuplicateClosure reports missing required substrate evidence when enabled', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledRequiredFamilies: ['F5-jsonl-substrate-consumption'],
  });

  assert.equal(result.ok, false);
  const violation = result.violations.find((item) => item.familyId === 'F5-jsonl-substrate-consumption');
  assert.ok(violation);
  assert.match(violation.message, /required evidence count 0 < 3/);
  assert.match(violation.message, /owning_packet=A\.13e-jsonl-strict-lf-substrate/);
});

test('validateCrossCuttingDuplicateClosure allows canonical A.13d runtime issue owners', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/protocol/src/sessions/control/contract.ts',
    'export const sessionShape = { lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional() };\n',
  );
  writeRepoFile(
    rootDir,
    'apps/cli/src/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue.ts',
    [
      "const record = { latestTurnStatus: 'failed', lastRuntimeIssue: issue };",
      "const legacyWireType = 'turn_aborted';",
      '',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    'apps/ui/sources/sync/domains/session/attention/deriveSessionAttentionState.ts',
    'export const failed = input.lastRuntimeIssue != null ? "failed" : "idle";\n',
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-runtime-failure-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('validateCrossCuttingDuplicateClosure allows provider identity branches outside context-compaction logic', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/codex/src/agent/identity/runtimeDescriptor.ts',
    "export const descriptor = rawDescriptor?.providerId === 'codex' ? rawDescriptor : null;\n",
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-context-compaction-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('validateCrossCuttingDuplicateClosure still rejects local runtime failure and context-compaction duplicates', async () => {
  const { validateCrossCuttingDuplicateClosure } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/ui/sources/components/pets/activity/providerFailure.ts',
    "export const failedSessionBadge = message.includes('turn_aborted provider runtime error');\n",
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/codex/src/agent/runtime/contextCompactionSchema.ts',
    "export const event = { type: 'context-compaction', compactionSummary: providerSummary };\n",
  );

  const result = validateCrossCuttingDuplicateClosure({
    rootDir,
    enabledForbiddenFamilies: ['F5-runtime-failure-duplicate', 'F5-context-compaction-duplicate'],
    enabledRequiredFamilies: [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.familyId === 'F5-runtime-failure-duplicate'));
  assert.ok(result.violations.some((violation) => violation.familyId === 'F5-context-compaction-duplicate'));
});
