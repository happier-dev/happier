import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm, access, readdir, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSourceRuntimeBundle } from './build_source_runtime.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runServerRuntimeMigration } from '../runtime/launch/runServerRuntimeMigration.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { matchesNativeTypeScriptInputVersion, resolveTypeScriptCliInvocation } from '../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

async function linkCanonicalServerWorkspace(repoDir) {
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  // The real migration owner imports real workspace packages. Preserve that
  // source graph rather than replacing its internal dependencies with fixtures.
  for (const directory of ['packages', 'node_modules']) {
    await symlink(join(canonicalRepo, directory), join(repoDir, directory),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
}

async function makeFixtureWritable(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (entry.isDirectory()) await makeFixtureWritable(join(directory, entry.name));
    else if (!entry.isSymbolicLink()) await chmod(join(directory, entry.name), 0o644);
  }
}

test('native author input versions accept settled text and refuse changed bytes', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-native-author-input-'});
  const texts = ['export const marker = "ascii";\n', 'export const marker = "雪😀";\n',
    '\uFEFFexport const marker = "BOM";\r\n',
    await readFile(fileURLToPath(new URL('../../../../packages/plugin-sdk/src/index.ts', import.meta.url)), 'utf8')];
  await mkdir(fixture.path('src'));
  for (const [index, text] of texts.entries()) await writeFile(fixture.path(`src/vector${index}.ts`), text);
  const project = fixture.path('tsconfig.json');
  await writeFile(project, JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',
    incremental:true,noResolve:true,noCheck:true,declaration:true,rootDir:'src',outDir:'emitted',
    tsBuildInfoFile:'build.tsbuildinfo'},include:['src/*.ts']}));
  const args = ['-p',project];
  const invocation = resolveTypeScriptCliInvocation({args,admissionClass:'source-bundle'});
  await promisify(execFile)(invocation.command, [...invocation.argsPrefix,...args]);
  const info = JSON.parse(await readFile(fixture.path('build.tsbuildinfo'), 'utf8'));
  for (const [index,text] of texts.entries()) {
    const sourceIndex = info.fileNames.findIndex(path => path.endsWith(`/src/vector${index}.ts`));
    assert.notEqual(sourceIndex, -1);
    const fileInfo = info.fileInfos[sourceIndex];
    const version = typeof fileInfo === 'string' ? fileInfo : fileInfo.version;
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(text), version), true);
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(`${text}\n// changed`), version), false,
      'a graph consumed from different bytes must not be reused under restored source');
  }
});

