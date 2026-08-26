import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

test('the finite Turbo graph is activated through the current package manager without replacing package-owned semantics', async () => {
  const [rootPackage, turbo, pluginSdk, pluginUi, sdk, gitignore] = await Promise.all([
    readJson('package.json'),
    readJson('turbo.json'),
    readJson('packages/plugin-sdk/package.json'),
    readJson('packages/plugin-ui/package.json'),
    readJson('packages/sdk/package.json'),
    readFile(path.join(repoRoot, '.gitignore'), 'utf8'),
  ]);

  assert.equal(rootPackage.devDependencies.turbo, '2.10.11');
  assert.match(gitignore, /^\.turbo\/$/mu);
  assert.ok(rootPackage.workspaces.packages.includes('packages/plugins/[a-z]*'));
  assert.equal(JSON.stringify(turbo).includes('@happier-dev/plugins-'), false);
  assert.equal(turbo.concurrency, '75%');
  const buildPackages = rootPackage.scripts['build:packages'];
  assert.match(buildPackages, /^node scripts\/workspaces\/ensureWorkspacePackagesBuiltCli\.mjs /u);
  for (const packageName of [
    'privacy-kit',
    '@happier-dev/protocol',
    '@happier-dev/agents',
    '@happier-dev/cli-common',
    '@happier-dev/release-runtime',
    '@happier-dev/support',
    '@happier-dev/bootstrap',
  ]) {
    assert.match(buildPackages, new RegExp(`(?:^| )${packageName.replace('/', '\\/')}(?: |$)`, 'u'));
  }
  assert.equal(
    rootPackage.scripts['typecheck:inner'],
    'yarn -s build:packages && yarn -s prepare:typecheck:workspaces && turbo run typecheck:finite --filter=@happier-dev/plugin-sdk --filter=@happier-dev/sdk && turbo run typecheck:source:finite --filter=@happier-dev/terminal-native --filter=@happier-dev/plugin-ui --filter=@happier-dev/app --filter=@happier-dev/cli --filter=@happier-dev/server --filter=@happier-dev/tests',
  );
  assert.equal(
    rootPackage.scripts['prepare:typecheck:workspaces'],
    'node scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs --for-component=packages/terminal-native --for-component=packages/plugin-ui --for-component=apps/ui --for-component=apps/cli --for-component=apps/server --for-component=packages/tests',
  );
  assert.equal(
    rootPackage.scripts['check:public-sdk:finite'],
    'apps/stack/bin/hstack-exec --script=check:public-sdk:finite:local',
  );
  assert.equal(
    rootPackage.scripts['check:public-sdk:finite:local'],
    'turbo run api:finite test:finite typecheck:finite --filter=@happier-dev/plugin-sdk --filter=@happier-dev/plugin-ui --filter=@happier-dev/sdk',
  );
  assert.equal(
    rootPackage.scripts['check:first-party-plugins:finite'],
    'apps/stack/bin/hstack-exec --script=check:first-party-plugins:finite:local',
  );
  assert.equal(
    rootPackage.scripts['check:first-party-plugins:finite:local'],
    'turbo run plugins:aggregate:finite --filter=@happier-dev/cli',
  );
  assert.deepEqual(turbo.tasks['prepare:finite'].dependsOn, ['^build:finite']);
  assert.equal(
    Object.hasOwn(turbo, 'globalDependencies'),
    false,
    'Plugin and API implementation files must not invalidate every finite task through the global hash',
  );
  assert.deepEqual(turbo.tasks['prepare:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/scripts/workspaces/**',
  ]);
  assert.deepEqual(turbo.tasks['build:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/scripts/workspaces/**',
  ]);
  assert.deepEqual(turbo.tasks['api:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/scripts/api-governance/**',
  ]);
  assert.deepEqual(turbo.tasks['project:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/apps/cli/scripts/build-owned/**',
  ]);
  assert.deepEqual(turbo.tasks['build:finite'].dependsOn, [
    'generated:finite',
    'prepare:finite',
    '^build:finite',
  ]);
  assert.deepEqual(turbo.tasks['generated:finite'].outputs, []);
  assert.deepEqual(turbo.tasks['api:finite'].dependsOn, ['build:finite']);
  assert.deepEqual(turbo.tasks['test:finite'].dependsOn, ['api:finite']);
  assert.deepEqual(turbo.tasks['typecheck:finite'].dependsOn, ['api:finite']);
  assert.deepEqual(turbo.tasks['typecheck:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/scripts/workspaces/**',
  ]);
  assert.deepEqual(turbo.tasks['typecheck:source:finite'].dependsOn, []);
  assert.deepEqual(turbo.tasks['typecheck:source:finite'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/scripts/workspaces/**',
    '$TURBO_ROOT$/packages/{privacy-kit,protocol,peer-mediation,transfers,voice-modelpacks,agents,cli-common,release-runtime,channels-protocol,support,connection-supervisor,triage-protocol,triage-sources,plugin-sdk}/dist/**/*.d.ts',
    '$TURBO_ROOT$/packages/{privacy-kit,cli-common}/*.{d.ts,d.mts,d.cts}',
    '$TURBO_ROOT$/packages/{audio-stream-native,sherpa-native,ssh-native,terminal-native}/src/**/*.ts',
  ]);
  assert.deepEqual(turbo.tasks['project:finite'].dependsOn, ['build:finite', '^build:finite']);
  assert.deepEqual(turbo.tasks['plugins:aggregate:finite'].dependsOn, ['^project:finite']);
  assert.equal(turbo.tasks['plugins:aggregate:finite'].cache, false);
  assert.deepEqual(turbo.tasks['build:finite'].outputs, []);
  assert.equal(turbo.tasks['build:finite'].cache, false);
  assert.deepEqual(turbo.tasks['project:finite'].outputs, []);

  assert.equal(pluginSdk.scripts['generated:finite'], 'yarn -s check:action-type-map');
  assert.equal(
    pluginSdk.scripts['prepare:finite'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations',
  );
  assert.equal(
    pluginSdk.scripts['build:finite'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=build:finite:prepared',
  );
  assert.equal(pluginSdk.scripts['build:finite:prepared'], 'yarn -s build:compiled');
  assert.equal(
    pluginSdk.scripts['api:finite'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=api:finite:prepared',
  );
  assert.equal(
    pluginSdk.scripts['api:finite:prepared'],
    'node ./scripts/apiSurfaceCli.mjs --materialize-source --check && yarn -s check:api-governance:prepared',
  );
  assert.equal(pluginSdk.scripts['test:finite'], 'yarn -s test:prepared');
  assert.equal(
    pluginSdk.scripts['typecheck:finite'],
    'yarn -s typecheck:tests:prepared',
  );

  assert.equal(pluginUi.scripts['prepare:finite'], undefined);
  assert.equal(
    pluginUi.scripts['typecheck:source:finite'],
    'yarn --cwd ../plugin-sdk -s check:public-toolchain:prepared && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit --tsBuildInfoFile node_modules/.cache/tsc/plugin-ui.typecheck.tsbuildinfo -p tsconfig.json',
  );
  assert.equal(pluginUi.scripts['build:finite'], 'yarn -s build:compiled');
  assert.equal(
    pluginUi.scripts['api:finite'],
    'yarn --cwd ../plugin-sdk -s check:public-toolchain:prepared && yarn -s check:api-governance:prepared',
  );
  assert.equal(pluginUi.scripts['test:finite'], 'yarn -s test:local');

  assert.equal(sdk.scripts['prepare:finite'], undefined);
  assert.equal(sdk.scripts['generated:finite'], 'yarn -s check:actions');
  assert.equal(sdk.scripts['build:finite'], 'yarn -s build:compiled');
  assert.equal(sdk.scripts['api:finite'], 'yarn -s check:api-governance:prepared');
  assert.equal(sdk.scripts['test:finite'], 'yarn -s test:local');
  assert.equal(
    sdk.scripts['typecheck:finite'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
  );
});

test('root typecheck packages expose cacheable finite implementations without re-entering hstack', async () => {
  const packagePaths = [
    'packages/terminal-native/package.json',
    'packages/plugin-ui/package.json',
    'apps/ui/package.json',
    'apps/cli/package.json',
    'apps/server/package.json',
    'packages/tests/package.json',
  ];
  const manifests = await Promise.all(packagePaths.map(readJson));
  for (const manifest of manifests) {
    assert.equal(typeof manifest.scripts?.['typecheck:source:finite'], 'string', manifest.name);
    assert.doesNotMatch(manifest.scripts['typecheck:source:finite'], /hstack-exec/u, manifest.name);
  }

  const publicationManifests = await Promise.all([
    readJson('packages/plugin-sdk/package.json'),
    readJson('packages/sdk/package.json'),
  ]);
  for (const manifest of publicationManifests) {
    assert.equal(typeof manifest.scripts?.['typecheck:finite'], 'string', manifest.name);
    assert.doesNotMatch(manifest.scripts['typecheck:finite'], /hstack-exec/u, manifest.name);
  }

});

test('source-only typecheck projects persist compiler state outside authored and packaged files', async () => {
  const projects = [
    ['apps/cli/tsconfig.json', 'node_modules/.cache/tsc/cli.typecheck.tsbuildinfo'],
    ['apps/server/tsconfig.json', 'node_modules/.cache/tsc/server.typecheck.tsbuildinfo'],
    ['packages/tests/tsconfig.json', 'node_modules/.cache/tsc/tests.typecheck.tsbuildinfo'],
    ['packages/terminal-native/tsconfig.json', 'node_modules/.cache/tsc/terminal-native.typecheck.tsbuildinfo'],
  ];
  for (const [relativePath, buildInfoPath] of projects) {
    const config = await readFile(path.join(repoRoot, relativePath), 'utf8');
    assert.match(config, /"incremental"\s*:\s*true/u, relativePath);
    assert.match(config, new RegExp(`"tsBuildInfoFile"\\s*:\\s*"${buildInfoPath.replaceAll('.', '\\.')}`), relativePath);
  }
});

test('public package test typechecks keep incremental state separate from emitted builds', async () => {
  const projects = [
    ['packages/plugin-sdk/tsconfig.tests.json', 'node_modules/.cache/tsc/plugin-sdk.tests.typecheck.tsbuildinfo'],
    ['packages/sdk/tsconfig.tests.json', 'node_modules/.cache/tsc/sdk.tests.typecheck.tsbuildinfo'],
  ];
  for (const [relativePath, buildInfoPath] of projects) {
    const config = await readJson(relativePath);
    assert.equal(config.compilerOptions.incremental, true, relativePath);
    assert.equal(config.compilerOptions.tsBuildInfoFile, buildInfoPath, relativePath);
  }
});

test('alternate production typecheck projects do not overwrite the full-project compiler state', async () => {
  const projects = [
    ['apps/cli/tsconfig.build.json', 'node_modules/.cache/tsc/cli.build.typecheck.tsbuildinfo'],
    ['apps/server/tsconfig.runtime.json', 'node_modules/.cache/tsc/server.runtime.typecheck.tsbuildinfo'],
  ];
  for (const [relativePath, buildInfoPath] of projects) {
    const config = await readJson(relativePath);
    assert.equal(config.compilerOptions?.tsBuildInfoFile, buildInfoPath, relativePath);
  }
});

test('first-party plugins project independently before one aggregate check', async () => {
  const cliPackage = await readJson('apps/cli/package.json');
  assert.equal(
    cliPackage.scripts['plugins:aggregate:finite'],
    'node scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/build-owned/generateBundledPluginEntries.ts --root ../.. --mode check --scope projections --aggregate',
  );

  const pluginRoot = path.join(repoRoot, 'packages/plugins');
  const pluginTemplate = await readJson('packages/plugins/_template/package.json');
  assert.equal(pluginTemplate.scripts['build:finite'], 'yarn -s build');
  assert.equal(
    pluginTemplate.scripts['project:finite'],
    'node --experimental-strip-types ../../../apps/cli/scripts/build-owned/checkBundledPluginWorkspace.mjs',
  );
  const pluginDirectoryNames = (await import('node:fs/promises')).readdir(pluginRoot, { withFileTypes: true });
  const pluginPackages = (await pluginDirectoryNames)
    .filter((entry) => entry.isDirectory() && entry.name !== '_template' && entry.name !== 'node_modules')
    .map((entry) => path.join('packages/plugins', entry.name, 'package.json'));
  const manifests = await Promise.all(pluginPackages.map(readJson));
  assert.ok(manifests.length > 0);
  for (const manifest of manifests) {
    assert.equal(
      manifest.scripts['build:finite'],
      'yarn -s build',
      manifest.name,
    );
    assert.equal(
      manifest.scripts['project:finite'],
      'node --experimental-strip-types ../../../apps/cli/scripts/build-owned/checkBundledPluginWorkspace.mjs',
      manifest.name,
    );
  }
});

test('external plugin development does not depend on Turbo', async () => {
  const authoringFiles = [
    'apps/cli/src/plugins/daemon/pathChangePreparer.ts',
    'apps/cli/src/plugins/daemon/developmentCandidateMaterializer.ts',
    'apps/cli/src/plugins/authoring/toolchain.ts',
  ];
  const contents = await Promise.all(authoringFiles.map((file) => readFile(path.join(repoRoot, file), 'utf8')));
  assert.equal(contents.some((content) => /\bturbo\b/i.test(content)), false);
});

test('CI invokes the activated finite public-package graph once', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /yarn -s check:public-sdk:finite/u);
  assert.match(workflow, /key: turbo-public-sdk-\$\{\{ runner\.os \}\}-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /key: turbo-typecheck-\$\{\{ runner\.os \}\}-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /apps\/cli\/node_modules\/\.cache\/tsc\/\*\.tsbuildinfo/u);
  assert.match(workflow, /packages\/plugin-sdk\/node_modules\/\.cache\/tsc\/\*\.tsbuildinfo/u);
  assert.doesNotMatch(workflow, /plugin-sdk prepare:declarations/u);
  assert.doesNotMatch(workflow, /plugin-sdk check:api-governance/u);
  assert.doesNotMatch(workflow, /plugin-ui check:api-governance/u);
  assert.doesNotMatch(workflow, /plugin-sdk test\s*$/mu);
  assert.doesNotMatch(workflow, /plugin-ui test\s*$/mu);
  assert.doesNotMatch(workflow, /@happier-dev\/sdk test\s*$/mu);
});
