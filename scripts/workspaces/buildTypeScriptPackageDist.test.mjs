import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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

async function hashFixtureDist(distDir) {
  const hash = createHash('sha256');
  for (const relativePath of ['index.js', 'index.d.ts']) {
    hash.update(relativePath);
    hash.update(await readFile(join(distDir, relativePath)));
  }
  return hash.digest('hex');
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

test('buildTypeScriptPackageDist reuses one stable compiler work tree across staged output destinations', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-persistent-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  const stagedOutputs = [join(packageDir, '.stage-one'), join(packageDir, '.stage-two')];
  const compilerRuns = [];

  for (const outputDir of stagedOutputs) {
    await buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      outputDir,
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        const compilerOutputDir = args[args.indexOf('--outDir') + 1];
        const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
        compilerRuns.push({ compilerOutputDir, tsBuildInfoFile });
        mkdirSync(compilerOutputDir, { recursive: true });
        writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
        writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
        writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
        return { status: 0 };
      },
    });
  }

  assert.equal(compilerRuns.length, 2);
  assert.equal(compilerRuns[1].compilerOutputDir, compilerRuns[0].compilerOutputDir);
  assert.equal(compilerRuns[1].tsBuildInfoFile, compilerRuns[0].tsBuildInfoFile);
  assert.notEqual(compilerRuns[0].compilerOutputDir, stagedOutputs[0]);
  assert.notEqual(compilerRuns[1].compilerOutputDir, stagedOutputs[1]);
  assert.equal(existsSync(compilerRuns[0].tsBuildInfoFile), true);
  assert.match(await readFile(join(stagedOutputs[1], 'index.js'), 'utf-8'), /built/);
});

test('buildTypeScriptPackageDist permits an incremental repeat but does not replace identical dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-unchanged-repeat');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerRuns = 0;
  const compilerOutputDirs = new Set();
  const runCommandImpl = (_command, args) => {
    compilerRuns += 1;
    const compilerOutputDir = args[args.indexOf('--outDir') + 1];
    compilerOutputDirs.add(compilerOutputDir);
    const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
    mkdirSync(compilerOutputDir, { recursive: true });
    writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
    writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
    writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
    return { status: 0 };
  };
  const buildOptions = {
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl,
  };

  await buildTypeScriptPackageDist(buildOptions);
  const before = statSync(join(packageDir, 'dist'));
  const beforeHash = await hashFixtureDist(join(packageDir, 'dist'));

  await buildTypeScriptPackageDist(buildOptions);

  const after = statSync(join(packageDir, 'dist'));
  const afterHash = await hashFixtureDist(join(packageDir, 'dist'));
  assert.equal(compilerRuns, 2, 'a cheap incremental compiler invocation remains allowed');
  assert.equal(compilerOutputDirs.size, 1, 'promoted builds share one stable compiler output tree');
  assert.equal(after.ino, before.ino, 'identical staged bytes must not replace the last-green dist directory');
  assert.equal(after.mtimeMs, before.mtimeMs, 'identical staged bytes must not mutate the last-green dist directory');
  assert.equal(afterHash, beforeHash);
});

test('buildTypeScriptPackageDist resets a corrupt compiler cache without replacing last-green dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-corrupt-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const green = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const green: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });
  await writeFile(tsBuildInfoFile, '{not-json', 'utf-8');

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
        assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
        assert.equal(existsSync(tsBuildInfoFile), false, 'corrupt compiler state must be discarded before reuse');
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(
    await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'),
    'export const green = true;\n',
  );
});

test('buildTypeScriptPackageDist discards an interrupted compiler cache without replacing last-green dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-interrupted-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const green = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const green: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });
  await rm(tsBuildInfoFile);

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
        assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
        assert.equal(existsSync(join(compilerOutputDir, 'index.js')), false);
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(
    await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'),
    'export const green = true;\n',
  );
});