test('source daemon owns a usable public author SDK closure without workspace dist', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-author-sdk-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const sdkDir = join(repoDir, 'packages/plugin-sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'), join(sdkDir, 'src'),
    join(protocolDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
    await mkdir(directory, {recursive:true});
  }
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module',
    dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},
    bundledDependencies:['@happier-dev/plugin-sdk','@happier-dev/protocol'], exports:{}}));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  for (const [name, directory] of [['plugin-sdk', sdkDir], ['protocol', protocolDir]]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({name:`@happier-dev/${name}`,version:'0.0.0',type:'module',
      main:'./dist/index.js',types:'./dist/index.d.ts',
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      ...(name === 'plugin-sdk' ? {happier:{publicSdkRelease:{posture:'developer_preview'}},
        imports:{'#author-value':{'happier-source':'./src/authorValue.ts',default:'./dist/authorValue.js'}},
        dependencies:{'@happier-dev/protocol':'0.0.0','author-external':'1.0.0'},bundledDependencies:['@happier-dev/protocol']} : {})}));
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true,
      ...(name === 'plugin-sdk' ? {paths:{'#author-value':['./src/authorValue.ts']}} : {})},include:['src/**/*.ts']}));
    await symlink(directory, join(repoDir, 'node_modules/@happier-dev', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "current-source";');
  await mkdir(join(protocolDir, 'dist'));
  await writeFile(join(protocolDir, 'dist/index.js'), 'export const marker = "stale-dist";');
  await writeFile(join(protocolDir, 'dist/index.d.ts'), 'export declare const marker: "stale-dist";');
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), {recursive:true});
  await cp(join(protocolDir, 'package.json'), join(shadowProtocolDir, 'package.json'));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), 'export const marker = "stale-installed-source";');
  // A third-party package may legitimately own dist declarations beneath a
  // workspace's node_modules. These are compiler inputs, not first-party code.
  const externalDir = join(sdkDir, 'node_modules/author-external');
  await mkdir(join(externalDir, 'dist'), {recursive:true});
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',types:'./dist/index.d.ts'}));
  await writeFile(join(externalDir, 'dist/index.d.ts'), 'export declare function createAuthorValue(value: string): { value: string };');
  await writeFile(join(externalDir, 'dist/index.js'), 'export function createAuthorValue(value) { return {value}; }');
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',main:'./dist/index.js',types:'./dist/index.d.ts'}));
  await writeFile(join(sdkDir, 'src/authorValue.ts'), 'export const authorValue = "package-alias";');
  await writeFile(join(sdkDir, 'src/index.ts'), "/// <reference path='../node_modules/author-external/dist/index.d.ts' />\nimport {marker} from '@happier-dev/protocol';\nexport {marker};\nexport const canonicalMarker = marker;\nimport {authorValue} from '#author-value';\nexport const canonicalAlias = authorValue;\nimport {createAuthorValue} from 'author-external';\nexport function echo(value: string) { return createAuthorValue(value).value; }\n");
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const compilerCommands = fixture.path('author-compiler-commands.jsonl');
  const compilerObserver = fixture.path('observe-author-compiler.mjs');
  // Observe the real OS launch without replacing compiler or domain logic.
  // Native parallel checkers replicate the declaration graph per host CPU.
  await writeFile(compilerObserver, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    import {appendFileSync,readFileSync} from 'node:fs';
    const childProcess=createRequire(import.meta.url)('node:child_process');
    const spawn=childProcess.spawn;
    childProcess.spawn=function(command,args,...options) {
      const child=spawn.call(this,command,args,...options);
      if (args?.includes('--noCheck') && args.some(arg=>arg.endsWith('tsconfig.dist.json')))
        child.once('exit',code=>{
          if (code !== 0) return;
          const info=JSON.parse(readFileSync(args[args.indexOf('--tsBuildInfoFile')+1],'utf8'));
          appendFileSync(${JSON.stringify(compilerCommands)},JSON.stringify({args,files:info.fileNames})+'\\n');
        });
      return child;
    };
    syncBuiltinESMExports();
  `);
  const env = {...process.env,
    NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(compilerObserver).href}`.trim()};
  const stackBaseDir = fixture.path('stacks/author');
  const runtime = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  const authorCommands = (await readFile(compilerCommands, 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(authorCommands.length > 0, 'the real public author compiler was observed');
  for (const {args} of authorCommands) assert.ok(args.includes('--singleThreaded'),
    'author declaration emission must not replicate its checker graph with host CPU count');
  const sdkCompiler = authorCommands.find(({args})=>args.some(arg=>arg.replaceAll('\\','/').includes('/plugin-sdk/tsconfig.dist.json')));
  assert.ok(sdkCompiler, 'the SDK declaration compiler was observed');
  assert.equal(sdkCompiler.files.some(path=>path.replaceAll('\\','/').endsWith('/protocol/src/index.ts')), false,
    'dependent author packages must consume the already emitted current-source declaration, not re-emit its source');
  const record = JSON.parse(await readFile(join(runtime.runtimeDir, '../../source-bundle.json'), 'utf8'));
  const sdkInput = Object.entries(record.sourceInputDigests).find(([path]) => path.endsWith('packages/plugin-sdk/src/index.ts'));
  assert.match(sdkInput?.[1], /^[a-f0-9]{64}$/,
    'settled compiler source bytes must remain eligible for normal source-bundle reuse');
  assert.equal(Object.keys(record.sourceInputDigests).some(path => path.includes('node_modules/@happier-dev/protocol/')), false,
    'author declarations must resolve canonical workspace source rather than a stale installed shadow');
  const warm = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon'});
  assert.equal(warm.entrypoint, runtime.entrypoint, 'settled public author closure reuses the existing source bundle');
  // The running source CLI must serve the real public resolver without looking
  // for a repository around the emitted runtime or reopening its moving input.
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const resolverUrl = pathToFileURL(join(canonicalRepo, 'apps/cli/src/plugins/authoring/hostSdkResolution.ts')).href;
  const {stdout} = await promisify(execFile)(process.execPath, ['--import',
    pathToFileURL(join(canonicalRepo, 'packages/cli-common/registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', `import {resolveHostPluginSdkPackageRoot} from ${JSON.stringify(resolverUrl)};
      console.log(resolveHostPluginSdkPackageRoot({runtimeModuleUrl:${JSON.stringify(pathToFileURL(runtime.entrypoint).href)}}));`],
    {cwd:join(canonicalRepo, 'apps/cli'), env:{...process.env,...runtime.env}});
  const sdkRoot = stdout.trim();
  assert.equal(relative(await realpath(runtime.runtimeDir), sdkRoot).startsWith('..'), false);
  const declarations = await readFile(join(sdkRoot, 'dist/index.d.ts'), 'utf8');
  assert.match(declarations, /echo\(value: string\): string/);
  assert.match(declarations, /canonicalMarker = "current-source"/);
  assert.match(declarations, /canonicalAlias = "package-alias"/);
  const nestedRuntime = await buildSourceRuntimeBundle({repoDir, outputDir:join(cliDir, '.source-output'), component:'daemon'});
  assert.match(await readFile(join(nestedRuntime.runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk/dist/index.d.ts'), 'utf8'),
    /canonicalMarker = "current-source"/, 'private current-build declarations remain valid even when output is inside the checkout');
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "moving-source";');
  const author = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
  assert.equal(author.marker, 'current-source');
  assert.equal(author.echo('author-value'), 'author-value');
  assert.equal(author.canonicalAlias, 'package-alias');
  await assert.rejects(access(join(sdkDir, 'dist')), {code:'ENOENT'});
  assert.match(await readFile(join(protocolDir, 'dist/index.js'), 'utf8'), /stale-dist/);
  await writeFile(join(sdkDir, 'src/index.ts'), "export {marker} from '../../protocol/dist/index.js';");
  await assert.rejects(buildSourceRuntimeBundle({repoDir,stackBaseDir,component:'daemon'}),
    /Source preparation failed \(exit 1\)/);
});

for (const consumed of [false, true]) {
  test(`moving source preparation succeeds when an ${consumed ? 'actually consumed' : 'unconsumed'} input changes without caching it under stale source`, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-moving-source-', registerCleanup:false});
    context.after(async () => {
      await makeFixtureWritable(fixture.root);
      await rm(fixture.root, {recursive:true, force:true});
    });
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, {recursive:true});
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module', exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    const original = 'export const ready = 1;';
    const entry = join(cliDir, 'src/index.ts');
    const changedFile = consumed ? entry : join(cliDir, 'src/unconsumed.ts');
    await writeFile(entry, original);
    await writeFile(changedFile, original);
    const builds = fixture.path('builds');
    // The real entry-discovery transform runs after cache admission and before
    // esbuild reads the graph. Its fixture edits exactly once, with no timers.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
      if (!existsSync(${JSON.stringify(builds)})) writeFileSync(${JSON.stringify(changedFile)},'export const ready = 2;');
      appendFileSync(${JSON.stringify(builds)},'built\\n');
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const env = {...process.env};
    if (consumed) {
      const observer = fixture.path('observe-read.mjs');
      // Observe real filesystem IO: return the bytes actually read, then model
      // an editor undo before preparation finishes. No bundler/domain mock.
      await writeFile(observer, `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        const fs=createRequire(import.meta.url)('node:fs/promises');
        const read=fs.readFile;
        const physicalEntry=await fs.realpath(${JSON.stringify(entry)});
        fs.readFile=async (...args)=>{
          const contents=await read(...args);
          if ((String(args[0])===${JSON.stringify(entry)} || String(args[0])===physicalEntry) && String(contents)==='export const ready = 2;')
            await fs.writeFile(${JSON.stringify(entry)},${JSON.stringify(original)});
          return contents;
        };
        syncBuiltinESMExports();
      `);
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim();
    }
    const stackBaseDir = fixture.path('stacks/consumer');
    const first = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(first.entrypoint))).ready, consumed ? 2 : 1);
    if (consumed) assert.equal(await readFile(entry, 'utf8'), original,
      'the editor undo occurred after the consumed bytes were read, before completion');
    const graph = JSON.parse(await readFile(join(first.runtimeDir, 'metafile.json'), 'utf8'));
    assert.equal(Object.keys(graph.inputs).includes('apps/cli/src/unconsumed.ts'), false);
    // Restoring the initial source must not adopt a result that consumed the
    // intervening bytes. Simply removing the old rejection fails this check.
    await writeFile(changedFile, original);
    const second = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(second.entrypoint))).ready, 1);
    if (consumed) assert.notEqual(first.identity, second.identity);
    else assert.equal(first.identity, second.identity, 'unconsumed edits cannot change emitted code identity');
    const stable = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal(stable.entrypoint, second.entrypoint, 'settled inputs retain warm reuse');
    assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 2);
  });
}

