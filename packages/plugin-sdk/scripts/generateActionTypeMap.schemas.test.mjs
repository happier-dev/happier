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

test('public support roots derive recursive readonly interfaces from their canonical owner', t => {
  const cache = resolve('packages/plugin-sdk/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'schema-action-support-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = resolve(root, 'request.json'), resultPath = resolve(root, 'result.json');
  writeFileSync(request, JSON.stringify({ repoRoot: process.cwd(), bindings:
    ['PluginAgentExternalSessionLinkDataArray', 'PluginAgentExternalSessionLinkDataObject', 'PluginAgentExternalSessionLinkDataValue']
      .map(name => ['plugins/contributions/agentExternalSessions.ts', name]),
  }));
  const generated = spawnSync(process.execPath, [resolve('packages/plugin-sdk/scripts/deriveActionDtos.mjs'), request, resultPath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  writeFileSync(resolve(root, 'dto.ts'), result.declarations.map(([, text]) => text).join('\n'));
  writeFileSync(resolve(root, 'consumer.ts'), `
    import type * as Dto from './dto.js';
    import type * as Canonical from '${resolve('packages/protocol/src/plugins/contributions/agentExternalSessions.js')}';
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
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit', resolve(root, 'consumer.ts')],
  { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
});
