import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('SDK compilation admits stale generated DTOs while the correspondence gate rejects them', (t) => {
  const repoRoot = process.cwd();
  const sdk = resolve(repoRoot, 'packages/plugin-sdk');
  const cache = resolve(sdk, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'happier-stale-dto-compilation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Source-level compiler fixture only: no package build, installation,
  // publication or mutation of the shared generated outputs.
  function copySource(from, to) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === 'test-support' || /\.(?:test|spec)\./u.test(entry.name)) continue;
      const input = resolve(from, entry.name), output = resolve(to, entry.name);
      if (entry.isDirectory()) copySource(input, output);
      else if (entry.name.endsWith('.ts')) writeFileSync(output, readFileSync(input));
    }
  }
  copySource(resolve(sdk, 'src'), resolve(root, 'src'));
  writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
  const config = JSON.parse(readFileSync(resolve(sdk, 'tsconfig.json'), 'utf8'));
  config.compilerOptions.incremental = false;
  delete config.compilerOptions.tsBuildInfoFile;
  writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify(config));
  const supportPath = resolve(root, 'src/actions/dtos/pluginActionDtoSupport.generated.ts');
  // The schema producer owns the grammar in support; the UI module retains
  // only stable aliases. Corrupt the generated owner, not its alias wrapper.
  const grammarPath = supportPath;
  const current = readFileSync(grammarPath, 'utf8');
  // Mutate optionality, not the printer's order of equivalent union members.
  const parsed = ts.createSourceFile(grammarPath, current, ts.ScriptTarget.ES2022, true);
  const grammar = parsed.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'PluginDeclarativeNodeV2');
  const optionalTokens = [];
  const visit = node => {
    if (ts.isPropertySignature(node) && node.questionToken && ['direction', 'gap'].includes(node.name.text)) {
      optionalTokens.push(node.questionToken.getStart(parsed));
    }
    ts.forEachChild(node, visit);
  };
  assert.ok(grammar, 'the generated declarative grammar must be present');
  visit(grammar);
  let stale = current;
  for (const offset of optionalTokens.sort((a, b) => b - a)) stale = stale.slice(0, offset) + stale.slice(offset + 1);
  assert.notEqual(stale, current, 'the fixture must actually change the generated node contract');
  writeFileSync(grammarPath, stale);
  const support = readFileSync(supportPath, 'utf8');
  const staleSupport = support.replace('readonly id: PluginInvocableActionId;',
    "readonly id: PluginInvocableActionId | '__stale_action_fixture__';");
  assert.notEqual(staleSupport, support, 'the fixture must also change the generated ActionSpec id');
  writeFileSync(supportPath, staleSupport);
  writeFileSync(supportPath, staleSupport.replace("export type PluginUiIconTokenV1 = ",
    "export type PluginUiIconTokenV1 = '__stale_icon_fixture__' | "));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: sdk });
  const compile = args => spawnSync(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd: root, encoding: 'utf8',
  });
  const sdkCompile = compile(['--noEmit', '-p', 'tsconfig.json']);
  assert.equal(sdkCompile.status, 0, JSON.stringify({ signal: sdkCompile.signal })
    + '\n' + sdkCompile.stdout + sdkCompile.stderr);
  writeFileSync(resolve(root, 'correspondence.ts'), `
    import type { PluginDeclarativeDocumentV1 as Canonical } from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
    import type { PluginDeclarativeNodeV2 as Stale } from './src/actions/dtos/actionDeclarativeNodeDto.generated.js';
    type Assert<T extends true> = T;
    type CurrentNodeMustFitProjection = Assert<Canonical['root'] extends Stale ? true : false>;
  `);
  const correspondence = compile(['--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit', 'correspondence.ts']);
  assert.notEqual(correspondence.status, 0, 'stale DTOs must still fail correspondence');
  assert.match(correspondence.stdout, /TS2344/u);
  t.diagnostic('stale DTO: full SDK source compilation GREEN; explicit correspondence RED');
});
