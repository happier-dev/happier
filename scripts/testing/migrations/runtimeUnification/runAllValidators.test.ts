import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type RunnerModule = typeof import('./runAllValidators.ts');

async function loadRunner(): Promise<RunnerModule> {
  try {
    return await import('./runAllValidators.ts');
  } catch (error) {
    assert.fail(`runner module should load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-runtime-unification-runner-'));
}

function writeRepoFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function writeAllowlistedBridge(rootDir: string): void {
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/agent/permissions/bridge/localPermissionBridge.ts',
    [
      'function createLocalWaiter(requestId: string) {',
      '  // L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency',
      '  return setTimeout(() => {',
      '    void requestId;',
      '  }, 1000);',
      '}',
      '',
    ].join('\n'),
  );
}

function writeFinalCanonicalLayoutFixtures(rootDir: string): void {
  writeRepoFile(rootDir, 'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts', '');
  writeRepoFile(rootDir, 'apps/cli/src/capabilities/systemTasks/liveSystemTasksRunner.ts', '');
  writeRepoFile(rootDir, 'apps/cli/src/capabilities/registry/toolSystemTasks.ts', '');
  writeRepoFile(rootDir, 'packages/protocol/src/runtime/events/v1.ts', '');
}

function writeProviderSettingsSingleOwnerFixtures(rootDir: string): void {
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/manifest.ts',
    'import { CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION } from "./providerSettings/definition.js";\nexport const manifest = { contributes: { providerSettings: [CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION] } };\n',
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/providerSettings/definition.ts',
    'import { defineProviderSettingsContribution, buildProviderSettingsDefaults, providerSettingsContributionToUiDescriptor } from "@happier-dev/plugin-sdk/manifest/providerSettings";\nexport const CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION = defineProviderSettingsContribution({ id: "claude.providerSettings.v1", providerId: "claude", fields: [] });\nexport const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS = buildProviderSettingsDefaults(CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION);\nexport const CLAUDE_PROVIDER_SETTINGS_DESCRIPTOR = providerSettingsContributionToUiDescriptor(CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION);\n',
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/ui/settings/descriptor.ts',
    'export { CLAUDE_PROVIDER_SETTINGS_DESCRIPTOR } from "../../providerSettings/definition.js";\n',
  );
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/protocol/remoteSettings.ts',
    'import { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS } from "../providerSettings/definition.js";\nexport { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS } from "../providerSettings/definition.js";\n',
  );
  writeRepoFile(
    rootDir,
    'packages/agents/src/providerSettings/generated/bundledProviderSettings.ts',
    'export const BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS = [{ id: "claude.providerSettings.v1", providerId: "claude" }];\n',
  );
}

test('runAllValidators lists the composed runtime-unification validator catalog', async () => {
  const { listRuntimeUnificationValidators } = await loadRunner();

  assert.deepEqual(
    listRuntimeUnificationValidators().map((entry) => entry.id),
    [
      'A.X-agent-ids-codegen',
      'J.X-no-host-imposed-permission-ttl',
      'F.5-cross-cutting-duplicate-closure',
      'F.5-backend-extraction-closure',
      'PROVIDER-SETTINGS-SDK-1-single-owner',
      'RPC-ACTION-SPEC-closure',
      'F.7-final-canonical-layout-closure',
      'RU2-release-governance-closure',
    ],
  );
});

test('runAllValidators aggregates validator failures with stable ids', async () => {
  const { runAllValidators } = await loadRunner();
  const rootDir = createRepo();
  writeAllowlistedBridge(rootDir);
  writeFinalCanonicalLayoutFixtures(rootDir);
  writeProviderSettingsSingleOwnerFixtures(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/codex/src/agent/utils/permissionHandler.ts',
    'const pendingPermissionRequests = new Map<string, unknown>();\n',
  );

  const result = await runAllValidators({ rootDir });

  assert.equal(result.ok, false);
  assert.equal(result.failedValidators, 3);
  const messages = result.results.flatMap((entry) => entry.errors).join('\n');
  assert.match(messages, /F5-permission-lifecycle/);
  assert.match(messages, /F\.5-backend-extraction-closure/);
  assert.match(messages, /RU2-release-governance-closure/);
});

test('runAllValidators enables required duplicate-closure evidence families by default', async () => {
  const { runAllValidators } = await loadRunner();
  const rootDir = createRepo();
  writeAllowlistedBridge(rootDir);
  writeFinalCanonicalLayoutFixtures(rootDir);
  writeProviderSettingsSingleOwnerFixtures(rootDir);

  const result = await runAllValidators({ rootDir });

  assert.equal(result.ok, false);
  const messages = result.results.flatMap((entry) => entry.errors).join('\n');
  assert.match(messages, /F5-jsonl-substrate-consumption/);
  assert.match(messages, /F5-tier2-acp-consumption/);
  assert.match(messages, /F5-permission-substrate-consumption/);
  assert.match(messages, /F5-runtime-failure-substrate-consumption/);
  assert.match(messages, /F5-session-media-substrate-consumption/);
});

test('runFinalClosureValidators reports final closure dependency blockers separately from validator failures', async () => {
  const { runFinalClosureValidators } = await loadRunner();
  const rootDir = createRepo();
  writeAllowlistedBridge(rootDir);
  writeFinalCanonicalLayoutFixtures(rootDir);
  writeProviderSettingsSingleOwnerFixtures(rootDir);
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv',
    [
      'packet_id\tfile_path\tline_count\tlast_modified\tstage\tstatus\tdepends_on\tconcept_refs\tnotes',
      'B.8\tstages/stage-B/B.8.md\t1\t-\tB\tblocked\t-\tbackend-extraction\t-',
      'C.5.1-opencode-host-compatibility-drain\tstages/stage-C/C.5.1.md\t1\t-\tC\taccepted\t-\tbackend-extraction\t-',
      'D.7\tstages/stage-D/D.7.md\t1\t-\tD\taccepted-focused\t-\tbackend-extraction\t-',
      'E.8.1-gemini-acp-revival-finish-and-host-deletion\tstages/stage-E/E.8.1.md\t1\t-\tE\tpacket-body-ready\t-\tbackend-extraction\t-',
      'F.1\tstages/stage-F/F.1.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.3\tstages/stage-F/F.3.md\t1\t-\tF\tblocked\t-\tvalidators-governance\t-',
      'F.5\tstages/stage-F/F.5.md\t1\t-\tF\tpacket-body-draft\t-\tvalidators-governance\t-',
      'F.6\tstages/stage-F/F.6.md\t1\t-\tF\tblocked\t-\tvalidators-governance\t-',
      'F.7\tstages/stage-F/F.7.md\t1\t-\tF\tblocked\t-\tvalidators-governance\t-',
      'A.13o.2-session-mutation-outbox-retry-dependency-semantics\tstages/stage-A/A.13o.2.md\t1\t-\tA\taccepted-focused\t-\truntime-core\t-',
      'A.13o.2.1-outbox-dead-letter-prerequisite-retention\tstages/stage-A/A.13o.2.1.md\t1\t-\tA\tpacket-body-ready\t-\truntime-core\t-',
      'SDK-GENERIC-HELPERS-1-plugin-adoption\tstages/stage-A/SDK-GENERIC-HELPERS-1.md\t1\t-\tA\tpacket-body-ready\t-\tplugin-sdk-v1\t-',
      'MESSAGE-META-REGISTRY-1-deletion\tstages/stage-A/MESSAGE-META-REGISTRY-1.md\t1\t-\tA\tpacket-body-ready\t-\tplugin-platform\t-',
      'ENGINE-REGISTRY-SPLIT-1-registry-decomposition\tstages/stage-A/ENGINE-REGISTRY-SPLIT-1.md\t1\t-\tA\tpacket-body-ready\t-\truntime-core\t-',
      'A.13q.5-public-sdk-surface-and-first-party-dogfood\tstages/stage-A/A.13q.5.md\t1\t-\tA\tpacket-body-ready\t-\tplugin-sdk-v1\t-',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/SDK-FREEZE-GATE.md',
    [
      '# SDK freeze',
      '| id | condition | owning packet / FD | state | check |',
      '| --- | --- | --- | --- | --- |',
      '| GATE-47 | public spawned loopback WebSocket transport | A.13p.10 | open | manual |',
      '| GATE-48 | public installable source-kind | INSTALLABLES-PYPI-WHEEL-ASSET-1 | open | manual |',
    ].join('\n'),
  );

  const result = await runFinalClosureValidators({ rootDir });

  assert.equal(result.finalClosureOk, false);
  assert.equal(result.validatorResult.ok, false);
  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'B.8'));
  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'D.7'));
  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'SDK-FREEZE-GATE:GATE-47'));
  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'SDK-FREEZE-GATE:GATE-48'));
});

test('runFinalClosureValidators reports F.7 structure rows that still need adjudication', async () => {
  const { runFinalClosureValidators } = await loadRunner();
  const rootDir = createRepo();
  writeAllowlistedBridge(rootDir);
  writeFinalCanonicalLayoutFixtures(rootDir);
  writeProviderSettingsSingleOwnerFixtures(rootDir);
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv',
    [
      'packet_id\tfile_path\tline_count\tlast_modified\tstage\tstatus\tdepends_on\tconcept_refs\tnotes',
      'B.8\tstages/stage-B/B.8.md\t1\t-\tB\taccepted\t-\tbackend-extraction\t-',
      'C.5.1-opencode-host-compatibility-drain\tstages/stage-C/C.5.1.md\t1\t-\tC\taccepted\t-\tbackend-extraction\t-',
      'D.7\tstages/stage-D/D.7.md\t1\t-\tD\taccepted\t-\tbackend-extraction\t-',
      'E.8.1-gemini-acp-revival-finish-and-host-deletion\tstages/stage-E/E.8.1.md\t1\t-\tE\taccepted\t-\tbackend-extraction\t-',
      'F.1\tstages/stage-F/F.1.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.3\tstages/stage-F/F.3.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.5\tstages/stage-F/F.5.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.6\tstages/stage-F/F.6.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.7\tstages/stage-F/F.7.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'A.13o.2-session-mutation-outbox-retry-dependency-semantics\tstages/stage-A/A.13o.2.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13o.2.1-outbox-dead-letter-prerequisite-retention\tstages/stage-A/A.13o.2.1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'SDK-GENERIC-HELPERS-1-plugin-adoption\tstages/stage-A/SDK-GENERIC-HELPERS-1.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
      'MESSAGE-META-REGISTRY-1-deletion\tstages/stage-A/MESSAGE-META-REGISTRY-1.md\t1\t-\tA\taccepted\t-\tplugin-platform\t-',
      'ENGINE-REGISTRY-SPLIT-1-registry-decomposition\tstages/stage-A/ENGINE-REGISTRY-SPLIT-1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13q.5-public-sdk-surface-and-first-party-dogfood\tstages/stage-A/A.13q.5.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
      'ANTIGRAVITY-1-agent-plugin-foundation-and-terminal-runtime\tstages/stage-E/ANTIGRAVITY-1.md\t1\t-\tE\taccepted\t-\tbackend-extraction\t-',
      'ANTIGRAVITY-2-localharness-runtime\tstages/stage-E/ANTIGRAVITY-2.md\t1\t-\tE\taccepted\t-\tbackend-extraction\t-',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/SDK-FREEZE-GATE.md',
    [
      '# SDK freeze',
      '| id | condition | owning packet / FD | state | check |',
      '| --- | --- | --- | --- | --- |',
      '| GATE-47 | public spawned loopback WebSocket transport | A.13p.10 | closed | manual |',
      '| GATE-48 | public installable source-kind | INSTALLABLES-PYPI-WHEEL-ASSET-1 | closed | manual |',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/structure-disposition-ledger.tsv',
    [
      'row_id\tcurrent_path\tpath_kind\tpackage_area\tcurrent_role\ttarget_role\tviolated_rule\tissue_kind\ttarget_path\tdisposition\towning_concept\towning_packet\tproof_required\tconfidence\tsource_evidence_refs\tnotes',
      'STR-09999\t[STALE]apps/cli/src/agent/systemTasks\tfolder\tapps-cli\tstale-plan-citation\tcanonical-path\tnone\tUNKNOWN_NEEDS_ADJUDICATION\t[TARGET]apps/cli/src/capabilities/systemTasks\tkeep\truntime-core\tF.7\t-\thigh\t-\tneeds decision',
    ].join('\n'),
  );

  const result = await runFinalClosureValidators({ rootDir });

  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'STR-09999'));
});

test('runFinalClosureValidators treats Antigravity V1 packets as final closure blockers', async () => {
  const { runFinalClosureValidators } = await loadRunner();
  const rootDir = createRepo();
  writeAllowlistedBridge(rootDir);
  writeFinalCanonicalLayoutFixtures(rootDir);
  writeProviderSettingsSingleOwnerFixtures(rootDir);
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv',
    [
      'packet_id\tfile_path\tline_count\tlast_modified\tstage\tstatus\tdepends_on\tconcept_refs\tnotes',
      'B.8\tstages/stage-B/B.8.md\t1\t-\tB\taccepted\t-\tbackend-extraction\t-',
      'C.5.1-opencode-host-compatibility-drain\tstages/stage-C/C.5.1.md\t1\t-\tC\taccepted\t-\tbackend-extraction\t-',
      'D.7\tstages/stage-D/D.7.md\t1\t-\tD\taccepted\t-\tbackend-extraction\t-',
      'E.8.1-gemini-acp-revival-finish-and-host-deletion\tstages/stage-E/E.8.1.md\t1\t-\tE\taccepted\t-\tbackend-extraction\t-',
      'F.1\tstages/stage-F/F.1.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.3\tstages/stage-F/F.3.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.5\tstages/stage-F/F.5.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.6\tstages/stage-F/F.6.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.7\tstages/stage-F/F.7.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'A.13o.2-session-mutation-outbox-retry-dependency-semantics\tstages/stage-A/A.13o.2.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13o.2.1-outbox-dead-letter-prerequisite-retention\tstages/stage-A/A.13o.2.1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'SDK-GENERIC-HELPERS-1-plugin-adoption\tstages/stage-A/SDK-GENERIC-HELPERS-1.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
      'MESSAGE-META-REGISTRY-1-deletion\tstages/stage-A/MESSAGE-META-REGISTRY-1.md\t1\t-\tA\taccepted\t-\tplugin-platform\t-',
      'ENGINE-REGISTRY-SPLIT-1-registry-decomposition\tstages/stage-A/ENGINE-REGISTRY-SPLIT-1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13q.5-public-sdk-surface-and-first-party-dogfood\tstages/stage-A/A.13q.5.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
    ].join('\n'),
  );
  writeRepoFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/SDK-FREEZE-GATE.md',
    [
      '# SDK freeze',
      '| id | condition | owning packet / FD | state | check |',
      '| --- | --- | --- | --- | --- |',
      '| GATE-47 | public spawned loopback WebSocket transport | A.13p.10 | closed | manual |',
      '| GATE-48 | public installable source-kind | INSTALLABLES-PYPI-WHEEL-ASSET-1 | closed | manual |',
    ].join('\n'),
  );

  const result = await runFinalClosureValidators({ rootDir });

  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'ANTIGRAVITY-1-agent-plugin-foundation-and-terminal-runtime'));
  assert.ok(result.dependencyBlockers.some((blocker) => blocker.id === 'ANTIGRAVITY-2-localharness-runtime'));
});
