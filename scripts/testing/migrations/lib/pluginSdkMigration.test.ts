import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  adaptPluginSdkMigrationMap,
  applyPluginSdkMigrationPlan,
  planPluginSdkMigration,
  runPluginSdkMigration,
  type PluginSdkMigrationMapRow,
} from './pluginSdkMigration.ts';
import {
  formatPluginSdkMigrationReport,
  parsePluginSdkMigrationCliArgs,
} from '../runPluginSdkMigration.ts';

const mapRows: readonly PluginSdkMigrationMapRow[] = [
  {
    action: 'move',
    canonicalSourceOwner: 'runtime',
    sourceSpecifier: './experimental/runtime',
    sourceSymbol: 'LegacyType',
    targetSpecifier: '/runtime',
    targetSymbol: 'LegacyType',
    removalCondition: 'remove old barrel',
  },
  {
    action: 'rename',
    canonicalSourceOwner: 'runtime',
    sourceSpecifier: './experimental/runtime',
    sourceSymbol: 'LegacyValue',
    targetSpecifier: '/runtime',
    targetSymbol: 'RuntimeValue',
    removalCondition: 'remove old barrel',
  },
  {
    action: 'retain',
    canonicalSourceOwner: 'sdk',
    sourceSpecifier: '.',
    sourceSymbol: 'definePlugin',
    targetSpecifier: '.',
    targetSymbol: 'definePlugin',
    removalCondition: 'not applicable',
  },
  {
    action: 'internalize',
    canonicalSourceOwner: 'sessions',
    sourceSpecifier: './experimental/runtime',
    sourceSymbol: 'PrivateCarrier',
    targetSpecifier: 'INTERNAL',
    targetSymbol: '-',
    removalCondition: 'private carrier',
  },
  {
    action: 'delete',
    canonicalSourceOwner: 'runtime',
    sourceSpecifier: './experimental/runtime',
    sourceSymbol: 'DeletedCarrier',
    targetSpecifier: 'DELETE',
    targetSymbol: '-',
    removalCondition: 'no positive consumer',
  },
  {
    action: 'retain',
    canonicalSourceOwner: 'host',
    sourceSpecifier: './internal/fs/json-owner-file-lock',
    sourceSymbol: 'withJsonOwnerFileLock',
    targetSpecifier: 'HOST-INTERNAL',
    targetSymbol: 'withJsonOwnerFileLock',
    removalCondition: 'host-only specifier remains exact',
  },
  {
    action: 'manual_semantic_migration',
    canonicalSourceOwner: 'host',
    sourceSpecifier: './runtime',
    sourceSymbol: 'SessionHandle',
    targetSpecifier: 'PENDING',
    targetSymbol: '-',
    removalCondition: 'privacy owner must settle the target',
  },
  {
    action: 'manual_semantic_migration',
    canonicalSourceOwner: 'ui',
    sourceSpecifier: 'UNBARRELLED_SOURCE',
    sourceSymbol: 'defineUiArtifactsManifest',
    targetSpecifier: '/ui/build',
    targetSymbol: 'defineUiArtifactsManifest',
    removalCondition: 'publish through the canonical owner',
  },
  {
    action: 'manual_semantic_migration',
    canonicalSourceOwner: 'claude',
    sourceSpecifier: '-',
    sourceSymbol: 'ClaudeOwnedValue',
    targetSpecifier: 'PLUGIN-OWNED',
    targetSymbol: '-',
    removalCondition: 'remain plugin-owned',
  },
  {
    action: 'manual_semantic_migration',
    canonicalSourceOwner: 'external-sessions',
    sourceSpecifier: '-',
    sourceSymbol: 'ExternalSessionsDecision',
    targetSpecifier: '/sessions/external',
    targetSymbol: 'ExternalSessionsDecision',
    removalCondition: 'no package declaration exists to rewrite',
  },
  {
    action: 'add',
    canonicalSourceOwner: 'events',
    sourceSpecifier: '-',
    sourceSymbol: 'NewEvent',
    targetSpecifier: '/events',
    targetSymbol: 'NewEvent',
    removalCondition: 'publish after producer proof',
  },
];

