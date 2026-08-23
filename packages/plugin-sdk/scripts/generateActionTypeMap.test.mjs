import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import ts from 'typescript';

import { renderActionTypeProjection, writeFileIfChanged } from './generateActionTypeMap.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const GENERATOR_PATH = resolve(PACKAGE_ROOT, 'scripts/generateActionTypeMap.mjs');
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

  const program = ts.createProgram({
    rootNames: [GENERATED_PATH],
    options: { ...parsed.options, incremental: false, noEmit: true },
  });
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === GENERATED_PATH)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('generated Action projection is self-contained TypeScript', () => {
  assert.deepEqual(compileGeneratedActionTypeMap(), []);
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

test('generated Action projection is declaration-neutral and retains its public aliases', () => {
  execFileSync(process.execPath, [GENERATOR_PATH, '--check'], {
    cwd: PACKAGE_ROOT,
    stdio: 'pipe',
  });

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
