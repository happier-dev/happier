import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTestHomePath, createTestHomeEnvironment, installTestHomeEnvironment } from '../../../../scripts/testing/testHomeEnvironment.mjs';

const executeFile = promisify(execFile);
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const cliRoot = join(repo, 'apps/cli');
const probe = fileURLToPath(new URL('./cli-startup-probe.cjs', import.meta.url));
let suiteHome;
let outputs;
after(() => suiteHome?.cleanup());

async function seedInstalledHome({ repo, happyHomeDir, pluginCount }) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { assertTestHomePath } = await import(pathToFileURL(join(repo, 'scripts/testing/testHomeEnvironment.mjs')).href);
  // The child already inherited canonical disposable HOME/config roots before
  // its first product import. Retain the real configuration guard as well.
  const { configuration } = await import('./src/configuration.ts');
  assertTestHomePath(configuration.happyHomeDir);
  assertTestHomePath(happyHomeDir);
  const { PluginManifestV2Schema } = await import('@happier-dev/protocol/plugins/manifest/v2');
  const { createPluginManifestV2Fixture } = await import('./src/plugins/testkit/manifestV2Fixture.ts');
  const { seedCurrentLocalPathPluginFixture } = await import('./src/plugins/store/registry/currentState.testkit.ts');
  for (let index = 0; index < pluginCount; index += 1) {
    const pluginRoot = join(dirname(happyHomeDir), `plugin-${index}`);
    const pluginId = `acme.help-${index}`;
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: pluginId,
      contributes: {
        actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['brief', 'full'] } } } }],
        commands: [{ id: 'read-command', title: 'Read', description: `Read admitted note ${index}`, path: [`admitted-note-${index}`, 'read'], action: 'read' }],
        agents: [{
          id: 'reader', title: `Admitted Agent ${index}`, runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }],
      },
    }));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version, devWatch: true });
  }
}

async function measureInstalledHelp(pluginCount, command = 'help', signal) {
  suiteHome ??= installTestHomeEnvironment();
  const home = createTestHomeEnvironment();
  const happyHomeDir = home.env.HAPPIER_HOME_DIR;
  assertTestHomePath(happyHomeDir, home.env.HAPPIER_TEST_HOME_ROOT);
  const env = { ...process.env, ...home.env };
  try {
    // Genuine admission happens outside the measured cold CLI process, through
    // the same source schema, fixture factory and committed writer as before.
    await executeFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `await (${seedInstalledHome.toString()})(${JSON.stringify({ repo, happyHomeDir, pluginCount })})`,
    ], { cwd: cliRoot, env, maxBuffer: 1024 * 1024, signal });
    const tracePath = join(home.env.HAPPIER_TEST_HOME_ROOT, 'trace.json');
    const coverageDir = join(home.env.HAPPIER_TEST_HOME_ROOT, 'coverage');
    assert.ok(process.env.CLISTART_BUNDLE, 'provide the canonical compiled CLI under test');
    assert.ok(process.env.CLISTART_METAFILE, 'compiled help requires its matching metafile');
    outputs ??= JSON.parse(await readFile(process.env.CLISTART_METAFILE, 'utf8')).outputs;
    const argv = command === 'help' ? ['--help'] : command === 'agents' ? ['agents', 'list', '--json'] : [
      'completion', 'candidates', '--',
      ...(command === 'completion-path' ? ['admitted-note-0', 'r']
        : command === 'completion-enum' ? ['admitted-note-0', 'read', '--format', 'b']
          : ['admitted-note-']),
    ];
    const { stdout } = await executeFile(process.execPath, ['--require', probe, process.env.CLISTART_BUNDLE, ...argv], {
      cwd: cliRoot,
      // Native V8 counts observe actual calls without instrumenting a TS loader.
      env: { ...env, NODE_V8_COVERAGE: coverageDir, CLISTART_IMPORT_TRACE: '0', CLISTART_TRACE: tracePath },
      maxBuffer: 1024 * 1024, signal,
    });
    if (process.env.CLISTART_REFERENCE_BUNDLE) {
      const reference = await executeFile(process.execPath, [process.env.CLISTART_REFERENCE_BUNDLE, ...argv], {
        cwd: cliRoot, env, maxBuffer: 1024 * 1024, signal,
      });
      assert.equal(stdout, reference.stdout);
    }
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    assert.deepEqual(trace.events.filter(event => event.kind === 'http:request' || event.kind === 'socket:start' && event.transport !== 'ipc'), []);
    const coverage = (await Promise.all((await readdir(coverageDir)).map(async file => (
      JSON.parse(await readFile(join(coverageDir, file), 'utf8'))
    )))).flatMap(report => report.result);
    const evaluated = coverage.filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)));
    const paths = [...new Set(evaluated.flatMap(script => {
      const output = Object.entries(outputs).find(([path]) => script.url.endsWith(path.replace(/^(?:\.\.\/)+/u, '')))?.[1];
      return Object.entries(output?.inputs ?? {}).filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path);
    }))];
    assert.ok(paths.some(path => /apps\/cli\/src\/index\.ts$/u.test(path)), 'the matching metafile observes the real CLI entry');
    const validationCalls = evaluated.reduce((total, script) => total + script.functions.filter(fn => (
      /[/\\]zod[/\\]/u.test(script.url) || (!script.url.startsWith('node:') && /(?:parse|safeParse|refine|validate)/iu.test(fn.functionName))
    )).reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0), 0);
    const fullValidationCalls = evaluated.flatMap(script => script.functions).filter(fn => (
      /^(?:ingestPluginManifestV2|resolvePluginManifestSetReferencesV2|readInstallationStateRevision|readPluginRegistryCommitInstallationAuthority)$/u.test(fn.functionName)
    )).reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
    const fullValidationOwners = paths.filter(path => /plugins[/\\](?:manifest[/\\](?:ingest|v2)|store[/\\]registry[/\\](?:generationStore|currentState))\.[cm]?[jt]s(?:\?|$)/u.test(path));
    const bodyReads = trace.events.filter(event => event.kind === 'readFile:start').map(event => event.path);
    console.info('admitted-listing-cost', JSON.stringify({
      command, pluginCount, evaluatedScripts: evaluated.length, validationCalls, fullValidationCalls, bodyReads: bodyReads.length,
    }));
    return { helpText: stdout, evaluatedScriptCount: evaluated.length, validationCalls, fullValidationCalls, fullValidationOwners, bodyReads };
  } finally { home.cleanup(); }
}