function writeFixture(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

test('adaptPluginSdkMigrationMap classifies complete map rows and queues only genuine refusals', () => {
  const adapted = adaptPluginSdkMigrationMap(mapRows);

  assert.deepEqual(
    adapted.rewriteRows.map((row) => ({
      sourceSpecifier: row.sourceSpecifier,
      sourceSymbol: row.sourceSymbol,
      targetSpecifier: row.targetSpecifier,
      targetSymbol: row.targetSymbol,
      action: row.action,
    })),
    [
      {
        sourceSpecifier: '@happier-dev/plugin-sdk',
        sourceSymbol: 'definePlugin',
        targetSpecifier: '@happier-dev/plugin-sdk',
        targetSymbol: 'definePlugin',
        action: 'retain',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/events',
        sourceSymbol: 'NewEvent',
        targetSpecifier: '@happier-dev/plugin-sdk/events',
        targetSymbol: 'NewEvent',
        action: 'retain',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
        sourceSymbol: 'DeletedCarrier',
        targetSpecifier: null,
        targetSymbol: null,
        action: 'delete',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
        sourceSymbol: 'LegacyType',
        targetSpecifier: '@happier-dev/plugin-sdk/runtime',
        targetSymbol: 'LegacyType',
        action: 'move',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
        sourceSymbol: 'LegacyValue',
        targetSpecifier: '@happier-dev/plugin-sdk/runtime',
        targetSymbol: 'RuntimeValue',
        action: 'rename',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
        sourceSymbol: 'PrivateCarrier',
        targetSpecifier: null,
        targetSymbol: null,
        action: 'internalize',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/internal/fs/json-owner-file-lock',
        sourceSymbol: 'withJsonOwnerFileLock',
        targetSpecifier: null,
        targetSymbol: null,
        action: 'manual_semantic_migration',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/runtime',
        sourceSymbol: 'LegacyType',
        targetSpecifier: '@happier-dev/plugin-sdk/runtime',
        targetSymbol: 'LegacyType',
        action: 'retain',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/runtime',
        sourceSymbol: 'RuntimeValue',
        targetSpecifier: '@happier-dev/plugin-sdk/runtime',
        targetSymbol: 'RuntimeValue',
        action: 'retain',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/runtime',
        sourceSymbol: 'SessionHandle',
        targetSpecifier: null,
        targetSymbol: null,
        action: 'manual_semantic_migration',
      },
    ],
  );
  assert.deepEqual(
    adapted.mapRefusals.map(({ symbol, reason }) => ({ symbol, reason })),
    [
      { symbol: 'withJsonOwnerFileLock', reason: 'non-package-target' },
      { symbol: 'SessionHandle', reason: 'pending-target' },
    ],
  );
  assert.deepEqual(
    adapted.nonInputs.map(({ sourceSymbol }) => sourceSymbol),
    ['ClaudeOwnedValue', 'ExternalSessionsDecision', 'defineUiArtifactsManifest'],
  );
  assert.equal(adapted.additions.length, 1);
});

test('adaptPluginSdkMigrationMap rejects a safe target identity that is also mapped elsewhere', () => {
  const conflictingRows: readonly PluginSdkMigrationMapRow[] = [
    {
      ...mapRows[0]!,
      targetSymbol: 'IntermediateType',
    },
    {
      ...mapRows[0]!,
      sourceSpecifier: './runtime',
      sourceSymbol: 'IntermediateType',
      targetSpecifier: '/agents/runtime',
      targetSymbol: 'FinalType',
    },
  ];

  assert.throws(
    () => adaptPluginSdkMigrationMap(conflictingRows),
    /Conflicting Plugin SDK migration target: @happier-dev\/plugin-sdk\/runtime#IntermediateType/,
  );

  assert.throws(
    () => adaptPluginSdkMigrationMap([
      {
        ...mapRows[10]!,
        targetSpecifier: '/runtime',
        targetSymbol: 'IntermediateType',
      },
      conflictingRows[1]!,
    ]),
    /Conflicting Plugin SDK migration target: @happier-dev\/plugin-sdk\/runtime#IntermediateType/,
  );
});

test('adaptPluginSdkMigrationMap deduplicates converging exact target identities', () => {
  const convergingRows: readonly PluginSdkMigrationMapRow[] = [
    {
      ...mapRows[0]!,
      targetSymbol: 'SharedType',
    },
    {
      ...mapRows[0]!,
      canonicalSourceOwner: 'host',
      sourceSymbol: 'OtherLegacyType',
      targetSymbol: 'SharedType',
    },
  ];

  const adapted = adaptPluginSdkMigrationMap(convergingRows);

  assert.deepEqual(
    adapted.rewriteRows
      .filter((row) => (
        row.sourceSpecifier === '@happier-dev/plugin-sdk/runtime'
        && row.sourceSymbol === 'SharedType'
      ))
      .map(({ sourceSpecifier, sourceSymbol, targetSpecifier, targetSymbol, action }) => ({
        sourceSpecifier,
        sourceSymbol,
        targetSpecifier,
        targetSymbol,
        action,
      })),
    [{
      sourceSpecifier: '@happier-dev/plugin-sdk/runtime',
      sourceSymbol: 'SharedType',
      targetSpecifier: '@happier-dev/plugin-sdk/runtime',
      targetSymbol: 'SharedType',
      action: 'retain',
    }],
  );
});

test('planPluginSdkMigration recognizes exact final add targets without masking unknown symbols', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-add-target-'));
  const filePath = 'packages/plugins/example/src/index.ts';
  const addRows: readonly PluginSdkMigrationMapRow[] = [
    {
      action: 'add',
      canonicalSourceOwner: 'external-sessions',
      sourceSpecifier: '-',
      sourceSymbol: 'ExternalSessionOperationReference',
      targetSpecifier: '/sessions/external',
      targetSymbol: 'ExternalSessionOperationReference',
      removalCondition: 'final target is published',
    },
    {
      action: 'add',
      canonicalSourceOwner: 'external-sessions',
      sourceSpecifier: '-',
      sourceSymbol: 'ExternalSessionTranscriptItem',
      targetSpecifier: '/sessions/external',
      targetSymbol: 'ExternalSessionTranscriptItem',
      removalCondition: 'final target is published',
    },
  ];
  writeFixture(rootDir, filePath, [
    "import type { ExternalSessionOperationReference } from '@happier-dev/plugin-sdk/sessions/external';",
    "import { ExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';",
  ].join('\n'));

  const exactResult = planPluginSdkMigration({ rootDir, mapRows: addRows });

  assert.equal(exactResult.plan.edits.length, 0);
  assert.deepEqual(exactResult.plan.refusals, []);
  assert.deepEqual(
    exactResult.plan.matches.map(({ sourceSymbol, status }) => ({ sourceSymbol, status })),
    [
      { sourceSymbol: 'ExternalSessionOperationReference', status: 'retained' },
      { sourceSymbol: 'ExternalSessionTranscriptItem', status: 'retained' },
    ],
  );

  writeFixture(
    rootDir,
    filePath,
    "import { UnknownExternalSessionValue } from '@happier-dev/plugin-sdk/sessions/external';",
  );
  const unknownResult = planPluginSdkMigration({ rootDir, mapRows: addRows });
  assert.deepEqual(
    unknownResult.plan.refusals.map(({ symbol, reason }) => ({ symbol, reason })),
    [{ symbol: 'UnknownExternalSessionValue', reason: 'unknown-symbol' }],
  );
});

