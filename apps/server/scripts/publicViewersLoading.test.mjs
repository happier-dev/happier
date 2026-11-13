import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = ['publicShareViewerBundle.generated.ts', 'publicProfileRenderer.generated.mjs'];

test('API startup excludes both generated viewers and public profiles render on first demand', async t => {
  // Build under the ignored package output tree so native imports use the same
  // workspace/hoisted package resolution as the real compiled server.
  const dist = join(projectDir, 'dist');
  await mkdir(dist, { recursive: true });
  const root = await mkdtemp(join(dist, 'public-viewers-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outdir = join(root, 'output');
  const result = await build({
    absWorkingDir: projectDir,
    entryPoints: ['sources/app/api/api.ts',
      'sources/app/api/routes/share/registerPublicShareViewerRoutes.ts',
      'sources/app/api/routes/account/registerPublicProfileReadRoutes.ts'],
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
    packages: 'external', outdir, outExtension: { '.js': '.mjs' },
    // Bun supplies require in ESM; preserve that runtime boundary in this Node-hosted bundle.
    banner: { js: "import { createRequire as __viewerCreateRequire } from 'node:module'; const require = __viewerCreateRequire(import.meta.url);" },
    tsconfig: join(projectDir, 'tsconfig.json'), metafile: true, logLevel: 'silent',
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find(path => outputs[path].entryPoint === 'sources/app/api/api.ts');
  assert.ok(entry, 'API entry must be compiled');
  const eager = new Set();
  const visit = path => {
    if (eager.has(path)) return;
    eager.add(path);
    for (const edge of outputs[path].imports) {
      if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
    }
  };
  visit(entry);
  const payloads = Object.entries(outputs).filter(([, output]) =>
    Object.keys(output.inputs).some(input => generated.some(name => input.endsWith(name))));
  const eagerPayloads = payloads.filter(([path]) => eager.has(path));
  const eagerGeneratedInputs = eagerPayloads.flatMap(([, output]) => Object.keys(output.inputs)
    .filter(input => generated.some(name => input.endsWith(name))));
  t.diagnostic(JSON.stringify({ startupGeneratedModules: eagerGeneratedInputs.length,
    startupGeneratedSourceBytes: eagerGeneratedInputs.reduce((sum, input) => sum + result.metafile.inputs[input].bytes, 0) }));
  assert.equal(eagerGeneratedInputs.length, 0, 'startup must load zero generated viewer modules');
  for (const name of generated) {
    assert.equal(payloads.filter(([, output]) => Object.keys(output.inputs).some(input => input.endsWith(name))).length,
      1, `${name} must still have one emitted owner`);
  }
  const emitted = symbol => {
    const path = Object.keys(outputs).find(path => outputs[path].exports.includes(symbol));
    assert.ok(path, `${symbol} must be available at its demand boundary`);
    return pathToFileURL(resolve(projectDir, path)).href;
  };
  const shareOwner = await import(emitted('loadPublicShareViewerScript'));
  const profileOwner = await import(emitted('loadPublicProfileHtml'));
  const preparationStarted = performance.now();
  await shareOwner.loadPublicShareViewerScript();
  t.diagnostic(JSON.stringify({ preparationAfterReadyMs: performance.now() - preparationStarted }));
  const measure = async (symbol, load, consume, prepared = true) => {
    const started = performance.now();
    const promise = load();
    assert.equal(load(), promise, 'concurrent requests share one module promise');
    if (prepared) {
      let alreadyPrepared = false;
      void promise.then(() => { alreadyPrepared = true; });
      await Promise.resolve();
      assert.equal(alreadyPrepared, true, 'prepared share viewer must not await module initialization');
    }
    const value = await promise;
    const loaded = performance.now();
    const first = consume(value);
    const rendered = performance.now();
    assert.equal(consume(await load()), first);
    t.diagnostic(JSON.stringify({ symbol, preparedAwaitMs: loaded - started, firstResponseMs: rendered - started,
      warmResponseMs: performance.now() - rendered, responseBytes: Buffer.byteLength(first) }));
    return first;
  };
  const script = await measure('PUBLIC_SHARE_VIEWER_SCRIPT', shareOwner.loadPublicShareViewerScript, value => value);
  assert.ok(script.length > 1000);
  assert.ok(script.includes('public-share-viewer'));
  const html = await measure('renderPublicProfileHtml', profileOwner.loadPublicProfileHtml,
    module => module.renderPublicProfileHtml({ kind: 'unavailable' }), false);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /<style>/);
  assert.match(html, /No public profile here/);
  const [head, body] = html.split('</style>');
  const defined = new Set([...(head ?? '').matchAll(/\.(r-[0-9a-z]+)\b/g)].map(match => match[1]));
  const used = [...new Set(body?.match(/\br-[0-9a-z]+\b/g) ?? [])];
  assert.ok(used.length > 0);
  assert.deepEqual(used.filter(name => !defined.has(name)), []);
  assert.doesNotMatch(html, /<script/);
  t.diagnostic(JSON.stringify({ startupGeneratedModules: eagerGeneratedInputs.length,
    demandGeneratedModules: generated.length, outputDir: relative(projectDir, outdir) }));
});
