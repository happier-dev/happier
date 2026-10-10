import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { run } from '../utils/proc/proc.mjs';
import { exportSourceWebUi } from './build_source_web_ui.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';

test('source web export uses fresh private source projections and one-shot origin-relative Expo output', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-source-web-ui-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const baseDir = join(scratch, 'expo-state');
  const outputDir = join(scratch, 'export');
  let expectedOutputDir = outputDir;
  const exportInputs = [];
  const env = { ...process.env, EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://moving-producer.invalid' };
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR;
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY;
  let exportCalls = 0;
  // Expo is the external process boundary. Source preparation and its entire
  // first-party compiler/generator graph remain real beneath this boundary.
  const runImpl = async (command, args, options) => {
    if (args[0] !== 'export') return run(command, args, options);
    exportCalls += 1;
    assert.equal(options.env.CI, '1');
    assert.equal(options.env.EXPO_PUBLIC_HAPPIER_SERVER_URL, '');
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const children = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' });
      const residentEsbuild = children.split('\n').filter(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        return row && Number(row[2]) === process.pid && !row[3].startsWith('Z')
          && /(?:^|[/\\])esbuild(?:\.exe)?$/.test(row[4]);
      });
      assert.deepEqual(residentEsbuild, [], 'source preparation must release its esbuild service before Expo starts');
    }
    const inventory = await readFile(options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
    assert.match(inventory, /happier\.channels/);
    assert.match(inventory, /happier\.posthog/);
    assert.match(inventory, /happier\.triage/);
    assert.ok(inventory.includes(expectedOutputDir));
    const uiDir = args[args.indexOf('--output-dir') + 1];
    exportInputs.push({ tmpDir: options.env.TMPDIR,
      inventoryPath: options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, uiDir });
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><script src="./app.js"></script></html>');
    await writeFile(join(uiDir, 'app.js'), `globalThis.ready = ${exportCalls};\n`.repeat(300));
  };
  const result = await exportSourceWebUi({ repoDir, baseDir, outputDir, env, runImpl });
  assert.equal(exportCalls, 1);
  assert.equal(result.uiDir, join(outputDir, 'web'));
  assert.equal(result.entrypoint, 'index.html');
  await assert.rejects(access(join(result.uiDir, 'node_modules')), { code: 'ENOENT' });
  const inputs = Object.keys(JSON.parse(await readFile(join(outputDir, 'tools/metafile.json'), 'utf8')).inputs);
  assert.equal(inputs.some((input) => /(?:^|\/)packages\/.*\/dist\//.test(input)), false);
  assert.ok(inputs.some((input) => input.includes('plugins/channels/src/manifest.ts')));
  const firstBytes = await readFile(join(result.uiDir, 'app.js'), 'utf8');
  assert.equal(brotliDecompressSync(await readFile(join(result.uiDir, 'app.js.br'))).toString(), firstBytes);
  assert.equal(gunzipSync(await readFile(join(result.uiDir, 'app.js.gz'))).toString(), firstBytes);
  expectedOutputDir = join(scratch, 'second-export');
  const second = await exportSourceWebUi({ repoDir, baseDir, outputDir: expectedOutputDir, env, runImpl });
  assert.equal(exportCalls, 2);
  assert.equal(exportInputs[0].tmpDir, exportInputs[1].tmpDir,
    'explicit rebuilds must preserve the canonical Expo cache directory');
  assert.ok(exportInputs[0].tmpDir.startsWith(baseDir));
  assert.notEqual(exportInputs[0].inventoryPath, exportInputs[1].inventoryPath);
  assert.notEqual(result.uiDir, second.uiDir);
  assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), firstBytes);
  assert.notEqual(await readFile(join(second.uiDir, 'app.js'), 'utf8'), firstBytes);
  await assert.rejects(exportSourceWebUi({ repoDir, baseDir, outputDir }), { code: 'EEXIST' });
});