test('adaptPluginSdkMigrationMap refuses non-canonical path spellings instead of normalizing them', () => {
  const malformedRows: readonly PluginSdkMigrationMapRow[] = [
    {
      ...mapRows[0]!,
      sourceSpecifier: './experimental/../runtime',
    },
    {
      ...mapRows[0]!,
      sourceSymbol: 'ArbitrarySource',
      sourceSpecifier: 'ARBITRARY_SOURCE',
    },
    {
      ...mapRows[0]!,
      sourceSymbol: 'OtherLegacyType',
      targetSpecifier: '/runtime/../host',
    },
    {
      ...mapRows[10]!,
      targetSpecifier: 'PENDING',
    },
  ];

  const adapted = adaptPluginSdkMigrationMap(malformedRows);

  assert.deepEqual(
    adapted.mapRefusals.map(({ symbol, reason }) => ({ symbol, reason })),
    [
      { symbol: 'NewEvent', reason: 'pending-target' },
      { symbol: 'LegacyType', reason: 'non-package-source' },
      { symbol: 'OtherLegacyType', reason: 'non-package-target' },
      { symbol: 'ArbitrarySource', reason: 'non-package-source' },
    ],
  );
  assert.equal(adapted.rewriteRows.length, 1);
  assert.equal(adapted.rewriteRows[0]?.action, 'manual_semantic_migration');
  assert.equal(adapted.additions.length, 0);
});

