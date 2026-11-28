import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import * as generator from './generateActionTypeMap.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

function writeCanonicalSdkTypeFixtures(root) {
  const put = (path, text) => {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  put('packages/plugin-sdk/src/identity.ts', `
    export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
    export type PluginJsonValueV2 = JsonValue;
  `);
  put('packages/plugin-sdk/src/scm/comparisonSource.ts', `
    import type { JsonValue } from '../identity.js';
    export type ScmComparisonSource =
      | { kind: 'turnCheckpoint'; sessionId?: string; turnId?: string; checkpointReceiptId?: string; evidenceMode?: 'checkpoint' | 'agent_reported' | 'reconciled' }
      | { kind: 'session'; sessionId: string }
      | { kind: 'workingTree' }
      | { kind: 'branch'; head: string; base: string }
      | { kind: 'commit'; commit: string; parent?: string }
      | { kind: 'pullRequest'; locator: { providerId: string; repository: string; number: number; baseOid?: string; headOid?: string; sourceAction?: { action: { pluginId: string; localId: string }; input?: JsonValue } } };
  `);
  // This isolated compiler boundary proves generated import identity and
  // neutral syntax, not the real Machine item/StoredApp domain shape. Public
  // API materialization and author builds check the actual canonical types.
  put('packages/plugin-sdk/src/machineSetup.ts', `
    import type { JsonValue } from './identity.js';
    export type MachinePresetItemV1 = Readonly<{
      kind: 'softwareRecipe';
      selection: { ref: { pluginId: string; recipeId: string; revision: string }; inputs: JsonValue };
    }>;
  `);
}

test('Action DTO declaration consumers retain literal keys and result fields without a validator dependency', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-action-dto-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    const fullPath = resolve(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, text);
  };
  put('packages/protocol/src/actions/actionIds.ts', `
    export const ACTION_ID_FAMILIES_V1 = Object.freeze({ inventory: ['inventory.list'] } as const);
  `);
  put('packages/protocol/src/actions/pluginActionSurface.ts', `
    export const PLUGIN_SURFACE_EXCLUSION_REASONS = Object.freeze({} as const);
  `);
  put('packages/protocol/src/actions/pluginActionDtos.ts', `
    import type { InventoryActionInputById, InventoryActionResultById } from './inventoryActionDtos.js';
    export type PluginActionInputById = InventoryActionInputById;
    export type PluginActionResultById = InventoryActionResultById;
    export type PluginInvocableActionId = keyof PluginActionInputById;
  `);
  const details = `{ readonly kind: 'exact'; readonly source: string }
    | { readonly kind: 'estimate'; readonly confidence: number }`;
  put('packages/protocol/src/actions/inventoryActionDtos.ts', `
    export type InventoryActionInputById = { readonly 'inventory.list': { query?: string; details?: ${details} } };
    export type InventoryActionResultById = { readonly 'inventory.list': { count: number; details: ${details} } };
  `);
  assert.equal(typeof generator.projectActionDtoDeclarations, 'function',
    'the declaration consumer must receive the named Protocol DTO closure');
  const project = () => generator.projectActionDtoDeclarations({ repoRoot: root, declarations: new Map(
    ['pluginActionDtos.ts', 'inventoryActionDtos.ts'].map(name => {
      const path = resolve(root, 'packages/protocol/src/actions', name);
      return [path, readFileSync(path, 'utf8')];
    }),
  ) });
  const publish = () => {
    const projection = project();
    for (const [path, output] of projection.outputs) put(path, output);
    return projection;
  };
  const projection = publish();
  assert.deepEqual(projection.inputKeys, ['inventory.list']);
  assert.deepEqual(projection.resultKeys, ['inventory.list']);
  for (const [, output] of projection.outputs) {
    assert.doesNotMatch(output, /\bzod\b|@happier-dev\/protocol|\bz\./u);
  }
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const compile = (args) => spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...args,
  ], { cwd: root, encoding: 'utf8' });
  const emitted = compile(['--declaration', '--emitDeclarationOnly', '--outDir', 'declarations',
    'packages/plugin-sdk/src/actions/actionTypeMap.generated.ts']);
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  put('consumer.ts', `
    import type { PluginActionInputById, PluginActionResultById } from './declarations/actionTypeMap.generated.js';
    const input: PluginActionInputById['inventory.list'] = { query: 'open' };
    declare const result: PluginActionResultById['inventory.list'];
    const count: number = result.count;
    // @ts-expect-error only canonical literal Action keys are admitted
    type UnknownAction = PluginActionInputById['inventory.missing'];
  `);
  const consumer = compile(['--noEmit', 'consumer.ts']);
  assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr);
  // An external package must be able to infer a declaration from a shared DTO
  // member through the public entry point, where the shape shard is private.
  put('declarations/package.json', JSON.stringify({
    name: 'fixture-sdk', exports: { './actions': './actionTypeMap.generated.d.ts' },
  }));
  mkdirSync(resolve(root, 'node_modules'), { recursive: true });
  symlinkSync(resolve(root, 'declarations'), resolve(root, 'node_modules/fixture-sdk'), 'junction');
  put('external.ts', `
    import type { PluginActionResultById } from 'fixture-sdk/actions';
    declare const result: PluginActionResultById['inventory.list'];
    export const details = result.details;
  `);
  const external = compile(['--declaration', '--emitDeclarationOnly', 'external.ts']);
  assert.equal(external.status, 0, external.stdout + external.stderr);
  const externalDeclaration = readFileSync(resolve(root, 'external.d.ts'), 'utf8');
  assert.doesNotMatch(externalDeclaration, /node_modules|pluginActionDtoShapes/u);
  assert.match(externalDeclaration, /confidence: number/u);

  // A changed canonical result must fail against the stale emitted declaration,
  // then reach the real consumer after explicit projection. Unknown/any or a
  // string-indexed map would conceal this RED.
  put('packages/protocol/src/actions/inventoryActionDtos.ts', readFileSync(
    resolve(root, 'packages/protocol/src/actions/inventoryActionDtos.ts'), 'utf8',
  ).replace('count: number', 'count: string'));
  put('consumer.ts', readFileSync(resolve(root, 'consumer.ts'), 'utf8')
    .replace('const count: number', 'const count: string'));
  const drift = compile(['--noEmit', 'consumer.ts']);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stdout, /TS2322/u);
  t.diagnostic(`stale declaration-consumer RED: ${drift.stdout.trim()}`);
  publish();
  const changed = compile(['--declaration', '--emitDeclarationOnly', '--outDir', 'declarations',
    'packages/plugin-sdk/src/actions/actionTypeMap.generated.ts']);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  const refreshed = compile(['--noEmit', 'consumer.ts']);
  assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr);
  t.diagnostic('refreshed declaration-consumer GREEN');
  put('packages/protocol/src/actions/actionIds.ts', `
    export const ACTION_ID_FAMILIES_V1 = Object.freeze({ inventory: ['inventory.renamed'] } as const);
  `);
  assert.throws(project, /key mismatch/u);
});

