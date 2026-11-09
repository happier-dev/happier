import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTestHomePath, createTestHomeEnvironment, installTestHomeEnvironment } from '../../../../scripts/testing/testHomeEnvironment.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const cliRoot = join(repo, 'apps/cli');
const probe = fileURLToPath(new URL('./cli-startup-probe.cjs', import.meta.url));
const optedIn = Boolean(process.env.CLISTART_FAMILY_SOURCE || process.env.CLISTART_BUNDLE);
const evaluated = coverage => coverage.filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)));
const heavy = path => /packages\/(?:protocol|plugin-sdk|agents|plugins)\/|apps\/cli\/src\/(?:configuration\.ts|providers\/|agent\/catalog\/|plugins\/runtime\/|plugins\/projection\/registry\/createResolvedContributionRegistry)/u.test(path);
let suiteHome;
let outputs;

function isolateHome() {
  suiteHome ??= installTestHomeEnvironment();
  const home = createTestHomeEnvironment();
  assertTestHomePath(home.env.HAPPIER_HOME_DIR, home.env.HAPPIER_TEST_HOME_ROOT);
  return home;
}
after(() => suiteHome?.cleanup());

async function evaluatedPaths(coverage) {
  if (process.env.CLISTART_BUNDLE) {
    assert.ok(process.env.CLISTART_METAFILE, 'compiled help requires its matching metafile');
    outputs ??= JSON.parse(await readFile(process.env.CLISTART_METAFILE, 'utf8')).outputs;
  }
  const scripts = evaluated(coverage);
  return outputs ? [...new Set(scripts.flatMap(script => {
    const output = Object.entries(outputs).find(([path]) => script.url.endsWith(path.replace(/^(?:\.\.\/)+/u, '')))?.[1];
    return Object.entries(output?.inputs ?? {}).filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path);
  }))] : scripts.map(script => script.url);
}

async function runHelp(argv, home, signal) {
  const tracePath = join(home.env.HAPPIER_TEST_HOME_ROOT, `${argv.join('-')}.json`);
  const child = await execute(process.execPath, [
    '--require', probe,
    ...(process.env.CLISTART_BUNDLE ? [] : ['--import', 'tsx']),
    process.env.CLISTART_BUNDLE ?? join(cliRoot, 'src/index.ts'), ...argv,
  ], {
    cwd: cliRoot,
    env: { ...process.env, ...home.env, HAPPIER_CLI_INVOKER_NAME: 'happier', CLISTART_IMPORT_TRACE: '1', CLISTART_TRACE: tracePath },
    maxBuffer: 8 * 1024 * 1024, signal,
  });
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const paths = await evaluatedPaths(trace.coverage);
  assert.ok(paths.some(path => /apps\/cli\/src\/index\.[jt]s$/u.test(path)), 'the matching source/metafile observes the real CLI entry');
  assert.deepEqual(trace.events.filter(event => event.kind === 'http:request' || event.kind === 'socket:start' && event.transport !== 'ipc'), []);
  return { stdout: child.stdout, paths };
}

// The accepted d012 reference predates help support for these roots. Several
// ignored --help and performed the operation; never invoke those as a fixture.
const rootsWithoutReferenceHelp = new Set(['completion', 'status', 'self-update', 'logout', 'acp-catalog', 'capabilities', 'tools']);

test('manager family help stays outside executable catalogs', { skip: !optedIn }, async t => {
  const metadataHome = isolateHome();
  let managerRoots;
  try {
    // Only the opted-in process suite loads source metadata. The native parent
    // has no Vite setup or product imports; this child inherits a disposable Home.
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const { staticCommandDescriptors } = await import("./src/cli/commandDescriptors.ts");
      const { BUNDLED_ACTION_CLI_COMMAND_PATHS } = await import("./src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts");
      console.log(JSON.stringify([...new Set([
        ...Object.entries(staticCommandDescriptors).filter(([, descriptor]) => descriptor.help).map(([root]) => root),
        ...BUNDLED_ACTION_CLI_COMMAND_PATHS.map(command => command.path[0]),
      ])]));
    `], { cwd: cliRoot, env: { ...process.env, ...metadataHome.env }, signal: t.signal });
    managerRoots = JSON.parse(stdout);
    assert.ok(Array.isArray(managerRoots) && managerRoots.length > 0, 'the canonical descriptors publish manager roots');
  } finally { metadataHome.cleanup(); }
  console.info('family-startup-coverage', JSON.stringify({ roots: managerRoots.length,
    referenceRoots: managerRoots.filter(root => !rootsWithoutReferenceHelp.has(root)).length }));
  for (const root of managerRoots) {
    await t.test(`keeps ${root} family help out of executable catalogs`, { timeout: 30_000 }, async current => {
      const home = isolateHome();
      try {
        const child = await runHelp([root, '--help'], home, current.signal);
        assert.notEqual(child.stdout.trim(), '');
        if (process.env.CLISTART_REFERENCE_BUNDLE && !rootsWithoutReferenceHelp.has(root)) {
          const reference = await execute(process.execPath, [process.env.CLISTART_REFERENCE_BUNDLE, root, '--help'], {
            cwd: cliRoot, env: { ...process.env, ...home.env, HAPPIER_CLI_INVOKER_NAME: 'happier' },
            maxBuffer: 8 * 1024 * 1024, signal: current.signal,
          });
          const currentLines = child.stdout.split('\n');
          const referenceLines = reference.stdout.split('\n');
          const differentLine = currentLines.findIndex((line, index) => line !== referenceLines[index]);
          assert.equal(child.stdout === reference.stdout, true, JSON.stringify({ root, differentLine,
            current: currentLines[differentLine], reference: referenceLines[differentLine] }));
        }
        assert.ok(child.paths.some(path => /apps\/cli\/src\/cli\/familyHelp\.ts(?:\?|$)/u.test(path)), 'the real family help owner executes');
        assert.deepEqual(child.paths.filter(path => /packages\/(?:plugin-sdk|agents|plugins)\/|apps\/cli\/src\/(?:configuration\.ts|providers\/|agent\/catalog\/|plugins\/runtime\/|plugins\/projection\/registry\/createResolvedContributionRegistry|cli\/actions\/(?:commandPresentation|compiledCommands)\.ts)/u.test(path)), []);
      } finally { home.cleanup(); }
    });
  }
});

test('does not evaluate runtime catalogs for source family help', { skip: !process.env.CLISTART_FAMILY_SOURCE_TRACE }, async () => {
  const trace = JSON.parse(await readFile(process.env.CLISTART_FAMILY_SOURCE_TRACE, 'utf8'));
  const urls = evaluated(trace.coverage).map(script => script.url);
  assert.ok(urls.some(path => /apps\/cli\/src\/cli\/commands\/providers\.ts(?:\?|$)/u.test(path)));
  assert.deepEqual(urls.filter(heavy), []);
});

test('renders family help with the same bytes and import boundary as root help', { skip: !optedIn, timeout: 30_000 }, async t => {
  const home = isolateHome();
  try {
    const root = await runHelp(['--help'], home, t.signal);
    assert.deepEqual(root.paths.filter(heavy), []);
    const provider = await runHelp(['provider', '--help'], home, t.signal);
    assert.ok(process.env.CLISTART_FAMILY_HELP_BASELINE, 'provide the accepted provider help bytes');
    assert.equal(provider.stdout, await readFile(process.env.CLISTART_FAMILY_HELP_BASELINE, 'utf8'));
    assert.deepEqual(provider.paths.filter(heavy), []);
  } finally { home.cleanup(); }
});

