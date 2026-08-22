import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyRewritePlan,
  planDeclarationRewrites,
  planImportRewrites,
  planImportRewritesForFilePaths,
} from './rewriteImports.ts';
import { type DeclarationRewriteRow } from './migrationTypes.ts';

const declarationRows: readonly DeclarationRewriteRow[] = [
  {
    sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    sourceSymbol: 'LegacyType',
    targetSpecifier: '@happier-dev/plugin-sdk/runtime',
    targetSymbol: 'LegacyType',
    action: 'move',
    owner: 'runtime',
  },
  {
    sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    sourceSymbol: 'LegacyValue',
    targetSpecifier: '@happier-dev/plugin-sdk/runtime',
    targetSymbol: 'RuntimeValue',
    action: 'rename',
    owner: 'runtime',
  },
  {
    sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    sourceSymbol: 'LegacyAgentType',
    targetSpecifier: '@happier-dev/plugin-sdk/agents/runtime',
    targetSymbol: 'AgentType',
    action: 'rename',
    owner: 'agents',
  },
  {
    sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    sourceSymbol: 'LegacyRetained',
    targetSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    targetSymbol: 'LegacyRetained',
    action: 'retain',
    owner: 'runtime',
  },
];

test('planDeclarationRewrites splits named declarations by final owner without changing local import names', () => {
  const before = [
    '// declaration comment stays attached',
    "import { type LegacyType as PublicType, /* value comment */ LegacyValue, LegacyAgentType, LegacyRetained } from '@happier-dev/plugin-sdk/experimental/runtime';",
    "export type { LegacyType as PublicType, LegacyAgentType } from '@happier-dev/plugin-sdk/experimental/runtime';",
    "const actionId = 'sessions.external.takeover.start';",
    "const manifestKey = 'backgroundServices';",
    "const bootstrapValue = Reflect.get(globalThis, '__happierPluginSdkRuntime');",
  ].join('\n');

  const plan = planDeclarationRewrites(
    [{ filePath: 'packages/plugins/example/src/index.ts', content: before }],
    declarationRows,
  );

  assert.equal(plan.refusals.length, 0);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.declarationEdits.length, 2);
  const after = plan.edits[0]!.after;
  assert.match(after, /^\/\/ declaration comment stays attached/m);
  assert.match(after, /import \{ type LegacyType as PublicType, \/\* value comment \*\/ RuntimeValue as LegacyValue \} from '@happier-dev\/plugin-sdk\/runtime';/);
  assert.match(after, /import \{ AgentType as LegacyAgentType \} from '@happier-dev\/plugin-sdk\/agents\/runtime';/);
  assert.match(after, /import \{ LegacyRetained \} from '@happier-dev\/plugin-sdk\/experimental\/runtime';/);
  assert.match(after, /export type \{ LegacyType as PublicType \} from '@happier-dev\/plugin-sdk\/runtime';/);
  assert.match(after, /export type \{ AgentType \} from '@happier-dev\/plugin-sdk\/agents\/runtime';/);
  assert.match(after, /const actionId = 'sessions\.external\.takeover\.start';/);
  assert.match(after, /const manifestKey = 'backgroundServices';/);
  assert.match(after, /Reflect\.get\(globalThis, '__happierPluginSdkRuntime'\)/);

  const secondPass = planDeclarationRewrites(
    [{ filePath: plan.edits[0]!.filePath, content: after }],
    declarationRows,
  );
  assert.equal(secondPass.edits.length, 0);
  assert.equal(secondPass.refusals.length, 0);
});

test('planDeclarationRewrites keeps comments on their original side of a split declaration separator', () => {
  const before = "import { LegacyType /* type trailing, comma-safe */, /* agent leading */ LegacyAgentType } from '@happier-dev/plugin-sdk/experimental/runtime';";

  const plan = planDeclarationRewrites(
    [{ filePath: 'packages/plugins/example/src/comments.ts', content: before }],
    declarationRows,
  );

  assert.equal(plan.refusals.length, 0);
  assert.equal(plan.edits.length, 1);
  assert.equal(
    plan.edits[0]!.after,
    [
      "import { LegacyType /* type trailing, comma-safe */ } from '@happier-dev/plugin-sdk/runtime';",
      "import { /* agent leading */ AgentType as LegacyAgentType } from '@happier-dev/plugin-sdk/agents/runtime';",
    ].join('\n'),
  );
});