test('source web export separately admits its external Expo command after preparation',
  { skip: process.platform !== 'linux', timeout: 30000 }, async (context) => {
    const fixture = await createTempFixture(context, { prefix: 'happier-source-expo-admission-' });
    const native = await installNativeAdmissionFixture({ root: fixture.root });
    const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
    const outputDir = fixture.path('export');
    const available = fixture.path('available-memory');
    const lowMemoryObserved = fixture.path('low-memory-observed');
    const executed = fixture.path('expo-executed');
    await writeFile(available, '16777216');
    await mkdir(fixture.path('bin'));
    await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf 'observed' > '${lowMemoryObserved}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
    await chmod(fixture.path('bin/awk'), 0o755);
    const expo = fixture.path('bin/expo');
    const expoScript = fixture.path('expo.mjs');
    await writeFile(expo, `#!/bin/sh\nexec '${process.execPath}' '${expoScript}' "$@"\n`);
    await chmod(expo, 0o755);
    await writeFile(expoScript, `
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=${JSON.stringify(native.admissionRoot)};
const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
const owner=token && join(root,'owners',token.replace(':','-'));
writeFileSync(${JSON.stringify(executed)},JSON.stringify({className:owner ? readFileSync(join(owner,'class'),'utf8').trim() : null, owners:readdirSync(join(root,'owners')).length,cwd:process.cwd()}));
const output=process.argv[process.argv.indexOf('--output-dir')+1];
mkdirSync(output);writeFileSync(join(output,'index.html'),'<!doctype html><script src="./app.js"></script>');
writeFileSync(join(output,'app.js'),'globalThis.ready=true;');
`);
    const adapter = fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
    await copyFile(fileURLToPath(new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url)), adapter);
    const commandBoundary = fixture.path('expo-command.mjs');
    // Mock only installed executable lookup and physical OS memory. Public
    // orchestration, preparation, admission and the external process stay real.
    await writeFile(commandBoundary, `
export {prepareExpoCommandEnv,applyExpoExportMaxWorkersArgs} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
export async function resolveExpoBin() { await writeFile(${JSON.stringify(available)},'5242880'); return ${JSON.stringify(expo)}; }
`);
    const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
    const publicOwner = fixture.path('public-source-web-ui.mjs');
    const source = (await readFile(sourceUrl, 'utf8')).replace(/from '(\.[^']+)'/g, (_match, specifier) => {
      const url = specifier === '../utils/proc/runSourceBuildCommand.mjs' ? pathToFileURL(adapter)
        : specifier === '../utils/expo/command.mjs' ? pathToFileURL(commandBoundary) : new URL(specifier, sourceUrl);
      return `from ${JSON.stringify(url.href)}`;
    });
    await writeFile(publicOwner, source);
    const { exportSourceWebUi: exportWithOsFixture } = await import(pathToFileURL(publicOwner));
    const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete env[key];
    await mkdir(join(native.admissionRoot, 'waiters'), { recursive: true });
    await mkdir(join(native.admissionRoot, 'owners'), { recursive: true });
    const watcher = watch(join(native.admissionRoot, 'waiters'));
    context.after(() => watcher.close());
    const pressureWatcher = watch(fixture.root);
    context.after(() => pressureWatcher.close());
    const observedPressure = new Promise((resolve, reject) => {
      pressureWatcher.on('error', reject);
      pressureWatcher.on('change', (_event, filename) => {
        if (filename === 'low-memory-observed') { pressureWatcher.close(); resolve(); }
      });
    });
    const queued = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', async () => {
        try {
          if ((await readFile(available, 'utf8')) === '5242880'
            && (await readdir(join(native.admissionRoot, 'waiters'))).length) {
            watcher.close();
            resolve('queued');
          }
        } catch (error) { reject(error); }
      });
    });
    const pending = exportWithOsFixture({ repoDir, baseDir: fixture.path('expo-state'), outputDir, env });
    assert.equal(await Promise.race([queued, pending.then(() => 'finished')]), 'queued',
      'Expo must wait for host memory rather than execute outside admission');
    await observedPressure;
    await assert.rejects(access(executed), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), [], 'preparation reservation was released');
    await writeFile(available, '16777216');
    await pending;
    assert.deepEqual(JSON.parse(await readFile(executed, 'utf8')),
      { className: 'validation', owners: 1, cwd: join(repoDir, 'apps/ui') });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  });
