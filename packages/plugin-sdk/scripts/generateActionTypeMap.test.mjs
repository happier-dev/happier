import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import ts from 'typescript';

import {
  collectGeneratedModuleDiagnostics,
  createActionTypeMapTimingReporter,
  createGeneratedModuleValidationCompilerOptions,
  renderActionTypeProjection,
  resolveActionTypeProjectionRootNames,
  runActionTypeMapWithWorkspaceLock,
  validateGeneratedModule,
  validateGeneratedModuleSyntax,
  writeFileIfChanged,
} from './generateActionTypeMap.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GENERATOR_PATH = fileURLToPath(new URL('./generateActionTypeMap.mjs', import.meta.url));
const PACKAGE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const GENERATED_PATH = resolve(PACKAGE_ROOT, 'src/actions/actionTypeMap.generated.ts');
const TSCONFIG_PATH = resolve(PACKAGE_ROOT, 'tsconfig.json');

function compileGeneratedActionTypeMap() {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG_PATH, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  assert.ok(parsed, 'plugin-sdk TypeScript configuration must load');

  const options = createGeneratedModuleValidationCompilerOptions(parsed.options);
  assert.equal(options.declaration, false);
  assert.equal(options.declarationMap, false);
  assert.equal(options.noEmit, true);
  assert.equal(options.incremental, false);
  const program = ts.createProgram({
    rootNames: [GENERATED_PATH],
    options,
  });
  const generated = program.getSourceFile(GENERATED_PATH);
  assert.ok(generated, 'generated Action type map source must load');
  return collectGeneratedModuleDiagnostics(program, generated)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('package compilation remains the semantic authority for the generated Action projection', () => {
  assert.deepEqual(compileGeneratedActionTypeMap(), []);
});

test('generated module validation rejects invalid syntax and private validator references', () => {
  assert.doesNotThrow(() => validateGeneratedModuleSyntax('export type Valid = { value: string };\n'));
  assert.throws(
    () => validateGeneratedModuleSyntax("import type { Private } from '@happier-dev/protocol';\nexport type Invalid = Private;\n"),
    /private or absolute import/u,
  );
  assert.throws(
    () => validateGeneratedModuleSyntax('export type Invalid = z.ZodString;\n'),
    /validator-library implementation reference/u,
  );
  assert.throws(
    () => validateGeneratedModuleSyntax('export type Invalid = {\n'),
    /not valid TypeScript/u,
  );
});

test('Action input projections accept the public readonly JSON value without changing normalized results', () => {
  const input = renderActionTypeProjection(
    'PluginActionInputById',
    '{ payload: PluginJsonValueV2; }',
  );
  const result = renderActionTypeProjection(
    'PluginActionResultById',
    '{ payload: PluginJsonValueV2; }',
  );

  assert.equal(input, '{ payload: JsonValue; }');
  assert.equal(result, '{ payload: PluginJsonValueV2; }');
});

test('Action type map timing identifies the expensive compiler phases', () => {
  const samples = [100, 125, 190, 260];
  const output = [];
  const phase = createActionTypeMapTimingReporter({
    now: () => samples.shift(),
    write: (line) => output.push(line),
  });

  phase('protocol-program');
  phase('structural-projection');
  phase('generated-module-validation');

  assert.deepEqual(output, [
    'action-type-map: phase=protocol-program deltaMs=25 totalMs=25\n',
    'action-type-map: phase=structural-projection deltaMs=65 totalMs=90\n',
    'action-type-map: phase=generated-module-validation deltaMs=70 totalMs=160\n',
  ]);
});

test('Action type map check performs in-memory semantic generated-module correspondence', () => {
  const source = readFileSync(GENERATOR_PATH, 'utf8');
  assert.match(source, /validateGeneratedModule\(output, inputKeys, resultKeys\);\n\s*timing\('generated-module-validation'\)/u);
});

test('in-memory semantic validation rejects unresolved and mismatched Action maps', () => {
  assert.doesNotThrow(() => validateGeneratedModule(
    'export type PluginActionInputById = { alpha: string };\nexport type PluginActionResultById = { alpha: number };\n',
    ['alpha'],
    ['alpha'],
  ));
  assert.throws(
    () => validateGeneratedModule(
      'export type PluginActionInputById = { alpha: MissingType };\nexport type PluginActionResultById = { alpha: number };\n',
      ['alpha'],
      ['alpha'],
    ),
    /does not compile|Cannot find name/u,
  );
  assert.throws(
    () => validateGeneratedModule(
      'export type PluginActionInputById = { alpha: string };\nexport type PluginActionResultById = { beta: number };\n',
      ['alpha'],
      ['alpha'],
    ),
    /key mismatch/u,
  );
});

test('Action type map roots the Protocol compiler at the unique declared projection owners', () => {
  const repoRoot = resolve('action-map-projection-root');
  assert.deepEqual(
    resolveActionTypeProjectionRootNames({
      repoRoot,
      projections: [
        { relativePath: 'packages/protocol/src/actions/actionSpecs.ts' },
        { relativePath: 'packages/protocol/src/actions/actionSpecs.ts' },
        { relativePath: 'packages/protocol/src/actions/executor/types.ts' },
      ],
    }),
    [
      resolve(repoRoot, 'packages/protocol/src/actions/actionSpecs.ts'),
      resolve(repoRoot, 'packages/protocol/src/actions/executor/types.ts'),
    ],
  );
});

test('Action type map publication leaves identical output untouched and writes changed output', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');

  await writeFileIfChanged(outputPath, 'first\n');
  const knownOldDate = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(outputPath, knownOldDate, knownOldDate);
  const beforeIdenticalWrite = statSync(outputPath);

  await writeFileIfChanged(outputPath, 'first\n');
  const afterIdenticalWrite = statSync(outputPath);
  assert.equal(afterIdenticalWrite.mtimeMs, beforeIdenticalWrite.mtimeMs);
  if (beforeIdenticalWrite.ino !== 0 && afterIdenticalWrite.ino !== 0) {
    assert.equal(afterIdenticalWrite.ino, beforeIdenticalWrite.ino);
  }

  await writeFileIfChanged(outputPath, 'second\n');
  assert.equal(readFileSync(outputPath, 'utf8'), 'second\n');
  assert.notEqual(statSync(outputPath).mtimeMs, beforeIdenticalWrite.mtimeMs);
});

