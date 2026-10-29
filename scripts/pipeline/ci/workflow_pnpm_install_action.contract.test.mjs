import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { readBundledPluginPublicationFailures, writeBundledPluginPublicationFailures } from '../../workspaces/bundledPluginPublicationFailure.mjs';

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const installActionPath = path.join(repoRoot, '.github', 'actions', 'install-pnpm-dependencies', 'action.yml');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preparation-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const runnerTemp = path.join(root, 'runner');
  fs.mkdirSync(workspace);
  fs.mkdirSync(runnerTemp);
  return { root, workspace, runnerTemp };
}

function write(root, relative, content, mode) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(destination, mode);
}

function runShellStep(step, workspace, runnerTemp, env = {}) {
  assert.equal(step?.shell ?? 'bash', 'bash');
  assert.equal(typeof step?.run, 'string', 'expected an executable owner shell step');
  return spawnSync('bash', ['-c', step.run], {
    cwd: workspace,
    env: { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, ...env },
    encoding: 'utf8',
  });
}

test('Gate unit shell invokes one selected project suite and fails closed on native preparation', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const step = workflow.jobs['gate-unit'].steps.find((entry) => entry.name === 'Run affected package unit suite');
  const calls = path.join(root, 'calls');
  // pnpm is the process boundary; execute the real workflow shell unchanged.
  write(root, 'bin/pnpm', '#!/bin/sh\nprintf "%s|%s\\n" "${HAPPIER_VITEST_MAX_WORKERS-}" "$*" >> "$GATE_CALLS"\nprintf \'{"testResults":[]}\' > "$HAPPIER_UNIT_JSON_OUTPUT"\nexit "${GATE_CHILD_STATUS:-0}"\n', 0o755);
  write(workspace, 'scripts/ci/reportGateRegressions.mjs', fs.readFileSync(path.join(repoRoot, 'scripts/ci/reportGateRegressions.mjs'), 'utf8'));
  const env = { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, GATE_CALLS: calls,
    GATE_PACKAGES: 'cli protocol server plugins', GATE_VITEST_MAX_WORKERS: '2',
    HAPPIER_VITEST_MAX_WORKERS: '1', CLI_PREPARATION_OUTCOMES: 'success success',
    HAPPIER_UNIT_JSON_OUTPUT: path.join(root, 'unit.json'), HAPPIER_GATE_TRIAGE_BASELINE: '' };
  const succeeded = runShellStep(step, workspace, runnerTemp, env);
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['2|run test:gate-unit cli protocol server plugins']);
  fs.unlinkSync(calls);
  const refused = runShellStep(step, workspace, runnerTemp, { ...env, CLI_PREPARATION_OUTCOMES: 'success failure' });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['2|run test:gate-unit protocol server plugins']);
  fs.unlinkSync(calls);
  const failed = runShellStep(step, workspace, runnerTemp, { ...env, GATE_CHILD_STATUS: '7' });
  assert.notEqual(failed.status, 0);
  const ui = runShellStep(step, workspace, runnerTemp, { ...env, GATE_PACKAGES: 'ui' });
  assert.equal(ui.status, 0, ui.stderr);
  assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), /^2\|--filter @happier-dev\/app run test:unit\b/);
});

test('the shared install action caches the pnpm store and always installs on a cache hit', () => {
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const locate = action.runs.steps.find((step) => step.id === 'pnpm-store');
  const cache = action.runs.steps.find((step) => step.id === 'dependency-cache');
  const install = action.runs.steps.find((step) => step.name === 'Install frozen dependencies');
  assert.match(locate.run, /pnpm store path/);
  assert.equal(cache.with.path, '${{ steps.pnpm-store.outputs.path }}');
  for (const input of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'patches/**']) assert.ok(cache.with.key.includes(input));
  assert.doesNotMatch(install.if, /cache-hit/);
  assert.match(install.run, /pnpm install.*--prod=false/);
  assert.equal(action.inputs.args.default, '--frozen-lockfile');
  assert.equal(install.env.REDISMS_DISABLE_POSTINSTALL, '1');
  assert.doesNotMatch(install.run, /--ignore-scripts/);
});