test('planDeclarationRewrites reports semantic, private, default, namespace, and unknown refusals without editing them', () => {
  const rows: readonly DeclarationRewriteRow[] = [
    ...declarationRows,
    {
      sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
      sourceSymbol: 'PrivateCarrier',
      targetSpecifier: null,
      targetSymbol: null,
      action: 'internalize',
      owner: 'external-sessions',
      reason: 'private source-bearing carrier',
    },
    {
      sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
      sourceSymbol: 'SemanticCarrier',
      targetSpecifier: null,
      targetSymbol: null,
      action: 'manual_semantic_migration',
      owner: 'voice',
      reason: 'caller must select the final contribution',
    },
    {
      sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
      sourceSymbol: 'DeletedCarrier',
      targetSpecifier: null,
      targetSymbol: null,
      action: 'delete',
      owner: 'managed-providers',
    },
  ];
  const files = [
    {
      filePath: 'packages/plugins/example/src/default.ts',
      content: "import Runtime, { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';",
    },
    {
      filePath: 'packages/plugins/example/src/namespace.ts',
      content: "import * as Runtime from '@happier-dev/plugin-sdk/experimental/runtime';",
    },
    {
      filePath: 'packages/plugins/example/src/semantic.ts',
      content: "import { LegacyType, PrivateCarrier, SemanticCarrier, DeletedCarrier, UnknownCarrier } from '@happier-dev/plugin-sdk/experimental/runtime';",
    },
  ];

  const plan = planDeclarationRewrites(files, rows);

  assert.equal(plan.edits.length, 0);
  assert.deepEqual(
    plan.refusals.map(({ filePath, symbol, reason, owner }) => ({ filePath, symbol, reason, owner })),
    [
      { filePath: files[0]!.filePath, symbol: 'default', reason: 'default-import', owner: null },
      { filePath: files[1]!.filePath, symbol: '*', reason: 'namespace-import', owner: null },
      { filePath: files[2]!.filePath, symbol: 'PrivateCarrier', reason: 'internalize', owner: 'external-sessions' },
      { filePath: files[2]!.filePath, symbol: 'SemanticCarrier', reason: 'manual_semantic_migration', owner: 'voice' },
      { filePath: files[2]!.filePath, symbol: 'DeletedCarrier', reason: 'delete', owner: 'managed-providers' },
      { filePath: files[2]!.filePath, symbol: 'UnknownCarrier', reason: 'unknown-symbol', owner: null },
    ],
  );
  assert.deepEqual(
    plan.matches.map(({ sourceSymbol, status }) => ({ sourceSymbol, status })),
    [
      { sourceSymbol: 'LegacyType', status: 'blocked-by-declaration-refusal' },
      { sourceSymbol: 'PrivateCarrier', status: 'refused' },
      { sourceSymbol: 'SemanticCarrier', status: 'refused' },
      { sourceSymbol: 'DeletedCarrier', status: 'refused' },
    ],
  );
  assert.deepEqual(plan.declarationEdits, []);
  assert.doesNotThrow(() => JSON.stringify(plan));
});

