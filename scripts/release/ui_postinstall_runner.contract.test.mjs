import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');
const uiPostinstallPath = join(repoRoot, 'apps', 'ui', 'tools', 'postinstall.mjs');
const uiPostinstallRunnerPath = join(repoRoot, 'apps', 'ui', 'tools', 'postinstall', 'runUiPostinstall.cjs');
const require = createRequire(import.meta.url);

test('ui postinstall distinguishes a workspace junction from an installed package on Windows', () => {
  const { isInstalledPackageContext, runUiPostinstall } = require(uiPostinstallRunnerPath);
  const workspaceJunction = 'D:\\a\\happier\\happier\\node_modules\\@happier-dev\\app';
  const physicalWorkspace = 'D:\\a\\happier\\happier\\apps\\ui';

  assert.equal(
    isInstalledPackageContext({
      cwd: workspaceJunction,
      realpathSync: () => physicalWorkspace,
    }),
    false,
    'a Yarn workspace junction must run the app-owned postinstall tasks'
  );
  assert.equal(
    isInstalledPackageContext({
      cwd: workspaceJunction,
      realpathSync: () => workspaceJunction,
    }),
    true,
    'a genuine installed package must continue to skip repository-only postinstall tasks'
  );

  const spawnCalls = [];
  const uiWorkspace = join(repoRoot, 'apps', 'ui');
  const status = runUiPostinstall({
    cwd: workspaceJunction,
    env: {
      HAPPIER_INSTALL_SCOPE: 'ui,protocol',
      npm_execpath: 'D:\\hostedtoolcache\\yarn.js',
    },
    execPath: 'C:\\hostedtoolcache\\node.exe',
    platform: 'win32',
    realpathSync: () => uiWorkspace,
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(spawnCalls, [{
    command: 'C:\\hostedtoolcache\\node.exe',
    args: ['D:\\hostedtoolcache\\yarn.js', 'run', '-s', 'postinstall:real'],
    options: {
      cwd: uiWorkspace,
      env: {
        HAPPIER_INSTALL_SCOPE: 'ui,protocol',
        npm_execpath: 'D:\\hostedtoolcache\\yarn.js',
      },
      stdio: 'inherit',
    },
  }]);
});

test('ui postinstall keeps filtered patch directories on the target node_modules volume', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-ui-filtered-patches-'));
  const patchDir = join(fixtureRoot, 'patches');
  const nodeModulesDir = join(fixtureRoot, 'node_modules');

  try {
    await mkdir(join(nodeModulesDir, 'react-native-enriched-markdown'), { recursive: true });
    await mkdir(patchDir, { recursive: true });
    await writeFile(
      join(patchDir, 'react-native-enriched-markdown+0.0.12.patch'),
      'patch contents',
      'utf8',
    );
    await writeFile(join(patchDir, 'missing-package+1.0.0.patch'), 'ignored', 'utf8');

    const { createFilteredPatchDir } = await import(
      '../../apps/ui/tools/postinstall/filteredPatchDirectory.mjs'
    );
    const filteredPatchDir = createFilteredPatchDir({
      patchDir,
      nodeModulesDir,
      label: 'windows',
    });

    assert.ok(filteredPatchDir);
    assert.equal(
      dirname(filteredPatchDir),
      nodeModulesDir,
      'the filtered directory must share the target node_modules volume on Windows',
    );
    assert.deepEqual(
      await readdir(filteredPatchDir),
      ['react-native-enriched-markdown+0.0.12.patch'],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('ui postinstall propagates patch failures outside CI for every installed copy', async (t) => {
  const postinstallSource = await readFile(uiPostinstallPath, 'utf8');
  const invocations = [...postinstallSource.matchAll(/args:\s*(\[\s*patchPackageCliPath,[\s\S]*?\])/g)];
  assert.ok(invocations.length > 0, 'the postinstall patch-package invocations must be exercised');
  const patchPackageCliPath = createRequire(uiPackagePath).resolve('patch-package/dist/index.js');
  const commandRunnerUrl = new URL('../../apps/ui/tools/postinstall/runCommand.mjs', import.meta.url).href;

  for (const [, argsExpression] of invocations) {
    const rootCopy = argsExpression.includes('path.relative(repoRootDir,');
    await t.test(rootCopy ? 'root node_modules' : 'UI node_modules', async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-ui-patch-failure-'));
      t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
      const expoAppDir = join(fixtureRoot, 'apps', 'ui');
      const cwd = rootCopy ? fixtureRoot : expoAppDir;
      const packageDir = join(cwd, 'node_modules', 'fixture-dependency');
      const patchDir = join(expoAppDir, 'patches');
      await mkdir(packageDir, { recursive: true });
      await mkdir(patchDir, { recursive: true });
      await writeFile(join(cwd, 'package.json'), JSON.stringify({
        name: 'postinstall-fixture', private: true, dependencies: { 'fixture-dependency': '1.0.0' },
      }));
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
      const original = 'module.exports = "original";\n';
      const patched = 'module.exports = "patched";\n';
      await writeFile(join(packageDir, 'index.js'), original);
      await writeFile(join(patchDir, 'fixture-dependency+1.0.0.patch'), [
        'diff --git a/node_modules/fixture-dependency/index.js b/node_modules/fixture-dependency/index.js',
        '--- a/node_modules/fixture-dependency/index.js',
        '+++ b/node_modules/fixture-dependency/index.js',
        '@@ -1 +1 @@',
        `-${original.trimEnd()}`,
        `+${patched.trimEnd()}`,
        '',
      ].join('\n'));
      const { createFilteredPatchDir } = await import('../../apps/ui/tools/postinstall/filteredPatchDirectory.mjs');
      const filteredPatchDir = createFilteredPatchDir({ patchDir, nodeModulesDir: join(cwd, 'node_modules') });
      // Read the real owner's external CLI arguments; keep filtering, command execution and patch-package real.
      const args = runInNewContext(argsExpression, {
        patchPackageCliPath, repoRootDir: fixtureRoot, expoAppDir, filteredPatchDir, path: { relative },
      });
      const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { runCommandOrExit } from ${JSON.stringify(commandRunnerUrl)};
        runCommandOrExit({ command: process.execPath, args: JSON.parse(process.argv[1]), options: { cwd: process.argv[2] } });
      `, JSON.stringify(args), cwd], {
        encoding: 'utf8',
        // patch-package normally changes its exit policy on CI; exercise its development policy even in CI runners.
        env: { ...process.env, NODE_ENV: 'development', PATCH_PACKAGE_INTEGRATION_TEST: '1' },
      });
      const applied = run();
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.equal(await readFile(join(packageDir, 'index.js'), 'utf8'), patched);

      const incompatible = 'module.exports = "different source";\n';
      await writeFile(join(packageDir, 'index.js'), incompatible);
      const failed = run();
      assert.match(failed.stdout + failed.stderr, /Failed to apply patch/);
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      assert.equal(await readFile(join(packageDir, 'index.js'), 'utf8'), incompatible);
    });
  }
});

test('ui postinstall runner skips installed package context and respects npm_execpath', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  const postinstallScript = String(uiPackageJson?.scripts?.postinstall ?? '');
  const runnerSource = await readFile(uiPostinstallRunnerPath, 'utf8');
  assert.equal(
    postinstallScript,
    'node ./tools/postinstall/runUiPostinstall.cjs',
    'apps/ui package.json should delegate postinstall ownership to the testable runner'
  );
  assert.match(
    runnerSource,
    /node_modules/i,
    'postinstall should no-op inside node_modules installs'
  );
  assert.match(
    runnerSource,
    /realpathSync/,
    'postinstall should resolve workspace junctions before classifying installed package context'
  );
  assert.match(
    runnerSource,
    /npm_execpath/,
    'postinstall should prefer npm_execpath when available'
  );
  assert.match(
    runnerSource,
    /process\.execPath/,
    'postinstall should execute npm_execpath via process.execPath'
  );
  assert.match(
    runnerSource,
    /result\.error/,
    'postinstall should surface spawn errors explicitly'
  );
  assert.match(
    runnerSource,
    /postinstall:real/,
    'postinstall runner should continue to delegate to postinstall:real'
  );
});

test('ui postinstall runtime owns patch-package as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['patch-package'],
    '^8.0.0',
    'apps/ui postinstall requires patch-package during EAS/local installs, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['patch-package'],
    undefined,
    'apps/ui should not keep patch-package in devDependencies once postinstall depends on it at install time'
  );
});

test('ui postinstall invokes the Skia setup CLI without a package-manager shim', async () => {
  const postinstallSource = await readFile(uiPostinstallPath, 'utf8');

  assert.doesNotMatch(
    postinstallSource,
    /command:\s*['"]npx['"]/,
    'shell-free Windows spawns cannot resolve the npx.cmd shim',
  );
  assert.match(
    postinstallSource,
    /@shopify['"],\s*['"]react-native-skia['"],\s*['"]scripts['"],\s*['"]setup-canvaskit\.js['"]/,
    'postinstall should resolve the Skia-owned CLI script from the installed package',
  );
  assert.match(
    postinstallSource,
    /command:\s*process\.execPath/,
    'postinstall should invoke the JavaScript CLI through the current Node runtime',
  );
});

test('ui Metro/Babel runtime owns babel-plugin-module-resolver as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-module-resolver'],
    '^5.0.2',
    'apps/ui Metro bundling requires babel-plugin-module-resolver during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-module-resolver'],
    undefined,
    'apps/ui should not keep babel-plugin-module-resolver in devDependencies once production bundling depends on it'
  );
});

test('ui production Metro/Babel runtime owns babel-plugin-transform-remove-console as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-transform-remove-console'],
    '^6.9.4',
    'apps/ui production Metro bundling requires babel-plugin-transform-remove-console during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-transform-remove-console'],
    undefined,
    'apps/ui should not keep babel-plugin-transform-remove-console in devDependencies once production bundling depends on it'
  );
});
