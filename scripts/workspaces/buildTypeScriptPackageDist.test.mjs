import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTypeScriptPackageDist } from './buildTypeScriptPackageDist.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createPackageFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `happier-${name}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    name: `@happier-dev/${name}`,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
  });
  await writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  });
  await writeFile(join(root, 'dist', 'index.js'), 'export const stable = true;\n', 'utf-8');
  await writeFile(join(root, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  return root;
}

async function createPackageFixtureWithUiArtifacts(t, name) {
  const packageDir = await createPackageFixture(t, name);
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  packageJson.exports['./happier-plugin-ui/*'] = './dist/happier-plugin-ui/*';
  packageJson.scripts = {
    build: 'fixture-build',
    'build:ui': 'fixture-build-ui',
  };
  await writeJson(packageJsonPath, packageJson);
  await mkdir(join(packageDir, 'dist', 'happier-plugin-ui'), { recursive: true });
  await writeFile(
    join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
    '{"version":1,"entries":["known-good"]}\n',
    'utf-8',
  );
  return packageDir;
}

function writeTypeScriptFixtureOutput(args) {
  const outDir = args[args.indexOf('--outDir') + 1];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
  writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
  return outDir;
}

test('buildTypeScriptPackageDist preserves previous dist when TypeScript compilation fails', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-fail');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n', 'utf-8');

  await assert.rejects(
    () =>
      buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: () => ({ status: 1 }),
      }),
    /failed with code|TypeScript package build failed/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
});

test('buildTypeScriptPackageDist composes an explicit staged UI producer before validating wildcard exports', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-composition');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let uiBuildCalls = 0;

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    resolveYarnCommandInvocationImpl: () => ({ command: 'yarn', args: ['-s', 'build:ui'] }),
    runCommandImpl: (_command, args, options) => {
      if (args.includes('tsconfig.json')) {
        writeTypeScriptFixtureOutput(args);
        return { status: 0 };
      }
      if (args.includes('build:ui')) {
        uiBuildCalls += 1;
        const outputDir = options.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        assert.equal(typeof outputDir, 'string');
        mkdirSync(join(outputDir, 'happier-plugin-ui'), { recursive: true });
        writeFileSync(
          join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
          '{"version":1,"entries":["rebuilt"]}\n',
          'utf-8',
        );
        return { status: 0 };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    },
  });

  assert.equal(uiBuildCalls, 1);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const built = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["rebuilt"]}\n',
  );
});

test('buildTypeScriptPackageDist preserves the complete prior dist when the staged UI producer fails', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-failure');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let uiBuildCalls = 0;

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      resolveYarnCommandInvocationImpl: () => ({ command: 'yarn', args: ['-s', 'build:ui'] }),
      runCommandImpl: (_command, args) => {
        if (args.includes('tsconfig.json')) {
          writeTypeScriptFixtureOutput(args);
          return { status: 0 };
        }
        if (args.includes('build:ui')) {
          uiBuildCalls += 1;
          return { status: 1 };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    }),
    /staged package output script "build:ui" failed/i,
  );

  assert.equal(uiBuildCalls, 1);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist rejects a wildcard export whose staged output has no matching file', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-missing-output');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        writeTypeScriptFixtureOutput(args);
        return { status: 0 };
      },
    }),
    /happier-plugin-ui\/\*/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist does not invoke a staged output producer when TypeScript fails', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-ts-failure');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n', 'utf-8');
  let uiBuildCalls = 0;

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      resolveYarnCommandInvocationImpl: () => ({ command: 'yarn', args: ['-s', 'build:ui'] }),
      runCommandImpl: (_command, args) => {
        if (args.includes('tsconfig.json')) return { status: 1 };
        if (args.includes('build:ui')) uiBuildCalls += 1;
        return { status: 0 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(uiBuildCalls, 0);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist can write to an explicit staged output directory without mutating live dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-staged');
  const stagedDist = join(packageDir, '.staged-dist');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: stagedDist,
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.match(await readFile(join(stagedDist, 'index.js'), 'utf-8'), /built/);
});

test('buildTypeScriptPackageDist keeps TypeScript incremental metadata out of promoted dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-incremental-metadata');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, '{}\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(packageDir, 'dist', '.tsbuildinfo')), false);
});

test('buildTypeScriptPackageDist promotes live dist under the canonical package build lock', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-lock');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let observedLockOptions = null;
  let compilerLockValue = null;

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    withWorkspaceBundleLockImpl: async (fn, options) => {
      observedLockOptions = options;
      return await fn({ heldLockValue: 'test-package-lock-lease' });
    },
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args, options) => {
      compilerLockValue = options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.match(observedLockOptions?.lockPath ?? '', /\.dist-build-happier-dev-build-ts-package-lock\.lock$/);
  assert.equal(compilerLockValue, 'test-package-lock-lease');
});

test('buildTypeScriptPackageDist rejects staged builds with missing local import targets', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-missing-local-import');
  await writeFile(join(packageDir, 'src', 'index.ts'), "export * from './internal.js';\n", 'utf-8');

  await assert.rejects(
    () =>
      buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: (_command, args) => {
          const outDir = args[args.indexOf('--outDir') + 1];
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'index.js'), "export * from './internal.js';\n", 'utf-8');
          writeFileSync(join(outDir, 'index.d.ts'), "export * from './internal.js';\n", 'utf-8');
          return { status: 0 };
        },
      }),
    /missing local imports|internal\.js/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
});

test('buildTypeScriptPackageDist marks declared bin targets executable in the promoted dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-bin');
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  packageJson.bin = { 'happier-example-bin': './dist/bin.js' };
  packageJson.exports['./bin'] = { default: './dist/bin.js' };
  await writeJson(packageJsonPath, packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      // tsc emits 0644 files; the shebang is preserved but the executable bit is not.
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(join(outDir, 'bin.js'), '#!/usr/bin/env node\nexport const bin = true;\n', { encoding: 'utf-8', mode: 0o644 });
      return { status: 0 };
    },
  });

  const { statSync } = await import('node:fs');
  const mode = statSync(join(packageDir, 'dist', 'bin.js')).mode;
  assert.equal(mode & 0o111, 0o111, 'bin target should be executable for user/group/other');
});