test('planDeclarationRewrites leaves an entire file unchanged when any declaration in it is refused', () => {
  const before = [
    "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';",
    "import { PrivateCarrier } from '@happier-dev/plugin-sdk/experimental/runtime';",
  ].join('\n');
  const plan = planDeclarationRewrites(
    [{ filePath: 'packages/plugins/example/src/mixed.ts', content: before }],
    [
      ...declarationRows,
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
        sourceSymbol: 'PrivateCarrier',
        targetSpecifier: null,
        targetSymbol: null,
        action: 'internalize',
        owner: 'external-sessions',
      },
    ],
  );

  assert.equal(plan.edits.length, 0);
  assert.equal(plan.declarationEdits.length, 0);
  assert.deepEqual(
    plan.matches.map(({ sourceSymbol, status }) => ({ sourceSymbol, status })),
    [
      { sourceSymbol: 'LegacyType', status: 'blocked-by-declaration-refusal' },
      { sourceSymbol: 'PrivateCarrier', status: 'refused' },
    ],
  );
});

test('planDeclarationRewrites refuses bare imports and namespace exports', () => {
  const plan = planDeclarationRewrites(
    [
      {
        filePath: 'packages/plugins/example/src/bare.ts',
        content: "import '@happier-dev/plugin-sdk/experimental/runtime';",
      },
      {
        filePath: 'packages/plugins/example/src/empty.ts',
        content: "import {} from '@happier-dev/plugin-sdk/experimental/runtime';",
      },
      {
        filePath: 'packages/plugins/example/src/namespace-export.ts',
        content: "export * from '@happier-dev/plugin-sdk/experimental/runtime';",
      },
    ],
    declarationRows,
  );

  assert.equal(plan.edits.length, 0);
  assert.deepEqual(
    plan.refusals.map(({ filePath, symbol, reason }) => ({ filePath, symbol, reason })),
    [
      {
        filePath: 'packages/plugins/example/src/bare.ts',
        symbol: '(side-effect)',
        reason: 'bare-import',
      },
      {
        filePath: 'packages/plugins/example/src/empty.ts',
        symbol: '(empty)',
        reason: 'unknown-symbol',
      },
      {
        filePath: 'packages/plugins/example/src/namespace-export.ts',
        symbol: '*',
        reason: 'namespace-export',
      },
    ],
  );
});

test('planDeclarationRewrites reports import types and dynamic imports without rewriting them', () => {
  const plan = planDeclarationRewrites(
    [{
      filePath: 'packages/plugins/example/src/non-declaration-imports.ts',
      content: [
        "type PublicType = import('@happier-dev/plugin-sdk/experimental/runtime').LegacyType;",
        "type RetainedType = import('@happier-dev/plugin-sdk/experimental/runtime').LegacyRetained;",
        "const runtime = import('@happier-dev/plugin-sdk/experimental/runtime');",
      ].join('\n'),
    }],
    declarationRows,
  );

  assert.equal(plan.edits.length, 0);
  assert.deepEqual(
    plan.refusals.map(({ symbol, reason }) => ({ symbol, reason })),
    [
      { symbol: 'LegacyType', reason: 'import-type' },
      { symbol: '(dynamic-import)', reason: 'dynamic-import' },
    ],
  );
  assert.deepEqual(
    plan.matches.map(({ sourceSymbol, status }) => ({ sourceSymbol, status })),
    [
      { sourceSymbol: 'LegacyType', status: 'blocked-by-declaration-refusal' },
      { sourceSymbol: 'LegacyRetained', status: 'retained' },
    ],
  );
});