test('buildTypeScriptPackageDist discards partial compiler state left by a failed compile before retrying', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-failed-cache-update');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        compilerOutputDir = args[args.indexOf('--outDir') + 1];
        tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
        mkdirSync(compilerOutputDir, { recursive: true });
        writeFileSync(join(compilerOutputDir, 'index.js'), 'export const partial = true;\n', 'utf-8');
        writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
      assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
      assert.equal(existsSync(join(compilerOutputDir, 'index.js')), false);
      assert.equal(existsSync(tsBuildInfoFile), false);
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const rebuilt = true;\n');
});

test('buildTypeScriptPackageDist invalidates its stable cache when compiler state tracks a renamed source', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-renamed-source');
  const removedSourcePath = join(packageDir, 'src', 'removed.ts');
  const renamedSourcePath = join(packageDir, 'src', 'renamed.ts');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  await writeFile(removedSourcePath, 'export const removed = true;\n', 'utf-8');
  let compilerOutputDir = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: join(packageDir, '.first-stage'),
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'removed.js'), 'export const removed = true;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts', 'src/removed.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });
  await rm(removedSourcePath);
  await writeFile(renamedSourcePath, 'export const renamed = true;\n', 'utf-8');

  const secondStage = join(packageDir, '.second-stage');
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: secondStage,
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
      assert.equal(existsSync(join(compilerOutputDir, 'removed.js')), false);
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'renamed.js'), 'export const renamed = true;\n', 'utf-8');
      writeFileSync(
        tsBuildInfoFile,
        JSON.stringify({ fileNames: ['src/index.ts', 'src/renamed.ts'] }),
        'utf-8',
      );
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(secondStage, 'removed.js')), false);
  assert.equal(existsSync(join(secondStage, 'renamed.js')), true);
  assert.match(await readFile(join(secondStage, 'index.js'), 'utf-8'), /rebuilt/);
});

test('buildTypeScriptPackageDist invalidates its stable cache when the compiler project excludes a prior source', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-config-change');
  const excludedSourcePath = join(packageDir, 'src', 'excluded.ts');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  await writeFile(excludedSourcePath, 'export const excluded = true;\n', 'utf-8');
  let compilerOutputDir = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: join(packageDir, '.config-first-stage'),
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'excluded.js'), 'export const excluded = true;\n', 'utf-8');
      writeFileSync(
        tsBuildInfoFile,
        JSON.stringify({ fileNames: ['src/index.ts', 'src/excluded.ts'] }),
        'utf-8',
      );
      return { status: 0 };
    },
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8'));
  await writeJson(tsconfigPath, { ...tsconfig, include: ['src/index.ts'] });

  const secondStage = join(packageDir, '.config-second-stage');
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: secondStage,
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
      assert.equal(existsSync(join(compilerOutputDir, 'excluded.js')), false);
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(secondStage, 'excluded.js')), false);
  assert.match(await readFile(join(secondStage, 'index.js'), 'utf-8'), /rebuilt/);
});

test('buildTypeScriptPackageDist does not republish a deleted TypeScript emit from its real incremental cache', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-real-deleted-source');
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8'));
  tsconfig.compilerOptions.incremental = true;
  await writeJson(tsconfigPath, tsconfig);

  const deletedSourcePath = join(packageDir, 'src', 'removed.ts');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  await writeFile(deletedSourcePath, 'export const removed = true;\n', 'utf-8');
  const firstStage = join(packageDir, '.real-first-stage');
  const secondStage = join(packageDir, '.real-second-stage');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: firstStage,
    stdio: 'ignore',
  });
  assert.equal(existsSync(join(firstStage, 'removed.js')), true);

  await rm(deletedSourcePath);
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: secondStage,
    stdio: 'ignore',
  });

  assert.equal(existsSync(join(secondStage, 'removed.js')), false);
  assert.match(await readFile(join(secondStage, 'index.js'), 'utf-8'), /built/);
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
  if (process.platform !== 'win32') {
    assert.equal(mode & 0o111, 0o111, 'bin target should be executable for user/group/other');
  }
});
