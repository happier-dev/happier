import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
  const raw = await readFile(resolve(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

async function readTypeScriptWorkspacePackages() {
  const rootPackage = await readJson('package.json');
  const patterns = rootPackage?.workspaces?.packages ?? [];
  const packagePaths = [];
  for (const pattern of patterns) {
    if (pattern === 'packages/plugins/[a-z]*') {
      const names = await readdir(resolve(repoRoot, 'packages/plugins'));
      packagePaths.push(...names.filter((name) => /^[a-z]/.test(name)).map((name) => `packages/plugins/${name}`));
      continue;
    }
    packagePaths.push(pattern);
  }
  packagePaths.push('packages/plugins/_template');

  const packages = [];
  for (const packagePath of packagePaths) {
    try {
      const pkg = await readJson(`${packagePath}/package.json`);
      const scripts = JSON.stringify(pkg?.scripts ?? {});
      if (
        pkg?.devDependencies?.typescript
        || pkg?.dependencies?.typescript
        || /(?:^|[^a-z])tsc(?:[^a-z]|$)|runTypeScriptCli|buildTypeScriptPackageDist/.test(scripts)
      ) {
        packages.push({ packagePath, pkg });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return packages;
}

async function readDistExportingTypeScriptWorkspacePackages() {
  return (await readTypeScriptWorkspacePackages()).filter(({ pkg }) => JSON.stringify({
    main: pkg?.main,
    types: pkg?.types,
    exports: pkg?.exports,
  }).includes('dist/'));
}

test('root owns the native TypeScript 7 compiler and the TypeScript 5 API package separately', async () => {
  const pkg = await readJson('package.json');

  assert.equal(pkg?.devDependencies?.['@typescript/native'], 'npm:typescript@7.0.2');
  assert.equal(pkg?.devDependencies?.typescript, '5.9.3');
});

test('compiler orchestration has one native TypeScript resolver with no TS5 fallback', async () => {
  const resolver = await readFile(resolve(repoRoot, 'scripts/workspaces/resolveTypeScriptCliInvocation.mjs'), 'utf8');
  assert.match(resolver, /@typescript\/native\/package\.json/);
  assert.doesNotMatch(resolver, /typescript\/lib\/tsc|typescript\/bin\/tsc|node_modules[^\n]*\.bin[^\n]*tsc/);

  for (const relativePath of [
    'apps/bootstrap/scripts/runTsc.mjs',
    'apps/server/scripts/runTypeScriptCli.mjs',
    'apps/cli/scripts/build.mjs',
    'apps/cli/scripts/buildSharedDeps.mjs',
  ]) {
    const source = await readFile(resolve(repoRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /typescript\/lib\/tsc|typescript\/bin\/tsc|node_modules[^\n]*\.bin[^\n]*tsc/);
  }
});

test('yarn tsc and first-party compiler scripts use the shared native runner in every TypeScript workspace', async () => {
  const rootPackage = await readJson('package.json');
  assert.equal(rootPackage?.scripts?.tsc, 'node scripts/workspaces/runTypeScriptCli.mjs');

  for (const { packagePath, pkg } of await readTypeScriptWorkspacePackages()) {
    const runner = packagePath.startsWith('packages/plugins/')
      ? 'node ../../../scripts/workspaces/runTypeScriptCli.mjs'
      : 'node ../../scripts/workspaces/runTypeScriptCli.mjs';
    assert.equal(pkg?.scripts?.tsc, runner, `${packagePath} yarn tsc must use the shared native runner`);

    for (const scriptName of ['build', 'build:esm', 'typecheck', 'types:check', 'typecheck:activity-surfaces']) {
      const script = String(pkg?.scripts?.[scriptName] ?? '');
      assert.doesNotMatch(script, /(^|&&\s*)tsc\b|typescript\/(?:lib|bin)\/tsc/,
        `${packagePath} ${scriptName} must not bypass native compiler ownership`);
    }
  }
});

test('dist-exporting TypeScript workspaces use the staged builder or one proven custom owner', async () => {
  const customAtomicOwners = new Set(['apps/cli', 'packages/cli-common']);
  const observedCustomOwners = [];

  for (const { packagePath, pkg } of await readDistExportingTypeScriptWorkspacePackages()) {
    if (customAtomicOwners.has(packagePath)) {
      observedCustomOwners.push(packagePath);
      continue;
    }
    const buildScript = [pkg?.scripts?.build, pkg?.scripts?.['build:esm']]
      .map((value) => String(value ?? ''))
      .join('\n');
    assert.match(
      buildScript,
      /scripts\/workspaces\/buildTypeScriptPackageDist\.mjs -p tsconfig\.json\b/,
      `${packagePath} build must honor HAPPIER_WORKSPACE_DIST_OUTPUT_DIR`,
    );
  }

  assert.deepEqual(observedCustomOwners.sort(), [...customAtomicOwners].sort());
});

test('docs production builds run the native type gate before the Next bundle', async () => {
  const pkg = await readJson('apps/docs/package.json');
  const buildRunner = await readFile(resolve(repoRoot, 'apps/docs/scripts/build.mjs'), 'utf8');
  const nextConfig = await readFile(resolve(repoRoot, 'apps/docs/next.config.mjs'), 'utf8');

  assert.equal(pkg?.scripts?.build, 'node scripts/build.mjs');
  assert.match(buildRunner, /execYarn(?:Impl)?\(\['-s', 'types:check'\]/);
  assert.match(buildRunner, /next\/dist\/bin\/next/);
  assert.match(nextConfig, /typescript\s*:\s*\{[\s\S]*?ignoreBuildErrors\s*:\s*true/);
});

test('cli-common keeps the atomic build entrypoint and resolves typecheck through a shared TypeScript wrapper', async () => {
  const pkg = await readJson('packages/cli-common/package.json');

  assert.equal(String(pkg?.scripts?.build ?? ''), 'node scripts/build.mjs');
  assert.match(
    String(pkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'cli-common typecheck should use the shared TypeScript wrapper'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.build ?? ''),
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common build should not hardcode a repo-root TypeScript binary path'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.typecheck ?? ''),
    /\btsc\b|node_modules\/typescript\/bin\/tsc/,
    'cli-common typecheck should not invoke a shell-wrapper TypeScript binary path'
  );
});

test('workspace build and typecheck scripts use the shared Node-safe TypeScript wrapper instead of bare tsc shell shims', async () => {
  const agentsPkg = await readJson('packages/agents/package.json');
  const protocolPkg = await readJson('packages/protocol/package.json');
  const cliCommonPkg = await readJson('packages/cli-common/package.json');
  const connectionSupervisorPkg = await readJson('packages/connection-supervisor/package.json');
  const releaseRuntimePkg = await readJson('packages/release-runtime/package.json');

  assert.match(
    String(agentsPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/buildTypeScriptPackageDist\.mjs -p tsconfig\.json\b/,
    'agents build should use the staged shared TypeScript package builder'
  );
  assert.match(
    String(agentsPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'agents typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(protocolPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/buildTypeScriptPackageDist\.mjs -p tsconfig\.json\b/,
    'protocol build should use the staged shared TypeScript package builder'
  );
  assert.match(
    String(protocolPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'protocol typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(cliCommonPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'cli-common typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(connectionSupervisorPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/buildTypeScriptPackageDist\.mjs -p tsconfig\.json\b/,
    'connection-supervisor build should use the staged shared TypeScript package builder'
  );
  assert.match(
    String(connectionSupervisorPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'connection-supervisor typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(releaseRuntimePkg?.scripts?.['build:esm'] ?? ''),
    /scripts\/workspaces\/buildTypeScriptPackageDist\.mjs -p tsconfig\.json\b/,
    'release-runtime build:esm should honor the workspace staged-output contract'
  );

  for (const [label, script] of [
    ['agents build', agentsPkg?.scripts?.build],
    ['agents typecheck', agentsPkg?.scripts?.typecheck],
    ['protocol build', protocolPkg?.scripts?.build],
    ['protocol typecheck', protocolPkg?.scripts?.typecheck],
    ['cli-common typecheck', cliCommonPkg?.scripts?.typecheck],
    ['connection-supervisor build', connectionSupervisorPkg?.scripts?.build],
    ['connection-supervisor typecheck', connectionSupervisorPkg?.scripts?.typecheck],
    ['release-runtime build:esm', releaseRuntimePkg?.scripts?.['build:esm']],
  ]) {
    assert.doesNotMatch(
      String(script ?? ''),
      /\btsc\b/,
      `${label} should not invoke the bare tsc shell shim`
    );
  }
});