test('planDeclarationRewrites ignores non-named imports from fully retained specifiers but still refuses losing namespace imports', () => {
  const plan = planDeclarationRewrites(
    [
      {
        filePath: 'apps/ui/sources/components/plugins/shared/hostRuntimeExternals.ts',
        content: "import * as PluginUiHostApiClient from '@happier-dev/plugin-sdk/ui/client';",
      },
      {
        filePath: 'apps/ui/sources/components/plugins/shared/hostRuntimeExternals.test.ts',
        content: "import * as PluginUiHostApiClient from '@happier-dev/plugin-sdk/ui/client';",
      },
      {
        filePath: 'packages/plugin-sdk/src/publicPackageExports.test.ts',
        content: "const registrationApi = await import('@happier-dev/plugin-sdk/host/registration');",
      },
      {
        filePath: 'packages/plugins/scm-git/src/index.ts',
        content: "import * as LegacyScmBackend from '@happier-dev/plugin-sdk/experimental/scm/backend';",
      },
    ],
    [
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/ui/client',
        sourceSymbol: 'createPluginUiHostApiClient',
        targetSpecifier: '@happier-dev/plugin-sdk/ui/client',
        targetSymbol: 'createPluginUiHostApiClient',
        action: 'retain',
        owner: 'sdk',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/host/registration',
        sourceSymbol: 'PluginRuntimeRegistration',
        targetSpecifier: '@happier-dev/plugin-sdk/host/registration',
        targetSymbol: 'PluginRuntimeRegistration',
        action: 'retain',
        owner: 'host',
      },
      {
        sourceSpecifier: '@happier-dev/plugin-sdk/experimental/scm/backend',
        sourceSymbol: 'ScmBackendRuntimeHandlers',
        targetSpecifier: '@happier-dev/plugin-sdk/scm/backend',
        targetSymbol: 'BackendRuntimeHandlers',
        action: 'rename',
        owner: 'scm',
      },
    ],
  );

  assert.equal(plan.edits.length, 0);
  assert.deepEqual(
    plan.refusals.map(({ filePath, sourceSpecifier, symbol, reason }) => ({
      filePath,
      sourceSpecifier,
      symbol,
      reason,
    })),
    [{
      filePath: 'packages/plugins/scm-git/src/index.ts',
      sourceSpecifier: '@happier-dev/plugin-sdk/experimental/scm/backend',
      symbol: '*',
      reason: 'namespace-import',
    }],
  );
});

test('planDeclarationRewrites refuses a retain row that changes symbol or specifier', () => {
  const plan = planDeclarationRewrites(
    [{
      filePath: 'packages/plugins/example/src/invalid-retain.ts',
      content: "import { LegacyType } from '@happier-dev/plugin-sdk/experimental/runtime';",
    }],
    [{
      sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
      sourceSymbol: 'LegacyType',
      targetSpecifier: '@happier-dev/plugin-sdk/runtime',
      targetSymbol: 'LegacyType',
      action: 'retain',
      owner: 'runtime',
    }],
  );

  assert.equal(plan.edits.length, 0);
  assert.deepEqual(plan.refusals, [{
    filePath: 'packages/plugins/example/src/invalid-retain.ts',
    sourceSpecifier: '@happier-dev/plugin-sdk/experimental/runtime',
    symbol: 'LegacyType',
    reason: 'invalid-safe-row',
    owner: 'runtime',
    detail: 'retain row must preserve both source specifier and source symbol',
  }]);
});

test('planImportRewrites rewrites exact import specifiers and is idempotent', () => {
  const plan = planImportRewrites(
    [
      {
        filePath: 'apps/ui/sources/example.test.tsx',
        content: "import { testUiMocks } from '@/dev/testkit/testUiMocks';",
      },
    ],
    [
      {
        id: 'rewrite-test-ui-mocks',
        from: '@/dev/testkit/testUiMocks',
        to: '@/sources/dev/testkit/createUiTestHarness',
      },
    ],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]?.after, "import { testUiMocks } from '@/sources/dev/testkit/createUiTestHarness';");

  const secondPass = planImportRewrites(
    [
      {
        filePath: plan.edits[0]!.filePath,
        content: plan.edits[0]!.after,
      },
    ],
    [
      {
        id: 'rewrite-test-ui-mocks',
        from: '@/dev/testkit/testUiMocks',
        to: '@/sources/dev/testkit/createUiTestHarness',
      },
    ],
  );

  assert.equal(secondPass.edits.length, 0);
});