test('syntax projection retains concrete family rows beyond the retired compiler print boundary', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-large-action-dto-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actions = resolve(root, 'packages/protocol/src/actions');
  mkdirSync(actions, { recursive: true });
  const keys = Array.from({ length: 512 }, (_, i) => `inventory.large.${i}`);
  const payload = 'x'.repeat(2100);
  writeFileSync(resolve(actions, 'actionIds.ts'), `export const ACTION_ID_FAMILIES_V1 = { inventory: ${JSON.stringify(keys)} } as const;`);
  writeFileSync(resolve(actions, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  writeFileSync(resolve(actions, 'pluginActionDtos.ts'), `
    import type { Inputs, Results } from './family.js';
    export type PluginActionInputById = Inputs;
    export type PluginActionResultById = Results;
    export type PluginInvocableActionId = keyof Inputs;
  `);
  writeFileSync(resolve(actions, 'family.ts'), `export type Inputs = { ${keys.map(key=>`${JSON.stringify(key)}: Record<string, never>;`).join('\n')} };\nexport type Results = { ${keys.map(key=>`${JSON.stringify(key)}: { payload: ${JSON.stringify(payload)} };`).join('\n')} };`);
  const declarations = new Map(['pluginActionDtos.ts', 'family.ts'].map(name => {
    const path = resolve(actions, name);
    return [path, readFileSync(path, 'utf8')];
  }));
  assert.ok(Buffer.byteLength(declarations.get(resolve(actions, 'family.ts'))) > 1_000_000,
    'exercise the previous aggregate print truncation region');
  const projection = generator.projectActionDtoDeclarations({ repoRoot: root, declarations });
  assert.deepEqual(projection.inputKeys, [...keys].sort());
  assert.deepEqual(projection.resultKeys, [...keys].sort());
  const text = projection.outputs.get('packages/plugin-sdk/src/actions/dtos/family.generated.ts');
  const file = ts.createSourceFile('family.ts', text, ts.ScriptTarget.ES2022, true);
  const result = file.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Results');
  const shared = projection.outputs.get('packages/plugin-sdk/src/actions/dtos/pluginActionDtoShapes.generated.ts');
  const sharedFile = ts.createSourceFile('shared.ts', shared, ts.ScriptTarget.ES2022, true);
  const shapes = new Map(sharedFile.statements.filter(ts.isTypeAliasDeclaration).map(node => [
    node.name.text, node.type.objectType.elements[0],
  ]));
  assert.deepEqual(result.type.members.map(node => node.name.text), keys);
  for (const member of result.type.members) {
    const row = ts.isTypeReferenceNode(member.type) ? shapes.get(member.type.typeName.text) : member.type;
    assert.equal(row.members[0].type.literal.text, payload);
  }
});

test('current published Action DTO closure emits portable declarations and recursive author contracts', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-current-action-dto-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projection = generator.projectActionDtoDeclarations();
  const sdkSourceRoot = resolve(root, 'packages/plugin-sdk/src');
  const actionsRoot = resolve(sdkSourceRoot, 'actions');
  for (const [path, text] of projection.outputs) {
    assert.equal(readFileSync(resolve(path), 'utf8'), text, `published DTO module is current: ${path}`);
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    assert.doesNotMatch(text, /\bzod\b|@happier-dev\/protocol|\bz\./u);
  }
  writeCanonicalSdkTypeFixtures(root);
  const comparison = `
    import type * as Dto from './actionTypeMap.generated.js';
    // @ts-expect-error the public map has no arbitrary string index
    type MissingAction = Dto.PluginActionInputById['not.a.canonical.action'];
    export type Result = Dto.PluginActionResultById['teams.credentials.list'];
    export type Input = Dto.PluginActionInputById['workflow.run.start'];
    // UI aliases no longer happen to be reached through the Action map's
    // support imports. Exercise their real public declaration root explicitly.
    export type UiNode = import('./dtos/actionDeclarativeNodeDto.generated.js').PluginDeclarativeNodeV2;
    export type LinkArray = Dto.PluginAgentExternalSessionLinkDataArray;
    export type LinkObject = Dto.PluginAgentExternalSessionLinkDataObject;
    export type LinkValue = Dto.PluginAgentExternalSessionLinkDataValue;
    export type SchemaJson = Dto.JSONType;
  `;
  writeFileSync(resolve(actionsRoot, 'compare.ts'), comparison);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const compile = (args) => spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...args,
  ], { cwd: actionsRoot, encoding: 'utf8' });
  const emitted = compile(['--declaration', '--emitDeclarationOnly', '--outDir', 'declarations', 'compare.ts']);
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const inspectDeclarations = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) inspectDeclarations(child);
      else if (entry.name.endsWith('.d.ts')) assert.doesNotMatch(readFileSync(child, 'utf8'),
        /\bzod\b|@happier-dev\/protocol|\bz\./u);
    }
  };
  inspectDeclarations(resolve(actionsRoot, 'declarations'));
  // Resolve the real package export and its prepared declarations, as an external
  // plugin does. Generated DTO modules alone cannot prove public reachability.
  const packageScope = resolve(actionsRoot, 'node_modules/@happier-dev');
  mkdirSync(packageScope, { recursive: true });
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), resolve(packageScope, 'plugin-sdk'), 'junction');
  writeFileSync(resolve(actionsRoot, 'consumer.ts'), `
    import type { Input, Result } from './declarations/actions/compare.js';
    import type { PluginActionWorkflowIngressBlockV1, PluginActionWorkflowBlockV1, PluginActionResultById, PluginActionInputById,
      ExecutionRunChildChoiceV1, ExecutionRunStartFailureDetailsV1 } from '@happier-dev/plugin-sdk/actions';
    import type { PluginDeclarativeNodeV2 } from './declarations/actions/dtos/actionDeclarativeNodeDto.generated.js';
    declare const input: Input;
    declare const result: Result;
    export const authored = input;
    export const received = result;
    declare const childFailure: ExecutionRunStartFailureDetailsV1;
    export const childChoice: ExecutionRunChildChoiceV1 | undefined = childFailure.childChoice;
    export const runCreation: 'noRunCreated' | 'outcomeUnknown' = childFailure.executionRunStart.runCreation;
    declare const review: PluginActionInputById['review.start'];
    export const reviewChildSelection: 'agentDefault' | undefined = review.childSelection;
    // @ts-expect-error child choices expose a fixed pair of admissible responses
    export const invalidChoice: ExecutionRunChildChoiceV1['options'] = ['inherit'];
    export const unavailable: PluginActionResultById['browser.goBack'] = {
      v: 1, commandId: 'back', status: 'failed',
      error: { code: 'sandbox_unavailable', message: 'Sandbox unavailable' },
    };
    export const stack: PluginDeclarativeNodeV2 = {
      kind: 'stack', children: [{ kind: 'action', label: 'Apply', effect: {
        kind: 'composerApply', expectedRevision: 1,
        operations: [{ kind: 'text.set', text: 'hello' }] as const,
      } }],
    };
    export const ingress: PluginActionWorkflowIngressBlockV1[] = [
      'root shorthand',
      { kind: 'parallel', id: 'p1', branches: [{ id: 'b1', blocks: ['nested shorthand'] }], failurePolicy: 'fail_stop' },
      { kind: 'loop', id: 'l1', body: ['loop shorthand'], repetition: { kind: 'count', count: { kind: 'literal', value: 2 } } },
    ];
    // @ts-expect-error executable blocks do not admit authored prompt shorthand
    export const executable: PluginActionWorkflowBlockV1 = 'not executable';
    // @ts-expect-error nested authored blocks do not admit numbers
    export const invalid: PluginActionWorkflowIngressBlockV1 = { kind: 'parallel', id: 'p2', branches: [{ id: 'b2', blocks: [123] }], failurePolicy: 'fail_stop' };
  `);
  const consumer = compile(['--declaration', '--emitDeclarationOnly', '--outDir', 'consumer-declarations', 'consumer.ts']);
  assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr);
  assert.equal(projection.inputKeys.length, projection.resultKeys.length);
});

