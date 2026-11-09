import { expect, it } from 'vitest';

// Exercise Metro module evaluation and its real Fast Refresh export inspection
// in cold graphs, where cyclic schema producers can still be initializing.
async function projectColdSchemas(source: string, metro = true, refresh = false) {
  const { build, transform } = await import('esbuild');
  const { transformAsync } = await import('@babel/core');
  const { default: metroPlugins } = await import('metro-transform-plugins');
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { compileFunction } = await import('node:vm');
  const root = resolve(import.meta.dirname, '../../../..');
  const bundle = await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs',
    conditions: ['happier-source'], write: false, treeShaking: false, ignoreAnnotations: true,
    plugins: [{ name: 'metro-protocol-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.resolved) return;
        if (!args.path.startsWith('.') && !args.path.startsWith('/') && !args.path.startsWith('@happier-dev/protocol/')) return { path: args.path, external: true };
        const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
        if (result.path.includes('/packages/protocol/src/') && result.path.endsWith('.ts')) {
          return { path: result.path + '.cjs', namespace: 'metro-protocol' };
        }
        if (args.namespace === 'metro-protocol') return result;
      });
      builder.onLoad({ filter: /.*/, namespace: 'metro-protocol' }, async ({ path: virtualPath }) => {
        const path = virtualPath.slice(0, -4);
        const ts = await transform(await readFile(path, 'utf8'), { loader: 'ts', format: 'esm', target: 'esnext' });
        if (!metro) return { contents: ts.code, loader: 'js', resolveDir: dirname(path) };
        const js = await transformAsync(ts.code, { babelrc: false, configFile: false,
          plugins: refresh ? ['@babel/plugin-transform-modules-commonjs']
            : [[metroPlugins.importExportPlugin, { importAll: 'require', importDefault: 'require' }]],
        });
        return { contents: js!.code! + (refresh ? `
const refresh = require('react-refresh/runtime');
refresh.register(module.exports, ${JSON.stringify(path)});
for (const key of Object.keys(module.exports)) refresh.register(module.exports[key], ${JSON.stringify(path)} + key);
` : ''), loader: 'js', resolveDir: dirname(path) };
      });
    } }],
  });
  const module = { exports: {} as { failures?: unknown[] } };
  compileFunction(bundle.outputFiles[0].text, ['require', 'module', 'exports'])(createRequire(import.meta.url), module, module.exports);
  return module.exports.failures;
}


it('projects every ACTION_IDS input, output and deferred hint through the public UI catalog entry', async () => {
  expect(await projectColdSchemas(`
    import '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
    import '@happier-dev/protocol/actions/actionSettings';
    import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
    import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
    import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
    export const failures = [];
    for (const id of ACTION_IDS) for (const field of ['inputSchema', 'outputSchema', 'inputHints']) {
      try {
        const spec = getActionSpec(id);
        if (field === 'inputHints') void spec.inputHints;
        else zodSchemaToJsonSchemaObject(spec[field]);
      } catch (error) { failures.push({ id, field, code: error.code, reason: error.message }); }
    }
  `, false)).toEqual([]);
}, 120_000);

it('keeps deployments.environments.create and deployments.deploy operands defined for setup.plan, setup.apply and publish under Metro', async () => {
  expect(await projectColdSchemas(`
      import * as first from '@happier-dev/protocol/deployments/deploymentActionsV1';
      import { MachineSetupAppChildV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
      import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
      void Object.keys(first);
      export const failures = [];
      for (const option of MachineSetupAppChildV1Schema._zod.def.options) {
        const id = option._zod.def.shape.actionId._zod.def.values[0];
        try { zodSchemaToJsonSchemaObject(option._zod.def.shape.input); }
        catch (error) { failures.push({ id, code: error.code, reason: error.message }); }
      }
    `)).toEqual([]);
}, 120_000);

it('projects transcript.follow question handler Account ids when permissions load first under Metro', async () => {
  expect(await projectColdSchemas(`
    import * as first from '@happier-dev/protocol/sessions/permissions/v1';
    import { SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/questionV1';
    import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
    void Object.keys(first);
    export const failures = [];
    try { zodSchemaToJsonSchemaObject(SessionQuestionHandlerV1Schema); }
    catch (error) { failures.push({ id: 'transcript.follow.currentHandler', code: error.code, reason: error.message }); }
  `)).toEqual([]);
}, 120_000);

it.each([
  'sessions/metadata/sessionMetadataSchemasV1',
  'actions/operations/v1',
  'plugins/contributions/machineProvisioners',
  'plugins/contributions/v2',
])('projects the actual failing Actions when %s loads before Metro Fast Refresh inspects cold cyclic exports', async (entry) => {
  expect(await projectColdSchemas(`
    import '@happier-dev/protocol/${entry}';
    import '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
    import '@happier-dev/protocol/actions/actionSettings';
    import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
    import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
    import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
    export const failures = [];
    for (const id of ACTION_IDS) for (const field of ['inputSchema', 'outputSchema', 'inputHints']) {
      try {
        const spec = getActionSpec(id);
        if (field === 'inputHints') void spec.inputHints;
        else zodSchemaToJsonSchemaObject(spec[field]);
      } catch (error) { failures.push({ id, field, code: error.code, reason: error.message }); }
    }
  `, true, true)).toEqual([]);
}, 120_000);