test('planImportRewrites rewrites only import statements and respects namedImportMap', () => {
  const before = [
    "import { oldThing, keepThing, oldAliased as localAlias } from '@/legacy/module';",
    "export { oldThing as exportedThing } from '@/legacy/module';",
    "const diagnostic = '@/legacy/module';",
  ].join('\n');

  const plan = planImportRewrites(
    [
      {
        filePath: 'apps/cli/src/example.ts',
        content: before,
      },
    ],
    [
      {
        id: 'rewrite-legacy-module',
        from: '@/legacy/module',
        to: '@/new/module',
        namedImportMap: {
          oldThing: 'newThing',
          oldAliased: 'newAliased',
        },
      },
    ],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(
    plan.edits[0]?.after,
    [
      "import { newThing, keepThing, newAliased as localAlias } from '@/new/module';",
      "export { newThing as exportedThing } from '@/new/module';",
      "const diagnostic = '@/legacy/module';",
    ].join('\n'),
  );
});

test('planImportRewritesForFilePaths only rewrites targeted files', () => {
  const plan = planImportRewritesForFilePaths(
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
    ['apps/cli/src/backends/catalog.ts'],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    plan.edits[0]?.after,
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
});

test('applyRewritePlan writes planned edits to disk and refuses mismatched content', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-rewrite-plan-'));
  const targetPath = join(rootDir, 'apps/cli/src/backends/catalog.ts');
  const untouchedPath = join(rootDir, 'apps/ui/sources/example.tsx');
  mkdirSync(dirname(targetPath), { recursive: true });
  mkdirSync(dirname(untouchedPath), { recursive: true });
  writeFileSync(targetPath, "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';", 'utf8');
  writeFileSync(untouchedPath, "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';", 'utf8');

  const plan = planImportRewritesForFilePaths(
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
    ['apps/cli/src/backends/catalog.ts'],
  );

  const result = applyRewritePlan(rootDir, plan);

  assert.equal(result.appliedEdits.length, 1);
  assert.equal(result.appliedEdits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    readFileSync(targetPath, 'utf8'),
    "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistryV2';",
  );
  assert.equal(readFileSync(untouchedPath, 'utf8'), "import { getResolvedContributionRegistry } from '@/plugins/registry/createResolvedContributionRegistry';");

  const mismatched = applyRewritePlan(rootDir, plan);
  assert.equal(mismatched.appliedEdits.length, 0);
  assert.equal(mismatched.skippedEdits.length, 1);
  assert.equal(mismatched.skippedEdits[0]?.reason, 'content-mismatch');
});

test('applyRewritePlan preflights the whole batch before writing any file', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-rewrite-plan-preflight-'));
  const firstFilePath = 'apps/cli/src/first.ts';
  const secondFilePath = 'apps/cli/src/second.ts';
  const missingFilePath = 'apps/cli/src/missing.ts';
  const firstBefore = "import { first } from '@/legacy/module';";
  const secondBefore = "import { second } from '@/legacy/module';";
  const missingBefore = "import { missing } from '@/legacy/module';";
  const firstAbsolutePath = join(rootDir, firstFilePath);
  const secondAbsolutePath = join(rootDir, secondFilePath);
  mkdirSync(dirname(firstAbsolutePath), { recursive: true });
  writeFileSync(firstAbsolutePath, firstBefore, 'utf8');
  writeFileSync(secondAbsolutePath, secondBefore, 'utf8');

  const plan = planImportRewrites(
    [
      { filePath: firstFilePath, content: firstBefore },
      { filePath: secondFilePath, content: secondBefore },
      { filePath: missingFilePath, content: missingBefore },
    ],
    [{ id: 'rewrite-module', from: '@/legacy/module', to: '@/new/module' }],
  );
  const concurrentSecondBytes = '// concurrent edit\n';
  writeFileSync(secondAbsolutePath, concurrentSecondBytes, 'utf8');

  const result = applyRewritePlan(rootDir, plan);

  assert.deepEqual(result.appliedEdits, []);
  assert.deepEqual(result.skippedEdits, [
    { filePath: secondFilePath, reason: 'content-mismatch' },
    { filePath: missingFilePath, reason: 'missing-file' },
  ]);
  assert.equal(readFileSync(firstAbsolutePath, 'utf8'), firstBefore);
  assert.equal(readFileSync(secondAbsolutePath, 'utf8'), concurrentSecondBytes);
});