test('release installs materialize foreign optional packages and both Linux libc variants without broadening ordinary installs', (t) => {
  const { root } = fixture(t);
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const install = action.runs.steps.find((step) => step.name === 'Install frozen dependencies');
  const foreignCpu = process.arch === 'arm64' ? 'x64' : 'arm64';
  const packages = [
    ['release-linux-glibc', 'linux', foreignCpu, 'glibc'],
    ['release-linux-musl', 'linux', foreignCpu, 'musl'],
    ['release-darwin', 'darwin', 'x64'],
    ['release-win32', 'win32', 'x64'],
  ];
  const optionalDependencies = {};
  for (const [name, os, cpu, libc] of packages) {
    const directory = path.join(root, name);
    write(directory, 'package/package.json', JSON.stringify({ name, version: '1.0.0', os: [os], cpu: [cpu], ...(libc ? { libc: [libc] } : {}) }));
    execFileSync('tar', ['-czf', path.join(root, `${name}.tgz`), '-C', directory, 'package']);
    optionalDependencies[name] = `file:${path.join(root, `${name}.tgz`)}`;
  }
  for (const crossTarget of ['false', 'true']) {
    const directory = path.join(root, crossTarget);
    write(directory, 'package.json', JSON.stringify({ private: true, optionalDependencies }));
    write(directory, 'pnpm-workspace.yaml', 'packages: ["."]\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    const args = `--frozen-lockfile --ignore-scripts --offline --store-dir=${path.join(root, 'store')}`;
    const env = { ...process.env, CI: 'true' };
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--offline', '--store-dir', path.join(root, 'store')], { cwd: directory, env, stdio: 'pipe' });
    const result = runShellStep({ ...install, run: install.run.replaceAll('${{ inputs.args }}', args)
      .replaceAll('${{ inputs.cross-target-optionals }}', crossTarget) }, directory, root, {
      ...env, ...install.env, HAPPIER_INSTALL_CROSS_TARGET_OPTIONALS: crossTarget, PNPM_INSTALL_ARGS: args,
    });
    assert.equal(result.status, 0, result.stderr);
    if (crossTarget === 'true') {
      for (const [name] of packages) assert.ok(fs.existsSync(path.join(directory, 'node_modules', name, 'package.json')), `release install must include ${name}`);
    } else {
      assert.equal(fs.existsSync(path.join(directory, 'node_modules/release-linux-musl/package.json')), false);
      assert.equal(fs.existsSync(path.join(directory, 'node_modules/release-linux-glibc/package.json')), false);
    }
  }
});

test('ordinary installs materialize both Linux libc variants of the host platform and nothing foreign', (t) => {
  // Linux CLI payloads keep glibc and musl optionals (finalizeRuntimeArtifactPayload), so a
  // source-built guest payload needs both from an ordinary worker install, as Yarn 1 gave it.
  const { root } = fixture(t);
  const { supportedArchitectures } = yaml.load(fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const foreignCpu = process.arch === 'arm64' ? 'x64' : 'arm64';
  const packages = [
    ['host-glibc', process.platform, process.arch, 'glibc'],
    ['host-musl', process.platform, process.arch, 'musl'],
    ['foreign-cpu', process.platform, foreignCpu],
  ];
  const optionalDependencies = {};
  for (const [name, os, cpu, libc] of packages) {
    const directory = path.join(root, name);
    write(directory, 'package/package.json', JSON.stringify({ name, version: '1.0.0', os: [os], cpu: [cpu], ...(libc ? { libc: [libc] } : {}) }));
    execFileSync('tar', ['-czf', path.join(root, `${name}.tgz`), '-C', directory, 'package']);
    optionalDependencies[name] = `file:${path.join(root, `${name}.tgz`)}`;
  }
  const directory = path.join(root, 'install');
  write(directory, 'package.json', JSON.stringify({ private: true, optionalDependencies }));
  write(directory, 'pnpm-workspace.yaml', yaml.dump({ packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, supportedArchitectures }));
  execFileSync('pnpm', ['install', '--ignore-scripts', '--offline', '--store-dir', path.join(root, 'store')], { cwd: directory, env: { ...process.env, CI: 'true' }, stdio: 'pipe' });
  const installed = (name) => fs.existsSync(path.join(directory, 'node_modules', name, 'package.json'));
  if (process.platform === 'linux') {
    assert.ok(installed('host-glibc'), 'ordinary Linux installs must include the glibc variant');
    assert.ok(installed('host-musl'), 'ordinary Linux installs must include the musl variant');
  }
  assert.equal(installed('foreign-cpu'), false);
});

test('the current-run preparation archive restores prepared outputs and readiness without collecting source changes', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const archive = workflow.jobs['gate-prepare']?.steps.find((step) => step.name === "Archive the current run's coherent preparation");
  const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
  write(workspace, 'packages/protocol/package.json', '{"name":"@happier-dev/protocol"}');
  write(workspace, 'packages/protocol/dist/index.js', 'export const current = true;');
  write(workspace, 'apps/bootstrap/package.json', '{"name":"@happier-dev/bootstrap"}');
  write(workspace, 'apps/bootstrap/dist/index.js', 'prepared app-workspace dependency');
  write(workspace, 'packages/plugins/example/package.json', '{"name":"@happier-dev/plugins-example"}');
  write(workspace, 'packages/plugins/example/.happier-plugin/plugin.json', '{"current":true}');
  const untrackedRuntime = 'packages/plugins/example/.happier-plugin/agent/runtime/factory.js';
  write(workspace, untrackedRuntime, 'current published plugin runtime');
  const publishedDependency = 'packages/plugins/example/.happier-plugin/node_modules/external/index.js';
  write(workspace, publishedDependency, 'current published plugin dependency');
  write(workspace, 'packages/plugins/example/.happier-plugin/.env.local', 'private plugin state');
  write(workspace, 'packages/iroh-native/native/iroh.node', 'native-output', 0o755);
  write(workspace, 'apps/cli/tools/unpacked/helper', '#!/bin/sh\nexit 0\n', 0o755);
  write(workspace, 'apps/ui/public/canvaskit.wasm', 'mandatory Skia web postinstall output');
  const ignoredGeneratedOutputs = [
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js',
    'packages/protocol/src/features/embeddedFeaturePolicies.generated.ts',
  ];
  for (const output of ignoredGeneratedOutputs) write(workspace, output, `canonical ignored output: ${output}`);
  write(workspace, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js', 'current physical copy');
  write(workspace, 'node_modules/external/index.js', 'third-party');
  fs.mkdirSync(path.join(workspace, 'node_modules/@happier-dev'), { recursive: true });
  fs.symlinkSync('../../packages/protocol', path.join(workspace, 'node_modules/@happier-dev/protocol'));
  write(workspace, '.project/tmp/cli-source-dev-shared-deps-sync.json', '{"version":8}');
  const failures = [{ packageName: '@happier-dev/plugins-example', pluginId: 'happier.example', diagnostic: { code: 'plugin_package_build_failed', message: 'Unusable plugin build' } }];
  writeBundledPluginPublicationFailures(workspace, failures);
  write(workspace, '.project/private-state', 'not public readiness');
  write(workspace, 'apps/cli/node_modules/external/.project/private-state', 'not dependency state');
  write(workspace, 'node_modules/external/.env', 'secret');
  const generated = 'packages/agents/src/generated/agentIds.ts';
  const untrackedGenerated = 'apps/ui/sources/text/bundledPluginTranslations/ja.generated.ts';
  const serverGenerated = [
    'apps/server/sources/app/api/routes/share/publicShareViewerBundle.generated.ts',
    'apps/server/sources/storage/enums.generated.ts',
    'apps/server/prisma/sqlite/schema.prisma',
    'apps/server/prisma/mysql/schema.prisma',
  ];
  write(workspace, generated, 'export const current = true;');
  write(workspace, untrackedGenerated, 'export const currentLocale = true;');
  for (const output of serverGenerated) write(workspace, output, `current Server projection: ${output}`);
  for (const provider of ['sqlite', 'mysql']) {
    write(workspace, `apps/server/generated/${provider}-client/index.js`, `current ${provider} client`);
    write(workspace, `apps/server/generated/${provider}-client/.happier-source-schema.sha256`, `${provider} schema identity`);
  }
  // No source inventory is required: even an unavailable Git boundary must not
  // prevent archiving the canonical prepared output directories.
  write(workspace, 'apps/cli/src/private.ts', 'not a prepared output');
  write(root, 'bin/git', '#!/bin/sh\necho "unexpected Git inventory invocation" >&2\nexit 42\n', 0o755);
  const result = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const archiveEntries = spawnSync('tar', ['--list', '--file', path.join(runnerTemp, 'gate-prepared-workspace.tar')], { encoding: 'utf8' });
  assert.equal(archiveEntries.status, 0, archiveEntries.stderr);
  assert.equal(archiveEntries.stdout.split('\n').filter((entry) => entry === publishedDependency).length, 1,
    'published dependency belongs to its prepared output, not a second dependency archive root');
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  write(consumer, generated, 'stale checkout projection');
  fs.mkdirSync(path.join(runnerTemp, 'gate-prepared'));
  fs.copyFileSync(path.join(runnerTemp, 'gate-prepared-workspace.tar'), path.join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
  const restored = runShellStep(restore, consumer, runnerTemp, { RESTORE_STARTED_SECONDS: String(Math.floor(Date.now() / 1000)) });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(consumer, generated), 'utf8'), 'stale checkout projection');
  for (const output of [untrackedGenerated, ...serverGenerated, 'apps/cli/src/private.ts']) {
    assert.equal(fs.existsSync(path.join(consumer, output)), false);
  }
  for (const provider of ['sqlite', 'mysql']) {
    assert.equal(fs.readFileSync(path.join(consumer, `apps/server/generated/${provider}-client/index.js`), 'utf8'), `current ${provider} client`);
    assert.equal(fs.readFileSync(path.join(consumer, `apps/server/generated/${provider}-client/.happier-source-schema.sha256`), 'utf8'), `${provider} schema identity`);
  }
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/bootstrap/dist/index.js'), 'utf8'), 'prepared app-workspace dependency');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/ui/public/canvaskit.wasm'), 'utf8'), 'mandatory Skia web postinstall output');
  for (const output of ignoredGeneratedOutputs) {
    assert.equal(fs.readFileSync(path.join(consumer, output), 'utf8'), `canonical ignored output: ${output}`);
  }
  assert.equal(fs.readlinkSync(path.join(consumer, 'node_modules/@happier-dev/protocol')), '../../packages/protocol');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js'), 'utf8'), 'current physical copy');
  assert.equal(fs.readFileSync(path.join(consumer, 'packages/plugins/example/.happier-plugin/plugin.json'), 'utf8'), '{"current":true}');
  assert.equal(fs.readFileSync(path.join(consumer, untrackedRuntime), 'utf8'), 'current published plugin runtime');
  assert.equal(fs.readFileSync(path.join(consumer, publishedDependency), 'utf8'), 'current published plugin dependency');
  for (const file of ['packages/iroh-native/native/iroh.node', 'apps/cli/tools/unpacked/helper']) {
    assert.equal(fs.statSync(path.join(consumer, file)).mode & 0o777, 0o755);
  }
  assert.equal(fs.readFileSync(path.join(consumer, '.project/tmp/cli-source-dev-shared-deps-sync.json'), 'utf8'), '{"version":8}');
  assert.deepEqual(readBundledPluginPublicationFailures(consumer), failures);
  for (const file of ['.project/private-state', 'apps/cli/node_modules/external/.project/private-state', 'node_modules/external/.env', 'packages/plugins/example/.happier-plugin/.env.local']) {
    assert.equal(fs.existsSync(path.join(consumer, file)), false);
  }
});

