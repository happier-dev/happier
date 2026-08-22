import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type ReleaseContractModule = typeof import('./validateReleaseContract.ts');
type FullyUnifiedModule = typeof import('./checkFullyUnified.ts');

const ROOT_DIR = join(import.meta.dirname, '../../../..');

async function loadReleaseContract(): Promise<ReleaseContractModule> {
  return import('./validateReleaseContract.ts');
}

async function loadFullyUnified(): Promise<FullyUnifiedModule> {
  return import('./checkFullyUnified.ts');
}

function readRootScripts(): Record<string, string | undefined> {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return packageJson.scripts ?? {};
}

function createFixtureRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-runtime-release-contract-'));
}

function writeFixtureFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

test('release contract entrypoint delegates to the composed runtime-unification validators', async () => {
  const { validateReleaseContract } = await loadReleaseContract();
  const rootDir = createFixtureRepo();

  const result = await validateReleaseContract({ rootDir });

  assert.equal(typeof result.ok, 'boolean');
  assert.ok(result.validatorResult.totalValidators > 0);
});

test('fully unified entrypoint reports final closure blockers separately from release validator failures', async () => {
  const { checkFullyUnified } = await loadFullyUnified();
  const rootDir = createFixtureRepo();

  const result = await checkFullyUnified({ rootDir });

  assert.equal(typeof result.fullyUnified, 'boolean');
  assert.ok(Array.isArray(result.finalClosureBlockers));
  assert.ok(result.foundationGate.totalValidators > 0);
  assert.equal(typeof result.releaseContract.ok, 'boolean');
  assert.equal(typeof result.strippedPathSmoke.ok, 'boolean');
  assert.equal(typeof result.finalClosure.ok, 'boolean');
});

test('fully unified entrypoint includes the V2-zero ratchet as a first-class dependency', async () => {
  const { checkFullyUnified } = await loadFullyUnified();
  const rootDir = createFixtureRepo();

  const result = await checkFullyUnified({ rootDir });

  assert.equal(typeof result.v2ZeroInventory.ok, 'boolean');
  assert.ok(Array.isArray(result.v2ZeroInventory.errors));
  assert.equal(result.fullyUnified, false);
});

test('root scripts expose F.6 release proof entrypoints', () => {
  const scripts = readRootScripts();

  assert.equal(scripts['test:smoke:stripped-path'], 'node --experimental-strip-types --test scripts/testing/smoke/strippedPathBinarySmoke.test.ts');
  assert.match(scripts['test:migration:governance'] ?? '', /validateReleaseContract\.ts/);
  assert.match(scripts['test:policy:self'] ?? '', /scripts\/testing\/migrations\/runtimeUnification\/\*\.test\.ts/);
});

test('release contract rejects root plugin entrypoints that re-export runtime contributions', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/index.ts',
    [
      "export * from './manifest.js';",
      "export * from './activate.js';",
      "export * from './agent/contributions/runtime.js';",
      '',
    ].join('\n'),
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /root-entrypoint-runtime-contribution/);
});

test('release contract rejects generated bundled plugin projection bindings residue', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
    'export const generated = [{ id: "acme", bindings: { stale: true } }];\n',
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale-bundled-plugin-bindings/);
});

test('release contract rejects host-provider catalog ownership residue', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'apps/cli/src/backends/gemini/index.ts',
    'export const geminiAgent = {};\n',
  );
  writeFixtureFile(
    rootDir,
    'apps/cli/src/agent/catalog/builtInHostCatalogEntryDefinitions.ts',
    'export const BUILT_IN_HOST_CATALOG_ENTRY_DEFINITIONS = Object.freeze([geminiAgent]);\n',
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, false);
  const message = result.errors.join('\n');
  assert.match(message, /host-provider-catalog-ownership/);
  assert.match(message, /apps\/cli\/src\/backends/);
});

test('release contract rejects forbidden legacy backend imports in runtime code', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  const legacyBackendAliasName = ['Agent', 'Backend'].join('');
  writeFixtureFile(
    rootDir,
    'apps/cli/src/plugins/runtime/acp/runtime.ts',
    `import type { ${legacyBackendAliasName} } from "@/backends/types";\nexport type Runtime = ${legacyBackendAliasName};\n`,
  );
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/agent/runtime.ts',
    'import { createBackend } from "../../../../../apps/cli/src/backends/acme/runtime";\nexport const runtime = createBackend;\n',
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, false);
  const message = result.errors.join('\n');
  assert.match(message, /forbidden-legacy-backend-dependency/);
  assert.match(message, /apps\/cli\/src\/plugins\/runtime\/acp\/runtime\.ts/);
  assert.match(message, /packages\/plugins\/acme\/src\/agent\/runtime\.ts/);
});