test('adaptPluginSdkMigrationMap preserves a package-sourced plugin-owned row for declaration refusal attribution', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-plugin-owned-'));
  writeFixture(
    rootDir,
    'packages/plugins/elevenlabs/src/index.ts',
    "import { PluginOwnedValue } from '@happier-dev/plugin-sdk/voice/client';",
  );
  const pluginOwnedRows: readonly PluginSdkMigrationMapRow[] = [{
    action: 'manual_semantic_migration',
    canonicalSourceOwner: 'elevenlabs',
    sourceSpecifier: './voice/client',
    sourceSymbol: 'PluginOwnedValue',
    targetSpecifier: 'PLUGIN-OWNED',
    targetSymbol: '-',
    removalCondition: 'move the plugin-private policy to its owning plugin',
  }];

  const result = planPluginSdkMigration({ rootDir, mapRows: pluginOwnedRows });

  assert.deepEqual(
    result.adaptedMap.mapRefusals.map(({ symbol, reason, owner }) => ({ symbol, reason, owner })),
    [],
  );
  assert.deepEqual(
    result.plan.refusals.map(({ symbol, reason, owner }) => ({ symbol, reason, owner })),
    [{ symbol: 'PluginOwnedValue', reason: 'manual_semantic_migration', owner: 'elevenlabs' }],
  );
});

test('planPluginSdkMigration treats an exact-final manual row as current while retaining genuine manual refusals', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-manual-current-'));
  writeFixture(rootDir, 'packages/plugins/example/src/current.ts', [
    "import { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';",
    "import { LegacyExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';",
  ].join('\n'));
  writeFixture(
    rootDir,
    'packages/plugins/example/src/losing.ts',
    "import { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/experimental/sessions';",
  );
  const manualRows: readonly PluginSdkMigrationMapRow[] = [
    {
      action: 'manual_semantic_migration',
      canonicalSourceOwner: 'external-sessions',
      sourceSpecifier: './sessions/external',
      sourceSymbol: 'AgentExternalSessionSource',
      targetSpecifier: '/sessions/external',
      targetSymbol: 'AgentExternalSessionSource',
      removalCondition: 'the approved final declaration is already current',
    },
    {
      action: 'manual_semantic_migration',
      canonicalSourceOwner: 'external-sessions',
      sourceSpecifier: './experimental/sessions',
      sourceSymbol: 'AgentExternalSessionSource',
      targetSpecifier: '/sessions/external',
      targetSymbol: 'AgentExternalSessionSource',
      removalCondition: 'the losing declaration still needs semantic migration',
    },
    {
      action: 'manual_semantic_migration',
      canonicalSourceOwner: 'external-sessions',
      sourceSpecifier: './sessions/external',
      sourceSymbol: 'LegacyExternalSessionSource',
      targetSpecifier: '/sessions/external',
      targetSymbol: 'AgentExternalSessionSource',
      removalCondition: 'the symbol transformation still needs semantic migration',
    },
  ];

  const result = planPluginSdkMigration({ rootDir, mapRows: manualRows });

  assert.equal(result.plan.edits.length, 0);
  assert.deepEqual(
    result.plan.matches.map(({ sourceSpecifier, sourceSymbol, status }) => ({
      sourceSpecifier,
      sourceSymbol,
      status,
    })),
    [
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/sessions/external',
        sourceSymbol: 'AgentExternalSessionSource',
        status: 'retained',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/sessions/external',
        sourceSymbol: 'LegacyExternalSessionSource',
        status: 'refused',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/sessions',
        sourceSymbol: 'AgentExternalSessionSource',
        status: 'refused',
      },
    ],
  );
  assert.deepEqual(
    result.plan.refusals.map(({ sourceSpecifier, symbol, reason }) => ({
      sourceSpecifier,
      symbol,
      reason,
    })),
    [
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/sessions/external',
        symbol: 'LegacyExternalSessionSource',
        reason: 'manual_semantic_migration',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/sessions',
        symbol: 'AgentExternalSessionSource',
        reason: 'manual_semantic_migration',
      },
    ],
  );
});

