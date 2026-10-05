import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { deriveActionDtoSchemas } from './deriveActionDtos.mjs';
import { prepareActionTypeMap } from './generateActionTypeMap.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('external authors can type inline Workflow and Session triggers and cannot author invalid blocks', () => {
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const compiled = spawnSync(invocation.command, [...invocation.argsPrefix, '--noEmit', '-p',
    resolve('packages/plugin-sdk/fixtures/authoring-inference/tsconfig.workflowTriggers.json')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('explicit Action generation derives current LocalServices preview schemas instead of copying stale DTOs', async t => {
  const started = performance.now();
  const prepared = await prepareActionTypeMap();
  assert.ok([...prepared.outputs.keys()].every(path => path.includes('/packages/plugin-sdk/src/')),
    'the producer publishes only consumed SDK DTOs, never duplicate Protocol copies');
  t.diagnostic(JSON.stringify({ coldGenerateMs: Math.round(performance.now() - started), parentMaxRssKiB: process.resourceUsage().maxRSS,
    familyMetrics: prepared.familyMetrics, inputs: prepared.inputKeys.length, results: prepared.resultKeys.length, modules: prepared.outputs.size }));
  const preview = [...prepared.outputs].find(([path]) => path.endsWith('/localServicesPreviewActionDtos.generated.ts'));
  assert.ok(preview, 'the canonical preview family is projected');
  assert.match(preview[1], /preview_registration_failed/u,
    'generate must include the failure admitted by the canonical preview schema');
  // Prove the complete candidate with the existing correspondence verifier
  // before publishing into this actively shared checkout. This is an ignored
  // compiler fixture, not a packaged or frozen release representation.
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'derived-action-correspondence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve('packages/protocol/src'), resolve(root, 'packages/protocol/src'), { recursive: true });
  const sdk = resolve(root, 'packages/plugin-sdk');
  cpSync(resolve('packages/plugin-sdk/src'), resolve(sdk, 'src'), { recursive: true });
  writeFileSync(resolve(sdk, 'package.json'), '{"type":"module"}');
  const config = JSON.parse(readFileSync(resolve('packages/plugin-sdk/tsconfig.json'), 'utf8'));
  config.compilerOptions.incremental = false;
  delete config.compilerOptions.tsBuildInfoFile;
  writeFileSync(resolve(sdk, 'tsconfig.json'), JSON.stringify(config));
  for (const [path, text] of prepared.outputs) {
    const target = resolve(root, relative(process.cwd(), path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022', '--extendedDiagnostics',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit',
    resolve(root, 'packages/protocol/src/auth/tr46.d.ts'), resolve(root, 'packages/protocol/src/actions/pluginActionDtoCorrespondence.ts'),
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message }) + '\n' + result.stdout + result.stderr);
  t.diagnostic(result.stdout);
  const sdkCompile = spawnSync(invocation.command, [...invocation.argsPrefix, '--noEmit', '-p', resolve(sdk, 'tsconfig.json')],
    { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(sdkCompile.status, 0, sdkCompile.stdout + sdkCompile.stderr);
  t.diagnostic('complete candidate correspondence and full SDK source compilation GREEN before publication');
});

test('schema edits regenerate family DTOs without any authored DTO input', async t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-action-dtos-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actions = resolve(root, 'packages/protocol/src/actions');
  mkdirSync(actions, { recursive: true });
  writeFileSync(resolve(actions, 'actionIds.ts'), `export const ACTION_ID_FAMILIES_V1 = { inventory: ['inventory.list'] } as const;`);
  writeFileSync(resolve(actions, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  const schemas = resolve(actions, 'actionSpecs.ts');
  writeFileSync(schemas, `
    import { z } from 'zod';
    type ProtocolComposableSchema<Input, Output> = { parse(input: Input): Output };
    type ProjectionValue<Schema, Projection extends 'input' | 'output'> =
      Schema extends ProtocolComposableSchema<infer Input, infer Output>
        ? Projection extends 'input' ? Input : Output : never;
    type ProtocolObjectProjection<Shape, Projection extends 'input' | 'output'> = {
      -readonly [Key in keyof Shape as undefined extends ProjectionValue<Shape[Key], Projection> ? never : Key]:
        Exclude<ProjectionValue<Shape[Key], Projection>, undefined>;
    } & {
      -readonly [Key in keyof Shape as undefined extends ProjectionValue<Shape[Key], Projection> ? Key : never]?:
        Exclude<ProjectionValue<Shape[Key], Projection>, undefined>;
    };
    const Input = z.object({ query: z.string().optional() }).strict();
    const OptionalPluginInput = z.object({ query: z.number() }).strict();
    const Output = z.object({ count: z.number(), status: z.enum(['ready']),
      projected: z.custom<ProtocolObjectProjection<{
        readonly value: ProtocolComposableSchema<string, number>;
        readonly label: ProtocolComposableSchema<string | undefined, string | undefined>;
      }, 'output'>>(), authored: z.custom<Readonly<{ kept: string }>>() }).strict();
    const INPUTS = { 'inventory.list': Input } as const;
    const OUTPUTS = { 'inventory.list': Output } as const;
    type CanonicalActionSchemaDefinition<Id, Input, Output, PluginInput> = {
      id: Id; inputSchema: Input; outputSchema: Output;
      surfaceBindings?: { plugin: { inputSchema: PluginInput } };
    };
    type Definition = { [Id in 'inventory.list']: CanonicalActionSchemaDefinition<Id, (typeof INPUTS)[Id], (typeof OUTPUTS)[Id], typeof OptionalPluginInput> };
  `);
  // A new family must enter generation solely through its canonical export.
  const familyDirectory = resolve(root, 'packages/protocol/src/sessions/organization');
  mkdirSync(familyDirectory, { recursive: true });
  const familyOwner = resolve(familyDirectory, 'newFamily.ts');
  writeFileSync(familyOwner, "export const NEW_ACTION_IDS = ['inventory.list'] as const;");
  writeFileSync(resolve(actions, 'actionIds.ts'), `import { NEW_ACTION_IDS } from '../sessions/organization/newFamily.js';
    export const ACTION_ID_FAMILIES_V1 = { fresh_family: NEW_ACTION_IDS } as const;`);
  const derive = async () => {
    const derived = await deriveActionDtoSchemas({ repoRoot: root, onlyFamilies: ['fresh_family'] });
    assert.deepEqual([...derived.outputs.keys()], [resolve(familyDirectory, 'freshFamilyActionDtos.ts')]);
    return [...derived.outputs.values()][0];
  };
  const initial = await derive();
  assert.match(initial, /count: number/u);
  assert.match(initial, /query\?: string/u);
  const source = ts.createSourceFile('dto.ts', initial, ts.ScriptTarget.ES2022, true);
  const resultMap = source.statements.find(node => ts.isTypeAliasDeclaration(node)
    && node.name.text === 'FreshFamilyActionResultById');
  const resultType = resultMap.type.members[0].type;
  const projected = resultType.members.find(member => member.name.getText(source) === 'projected').type;
  assert.equal(ts.isTypeLiteralNode(projected), true, projected.getText(source));
  assert.deepEqual(projected.members.map(member => ({
    name: member.name.getText(source),
    readonly: member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
    optional: member.questionToken !== undefined,
    type: member.type.getText(source),
  })), [
    { name: 'value', readonly: false, optional: false, type: 'number' },
    { name: 'label', readonly: false, optional: true, type: 'string' },
  ]);
  const authored = resultType.members.find(member => member.name.getText(source) === 'authored').type;
  const authoredReadonly = ts.isTypeReferenceNode(authored) && authored.typeName.getText(source) === 'Readonly'
    || ts.isTypeLiteralNode(authored)
      && authored.members[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
  assert.equal(authoredReadonly, true,
    'projection flattening must preserve unrelated authored readonly members');
  writeFileSync(schemas, readFileSync(schemas, 'utf8').replace('count: z.number()', 'count: z.string()').replace("['ready']", "['ready', 'failed']"));
  const refreshed = await derive();
  assert.match(refreshed, /count: string/u);
  assert.match(refreshed, /'ready' \| 'failed'|'failed' \| 'ready'/u);
  assert.doesNotMatch(refreshed, /z\.|zod|count: number/u);
});

test('Action schema derivation admits imported declarations without unrelated ambient packages', async t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-ambient-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actions = resolve(root, 'packages/protocol/src/actions');
  const ambient = resolve(root, 'node_modules/@types/unrelated/index.d.ts');
  const imported = resolve(root, 'node_modules/explicit-schema/index.d.ts');
  for (const directory of [actions, dirname(ambient), dirname(imported)]) mkdirSync(directory, { recursive: true });
  writeFileSync(ambient, 'declare const unrelatedApplicationGlobal: unique symbol;\n');
  writeFileSync(imported, "import { z } from 'zod'; export declare const ImportedInput: z.ZodString;\n");
  writeFileSync(resolve(actions, 'actionIds.ts'), "export const ACTION_ID_FAMILIES_V1 = { inventory: ['inventory.list'] } as const;");
  writeFileSync(resolve(actions, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  writeFileSync(resolve(actions, 'actionSpecs.ts'), `
    import { z } from 'zod';
    import { ImportedInput } from 'explicit-schema';
    export const ACTION_SPECS = [{ id: 'inventory.list', inputSchema: ImportedInput, outputSchema: z.number() }] as const;
  `);
  const request = resolve(root, 'request.json');
  const result = resolve(root, 'result.json');
  writeFileSync(request, JSON.stringify({ repoRoot: root, keys: ['inventory.list'], bindings: [
    ['actions/actionSpecs.ts', 'PluginActionInputById', 'MeasuredInput', true],
    ['actions/actionSpecs.ts', 'PluginActionResultById', 'MeasuredResult', false],
  ] }));
  const generated = spawnSync(process.execPath, [resolve('packages/plugin-sdk/scripts/deriveActionDtos.mjs'), request, result],
    { cwd: root, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const derived = JSON.parse(readFileSync(result, 'utf8'));
  const inputs = new Map(derived.inputDigests);
  assert.match(derived.declarations.map(([, text]) => text).join('\n'), /"inventory.list": string/u);
  assert.ok(inputs.has(imported), 'explicitly imported schema declarations remain derivation inputs');
  assert.ok(!inputs.has(ambient), 'unrelated ambient packages must not enter the Action derivation input identity');
});

test('versioned imported Action spec owners supply generated DTO schemas', async t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-imported-action-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actions = resolve(root, 'packages/protocol/src/actions');
  mkdirSync(resolve(actions, 'specs'), { recursive: true });
  writeFileSync(resolve(actions, 'actionIds.ts'), "export const ACTION_ID_FAMILIES_V1 = { widgets: ['widgets.catalog.list'] } as const;");
  writeFileSync(resolve(actions, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  writeFileSync(resolve(actions, 'actionSpecs.ts'), `
    import { WIDGET_INSTANCE_ACTION_SPECS_V1 as widgetSpecs } from './specs/widgets.js';
    export const ACTION_SPECS = [...widgetSpecs];
  `);
  writeFileSync(resolve(actions, 'specs/widgets.ts'), `
    import { z } from 'zod';
    export const WIDGET_INSTANCE_ACTION_SPECS_V1 = [{
      id: 'widgets.catalog.list',
      inputSchema: z.object({ query: z.string().optional() }).strict(),
      outputSchema: z.object({ count: z.number() }).strict(),
    }] as const;
  `);
  const derived = await deriveActionDtoSchemas({ repoRoot: root, onlyFamilies: ['widgets'] });
  const dto = [...derived.outputs.values()].join('\n');
  assert.match(dto, /query\?: string/u);
  assert.match(dto, /count: number/u);
  writeFileSync(resolve(actions, 'specs/widgets.ts'), `
    import { z } from 'zod';
    const IDS = ['widgets.catalog.list'] as const;
    const INPUTS = { 'widgets.catalog.list': z.object({ query: z.string().optional() }).strict() } as const;
    const OUTPUTS = { 'widgets.catalog.list': z.object({ count: z.number() }).strict() } as const;
    export const WIDGET_INSTANCE_ACTION_SPECS_V1 = IDS.map(id => ({
      id, inputSchema: INPUTS[id], outputSchema: OUTPUTS[id],
    } as const));
  `);
  const mapped = await deriveActionDtoSchemas({ repoRoot: root, onlyFamilies: ['widgets'] });
  const mappedDto = [...mapped.outputs.values()].join('\n');
  assert.match(mappedDto, /query\?: string/u);
  assert.match(mappedDto, /count: number/u);
});

test('public support roots preserve canonical mutable projections and recursive readonly interfaces', t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-action-support-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = resolve(root, 'request.json'), resultPath = resolve(root, 'result.json');
  writeFileSync(request, JSON.stringify({ repoRoot: process.cwd(), bindings: [
    ...['PluginAgentExternalSessionLinkDataArray', 'PluginAgentExternalSessionLinkDataObject', 'PluginAgentExternalSessionLinkDataValue']
      .map(name => ['plugins/contributions/agentExternalSessions.ts', name]),
    ['plugins/contributions/publicTypes.ts', 'PluginContributionReferenceV2', 'PluginContributionReference'],
    ['plugins/ui/semanticCommands.ts', 'PluginUiSemanticOpenSurfaceCommandV1'],
    ...['EntityDragItemV1', 'EntityDragScopeV1', 'EntityDragKindV1', 'EntityDropAdmissionV1', 'EntityDropEffectV1', 'EntityDropPreviewV1', 'EntityDropReasonV1', 'EntityDropOutcomeV1']
      .map(name => ['plugins/ui/entityDragDrop.ts', name]),
    ...['PluginUiReadEntityDragItemRequestV1', 'PluginUiUpdateEntityDragDropRequestV1', 'PluginUiUpdateEntityDragDropResultV1', 'PluginUiWatchEntityDragDropRequestV1', 'PluginUiEntityDragDropStateV1', 'PluginUiEntityDropDestinationV1']
      .map(name => ['plugins/ui/entityDragDropHost.ts', name]),
    ...['PluginUiWidgetAreaRequestV1', 'PluginUiWidgetAreaResultV1', 'PluginUiWidgetAreaOperationV1']
      .map(name => ['plugins/ui/widgetArea.ts', name]),
  ] }));
  const generated = spawnSync(process.execPath, [resolve('packages/plugin-sdk/scripts/deriveActionDtos.mjs'), request, resultPath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  writeFileSync(resolve(root, 'dto.ts'), `import type { JsonValue } from '${resolve('packages/protocol/src/json/strictJsonValue.js')}';\n`
    + `import type { PluginUiJsonValueV1 } from '${resolve('packages/protocol/src/plugins/contributions/ui/json.js')}';\n`
    + `import type { PluginJsonValueV2, PluginJsonSchemaV2 as PluginJsonSchema } from '${resolve('packages/protocol/src/plugins/contributions/jsonSchema.js')}';\n`
    + `import type { PluginInvocableActionId } from '${resolve('packages/plugin-sdk/src/actions/actionTypeMap.generated.js')}';\n`
    + result.declarations.map(([, text]) => text).join('\n'));
  writeFileSync(resolve(root, 'consumer.ts'), `
    import type * as Dto from './dto.js';
    import type * as Canonical from '${resolve('packages/protocol/src/plugins/contributions/agentExternalSessions.js')}';
    import type { PluginContributionReferenceV2 } from '${resolve('packages/protocol/src/plugins/contributions/publicTypes.js')}';
    import type { PluginUiSemanticOpenSurfaceCommandV1 } from '${resolve('packages/protocol/src/plugins/ui/semanticCommands.js')}';
    import type * as Drag from '${resolve('packages/protocol/src/plugins/ui/entityDragDrop.js')}';
    import type * as HostedDrag from '${resolve('packages/protocol/src/plugins/ui/entityDragDropHost.js')}';
    import type * as WidgetArea from '${resolve('packages/protocol/src/plugins/ui/widgetArea.js')}';
    import { expectTypeOf } from 'vitest';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    // Neutral DTOs preserve the exact readonly/optional field grammar, not
    // the private mapped-type identity of the canonical schema projection.
    expectTypeOf<Dto.PluginContributionReference>().branded.toEqualTypeOf<PluginContributionReferenceV2>();
    type OptionalProjection = Assert<Equal<Dto.PluginUiSemanticOpenSurfaceCommandV1, PluginUiSemanticOpenSurfaceCommandV1>>;
    type ReadonlyProjection = Assert<Equal<Dto.PluginAgentExternalSessionLinkDataArray, Canonical.PluginAgentExternalSessionLinkDataArray>>;
    expectTypeOf<Dto.EntityDragItemV1>().branded.toEqualTypeOf<Drag.EntityDragItemV1>();
    expectTypeOf<Dto.EntityDragScopeV1>().branded.toEqualTypeOf<Drag.EntityDragScopeV1>();
    expectTypeOf<Dto.EntityDropAdmissionV1>().branded.toEqualTypeOf<Drag.EntityDropAdmissionV1>();
    type KindProjection = Assert<Equal<Dto.EntityDragKindV1, Drag.EntityDragKindV1>>;
    expectTypeOf<Dto.PluginUiUpdateEntityDragDropRequestV1>().branded.toEqualTypeOf<HostedDrag.PluginUiUpdateEntityDragDropRequestV1>();
    expectTypeOf<Dto.PluginUiEntityDragDropStateV1>().branded.toEqualTypeOf<HostedDrag.PluginUiEntityDragDropStateV1>();
    expectTypeOf<Dto.PluginUiWidgetAreaRequestV1>().branded.toEqualTypeOf<WidgetArea.PluginUiWidgetAreaRequestV1>();
    expectTypeOf<Dto.PluginUiWidgetAreaResultV1>().branded.toEqualTypeOf<WidgetArea.PluginUiWidgetAreaResultV1>();
    declare const canonical: Canonical.PluginAgentExternalSessionLinkDataArray;
    declare const dto: Dto.PluginAgentExternalSessionLinkDataArray;
    const forward: Dto.PluginAgentExternalSessionLinkDataArray = canonical;
    const reverse: Canonical.PluginAgentExternalSessionLinkDataArray = dto;
    const authored: Dto.PluginAgentExternalSessionLinkDataObject = { nested: [{ answer: 42 }] as const };
    // @ts-expect-error recursive JSON does not admit a callable value
    const invalid: Dto.PluginAgentExternalSessionLinkDataValue = () => 42;
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const compile = spawnSync(invocation.command, [...invocation.argsPrefix, '--ignoreConfig', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit',
    resolve('packages/protocol/src/auth/tr46.d.ts'), resolve(root, 'consumer.ts')],
  { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr
    + (result.declarations.find(([name]) => name === 'PluginContributionReference')?.[1] ?? ''));
});

test('public support roots preserve requested re-export aliases and explicit projection names', t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-action-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = resolve(root, 'request.json'), resultPath = resolve(root, 'result.json');
  writeFileSync(request, JSON.stringify({ repoRoot: process.cwd(), bindings: [
    ['actions/actionInputHintsRuntime.ts', 'ActionInputFieldHint'],
    ['actions/actionInputHintsRuntime.ts', 'ActionInputHints'],
    ['actions/actionInputHintsRuntime.ts', 'ActionInputOption', 'ProjectedOption'],
  ] }));
  const generated = spawnSync(process.execPath, [resolve('packages/plugin-sdk/scripts/deriveActionDtos.mjs'), request, resultPath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  for (const name of ['ActionInputFieldHint', 'ActionInputHints', 'ProjectedOption']) {
    assert.ok(result.declarations.some(([candidate]) => candidate === name), `missing exported DTO ${name}`);
  }
  writeFileSync(resolve(root, 'dto.ts'), `import type { JsonValue } from '${resolve('packages/protocol/src/json/strictJsonValue.js')}';\n`
    + result.declarations.map(([, text]) => text).join('\n'));
  writeFileSync(resolve(root, 'consumer.ts'), `
    import type * as Dto from './dto.js';
    import type * as Canonical from '${resolve('packages/protocol/src/actions/actionInputHintsRuntime.js')}';
    declare const field: Canonical.ActionInputFieldHint;
    declare const hints: Dto.ActionInputHints;
    declare const option: Dto.ProjectedOption;
    const forward: Dto.ActionInputFieldHint = field;
    const reverse: Canonical.ActionInputHints = hints;
    const projected: Canonical.ActionInputOption = option;
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: process.cwd(), workspaceDir: process.cwd() });
  const compile = spawnSync(invocation.command, [...invocation.argsPrefix, '--ignoreConfig', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit', resolve(root, 'consumer.ts')],
  { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
});
