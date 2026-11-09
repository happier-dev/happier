import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

test('every normalized plugin-visible client-capable Action exposes an optional string selector', async t => {
  const started = performance.now();
  const bundled = await build({
    stdin: { contents: `import { listActionSpecs, PLUGIN_ACTION_INPUT_SCHEMAS } from './packages/protocol/src/actions/actionSpecs.ts';
      function hasSelector(schema) {
        const def = schema._zod.def;
        if (def.type === 'union') return def.options.every(hasSelector);
        if (def.type === 'intersection') return hasSelector(def.left) && hasSelector(def.right);
        if (def.type !== 'object') return false;
        const selector = def.shape.clientId;
        return Boolean(selector && selector.safeParse(undefined).success
          && selector.safeParse('exact-client').success && !selector.safeParse(1).success);
      }
      export const ids = listActionSpecs().filter(spec => spec.surfaces.plugin && spec.outputSchema
        && (spec.executionPlacement === 'client' || spec.executionPlacements?.includes('client'))).map(spec => spec.id);
      export const runtimeMissing = ids.filter(id => !hasSelector(PLUGIN_ACTION_INPUT_SCHEMAS[id]));
      // Dynamic invocation uses the neutral parser adapter, not a native object.
      const invoke = PLUGIN_ACTION_INPUT_SCHEMAS['action.invoke'];
      const request = { action: { pluginId: 'acme.plugin', localId: 'open-details' } };
      const selected = invoke.safeParse({ ...request, clientId: 'exact-client' });
      export const outerSelectorValid = invoke.safeParse(request).success && selected.success
        && selected.data.clientId === 'exact-client' && !invoke.safeParse({ ...request, clientId: 1 }).success;`,
    resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', conditions: ['happier-source'],
    tsconfigRaw: {}, logLevel: 'silent',
  });
  const runtime = { exports: {} };
  runInThisContext(`(function(module, exports, require) { ${bundled.outputFiles[0].text}\n})`,
    { filename: resolve('packages/protocol/src/actions/actionSpecs.ts') })(runtime, runtime.exports, createRequire(import.meta.url));
  const { ids, runtimeMissing, outerSelectorValid } = runtime.exports;
  assert.ok(ids.length > 0, 'the real normalized catalog must be loaded');
  assert.deepEqual(runtimeMissing, [], 'the normalized runtime schemas must admit the same selector');
  assert.equal(outerSelectorValid, true, 'outer action.invoke must admit and retain only an optional string selector');
  const path = resolve('packages/plugin-sdk/src/actions/actionTypeMap.generated.ts');
  const program = ts.createProgram([path], { strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source))
    .find(symbol => symbol.name === 'PluginActionInputById');
  const inputs = checker.getDeclaredTypeOfSymbol(symbol);
  const missing = [];
  for (const id of [...ids, 'action.invoke']) {
    const row = checker.getPropertyOfType(inputs, id);
    const input = row && checker.getTypeOfSymbolAtLocation(row, source);
    const selector = input && checker.getPropertyOfType(input, 'clientId');
    if (!selector || !(selector.flags & ts.SymbolFlags.Optional)
      || checker.typeToString(checker.getTypeOfSymbolAtLocation(selector, source)) !== 'string | undefined') missing.push(id);
  }
  t.diagnostic(JSON.stringify({ clientCapableActions: ids.length, missing, elapsedMs: Math.round(performance.now() - started) }));
  assert.deepEqual(missing, [], 'normalized client placement must not be erased by schema carriers');
});
