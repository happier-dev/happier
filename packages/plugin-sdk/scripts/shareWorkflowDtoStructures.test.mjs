import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

import { deriveActionDtoSchemas } from './deriveActionDtos.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('Workflow DTOs share repeated semantic objects without changing input, output or author typing', async t => {
  const repoRoot = process.cwd();
  const temporaryRoot = resolve(repoRoot, '.happier/qa');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(resolve(temporaryRoot, 'workflow-dto-sharing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  put('packages/protocol/src/actions/actionIds.ts', `export const ACTION_ID_FAMILIES_V1 = {
    workflows: ['workflow.first', 'workflow.second']
  } as const;`);
  put('packages/protocol/src/actions/pluginActionSurface.ts', 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  put('packages/protocol/src/actions/actionSpecs.ts', `import { z } from 'zod/mini';
    const definition = z.strictObject({ blocks: z.array(z.unknown()), version: z.optional(z.literal(1)) });
    const selection = z.strictObject({ engine: z.string(), options: z.optional(z.record(z.string(), z.unknown())) });
    export const input = z.strictObject({ definition, selection, execution: selection });
    export const output = z.strictObject({
      definition: z.custom<Readonly<{ blocks: readonly unknown[]; version?: 1 }>>(),
      selection, execution: selection,
    });
    export const ACTION_SPECS = [
      { id: 'workflow.first', inputSchema: input, outputSchema: output },
      { id: 'workflow.second', inputSchema: input, outputSchema: output },
    ];`);
  const result = await deriveActionDtoSchemas({ repoRoot: root, onlyFamilies: ['workflows'] });
  const output = [...result.outputs.values()][0];
  assert.ok(output);
  const file = ts.createSourceFile('dto.ts', output, ts.ScriptTarget.ES2022, true);
  const maps = file.statements.filter(node => ts.isTypeAliasDeclaration(node)
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.deepEqual(maps.map(node => node.name.text), ['WorkflowsActionInputById', 'WorkflowsActionResultById']);
  const inlineObjects = [];
  const visit = node => {
    if (ts.isPropertySignature(node) && ['definition', 'selection', 'execution'].includes(node.name.getText(file))
      && ts.isTypeLiteralNode(node.type)) inlineObjects.push(node.name.getText(file));
    ts.forEachChild(node, visit);
  };
  maps.forEach(visit);
  assert.deepEqual(inlineObjects, [], 'repeated semantic objects must be shared at their generator owner');
  assert.doesNotMatch(output, /\bzod\b|@happier-dev\/protocol|\bz\./u);
  put('dto.ts', output);
  put('consumer.ts', `import type { input, output } from './packages/protocol/src/actions/actionSpecs.js';
    import type { z } from 'zod/mini';
    import type { WorkflowsActionInputById, WorkflowsActionResultById } from './dto.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type Input = Assert<Equal<WorkflowsActionInputById['workflow.first'], z.input<typeof input>>>;
    type Output = Assert<Equal<WorkflowsActionResultById['workflow.second'], z.output<typeof output>>>;
    const authored: WorkflowsActionInputById['workflow.second'] = {
      definition: { blocks: [] }, selection: { engine: 'selected' }, execution: { engine: 'selected' },
    };
    authored.definition.blocks.push('another block');
    declare const result: WorkflowsActionResultById['workflow.first'];
    // @ts-expect-error the output's readonly array is distinct from the mutable ingress carrier
    result.definition.blocks.push('invalid');
    // @ts-expect-error a selected engine remains required
    const invalid: typeof authored.selection = {};
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const compilation = spawnSync(invocation.command, [...invocation.argsPrefix, '--ignoreConfig', '--strict',
    '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--noEmit',
    resolve(root, 'consumer.ts')], { cwd: root, encoding: 'utf8' });
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
});