test('release contract rejects Voice V3-F V2 media residue found outside historical fixed paths', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'packages/protocol/src/machines/peer/mediation/renamedVoiceSurface.ts',
    'export const VoiceMediaAgentRealtimeFrameV1Schema = z.union([]);\n',
  );
  writeFixtureFile(
    rootDir,
    'apps/cli/src/daemon/voiceMedia/renamedPositiveCoverage.test.ts',
    "expect(dispatchVoiceMediaAgentRealtimeBinaryFrame({})).resolves.toBeDefined();\n",
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /voice-v3-f-v2-media-residue/);
  assert.ok(result.scannedFiles.includes(
    'packages/protocol/src/machines/peer/mediation/renamedVoiceSurface.ts',
  ));
  assert.ok(result.scannedFiles.includes(
    'apps/cli/src/daemon/voiceMedia/renamedPositiveCoverage.test.ts',
  ));
});

test('release contract accepts a clean retained speech-transcription Voice media fixture', async () => {
  const { validateReleaseContractSurface } = await loadReleaseContract();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'packages/protocol/src/machines/peer/mediation/renamedVoiceSurface.ts',
    "export const retainedApplicationKind = z.literal('speech_transcription');\n",
  );

  const result = validateReleaseContractSurface({ rootDir });

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.errors.join('\n'), /voice-v3-f-v2-media-residue/);
});

test('fully unified default mode does not require F.6 packet self-acceptance', async () => {
  const { checkFullyUnified } = await loadFullyUnified();
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv',
    [
      'packet_id\tfile_path\tline_count\tlast_modified\tstage\tstatus\tdepends_on\tconcept_refs\tnotes',
      'B.8\tstages/stage-B/B.8.md\t1\t-\tB\taccepted\t-\tbackend-extraction\t-',
      'C.5.1-opencode-host-compatibility-drain\tstages/stage-C/C.5.1.md\t1\t-\tC\taccepted\t-\tbackend-extraction\t-',
      'D.7\tstages/stage-D/D.7.md\t1\t-\tD\taccepted\t-\tbackend-extraction\t-',
      'E.8.1-gemini-acp-revival-finish-and-host-deletion\tstages/stage-E/E.8.1.md\t1\t-\tE\taccepted\t-\tbackend-extraction\t-',
      'ANTIGRAVITY-1-agent-plugin-foundation-and-terminal-runtime\tstages/stage-E/ANTIGRAVITY-1.md\t1\t-\tE\taccepted\t-\truntime-core\t-',
      'ANTIGRAVITY-2-localharness-runtime\tstages/stage-E/ANTIGRAVITY-2.md\t1\t-\tE\taccepted\t-\truntime-core\t-',
      'F.1\tstages/stage-F/F.1.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.3\tstages/stage-F/F.3.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.5\tstages/stage-F/F.5.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'F.6\tstages/stage-F/F.6.md\t1\t-\tF\taccepted-focused\t-\tvalidators-governance\t-',
      'F.7\tstages/stage-F/F.7.md\t1\t-\tF\taccepted\t-\tvalidators-governance\t-',
      'A.13o.2-session-mutation-outbox-retry-dependency-semantics\tstages/stage-A/A.13o.2.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13o.2.1-outbox-dead-letter-prerequisite-retention\tstages/stage-A/A.13o.2.1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'SDK-GENERIC-HELPERS-1-plugin-adoption\tstages/stage-A/SDK-GENERIC-HELPERS-1.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
      'MESSAGE-META-REGISTRY-1-deletion\tstages/stage-A/MESSAGE-META-REGISTRY-1.md\t1\t-\tA\taccepted\t-\tplugin-platform\t-',
      'ENGINE-REGISTRY-SPLIT-1-registry-decomposition\tstages/stage-A/ENGINE-REGISTRY-SPLIT-1.md\t1\t-\tA\taccepted\t-\truntime-core\t-',
      'A.13q.5-public-sdk-surface-and-first-party-dogfood\tstages/stage-A/A.13q.5.md\t1\t-\tA\taccepted\t-\tplugin-sdk-v1\t-',
    ].join('\n'),
  );
  writeFixtureFile(
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

  const focusedResult = await checkFullyUnified({ rootDir });
  const finalResult = await checkFullyUnified({ rootDir, finalMode: true });

  assert.ok(!focusedResult.finalClosureBlockers.some((blocker) => blocker.id === 'F.6'));
  assert.ok(finalResult.finalClosureBlockers.some((blocker) => blocker.id === 'F.6'));
});