test('concurrent stacks share one read-only source bundle and retain selected bundles across source changes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-source-dedupe-'));
  let live;
  context.after(async () => {
    if (live && live.exitCode === null) {
      const retired = new Promise(resolve => live.once('exit', resolve));
      live.kill();
      await retired;
    }
    await makeFixtureWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const repoDir = join(root, 'repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locatorDir, { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const builds = join(root, 'builds');
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(builds)}, 'built\\n'); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  const stacks = [join(root, 'stacks/a'), join(root, 'stacks/b')];
  const script = `import {buildSourceRuntimeBundle} from ${JSON.stringify(new URL('./build_source_runtime.mjs', import.meta.url).href)}; console.log(JSON.stringify(await buildSourceRuntimeBundle({repoDir:process.argv[1],stackBaseDir:process.argv[2],component:'daemon'})));`;
  const results = await Promise.all(stacks.map(async stackBaseDir => {
    const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir, stackBaseDir]);
    return JSON.parse(stdout);
  }));
  assert.equal(results[0].entrypoint, results[1].entrypoint);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(results[0].entrypoint)).mode & 0o222, 0);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const unchanged = await buildSourceRuntimeBundle({repoDir, stackBaseDir:stacks[0], component:'daemon'});
  assert.equal(unchanged.entrypoint, results[0].entrypoint, 'content, not write time, owns reuse');
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 2;');
  const recovered = await buildSourceRuntimeBundle({repoDir, stackBaseDir: stacks[0], component:'daemon', reuseSelected:true});
  assert.equal(recovered.entrypoint, results[0].entrypoint, 'in-run recovery keeps the selected emitted graph despite moving source');
  assert.equal(recovered.identity, results[0].identity);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  const second = await buildSourceRuntimeBundle({repoDir, stackBaseDir: stacks[0], component:'daemon'});
  assert.notEqual(second.entrypoint, results[0].entrypoint);
  await access(results[0].entrypoint); // Other stack still selects this bundle.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 3; console.log("ready"); setInterval(()=>{},1000);');
  const third = await buildSourceRuntimeBundle({repoDir, stackBaseDir: stacks[0], component:'daemon'});
  if (process.platform === 'win32') await access(second.entrypoint); // No authoritative process observation: retain.
  else await assert.rejects(access(second.entrypoint), {code:'ENOENT'});
  await access(results[0].entrypoint);
  await access(third.entrypoint);
  await assert.rejects(buildSourceRuntimeBundle({repoDir, stackBaseDir: join(root, 'stacks/unselected'), component:'daemon', reuseSelected:true}),
    /selected source daemon bundle.*unavailable/i, 'recovery cannot silently build current source when selection is missing');
  assert.equal((await readdir(join(root, 'stacks/source-bundles'))).filter(name => name.startsWith('bundle-')).length, process.platform === 'win32' ? 3 : 2);
  live = spawn(process.execPath, [third.entrypoint], {env:{...process.env,...third.env},stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject) => { live.once('error',reject);live.stdout.once('data',resolve); });
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 4;');
  const fourth = await buildSourceRuntimeBundle({repoDir, stackBaseDir:stacks[0], component:'daemon'});
  await access(third.entrypoint); // Live runtime retains its old launch independently of selection.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const readopted = await buildSourceRuntimeBundle({repoDir, stackBaseDir:stacks[0], component:'daemon'});
  assert.equal(readopted.entrypoint, results[0].entrypoint);
  await access(fourth.entrypoint); // The newest built bundle survives adopting an older selected bundle.
});

