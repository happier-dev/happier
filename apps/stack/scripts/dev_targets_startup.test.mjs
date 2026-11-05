import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const run = promisify(execFile);

test('dev-targets exec loads only the command controller before dispatch validation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-targets-startup-' });
  const configPath = fixture.path('dev-targets.json');
  const metricsPath = fixture.path('startup.json');
  await writeFile(configPath, JSON.stringify({ version: 3, targets: [], commandExecution: { mode: 'local' } }));
  // Observe the real Node loader boundary, including source registration. No
  // internal Stack helpers or source-runtime decisions are replaced.
  const probe = `
    import { registerHooks } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const started = performance.now();
    let resolutions = 0, loads = 0, registration;
    const edges = new Map();
    registerHooks({
      resolve(specifier, context, next) {
        resolutions++;
        const result = next(specifier, context);
        if (context.parentURL) {
          if (!edges.has(context.parentURL)) edges.set(context.parentURL, new Set());
          edges.get(context.parentURL).add(result.url);
        }
        return result;
      },
      load(url, context, next) { loads++; return next(url, context); },
    });
    let firstWorkMs;
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (...args) => {
      firstWorkMs ??= performance.now() - started;
      return stderrWrite(...args);
    };
    const entry = ${JSON.stringify(new URL('./dev_targets.mjs', import.meta.url).href)};
    process.on('exit', () => {
      const reachable = root => {
        const visited = new Set();
        const visit = url => { if (visited.has(url)) return; visited.add(url); for (const child of edges.get(url) ?? []) visit(child); };
        visit(root);
        return visited.size;
      };
      const roots = [...(edges.get(entry) ?? [])].map(url => ({
        module: url.split('/scripts/').at(-1), reachable: reachable(url),
      })).sort((a,b) => b.reachable - a.reachable).slice(0, 8);
      writeFileSync(${JSON.stringify(metricsPath)}, JSON.stringify({ resolutions, loads, registration, firstWorkMs, roots }));
    });
    await import(${JSON.stringify(new URL('../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).href)});
    registration = { resolutions, loads, ms: performance.now() - started };
    process.argv = [process.execPath, fileURLToPath(entry), 'exec', 'auto', '--json'];
    await import(entry);
  `;
  const result = await run(process.execPath, ['--input-type=module', '--eval', probe], {
    env: { ...process.env, NODE_OPTIONS: '',
      HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_STACK_STORAGE_DIR: fixture.root,
      HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1', HAPPIER_EXEC_CONFIG_PATH: configPath },
  }).catch(error => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exec streams command output/);
  const metrics = JSON.parse(await readFile(metricsPath, 'utf8'));
  t.diagnostic(JSON.stringify(metrics));
  // Cold nl3 baseline: 2,088 loads; even the smallest unused provisioning
  // graph reached 1,780 modules. Dispatch must not activate that graph.
  assert.ok(metrics.loads < 1_780, `controller loaded ${metrics.loads} modules before dispatch validation`);
});
