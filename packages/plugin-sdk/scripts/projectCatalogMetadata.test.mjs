import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { projectCatalogMetadata } from './projectCatalogMetadata.mjs';
import { publishPreparedActionTypeMap } from './generateActionTypeMap.mjs';

test('catalog safety changes update the safe leaf and fail the existing publication drift check', async t => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'happier-catalog-metadata-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const actions = resolve(repoRoot, 'packages/protocol/src/actions');
  await mkdir(actions, { recursive: true });
  const specs = [
    { id: 'session.title.set', safety: 'safe', executionPlacement: 'client', bindings: { mcpToolName: 'session_title_set' } },
    { id: 'read', safety: 'safe', bindings: { mcpToolName: 'read' } },
    { id: 'write', safety: 'danger', bindings: { mcpToolName: 'write' } },
    { id: 'duplicate', safety: 'safe', bindings: { mcpToolName: 'read' } },
    { id: 'no-tool', safety: 'safe' },
  ];
  const derive = async () => {
    await writeFile(resolve(actions, 'actionSpecs.ts'), `export const ACTION_SPECS = ${JSON.stringify(specs)};`);
    return await projectCatalogMetadata({ repoRoot });
  };
  const names = async projection => {
    const source = projection.outputs.get(resolve(repoRoot, 'packages/protocol/src/tools/autoApprovedNames.generated.ts'));
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    return (await import(`data:text/javascript,${encodeURIComponent(js)}`)).autoApprovedNames;
  };
  const before = await derive();
  assert.deepEqual(await names(before), ['action_execute', 'action_options_resolve', 'action_spec_get', 'action_spec_search',
    'change_title', 'read', 'session_title_set']);
  const context = { assertOwned() {}, assertInputsCurrent() {} };
  const prepared = projection => ({ outputs: projection.outputs, timing() {} });
  await publishPreparedActionTypeMap('--write', prepared(before), context);
  await publishPreparedActionTypeMap('--check', prepared(before), context);
  // A real authority change must withdraw both the direct tool and its alias.
  specs[0].safety = 'danger';
  specs[2].safety = 'safe';
  const after = await derive();
  assert.deepEqual(await names(after), ['action_execute', 'action_options_resolve', 'action_spec_get', 'action_spec_search', 'read', 'write']);
  await assert.rejects(publishPreparedActionTypeMap('--check', prepared(after), context), /Generated Action type map is stale/);
});
