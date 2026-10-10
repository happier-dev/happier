import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, mkdir, writeFile, symlink, rm, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSourceRuntimeBundle } from './build_source_runtime.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';

test('installed source daemon bundles the real plugin, child-entry, sodium and Ink graph', async () => {
  const repoDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const outputDir = await mkdtemp('/var/tmp/happier-source-runtime-daemon-');
  const started = performance.now();
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'daemon' });
  const elapsedMs = performance.now() - started;
  const metafile = JSON.parse(await readFile(join(runtime.runtimeDir, 'metafile.json'), 'utf8'));
  assert.equal(Object.keys(metafile.inputs).some((file) => /^(apps|packages)\/.*\/dist\//.test(file)), false);
  assert.equal(Object.keys(metafile.inputs).some((file) => /node_modules\/@happier-dev\//.test(file)), false);
  const version = spawnSync(process.execPath, [runtime.entrypoint, '--version'], {
    env: { ...process.env, ...runtime.env, HAPPIER_HOME_DIR: join(outputDir, 'home') }, encoding: 'utf8',
  });
  assert.equal(version.status, 0, version.stderr);
  const plugin = await import(pathToFileURL(join(outputDir, 'packages/plugins/codex/dist/index.js')).href);
  assert.equal(typeof plugin.activate, 'function');
  const registrationOutput = Object.entries(metafile.outputs).find(([, output]) => output.exports.includes('createPluginRegistrationScope'));
  const rightsOutput = Object.entries(metafile.outputs).find(([, output]) => output.exports.includes('derivePluginDaemonContributionRegistrationRights'));
  assert.ok(registrationOutput, 'frozen SDK registration owner is present');
  assert.ok(rightsOutput, 'frozen Protocol registration rights owner is present');
  const { createPluginRegistrationScope } = await import(pathToFileURL(resolve(repoDir, registrationOutput[0])).href);
  const { derivePluginDaemonContributionRegistrationRights } = await import(pathToFileURL(resolve(repoDir, rightsOutput[0])).href);
  for (const agent of ['claude', 'codex']) {
    const pluginDir = join(outputDir, 'packages/plugins', agent);
    const declaration = JSON.parse(await readFile(join(pluginDir, '.happier-plugin/plugin.json'), 'utf8'));
    const executable = await import(pathToFileURL(join(pluginDir, 'dist/index.js')).href);
    const scope = createPluginRegistrationScope({
      pluginId: declaration.id,
      target: { realm: 'daemon' },
      rights: derivePluginDaemonContributionRegistrationRights(declaration.contributes),
    });
    try {
      await executable.activate(scope.api);
      const registration = scope.commit().find((entry) => entry.family === 'agents' && entry.localId === agent);
      assert.ok(registration?.value.cliAuth, `${agent} CLI auth is admitted by its frozen declaration`);
      assert.ok(registration?.value.providerBinding, `${agent} provider binding survives complete activation`);
    } finally {
      await scope.dispose();
    }
  }
  const runner = await import(pathToFileURL(join(outputDir, 'packages/plugins/codex/dist/agent/runtime/engine.js')).href);
  assert.equal(typeof runner.createCodexAgentRuntime, 'function');
  const childEnvironment = { ...process.env, ...runtime.env, HAPPIER_HOME_DIR: join(outputDir, 'home') };
  const libraryAndVoice = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const library = await import(${JSON.stringify(pathToFileURL(join(runtime.cliDir, 'package-dist/lib.mjs')).href)});
    assert.equal(typeof library.ApiClient, 'function');
    const voice = await import(${JSON.stringify(pathToFileURL(join(runtime.cliDir, 'package-dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs')).href)});
    assert.equal(typeof voice.voiceInferenceRuntimeEngine.warmModel, 'function');
    await assert.rejects(voice.voiceInferenceRuntimeEngine.warmModel({signal:AbortSignal.abort()}));
  `], { env: childEnvironment, encoding: 'utf8' });
  assert.equal(libraryAndVoice.status, 0, libraryAndVoice.stderr);
  for (const path of ['package-dist/mcp/bridges/happierMcpStdioBridge.mjs', 'package-dist/mcp/launchers/stdioMcpServerLauncher.mjs']) {
    const child = spawnSync(process.execPath, [join(runtime.cliDir, path)], {
      env: { ...childEnvironment, HAPPIER_HTTP_MCP_URL: '', HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: '' }, encoding: 'utf8',
    });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /Missing/);
  }
  const subprocessOwnerOutput = Object.entries(metafile.outputs).find(([, output]) => output.exports.includes('buildHappyCliSubprocessInvocation'));
  assert.ok(subprocessOwnerOutput, 'canonical subprocess selector is present in frozen split graph');
  // Runs use the existing in-process owner, not a separate CLI subcommand.
  const runOwnerOutput = Object.entries(metafile.outputs).find(([, output]) => !output.entryPoint
    && Object.keys(output.inputs).some((path) => path.endsWith('/agent/runtime/bridges/executionRun/runtime/create.ts')));
  assert.ok(runOwnerOutput, 'canonical Run runtime is embedded in the frozen split graph');
  const subprocessSelector = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const owner = await import(${JSON.stringify(pathToFileURL(resolve(repoDir, subprocessOwnerOutput[0])).href)});
    await import(${JSON.stringify(pathToFileURL(resolve(repoDir, runOwnerOutput[0])).href)});
    for (const args of [['codex', '--started-by', 'daemon'], ['daemon', 'voice-inference-worker']]) {
      const selected = owner.buildHappyCliSubprocessInvocation(args);
      assert.equal(selected.runtime, 'node');
      assert.ok(selected.argv.includes(${JSON.stringify(runtime.entrypoint)}));
      assert.deepEqual(selected.argv.slice(-args.length), args);
      assert.equal(selected.argv.includes('--import'), false);
    }
  `], { env: { ...childEnvironment, HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node' }, encoding: 'utf8' });
  assert.equal(subprocessSelector.status, 0, subprocessSelector.stderr);
  process.stdout.write(JSON.stringify({ component: 'daemon', outputDir, identity: runtime.identity, elapsedMs, inputs: Object.keys(metafile.inputs).length, version: version.stdout.trim() }) + '\n');
});

test('installed source server bundles without workspace dist preparation', async () => {
  const repoDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const outputDir = await mkdtemp('/var/tmp/happier-source-runtime-server-');
  const started = performance.now();
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite' });
  const metafile = JSON.parse(await readFile(join(runtime.runtimeDir, 'metafile.json'), 'utf8'));
  assert.equal(Object.keys(metafile.inputs).some((file) => /^(apps|packages)\/.*\/dist\//.test(file)), false);
  const launch = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: runtime, migrationsEnabled: false });
  const probe = spawnSync(launch.command, [...launch.args, '--probe-runtime-capabilities'], {
    env: { ...process.env, ...runtime.env }, encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).component, 'happier-server-light');
  // Unlike the capability fast path, this traverses normal startup module
  // loading and fails its canonical argument admission before any DB opens.
  const startup = spawnSync(launch.command, [...launch.args, '--materialize-iroh-endpoint-descriptor'], {
    cwd: outputDir,
    env: { ...process.env, ...runtime.env, DOTENV_CONFIG_PATH: join(outputDir, 'absent.env') }, encoding: 'utf8',
  });
  assert.equal(startup.status, 1, startup.stderr);
  assert.match(startup.stderr, /requires a positive --source-descriptor-revision/);
  process.stdout.write(JSON.stringify({ component: 'server', outputDir, identity: runtime.identity, elapsedMs: performance.now() - started, inputs: Object.keys(metafile.inputs).length }) + '\n');
});

test('full source server includes each provider migration JS sidecar and frozen schema', async () => {
  const repoDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  for (const dbProvider of ['postgres', 'mysql', 'pglite', 'sqlite']) {
    const outputDir = await mkdtemp('/var/tmp/happier-source-runtime-full-');
    const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'server', serverComponent: 'happier-server', dbProvider });
    assert.equal(runtime.migration?.mode, 'external');
    assert.equal(runtime.migration.command, join(runtime.serverDir, 'scripts/migrate.mjs'));
    assert.ok((await readFile(runtime.migration.command)).length > 0);
    assert.ok((await readFile(join(runtime.serverDir, 'prisma/schema.prisma'))).length > 0);
    assert.equal((await lstat(join(runtime.serverDir, 'prisma'))).isSymbolicLink(), false);
  }
});

test('frozen source crypto executes the real Argon2id golden vector beside Ink async ESM', async (context) => {
  const repoDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const fixture = await mkdtemp('/var/tmp/happier-source-runtime-kdf-');
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const cliDir = join(fixture, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  for (const name of ['node_modules', 'packages']) await symlink(join(repoDir, name), join(fixture, name), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(repoDir, 'apps/cli/node_modules'), join(cliDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': [join(repoDir, 'apps/cli/src/*')] } } }));
  await writeFile(join(cliDir, 'src/index.ts'), `import {deriveNativeEmailPasswordKeys} from ${JSON.stringify(join(repoDir, 'apps/cli/src/auth/nativeEmailPasswordCrypto.ts'))};\nimport {render} from 'ink';\nexport async function probe() { const keys = await deriveNativeEmailPasswordKeys({password:'a password with spaces 🗝',kdf:{algorithm:'argon2id13',salt:'AAAAAAAAAAAAAAAAAAAAAA',opsLimit:3,memLimitBytes:67108864,outputBytes:32}}); try { return [Buffer.from(keys.authKey).toString('base64url'), typeof render]; } finally { keys.authKey.fill(0);keys.wrapKey.fill(0); } }\n`);
  const runtime = await buildSourceRuntimeBundle({ repoDir: fixture, outputDir: join(fixture, 'runtime'), component: 'daemon' });
  const compiled = await import(pathToFileURL(runtime.entrypoint).href);
  assert.deepEqual(await compiled.probe(), ['7VQv5bMjwJVCy2xKgDSf4iZBHCsrd3O2eJY12_UWhZE', 'function']);
});