test('one-shot source builds retire their real preparation process after success and failure', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-service-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  await linkCanonicalServerWorkspace(repoDir);
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  await mkdir(join(serverDir, 'scripts'));
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url)))};`);
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  // Observe the real OS process boundary in an isolated host so no other build
  // can own the installed esbuild service. All spawn calls still execute.
  const script = `
    import {createRequire} from 'node:module';
    import {writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const require=createRequire(import.meta.url), cp=require('node:child_process');
    const spawn=cp.spawn, services=[];
    cp.spawn=function(command,args,options){
      const child=spawn.call(this,command,args,options);
      if(args?.some(arg=>arg.startsWith('--service=') || arg.endsWith('build_source_runtime.mjs'))) services.push(child);
      return child;
    };
    const {buildSourceRuntimeBundle}=await import(${JSON.stringify(new URL('./build_source_runtime.mjs', import.meta.url).href)});
    const repoDir=process.argv[1], results=[];
    try {
      for(const failure of [false,true]) {
        if(failure) await writeFile(join(repoDir,'apps/server/sources/main.light.ts'),'import "./missing-source";');
        let rejected=false;
        try {await buildSourceRuntimeBundle({repoDir,outputDir:join(repoDir,failure?'failure':'success'),component:'server'});}
        catch(error){if(!failure) throw error; rejected=true;}
        const child=services.at(-1);
        if(!child) throw new Error('real source preparation process was not observed');
        const retired=await new Promise(resolve=>{
          if(child.exitCode!==null || child.signalCode!==null) return resolve(true);
          const timer=setTimeout(()=>resolve(false),1000);
          child.once('exit',()=>{clearTimeout(timer);resolve(true);});
        });
        results.push({failure,rejected,retired});
      }
      console.log(JSON.stringify(results));
    } finally {require(join(repoDir,'apps/server/node_modules/esbuild')).stop();}
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir]);
  assert.deepEqual(JSON.parse(stdout.trim()), [
    { failure: false, rejected: false, retired: true },
    { failure: true, rejected: true, retired: true },
  ]);
});