test('planPluginSdkMigration inventories the approved source scope and preserves engine refusal semantics', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-plan-'));
  writeFixture(rootDir, 'packages/plugins/example/src/safe.ts', [
    '// declaration comment',
    "import type { LegacyType as PublicType } from '@happier-dev/plugin-sdk/experimental/runtime';",
    "import { /* keep */ LegacyValue as LocalValue } from '@happier-dev/plugin-sdk/experimental/runtime';",
  ].join('\n'));
  writeFixture(rootDir, 'apps/cli/src/refused.ts', [
    "import { PrivateCarrier, DeletedCarrier, UnknownCarrier } from '@happier-dev/plugin-sdk/experimental/runtime';",
    "import Runtime from '@happier-dev/plugin-sdk/experimental/runtime';",
    "import * as RuntimeNamespace from '@happier-dev/plugin-sdk/experimental/runtime';",
    "import { SessionHandle } from '@happier-dev/plugin-sdk/runtime';",
  ].join('\n'));
  writeFixture(rootDir, 'outside/not-scanned.ts', "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';");
  writeFixture(rootDir, 'packages/protocol/.backup.concurrent/src/not-scanned.ts', "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';");
  writeFixture(rootDir, 'scripts/testing/unrelated.ts', 'export const unrelated = true;');

  const result = planPluginSdkMigration({ rootDir, mapRows });

  assert.equal(result.filesScanned, 3);
  assert.equal(result.candidateFilesScanned, 2);
  assert.equal(result.plan.edits.length, 1);
  assert.match(result.plan.edits[0]!.after, /import type \{ LegacyType as PublicType \} from '@happier-dev\/plugin-sdk\/runtime';/);
  assert.match(result.plan.edits[0]!.after, /import \{ \/\* keep \*\/ RuntimeValue as LocalValue \} from '@happier-dev\/plugin-sdk\/runtime';/);
  assert.deepEqual(
    result.plan.refusals.map(({ filePath, symbol, reason }) => ({ filePath, symbol, reason })),
    [
      { filePath: 'apps/cli/src/refused.ts', symbol: 'PrivateCarrier', reason: 'internalize' },
      { filePath: 'apps/cli/src/refused.ts', symbol: 'DeletedCarrier', reason: 'delete' },
      { filePath: 'apps/cli/src/refused.ts', symbol: 'UnknownCarrier', reason: 'unknown-symbol' },
      { filePath: 'apps/cli/src/refused.ts', symbol: 'default', reason: 'default-import' },
      { filePath: 'apps/cli/src/refused.ts', symbol: '*', reason: 'namespace-import' },
      { filePath: 'apps/cli/src/refused.ts', symbol: 'SessionHandle', reason: 'manual_semantic_migration' },
    ],
  );
});

test('runPluginSdkMigration is dry-run by default and write mode enforces an empty second dry run', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-run-'));
  const filePath = 'packages/plugins/example/src/index.ts';
  const before = "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';";
  writeFixture(rootDir, filePath, before);

  const dryRun = runPluginSdkMigration({ rootDir, mapRows: mapRows.slice(0, 3) });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(readFileSync(join(rootDir, filePath), 'utf8'), before);
  assert.equal(dryRun.plan.edits.length, 1);
  assert.equal(dryRun.secondDryRun, null);

  const writeRun = runPluginSdkMigration({ rootDir, mapRows: mapRows.slice(0, 3), write: true });
  assert.equal(writeRun.mode, 'write');
  assert.equal(writeRun.applyResult?.appliedEdits.length, 1);
  assert.equal(writeRun.applyResult?.skippedEdits.length, 0);
  assert.equal(writeRun.secondDryRun?.edits.length, 0);
  assert.equal(writeRun.idempotent, true);
  assert.equal(
    readFileSync(join(rootDir, filePath), 'utf8'),
    "import { LegacyType } from '@happier-dev/plugin-sdk/runtime';",
  );
});

test('write mode refuses the whole batch before applying when the dry run is not clean', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-refused-write-'));
  const filePath = 'packages/plugins/example/src/index.ts';
  const before = "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';";
  writeFixture(rootDir, filePath, before);

  const result = runPluginSdkMigration({ rootDir, mapRows, write: true });

  assert.equal(result.mode, 'write');
  assert.equal(result.ok, false);
  assert.deepEqual(result.applyResult, { appliedEdits: [], skippedEdits: [] });
  assert.equal(result.secondDryRun, null);
  assert.equal(result.idempotent, false);
  assert.equal(readFileSync(join(rootDir, filePath), 'utf8'), before);
});