test('Action type map generation shares the canonical workspace publication lock', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'plugin-sdk.lock');
  let releaseFirst;
  let firstEntered;
  const firstEnteredPromise = new Promise((resolveEntered) => {
    firstEntered = resolveEntered;
  });
  const releaseFirstPromise = new Promise((resolveRelease) => {
    releaseFirst = resolveRelease;
  });
  let secondEntered = false;
  let secondWaited;
  const secondWaitedPromise = new Promise((resolveWaited) => {
    secondWaited = resolveWaited;
  });

  const first = runActionTypeMapWithWorkspaceLock({
    mode: '--check',
    lockPath,
    run: async () => {
      firstEntered();
      await releaseFirstPromise;
    },
  });
  await firstEnteredPromise;

  const second = runActionTypeMapWithWorkspaceLock({
    mode: '--check',
    lockPath,
    lockOptions: { onWait: secondWaited },
    run: async () => {
      secondEntered = true;
    },
  });
  await secondWaitedPromise;
  assert.equal(secondEntered, false);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test('generated Action projection is declaration-neutral and retains its public aliases', () => {
  const source = readFileSync(GENERATED_PATH, 'utf8');
  const importPaths = [...source.matchAll(/^import(?: type)? [^;]+ from '([^']+)';$/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(importPaths, [
    '../identity.js',
    '../externalSessions.js',
    '../ui/publicContract.js',
  ]);
  assert.doesNotMatch(
    source,
    /(?:['"]zod(?:\/[^'"]*)?['"]|\bz\.[A-Za-z_$]|\bZod[A-Za-z0-9_]*\b|\$(?:brand|Zod[A-Za-z0-9_]*))/u,
  );
  for (const name of [
    'ActionCaller',
    'PluginPolicyExpressionV2',
    'ActionSurfaceBindingTransform',
    'PluginJsonSchemaV2',
    'PluginAgentExternalSessionLinkDataArray',
    'PluginAgentExternalSessionLinkDataObject',
    'PluginAgentExternalSessionLinkDataValue',
    'JSONType',
    'PluginActionInputById',
    'PluginActionResultById',
    'PluginInvocableActionId',
  ]) {
    assert.match(source, new RegExp(`export type ${name}\\b`, 'u'));
  }
});