test('source bundle freezes source exports and a lazy entry without consuming dist', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps/cli');
  const packageDir = join(repoDir, 'packages/example');
  const unscopedDir = join(repoDir, 'packages/unscoped');
  const sdkDir = join(repoDir, 'packages/sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  await Promise.all([mkdir(join(cliDir, 'src'), { recursive: true }), mkdir(join(packageDir, 'src'), { recursive: true }), mkdir(join(repoDir, 'node_modules/@happier-dev'), { recursive: true })]);
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', dependencies: {}, exports: { './lib': { 'happier-source': './src/library.ts', default: './dist/lib.mjs' } } }));
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(packageDir, 'src/index.ts'), "export const value = 'frozen';\n");
  await mkdir(join(unscopedDir, 'src'), { recursive: true });
  await mkdir(join(unscopedDir, 'dist'), { recursive: true });
  await writeFile(join(unscopedDir, 'package.json'), JSON.stringify({ name: 'unscoped-first-party', type: 'module', exports: { import: { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(unscopedDir, 'src/index.ts'), "export const value = '-unscoped';\n");
  await writeFile(join(unscopedDir, 'dist/index.js'), "export const value = '-stale-dist';\n");
  await symlink(unscopedDir, join(repoDir, 'node_modules/unscoped-first-party'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(sdkDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(sdkDir, 'package.json'), JSON.stringify({ name: '@happier-dev/sdk', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } }, imports: { '#http': { 'happier-source': './src/http.ts', default: './dist/http.js' } } }));
  await writeFile(join(sdkDir, 'src/index.ts'), "export { value } from '#http';\n");
  await writeFile(join(sdkDir, 'src/http.ts'), "export { value } from '@happier-dev/protocol';\n");
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(protocolDir, 'src/index.ts'), "export { value } from './authored';\n");
  await writeFile(join(protocolDir, 'src/authored.ts'), "export const value = '-canonical-protocol';\n");
  // A public bundled SDK dependency can retain a source condition while lacking
  // the authored transitive source. Native source builds must use the workspace
  // authority, not this nearer installed copy or its stale emitted fallback.
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), { recursive: true });
  await writeFile(join(shadowProtocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), "export { value } from './missing-bundled-source';\n");
  await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(protocolDir, join(repoDir, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(cliDir, 'src/index.ts'), "import {value} from '@happier-dev/example'; import {value as unscoped} from 'unscoped-first-party'; import {value as sdk} from '@happier-dev/sdk'; export const read = async () => value + (await import('./lazy')).value + unscoped + sdk;\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "export const value = '-lazy';\n");
  await writeFile(join(cliDir, 'src/library.ts'), "export const value = 'frozen-library';\n");
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await writeFile(join(cliDir, 'scripts/process_tree.cjs'), "exports.read = async () => (await import('@happier-dev/example')).value;\n");
  await symlink(packageDir, join(repoDir, 'node_modules/@happier-dev/example'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(repoDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), join(repoDir, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
  const sourceToolsDir = join(repoDir, 'packages/cli-common');
  await mkdir(sourceToolsDir, { recursive: true });
  for (const file of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'cliRuntimeSidecars.mjs']) {
    await cp(new URL('../../../../packages/cli-common/' + file, import.meta.url), join(sourceToolsDir, file));
  }
  const { stdout: sdkSourceValue } = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(join(sourceToolsDir, 'registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', "console.log((await import('@happier-dev/sdk')).value)",
  ], { cwd: repoDir });
  assert.equal(sdkSourceValue.trim(), '-canonical-protocol', 'Node source tools also bypass the SDK installed Protocol shadow');
  const admissionEvidence = join(repoDir, 'admission.json');
  await mkdir(join(cliDir, 'src/plugins/projection/registry/sources'), { recursive: true });
  await writeFile(join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'), `
    import {writeFileSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
    const root=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
    const admissionClass=token && root ? readFileSync(join(root,'owners',token.replace(':','-'),'class'),'utf8').trim() : null;
    writeFileSync(${JSON.stringify(admissionEvidence)},JSON.stringify({pid:process.pid,admissionClass}));
    export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
  `);
  // Observe this builder's class rather than the enclosing test runner's
  // already-admitted validation reservation.
  const buildEnv = {...process.env};
  for (const key of Object.keys(buildEnv)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete buildEnv[key];
  const result = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'daemon', env:buildEnv });
  const admitted = JSON.parse(await readFile(admissionEvidence, 'utf8'));
  assert.notEqual(admitted.pid, process.pid, 'source preparation is finite, not part of the long-lived caller');
  if (process.platform === 'linux') assert.equal(admitted.admissionClass, 'source-bundle');
  await writeFile(join(packageDir, 'src/index.ts'), "export const value = 'changed';\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "throw new Error('moving source was loaded');\n");
  await writeFile(join(unscopedDir, 'src/index.ts'), "throw new Error('moving unscoped source was loaded');\n");
  assert.equal(await (await import(pathToFileURL(result.entrypoint).href)).read(), 'frozen-lazy-unscoped-canonical-protocol');
  assert.equal(await createRequire(import.meta.url)(join(result.cliDir, 'scripts/process_tree.cjs')).read(), 'frozen');
  const publicLibrary = createRequire(join(result.cliDir, 'package.json')).resolve('@happier-dev/cli/lib');
  assert.equal((await import(pathToFileURL(publicLibrary).href)).value, 'frozen-library');
  assert.match(result.identity, /^[a-f0-9]{16}$/);
  const metafile = JSON.parse(await readFile(join(result.runtimeDir, 'metafile.json'), 'utf8'));
  assert.equal(Object.keys(metafile.inputs).some((file) => file.includes('/dist/')), false);
  const rebuilt = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output-two'), component: 'daemon', env:buildEnv });
  assert.notEqual(rebuilt.identity, result.identity);
});

test('source server refuses reuse of copied SQL consumed during an editor undo', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-sql-undo-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules']
    .map(name => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;');
  const prisma = join(serverDir, 'prisma');
  const sql = join(prisma, 'migrations/example/migration.sql');
  await writeFile(sql, 'SELECT 1;\n');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const observer = fixture.path('observe-sql-copy.mjs');
  const marker = fixture.path('edited');
  // Intercept filesystem IO only. The public builder, fingerprint, consumed
  // input recorder and reuse/adoption all remain real.
  await writeFile(observer, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const fs=createRequire(import.meta.url)('node:fs/promises');
    const read=fs.readFile, write=fs.writeFile, copy=fs.cp;
    fs.writeFile=async (...args)=>{
      if (String(args[0]).replaceAll('\\\\','/').endsWith('/apps/server/package.json')
        && String(args[0])!==${JSON.stringify(join(serverDir, 'package.json'))}
        && !(await fs.access(${JSON.stringify(marker)}).then(()=>true,()=>false))) {
        await write(${JSON.stringify(marker)},'edited');
        await write(${JSON.stringify(sql)},'SELECT 2;\\n');
      }
      return write(...args);
    };
    fs.readFile=async (...args)=>{
      const contents=await read(...args);
      if (String(args[0])===${JSON.stringify(sql)} && String(contents)==='SELECT 2;\\n')
        await write(${JSON.stringify(sql)},'SELECT 1;\\n');
      return contents;
    };
    fs.cp=async (...args)=>{
      const result=await copy(...args);
      if (String(args[0])===${JSON.stringify(prisma)}) await write(${JSON.stringify(sql)},'SELECT 1;\\n');
      return result;
    };
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim() };
  const options = { repoDir, stackBaseDir: fixture.path('stacks/server'), component: 'server',
    serverComponent: 'happier-server', dbProvider: 'postgres', env };
  const first = await buildSourceRuntimeBundle(options);
  assert.equal(await readFile(join(first.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 2;\n');
  assert.equal(await readFile(sql, 'utf8'), 'SELECT 1;\n', 'source was restored before reuse admission');
  const second = await buildSourceRuntimeBundle(options);
  assert.equal(await readFile(join(second.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n',
    'the restored source must not adopt the bundle containing transient SQL');
  assert.notEqual(second.entrypoint, first.entrypoint);
  assert.equal((await buildSourceRuntimeBundle(options)).entrypoint, second.entrypoint, 'settled SQL keeps warm reuse');
});

test('source server retains migration source assets without copying checkout database files', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules'].map((name) => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;\n');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;\n');
  await writeFile(join(serverDir, 'prisma/schema.prisma'), 'datasource db {}\n');
  await writeFile(join(serverDir, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  await writeFile(join(serverDir, 'prisma/migrations/example/migration.sql'), 'SELECT 1;\n');
  await writeFile(join(serverDir, 'prisma/development.db'), 'private retained checkout data');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'server', serverComponent: 'happier-server', dbProvider: 'postgres' });
  const stackBaseDir = join(repoDir, 'stacks/server');
  await mkdir(join(stackBaseDir, 'source-runtime'), {recursive:true});
  await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({entrypoint:runtime.entrypoint}));
  await writeFile(join(serverDir, 'sources/main.ts'), 'import "./missing-moving-source";');
  const recovered = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'server', reuseSelected:true});
  assert.deepEqual(recovered, runtime, 'server recovery preserves emitted code, environment and migration launch together');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/schema.prisma'), 'utf8'), 'datasource db {}\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/migration_lock.toml'), 'utf8'), 'provider = "postgresql"\n');
  await assert.rejects(access(join(runtime.serverDir, 'prisma/development.db')), { code: 'ENOENT' });
});

test('Node source-light runs the canonical SQLite migration before startup without losing retained data', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-light-migration-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  await mkdir(fixture.path('repo'));
  await linkCanonicalServerWorkspace(fixture.path('repo'));
  const serverDir = fixture.path('repo/apps/server');
  const migrationName = '20260927010000_add_home_settings_and_administration_events';
  const canonicalDeploy = fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url));
  const canonicalMigrations = fileURLToPath(new URL('../../../server/prisma/sqlite/migrations', import.meta.url));
  await Promise.all(['sources', 'scripts', `prisma/sqlite/migrations/${migrationName}`, 'node_modules']
    .map(name => mkdir(join(serverDir, name), {recursive:true})));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({name:'@happier-dev/server', type:'module'}));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  // Re-export the actual deployment owner; no migration-domain logic is mocked.
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(canonicalDeploy)};`);
  await cp(canonicalMigrations, join(serverDir, 'prisma/sqlite/migrations'), {recursive:true});
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
    join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await buildSourceRuntimeBundle({repoDir:fixture.path('repo'), stackBaseDir:fixture.path('stacks/consumer'),
    component:'server', serverComponent:'happier-server-light', dbProvider:'sqlite'});
  assert.equal(runtime.migration.mode, 'external', 'Node cannot perform the Bun-only in-process migration');
  const dataDir = fixture.path('retained-data');
  await mkdir(dataDir);
  const databasePath = join(dataDir, 'retained.sqlite');
  const execute = promisify(execFile);
  await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE Retained (value TEXT NOT NULL); INSERT INTO Retained VALUES ('keep');");db.close();
  `, databasePath]);
  const env = {...process.env, ...runtime.env, HAPPIER_SERVER_LIGHT_DATA_DIR:dataDir,
    DATABASE_URL:`file:${databasePath}`};
  const serverLaunchSpec = resolveServerRuntimeLaunchSpec({sourceRuntimeLaunch:runtime});
  const children = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await runServerRuntimeMigration({serverLaunchSpec, env, children});
  }
  assert.deepEqual(children, []);
  const observed = await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    console.log(JSON.stringify({retained:db.prepare('SELECT value FROM Retained').get().value,
      homeSettings:db.prepare('SELECT count(*) AS count FROM HomeSettings').get().count,
      migrations:db.prepare('SELECT count(*) AS count FROM _prisma_migrations WHERE migration_name=?').get(process.argv[2]).count}));
    db.close();
  `, databasePath, migrationName]);
  assert.deepEqual(JSON.parse(observed.stdout), {retained:'keep', homeSettings:0, migrations:1});
});

test('cancelling source author emission retires its declaration compiler',
  { skip: process.platform !== 'linux', timeout: 20000 }, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-source-author-cancel-'});
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const sdkDir = join(repoDir, 'packages/plugin-sdk');
    for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'),
      join(sdkDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
      await mkdir(directory, {recursive:true});
    }
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli',type:'module',
      dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},bundledDependencies:['@happier-dev/plugin-sdk'],exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await writeFile(join(sdkDir, 'package.json'), JSON.stringify({name:'@happier-dev/plugin-sdk',version:'0.0.0',
      type:'module',main:'./dist/index.js',types:'./dist/index.d.ts',
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      happier:{publicSdkRelease:{posture:'developer_preview'}}}));
    await writeFile(join(sdkDir, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true},include:['src/**/*.ts']}));
    await writeFile(join(sdkDir, 'src/index.ts'), 'export const author=true;');
    await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/plugin-sdk'));
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = fixture.path('active-compiler.json');
    const heldCompiler = fixture.path('held-compiler.mjs');
    // Only the external compiler tool is substituted. Keep source preparation,
    // admission and foreground process custody on their real internal paths.
    await writeFile(heldCompiler, `import {writeFileSync,renameSync} from 'node:fs';
      writeFileSync(${JSON.stringify(ready+'.tmp')},JSON.stringify({pid:process.pid}));
      renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});
      setInterval(()=>{},1000);`);
    const compilerPath = resolveTypeScriptCliInvocation({args:[]}).compilerPath;
    const observer = fixture.path('hold-compiler.mjs');
    await writeFile(observer, `import {createRequire,syncBuiltinESMExports} from 'node:module';
      const childProcess=createRequire(import.meta.url)('node:child_process');
      const spawn=childProcess.spawn;
      childProcess.spawn=function(command,args,...options) {
        return spawn.call(this,command,args?.map(arg=>arg===${JSON.stringify(compilerPath)}?${JSON.stringify(heldCompiler)}:arg),...options);
      };
      syncBuiltinESMExports();`);
    let compilerPid;
    context.after(() => {
      // A RED result must not leak this test's deliberately held OS process.
      if (compilerPid) {
        try { process.kill(compilerPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    const watcher = watch(fixture.root);
    context.after(() => watcher.close());
    const active = new Promise((resolve,reject) => {
      watcher.on('error',reject);
      watcher.on('change',(_event,filename) => { if (filename==='active-compiler.json') resolve(); });
    });
    const controller = new AbortController();
    const pending = buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('output'),component:'daemon',
      signal:AbortSignal.any([controller.signal,context.signal]),env:{...process.env,
        NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${pathToFileURL(observer).href}`.trim()}});
    const cancelled = assert.rejects(pending,{name:'AbortError'});
    await active;
    compilerPid = JSON.parse(await readFile(ready,'utf8')).pid;
    controller.abort();
    await cancelled;
    let alive = true;
    for (let attempt=0;attempt<100;attempt++) {
      try { alive=!(await readFile(`/proc/${compilerPid}/status`,'utf8')).match(/^State:\s+Z/m); }
      catch (error) { if (error.code!=='ENOENT') throw error; alive=false; }
      if (!alive) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(alive,false,'the declaration compiler survived source preparation cancellation');
  });

test('cancelling admitted source preparation retires its active worker and native service',
  { skip: process.platform !== 'linux', timeout: 20000 }, async (context) => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-cancel-'));
    context.after(() => rm(repoDir, { recursive: true, force: true }));
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, { recursive: true });
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = join(repoDir, 'active-worker.json');
    // The canonical locator transform has already started the real esbuild
    // service. Hold its fixture module so cancellation reaches an active build.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {writeFileSync,readFileSync,renameSync} from 'node:fs';
      setInterval(()=>{},1000);
      writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.pid,children:readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children','utf8').trim().split(/\\s+/).filter(Boolean).map(Number)}));
      renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});
      await new Promise(()=>{});
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const watcher = watch(repoDir);
    context.after(() => watcher.close());
    const active = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', (_event, filename) => { if (filename === 'active-worker.json') resolve(); });
    });
    const controller = new AbortController();
    const pending = buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'daemon', signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await active;
    const worker = JSON.parse(await readFile(ready, 'utf8'));
    assert.notEqual(worker.pid, process.pid);
    assert.ok(worker.children.length, 'the worker has started its real native service');
    controller.abort();
    await cancelled;
    // Wait only for the kernel to expose the already-requested child exit.
    for (const pid of [worker.pid, ...worker.children]) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { alive = !(await readFile(`/proc/${pid}/status`, 'utf8')).match(/^State:\s+Z/m); }
        catch (error) { if (error.code !== 'ENOENT') throw error; alive = false; }
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(alive, false, `source preparation child ${pid} survived cancellation`);
    }
  });