function assertConstantValidation(single, several) {
  assert.equal(single.fullValidationCalls, 0, JSON.stringify({ single: single.fullValidationCalls, several: several.fullValidationCalls }));
  assert.equal(several.fullValidationCalls, 0);
  assert.equal(several.validationCalls, single.validationCalls);
  assert.equal(several.evaluatedScriptCount, single.evaluatedScriptCount);
}

test('reads compiled installed help with constant validation work and no live-source reads', { skip: !process.env.CLISTART_BUNDLE, timeout: 180_000 }, async t => {
  const single = await measureInstalledHelp(1, 'help', t.signal);
  const several = await measureInstalledHelp(4, 'help', t.signal);
  assert.ok(single.helpText.includes('Read admitted note 0'));
  assert.ok(several.helpText.includes('Read admitted note 3'));
  assertConstantValidation(single, several);
  assert.deepEqual(single.fullValidationOwners, []);
  assert.deepEqual(several.fullValidationOwners, []);
  for (const measured of [single, several]) {
    assert.equal(measured.bodyReads.length, 2);
    assert.ok(measured.bodyReads.every(path => /plugin-registry-current\.v1\.json$|plugin-installations\.v1\.json$/u.test(path)));
  }
});

test('reads compiled static completion without whole-manifest validation', { skip: !process.env.CLISTART_BUNDLE, timeout: 180_000 }, async t => {
  const single = await measureInstalledHelp(1, 'completion', t.signal);
  const several = await measureInstalledHelp(4, 'completion', t.signal);
  assert.deepEqual(single.helpText.trim().split('\n'), ['admitted-note-0']);
  assert.deepEqual(several.helpText.trim().split('\n'), ['admitted-note-0', 'admitted-note-1', 'admitted-note-2', 'admitted-note-3']);
  assertConstantValidation(single, several);
  assert.equal(single.bodyReads.length, several.bodyReads.length);
  assert.ok(several.bodyReads.every(path => !/plugin\.json$|ui-artifacts/u.test(path)));
});

test('reads compiled Agent listing without whole-manifest validation', { skip: !process.env.CLISTART_BUNDLE, timeout: 180_000 }, async t => {
  const single = await measureInstalledHelp(1, 'agents', t.signal);
  const several = await measureInstalledHelp(4, 'agents', t.signal);
  assert.deepEqual(JSON.parse(several.helpText).data.agents.find(row => row.id === 'acme.help-3/reader'), {
    id: 'acme.help-3/reader', title: 'Admitted Agent 3', installed: false, source: null, command: null,
  });
  assertConstantValidation(single, several);
  assert.equal(single.bodyReads.length, several.bodyReads.length);
  assert.ok(several.bodyReads.every(path => !/plugin\.json$|ui-artifacts/u.test(path)));
});

for (const [command, expected] of [['completion-path', 'read'], ['completion-enum', 'brief']]) {
  test(`reads compiled ${command} from admitted declarations`, { skip: !process.env.CLISTART_BUNDLE, timeout: 180_000 }, async t => {
    const single = await measureInstalledHelp(1, command, t.signal);
    const several = await measureInstalledHelp(4, command, t.signal);
    assert.equal(single.helpText.trim(), expected);
    assert.equal(several.helpText, single.helpText);
    assertConstantValidation(single, several);
    assert.equal(single.bodyReads.length, several.bodyReads.length);
    assert.ok(several.bodyReads.every(path => !/plugin\.json$|ui-artifacts/u.test(path)));
  });
}

