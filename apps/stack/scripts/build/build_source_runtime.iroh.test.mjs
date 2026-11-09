import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture } from '../testkit/core/source_runtime_fixture.mjs';
import { buildSourceRuntimeBundle, setBundleReadOnly } from './build_source_runtime.mjs';

test('source runtimes retain their captured Iroh addon and change identity with Rust inputs',
  { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-iroh-', registerCleanup: false });
  t.after(async () => { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  const iroh = join(repoDir, 'packages/iroh-native');
  for (const path of ['sources', 'scripts', 'node_modules']) await mkdir(join(server, path), { recursive: true });
  await mkdir(iroh, { recursive: true });
  for (const path of ['src', 'scripts', 'package.json', 'rust-toolchain.toml']) {
    await cp(join(sourceRoot, 'packages/iroh-native', path), join(iroh, path), { recursive: true });
  }
  await cp(join(sourceRoot, 'packages/protocol'), join(repoDir, 'packages/protocol'),
    { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|dist|\.tsrs)(?:[/\\]|$)/.test(path) });
  // These Rust bytes stand at the Cargo boundary; all source capture, esbuild
  // plugins, loader resolution and actual native module loading stay real.
  await mkdir(join(iroh, 'rust/happier-iroh-core/src'), { recursive: true });
  const rustSource = join(iroh, 'rust/happier-iroh-core/src/lib.rs');
  await writeFile(rustSource, 'pub const MARKER: &str = "A";');
  await writeFile(join(iroh, 'rust/Cargo.toml'), '[workspace]\nmembers = ["happier-iroh-core"]\n');
  await writeFile(join(iroh, 'rust/Cargo.lock'), '# captured lock\n');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module',
    dependencies: { '@happier-dev/iroh-native': 'workspace:*' } }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await writeFile(join(server, 'sources/main.light.ts'), `
    import { loadIrohNodeNativeAddon, resolveIrohNodeAddonPath } from '@happier-dev/iroh-native/node';
    export const addonPath = resolveIrohNodeAddonPath();
    export const marker = loadIrohNodeNativeAddon(addonPath).getAvailability();
  `);
  const { symlink } = await import('node:fs/promises');
  await symlink(join(sourceRoot, 'node_modules'), join(repoDir, 'node_modules'), 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'), 'dir');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const bin = fixture.path('cargo-bin');
  await mkdir(bin);
  const exportsSource = await readFile(join(iroh, 'src/nodeNative.types.ts'), 'utf8');
  const names = [...exportsSource.match(/IROH_NODE_NATIVE_EXPORTS = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  await writeFile(join(bin, 'cargo'), `#!${process.execPath}
    const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
    const args = process.argv.slice(2);
    const crate = args[args.indexOf('--manifest-path') + 1];
    const root = path.resolve(path.dirname(crate), '../..');
    const marker = fs.readFileSync(path.join(root, 'rust/happier-iroh-core/src/lib.rs'), 'utf8').match(/"([AB])"/)[1];
    const target = args[args.indexOf('--target') + 1];
    const output = path.join(process.env.CARGO_TARGET_DIR, target, args.includes('--release') ? 'release' : 'debug');
    fs.appendFileSync(path.join(__dirname, 'targets.jsonl'), JSON.stringify(process.env.CARGO_TARGET_DIR) + '\\n');
    fs.mkdirSync(output, {recursive:true});
    const c = path.join(output, 'addon.c');
    fs.writeFileSync(c, 'typedef void* V; typedef int S; extern S napi_create_string_utf8(V,const char*,unsigned long,V*); extern S napi_create_function(V,const char*,unsigned long,V(*)(V,V),void*,V*); extern S napi_set_named_property(V,V,const char*,V); static V marker(V e,V i){V v;napi_create_string_utf8(e,"'+marker+'",1,&v);return v;} V napi_register_module_v1(V e,V exports){V f;' +
      ${JSON.stringify(names)}.map(name => 'napi_create_function(e,"'+name+'",'+name.length+',marker,0,&f);napi_set_named_property(e,exports,"'+name+'",f);').join('') + 'return exports;}');
    const lib = path.join(output, process.platform === 'darwin' ? 'libhappier_iroh_node.dylib' : 'libhappier_iroh_node.so');
    const result = cp.spawnSync('cc', process.platform === 'darwin' ? ['-dynamiclib','-undefined','dynamic_lookup',c,'-o',lib] : ['-shared','-fPIC',c,'-o',lib], {stdio:'inherit'});
    process.exit(result.status ?? 1);
  `);
  await chmod(join(bin, 'cargo'), 0o755);
  const env = { ...(native?.env ?? process.env), PATH: `${bin}:${native?.env.PATH ?? process.env.PATH}` };
  const build = native?.build ?? buildSourceRuntimeBundle;
  const first = await build({ repoDir, outputDir: fixture.path('first'), component: 'server', env });
  const loaded = await import(pathToFileURL(first.entrypoint));
  assert.equal(loaded.marker, 'A');
  assert.ok(loaded.addonPath.startsWith(first.runtimeDir), 'the actual loader must resolve retained output');
  const cargoTargets = async () => (await readFile(join(bin, 'targets.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const [firstTarget] = await cargoTargets();
  assert.ok(!firstTarget.startsWith(repoDir + '/'), 'Cargo intermediates must stay outside the watched checkout');
  assert.ok(firstTarget.startsWith(fixture.root + '/'), 'the runtime output owner retains and cleans its Cargo cache');
  const warm = await build({ repoDir, outputDir: fixture.path('warm'), component: 'server', env });
  assert.equal((await cargoTargets())[1], firstTarget, 'identical captured inputs reuse the same external Cargo partition');
  assert.equal((await import(pathToFileURL(warm.entrypoint))).marker, 'A');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const firstDigest = digest(await readFile(loaded.addonPath));
  await mkdir(join(iroh, 'native'), { recursive: true });
  await writeFile(join(iroh, 'native', `happier-iroh-native-lifecycle.${process.platform}-${process.arch}.node`), 'changed live output');
  await writeFile(rustSource, 'pub const MARKER: &str = "B";');
  const evaluate = async built => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
    `const loaded = await import(${JSON.stringify(pathToFileURL(built.entrypoint).href)}); console.log(JSON.stringify({marker:loaded.marker,addonPath:loaded.addonPath}));`])).stdout);
  assert.equal((await evaluate(first)).marker, 'A', 'a fresh process still loads the old captured addon');
  assert.equal(digest(await readFile(loaded.addonPath)), firstDigest);
  const second = await build({ repoDir, outputDir: fixture.path('second'), component: 'server', env });
  assert.notEqual((await cargoTargets()).at(-1), firstTarget, 'changed Rust inputs use another cache partition');
  const next = await evaluate(second);
  assert.equal(next.marker, 'B');
  assert.notEqual(first.identity, second.identity);
  assert.notEqual(firstDigest, digest(await readFile(next.addonPath)));
  const record = JSON.parse(await readFile(join(fixture.path('second'), 'source-bundle.json'), 'utf8'));
  assert.equal(record.sourceInputDigests['packages/iroh-native/rust/happier-iroh-core/src/lib.rs'], digest(await readFile(rustSource)));
  assert.ok(record.sourceInputDigests['packages/iroh-native/rust-toolchain.toml']);
  assert.equal(Object.keys(record.sourceInputDigests).some(path => path.startsWith('packages/iroh-native/native/')), false);
});