test('plugins can emit an inferred schema combining Project execution and Action approval', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-project-execution-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageScope = resolve(root, 'node_modules/@happier-dev');
  mkdirSync(packageScope, { recursive: true });
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), resolve(packageScope, 'plugin-sdk'), 'junction');
  writeFileSync(resolve(root, 'consumer.ts'), `
    export type { PluginJsonValueV2 } from '@happier-dev/plugin-sdk';
    export type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
    import {
      defineProtocolUnion,
      ProtocolActionApprovalRequestCreatedResultSchema,
      ProtocolProjectComputeExecResultV1Schema,
    } from '@happier-dev/plugin-sdk/protocol';
    export const result = defineProtocolUnion([
      ProtocolProjectComputeExecResultV1Schema,
      ProtocolActionApprovalRequestCreatedResultSchema,
    ]);
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd(), invocationKind: 'build' });
  const emitted = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--declaration', '--emitDeclarationOnly', '--outDir', 'declarations', 'consumer.ts',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(emitted.status, 0, emitted.error?.message ?? emitted.stdout + emitted.stderr);
  const declaration = readFileSync(resolve(root, 'declarations/consumer.d.ts'), 'utf8');
  assert.match(declaration, /\bProjectComputeExecAcceptedResultV1\b/u);
  assert.doesNotMatch(declaration, /node_modules|plugin-sdk\/dist|@happier-dev\/protocol/u);
});

test('SDK declarative aliases and neutral DTOs remain equivalent in a declaration consumer', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-action-ui-dto-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actionsRoot = resolve(root, 'packages/plugin-sdk/src/actions');
  for (const [path, text] of generator.projectActionDtoDeclarations().outputs) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text);
  }
  writeCanonicalSdkTypeFixtures(root);
  const file = ts.createSourceFile('manifest.ts', readFileSync(new URL('../src/manifest.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true);
  const aliases = new Map(file.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node]));
  const selected = new Set();
  const projectedImports = new Map();
  const builtins = new Set(['Readonly', 'Record', 'Exclude']);
  const externals = new Set(['JsonValue', 'PluginJsonValueV2', 'PluginUiIconTokenV1', 'PluginUiAttachmentToneV1', 'ComposerContentMediaKindV1', 'ComposerContentMimeTypeV1']);
  const select = name => {
    if (builtins.has(name) || externals.has(name) || selected.has(name)) return;
    const node = aliases.get(name);
    if (!node) {
      const owner = file.statements.find(node => ts.isImportDeclaration(node)
        && /^\.\/actions\/dtos\/[A-Za-z0-9]+\.generated\.js$/u.test(node.moduleSpecifier.text)
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(item => item.name.text === name));
      assert.ok(owner, `existing SDK grammar dependency: ${name}`);
      const binding = owner.importClause.namedBindings.elements.find(item=>item.name.text === name);
      projectedImports.set(name, {
        imported: (binding.propertyName ?? binding.name).text,
        module: owner.moduleSpecifier.text.replace('./actions/', './'),
      });
      return;
    }
    selected.add(name);
    const visit = child => { if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) select(child.typeName.text); ts.forEachChild(child, visit); };
    visit(node);
  };
  select('PluginDeclarativeNodeV2');
  for (const [name, node] of aliases) {
    if (ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
      && node.type.typeName.text.startsWith('DtoPlugin')) select(name);
  }
  const printer = ts.createPrinter();
  const projectedImportText = [...new Set([...projectedImports.values()].map(({ module }) => module))]
    .map(module => `import type { ${[...projectedImports].filter(([, value]) => value.module === module).map(([local, value]) => `${value.imported} as ${local}`).join(', ')} } from '${module}';`)
    .join('\n');
  const original = `type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };\ntype PluginJsonValueV2 = JsonValue;\nimport type { PluginInvocableActionId } from './actionTypeMap.generated.js';\nimport type { PluginUiIconTokenV1, PluginUiAttachmentToneV1, ComposerContentMediaKindV1, ComposerContentMimeTypeV1 } from './dtos/actionDeclarativeNodeDto.generated.js';\n`
    + (projectedImportText ? `${projectedImportText}\n` : '')
    + [...selected].map(name => printer.printNode(ts.EmitHint.Unspecified, aliases.get(name), file)).join('\n');
  writeFileSync(resolve(actionsRoot, 'originalUi.ts'), original.replaceAll("import('./actions/actionTypeMap.generated.js').PluginInvocableActionId", 'PluginInvocableActionId'));
  writeFileSync(resolve(actionsRoot, 'uiComparison.ts'), `
    import type * as Original from './originalUi.js';
    import type * as Neutral from './dtos/pluginActionDtoSupport.generated.js';
    type Equal<A,B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    type Assert<T extends true> = T;
    ${[...selected].map(name=>`type Preserve${name} = Assert<Equal<Original.${name}, Neutral.${name}>>;`).join('\n')}
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit', 'uiComparison.ts'], { cwd: actionsRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