test('prepared restore refuses a missing artifact and preparation requires canonical readiness', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
  const missing = runShellStep(restore, workspace, runnerTemp, { RESTORE_STARTED_SECONDS: '0' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /gate-prepared-workspace\.tar/);
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.mkdirSync(path.join(workspace, 'apps'));
  fs.mkdirSync(path.join(workspace, 'packages'));
  const archive = workflow.jobs['gate-prepare']?.steps.find((step) => step.name === "Archive the current run's coherent preparation");
  const absentReadiness = runShellStep(archive, workspace, runnerTemp);
  assert.notEqual(absentReadiness.status, 0);
  assert.equal(fs.existsSync(path.join(runnerTemp, 'gate-prepared-workspace.tar')), false);
});

test('a workspace package build failure fails the compiler and artifact gates while unit gates still run', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const prepare = workflow.jobs['gate-prepare'];
  const steps = prepare.steps;

  // Installation runs only postinstalls that do not compile workspace packages,
  // so one package's compiler error cannot fail `pnpm install` for every gate.
  const { shouldRunPostinstall } = createRequire(import.meta.url)(path.join(repoRoot, 'scripts/postinstall/shouldRunPostinstall.cjs'));
  const install = steps.find((step) => step.id === 'dependencies');
  const scope = install.env?.HAPPIER_INSTALL_SCOPE ?? '';
  const compiles = /\brun\s+build\b|build:shared|buildTypeScriptPackageDist|ensureWorkspacePackagesBuilt/;
  const admitted = [];
  for (const directory of ['apps', 'packages', 'packages/plugins']) {
    for (const entry of fs.readdirSync(path.join(repoRoot, directory))) {
      const manifestPath = path.join(repoRoot, directory, entry, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const scripts = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts ?? {};
      if (!scripts.postinstall) continue;
      const delegate = scripts.postinstall.match(/^node\s+(\S+\.c?js)$/)?.[1];
      const gateSource = delegate ? fs.readFileSync(path.join(repoRoot, directory, entry, delegate), 'utf8') : scripts.postinstall;
      const token = gateSource.match(/workspace:\s*'([^']+)'/)?.[1];
      assert.ok(token, `${directory}/${entry} postinstall must consult the install-scope gate`);
      if (!shouldRunPostinstall({ workspace: token, scope })) continue;
      admitted.push(token);
      const executed = `${scripts.postinstall}\n${scripts.postinstall.includes('postinstall:real') ? scripts['postinstall:real'] ?? '' : ''}`;
      assert.doesNotMatch(executed, compiles, `${directory}/${entry} postinstall compiles workspace packages during the Gate install`);
    }
  }
  for (const token of ['cli', 'ui']) assert.ok(admitted.includes(token), `unit suites read the ${token} postinstall outputs`);

  // Package builds are their own recorded step; the canonical source generator
  // that unit suites import runs before it, independently of compilation.
  const buildIndex = steps.findIndex((step) => /\bprepare:typecheck:workspaces\b/.test(step.run ?? ''));
  const build = steps[buildIndex];
  assert.equal(build['continue-on-error'], true);
  assert.equal(prepare.outputs.workspace_build, `\${{ steps.${build.id}.outcome }}`);
  assert.ok(steps.slice(0, buildIndex).some((step) => /generate-embedded-feature-policies\.mjs/.test(step.run ?? '')));
  for (const step of steps.slice(buildIndex + 1).filter((entry) => /build:shared|verify:native/.test(entry.run ?? ''))) {
    assert.equal(step.if, `\${{ steps.${build.id}.outcome == 'success' }}`, `${step.name} consumes package outputs`);
  }

  // Unit consumers restore whatever was prepared; dist consumers fail closed.
  assert.doesNotMatch(JSON.stringify(workflow.jobs['gate-unit'].if ?? ''), /workspace_build/);
  for (const id of ['gate-compiler', 'gate-build-artifacts']) {
    const [guard] = workflow.jobs[id].steps;
    assert.equal(guard.env?.WORKSPACE_BUILD, '${{ needs.gate-prepare.outputs.workspace_build }}', `${id} must check the build first`);
    assert.equal(runShellStep(guard, workspace, runnerTemp, { WORKSPACE_BUILD: 'success' }).status, 0);
    const refused = runShellStep(guard, workspace, runnerTemp, { WORKSPACE_BUILD: 'failure' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /::error::/);
  }

  // A failed build still publishes the unit preparation without the readiness
  // stamp that only a successful CLI closure produces; success still requires it.
  const archive = steps.find((step) => step.name === "Archive the current run's coherent preparation");
  assert.equal(archive.env?.WORKSPACE_BUILD_OUTCOME, `\${{ steps.${build.id}.outcome }}`);
  write(workspace, 'node_modules/external/index.js', 'third-party');
  write(workspace, 'apps/cli/tools/unpacked/helper', 'unpacked tool');
  write(workspace, 'packages/iroh-native/native/iroh.node', 'native-output');
  write(workspace, 'packages/protocol/package.json', '{"name":"@happier-dev/protocol"}');
  assert.notEqual(runShellStep(archive, workspace, runnerTemp, { WORKSPACE_BUILD_OUTCOME: 'success' }).status, 0);
  const archived = runShellStep(archive, workspace, runnerTemp, { WORKSPACE_BUILD_OUTCOME: 'failure' });
  assert.equal(archived.status, 0, archived.stderr);
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  fs.mkdirSync(path.join(runnerTemp, 'gate-prepared'));
  fs.copyFileSync(path.join(runnerTemp, 'gate-prepared-workspace.tar'), path.join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
  const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
  const restored = runShellStep(restore, consumer, runnerTemp, { RESTORE_STARTED_SECONDS: '0' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(consumer, 'packages/iroh-native/native/iroh.node'), 'utf8'), 'native-output');
});

test('the Gate reuses package outputs only inside one build epoch and saves them on a push key miss', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const steps = workflow.jobs['gate-prepare'].steps;
  const indexOf = (predicate, label) => {
    const index = steps.findIndex(predicate);
    assert.notEqual(index, -1, `missing Gate preparation step: ${label}`);
    return index;
  };
  const keyIndex = indexOf((step) => step.id === 'workspace-build-cache-key', 'cache key');
  const restoreIndex = indexOf((step) => String(step.uses ?? '').startsWith('actions/cache/restore@')
    && step.id === 'workspace-build-cache', 'cache restore');
  const installIndex = indexOf((step) => step.id === 'dependencies', 'install');
  const buildIndex = indexOf((step) => /\bprepare:typecheck:workspaces\b/.test(step.run ?? ''), 'package build');
  const saveIndex = indexOf((step) => String(step.uses ?? '').startsWith('actions/cache/save@'), 'cache save');
  // The key hashes checked-out bytes only, and the owner decides reuse at build time.
  assert.ok(keyIndex < restoreIndex && restoreIndex < installIndex && installIndex < buildIndex && buildIndex < saveIndex);
  const restore = steps[restoreIndex];
  const save = steps[saveIndex];
  const cachedPaths = (step) => String(step.with?.path ?? '').trim().split('\n').map((entry) => entry.trim());
  assert.deepEqual(cachedPaths(restore), ['packages/*/dist', 'packages/plugins/*/dist']);
  assert.deepEqual(cachedPaths(save), cachedPaths(restore));
  const output = (name) => `\${{ steps.workspace-build-cache-key.outputs.${name} }}`;
  assert.equal(restore.with.key, `${output('prefix')}${output('packages')}`);
  assert.equal(restore.with['restore-keys'], output('prefix'));
  assert.equal(save.with.key, '${{ steps.workspace-build-cache.outputs.cache-primary-key }}');
  assert.equal(save.if, "${{ github.event_name == 'push' && steps.workspace-build-cache.outputs.cache-hit != 'true' }}");

  // The epoch is exactly the build owner's global fingerprint inputs: restoring
  // across any of them can only rebuild everything over retained files.
  const owner = fs.readFileSync(path.join(repoRoot, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'), 'utf8');
  const fingerprint = owner.slice(owner.indexOf('export function readWorkspacePackageInputFingerprint'));
  const ownerFiles = [...fingerprint.match(/const buildOwnerPaths = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => `scripts/workspaces/${match[1]}`);
  const policyFiles = [...fingerprint.match(/const dependencyPolicyPaths = [\s\S]*?\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  const epochFiles = [...steps[keyIndex].run.matchAll(/HEAD:([^\s)"]+)/g)].map((match) => match[1]).filter((file) => file !== 'packages');
  assert.deepEqual([...epochFiles].sort(), [...policyFiles, ...ownerFiles].sort());

  // Execute the real key step: package edits change only the entry, epoch
  // edits change the restore prefix, and unrelated edits change neither.
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  for (const file of epochFiles) write(workspace, file, `${file}\n`);
  write(workspace, 'packages/plugins/zai/src/index.ts', 'export {};\n');
  write(workspace, 'apps/ui/sources/app.ts', 'export {};\n');
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Gate', '-c', 'user.email=gate@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'state');
    const outputFile = path.join(root, `output-${Math.random()}`);
    const result = runShellStep(steps[keyIndex], workspace, runnerTemp, { GITHUB_OUTPUT: outputFile, RUNNER_OS: 'Linux' });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(fs.readFileSync(outputFile, 'utf8').trim().split('\n').map((line) => line.split('=')));
  };
  const initial = commit();
  assert.match(initial.prefix, /^gate-workspace-build-v1-Linux-[0-9a-f]{16}-$/);
  assert.match(initial.packages, /^[0-9a-f]{40}$/);
  write(workspace, 'apps/ui/sources/app.ts', 'export const app = 1;\n');
  assert.deepEqual(commit(), initial);
  write(workspace, 'packages/plugins/zai/src/index.ts', 'export const zai = 1;\n');
  const packageEdit = commit();
  assert.equal(packageEdit.prefix, initial.prefix);
  assert.notEqual(packageEdit.packages, initial.packages);
  for (const file of epochFiles) {
    const before = commit();
    write(workspace, file, `${file} changed\n`);
    const after = commit();
    assert.notEqual(after.prefix, before.prefix, `${file} must start a new epoch`);
    assert.equal(after.packages, before.packages);
  }
});

test('GitHub workflows route dependency installs through the shared install-pnpm-dependencies action', () => {
  const actionRaw = fs.readFileSync(installActionPath, 'utf8');
  assert.match(
    actionRaw,
    /scripts\/ci\/setup-pnpm\.mjs/,
    'expected the shared pnpm setup before dependency installation',
  );
  assert.match(
    actionRaw,
    /ONNXRUNTIME_NODE_INSTALL_CUDA:\s*skip/,
    'expected install-pnpm-dependencies action to skip optional ONNX Runtime CUDA downloads in CI',
  );

  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort();

  let sharedActionUseCount = 0;
  for (const file of workflowFiles) {
    const raw = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (file.startsWith('issue-triage')) continue; // Installs the external maintainer-tools repository.
    if (raw.includes('./.github/actions/install-pnpm-dependencies')) {
      sharedActionUseCount += 1;
    }
    assert.doesNotMatch(
      raw,
      /\b(?:yarn|pnpm) install\b|corepack/,
      `${file} should use the shared install-pnpm-dependencies action instead of another bootstrap owner`,
    );
    assert.doesNotMatch(
      raw,
      /- name: Install dependencies(?:(?!\n\s*- name:)[\s\S])*?shell:\s*[^\n]+(?:(?!\n\s*- name:)[\s\S])*?uses:\s*\.\/\.github\/actions\/install-pnpm-dependencies/,
      `${file} should not keep shell on an install-pnpm-dependencies action step`,
    );
  }

  assert.ok(sharedActionUseCount > 0, 'expected at least one workflow to use the shared install-pnpm-dependencies action');
});