test('write mode recognizes a rewritten safe target identity on its refusal-free second pass', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-second-pass-refusal-'));
  const filePath = 'packages/plugins/example/src/index.ts';
  writeFixture(
    rootDir,
    filePath,
    "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';",
  );
  const secondPassRows: readonly PluginSdkMigrationMapRow[] = [
    mapRows[0]!,
    {
      ...mapRows[2]!,
      sourceSpecifier: './runtime',
      sourceSymbol: 'DifferentType',
      targetSpecifier: '/runtime',
      targetSymbol: 'DifferentType',
    },
  ];

  const result = runPluginSdkMigration({ rootDir, mapRows: secondPassRows, write: true });

  assert.equal(result.secondDryRun?.edits.length, 0);
  assert.deepEqual(result.secondDryRun?.refusals, []);
  assert.deepEqual(
    result.secondDryRun?.matches.map(({ sourceSpecifier, sourceSymbol, status }) => ({
      sourceSpecifier,
      sourceSymbol,
      status,
    })),
    [{
      sourceSpecifier: '@happier-dev/plugin-sdk/runtime',
      sourceSymbol: 'LegacyType',
      status: 'retained',
    }],
  );
  assert.equal(result.idempotent, true);
  assert.equal(result.ok, true);
});

test('a safe target identity does not mask an unknown symbol on the same target specifier', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-target-unknown-'));
  writeFixture(
    rootDir,
    'packages/plugins/example/src/index.ts',
    "import { LegacyType, UnknownCarrier } from '@happier-dev/plugin-sdk/runtime';",
  );
  const targetRows: readonly PluginSdkMigrationMapRow[] = [
    mapRows[0]!,
    {
      ...mapRows[2]!,
      sourceSpecifier: './runtime',
      sourceSymbol: 'DifferentType',
      targetSpecifier: '/runtime',
      targetSymbol: 'DifferentType',
    },
  ];

  const result = planPluginSdkMigration({ rootDir, mapRows: targetRows });

  assert.equal(result.plan.edits.length, 0);
  assert.deepEqual(
    result.plan.matches.map(({ sourceSymbol, status }) => ({ sourceSymbol, status })),
    [{ sourceSymbol: 'LegacyType', status: 'retained' }],
  );
  assert.deepEqual(
    result.plan.refusals.map(({ symbol, reason }) => ({ symbol, reason })),
    [{ symbol: 'UnknownCarrier', reason: 'unknown-symbol' }],
  );
});

test('applyPluginSdkMigrationPlan preserves current content when bytes changed after planning', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-guard-'));
  const filePath = 'packages/plugins/example/src/index.ts';
  writeFixture(rootDir, filePath, "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';");
  const planned = planPluginSdkMigration({ rootDir, mapRows: mapRows.slice(0, 3) });

  const concurrentBytes = '// concurrent edit\n';
  writeFixture(rootDir, filePath, concurrentBytes);
  const applied = applyPluginSdkMigrationPlan(rootDir, planned.plan);

  assert.equal(applied.appliedEdits.length, 0);
  assert.deepEqual(applied.skippedEdits, [{ filePath, reason: 'content-mismatch' }]);
  assert.equal(readFileSync(join(rootDir, filePath), 'utf8'), concurrentBytes);
});

test('CLI defaults to dry-run options and formats deterministic machine-readable output', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'plugin-sdk-migration-report-'));
  writeFixture(
    rootDir,
    'packages/plugins/example/src/index.ts',
    "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';",
  );
  assert.deepEqual(parsePluginSdkMigrationCliArgs([], rootDir), {
    rootDir,
    write: false,
  });

  const result = runPluginSdkMigration({ rootDir, mapRows: mapRows.slice(0, 3) });
  const first = JSON.stringify(formatPluginSdkMigrationReport(result));
  const second = JSON.stringify(formatPluginSdkMigrationReport(
    runPluginSdkMigration({ rootDir, mapRows: mapRows.slice(0, 3) }),
  ));
  assert.equal(first, second);
  const parsed: unknown = JSON.parse(first);
  assert.equal(typeof parsed, 'object');
  assert.match(first, /"mode":"dry-run"/);
  assert.match(first, /"editPlan":\[\{"filePath":"packages\/plugins\/example\/src\/index\.ts"\}\]/);
  assert.match(first, /"declarationEdits":\[/);

  const reportWithNonInputs = formatPluginSdkMigrationReport(
    runPluginSdkMigration({ rootDir, mapRows }),
  );
  assert.equal(reportWithNonInputs.summary.nonInputs, 3);
});
