import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build as bundle } from 'esbuild';
import ts from 'typescript';
import { syncBundledWorkspacePackages } from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import { resolveTypecheckCacheDirectory } from '../../../scripts/workspaces/workspaceSourceTypecheck.mjs';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { buildCliDist } from './build.mjs';
import { runPkgrollBuild } from './runPkgrollBuild.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';

function writeBuildPackageManifest(packageRoot: string) {
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/build-fixture',
    version: '0.0.0',
    main: './dist/index.cjs',
  }), 'utf8');
}

describe('buildCliDist', () => {
  it.each([false, true])('captures the real native exit helper across builds without retaining a removed input (private snapshot: %s)', async (skipLock) => {
    const packageRoot = createTempDirSync('happier-cli-build-native-exit-');
    try {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/build-fixture', version: '0.0.0', main: './dist/index.cjs', module: './dist/index.mjs',
      }));
      mkdirSync(join(packageRoot, 'src/terminal/host'), { recursive: true });
      mkdirSync(join(packageRoot, 'scripts'));
      const helperPath = join(packageRoot, 'scripts/native_process_exit.cjs');
      cpSync(fileURLToPath(new URL('./native_process_exit.cjs', import.meta.url)), helperPath);
      const helperDeclarationPath = join(packageRoot, 'scripts/native_process_exit.d.cts');
      cpSync(fileURLToPath(new URL('./native_process_exit.d.cts', import.meta.url)), helperDeclarationPath);
      writeFileSync(join(packageRoot, 'scripts/not-a-runtime-input.cjs'), 'throw new Error("must not be captured");\n');
      writeFileSync(join(packageRoot, 'src/terminal/host/borrowed.ts'), [
        "import { isNativeProcessExited } from '../../../scripts/native_process_exit.cjs';",
        "export const valid = isNativeProcessExited({ type: 'terminal-native-exited', code: 0, signal: null });",
        "export const invalid = isNativeProcessExited({ type: 'terminal-native-exited', code: null, signal: null });",
      ].join('\n'));
      writeFileSync(join(packageRoot, 'src/index.ts'), "export { valid, invalid } from './terminal/host/borrowed';\n");
      const roots: string[] = [];
      const initialFreshness = await readHappyCliRuntimeInputFreshness(packageRoot);
      let capturedHelper = readFileSync(helperPath, 'utf8');
      const options = {
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'), skipLock,
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime', npm_lifecycle_event: 'build:compiled' },
        // Keep the real executable bundler; observe only its admitted source boundary.
        runPkgrollBuildImpl: async (params: Parameters<typeof runPkgrollBuild>[0]) => {
          const root = dirname(params.packageJsonPath);
          roots.push(root);
          expect(existsSync(join(root, 'scripts/not-a-runtime-input.cjs'))).toBe(false);
          expect(readFileSync(join(root, 'scripts/native_process_exit.d.cts'), 'utf8'))
            .toBe(readFileSync(helperDeclarationPath, 'utf8'));
          if (roots.length === 1) writeFileSync(helperPath, `${capturedHelper}\n// New authored generation after admission.\n`);
          await runPkgrollBuild(params);
          expect(readFileSync(join(root, 'scripts/native_process_exit.cjs'), 'utf8')).toBe(capturedHelper);
        },
      };
      await buildCliDist(options);
      expect(await import(join(packageRoot, 'dist/index.mjs'))).toMatchObject({ valid: true, invalid: false });
      const firstManifest = JSON.parse(readFileSync(join(packageRoot, 'dist/.build-manifest.json'), 'utf8'));
      expect(firstManifest.inputFingerprint).toBe(initialFreshness?.fingerprint);
      const changedFreshness = await readHappyCliRuntimeInputFreshness(packageRoot);
      expect(changedFreshness?.fingerprint).not.toBe(initialFreshness?.fingerprint);
      capturedHelper = readFileSync(helperPath, 'utf8');
      await buildCliDist(options);
      expect(JSON.parse(readFileSync(join(packageRoot, 'dist/.build-manifest.json'), 'utf8')).inputFingerprint)
        .toBe(changedFreshness?.fingerprint);
      expect(roots[1] === roots[0]).toBe(!skipLock);
      rmSync(helperPath);
      await expect(buildCliDist({ ...options, runPkgrollBuildImpl: async (params: Parameters<typeof runPkgrollBuild>[0]) => {
        expect(existsSync(join(dirname(params.packageJsonPath), 'scripts/native_process_exit.cjs'))).toBe(false);
        await runPkgrollBuild(params);
      } })).rejects.toMatchObject({ code: 'EEXIT', exitCode: 1 });
      expect(readFileSync(join(packageRoot, 'dist/.build-manifest.json'), 'utf8')).toContain(changedFreshness!.fingerprint);
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });

  it.each([false, true])('consumes checked source partitions without another compiler and rejects a missing declaration (%s)', async (missingLeaf) => {
    const workspaceRoot = createTempDirSync('happier-cli-prepared-declarations-');
    const packageRoot = join(workspaceRoot, 'apps/cli');
    try {
      for (const app of ['cli', 'ui', 'server']) {
        mkdirSync(join(workspaceRoot, 'apps', app), { recursive: true });
        writeFileSync(join(workspaceRoot, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
      }
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ private: true }));
      writeFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/build-fixture', version: '0.0.0',
        main: './dist/index.cjs', module: './dist/index.mjs', types: './dist/index.d.cts',
      }));
      mkdirSync(join(packageRoot, 'src'));
      mkdirSync(join(packageRoot, 'node_modules'));
      symlinkSync(dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
        join(packageRoot, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(packageRoot, 'src/foundation.ts'), "export interface Result { label: string }; export const label = 'prepared';\n");
      writeFileSync(join(packageRoot, 'src/service.ts'), "import { label } from './foundation'; export const service = label;\n");
      writeFileSync(join(packageRoot, 'src/core-a.ts'), "import './core-b'; import { service } from './service'; export const label = service;\n");
      writeFileSync(join(packageRoot, 'src/core-b.ts'), "import './core-c';\n");
      writeFileSync(join(packageRoot, 'src/core-c.ts'), "import './core-a';\n");
      writeFileSync(join(packageRoot, 'src/index.ts'), "import { label } from './core-a'; import type { Result } from './foundation'; export const result: Result = { label };\n");
      writeFileSync(join(packageRoot, 'src/index.test.ts'), "import { result } from './index'; export const checked = result;\n");
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        strict: true, target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler',
        types: [], skipLibCheck: true, rootDir: 'src', noEmit: true, declaration: true,
      }, include: ['src/**/*.ts'] }));
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), '{"extends":"./tsconfig.json"}');
      const projectNames = ['foundation', 'services', 'core', 'source', 'test', 'test-ui'];
      for (const [index, name] of projectNames.entries()) {
        writeFileSync(join(packageRoot, `tsconfig.${name}.json`), JSON.stringify({
          extends: './tsconfig.json', compilerOptions: { composite: true, noEmit: false,
            emitDeclarationOnly: true, disableSourceOfProjectReferenceRedirect: true,
            outDir: `node_modules/.cache/tsc/${name}`, tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo` },
          files: name === 'test-ui' ? [] : [name === 'test' ? 'src/index.test.ts' : 'src/foundation.ts'], include: [],
          references: projectNames.slice(0, index).map(previous => ({ path: `./tsconfig.${previous}.json` })),
        }));
      }
      const compilerRunner = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/workspaces/runTypeScriptCli.mjs');
      const checked = spawnSync(process.execPath, [compilerRunner, '--singleThreaded',
        ...projectNames.flatMap(name => ['--project', `tsconfig.${name}.json`])], {
        // The prepared-declaration consumer reads Microsoft's workspace cache; tsrs keeps separate `.tsrs` caches.
        cwd: packageRoot, encoding: 'utf8', env: { ...process.env, HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' },
      });
      expect(checked.status, checked.stdout + checked.stderr).toBe(0);
      if (missingLeaf) rmSync(join(resolveTypecheckCacheDirectory(packageRoot), 'foundation/foundation.d.ts'));
      const build = buildCliDist({
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        preparedDeclarations: true,
        env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict', npm_lifecycle_event: 'build:prepared' },
        // The native compiler executable is the boundary. Prepared consumers
        // must never launch it after this same source graph has succeeded.
        runTypecheckImpl: () => { throw new Error('duplicate source compiler'); },
      });
      if (missingLeaf) {
        await expect(build).rejects.toThrow(/missing prepared CLI declaration.*foundation\.d\.ts/u);
        expect(existsSync(join(packageRoot, 'dist/index.mjs'))).toBe(false);
      } else {
        await build;
        expect(await import(join(packageRoot, 'dist/index.mjs'))).toMatchObject({ result: { label: 'prepared' } });
        expect(readFileSync(join(packageRoot, 'dist/index.d.cts'), 'utf8')).toMatch(/interface Result/u);
        // Publication must re-check current source even when a complete, valid
        // declaration graph was available to the preceding Gate consumer.
        writeFileSync(join(packageRoot, 'src/index.ts'), "export const result: number = 'invalid after preparation';\n");
        await expect(buildCliDist({
          packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
          preparedDeclarations: true,
          env: { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'prepack' },
        })).rejects.toThrow(/exited with status [12]/u);
        expect(readFileSync(join(packageRoot, 'dist/index.mjs'), 'utf8')).toContain('prepared');
      }
    } finally { rmSync(workspaceRoot, { recursive: true, force: true }); }
  });
  it.each(['source-dev', 'qa-runtime'])('emits semantic-invalid runtime without launching a checker (%s)', async (mode) => {
    const packageRoot = createTempDirSync('happier-cli-runtime-emission-');
    try {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/build-fixture', version: '0.0.0',
        main: './dist/index.cjs', module: './dist/index.mjs', types: './dist/index.d.cts',
      }));
      const compiler = join(packageRoot, 'compiler.cjs');
      const checked = join(packageRoot, 'checked');
      writeFileSync(compiler, `require('node:fs').writeFileSync(${JSON.stringify(checked)}, 'started'); process.exit(1);`);
      mkdirSync(join(packageRoot, 'src'));
      mkdirSync(join(packageRoot, 'node_modules'));
      // Pkgroll's public declaration compiler resolves its optional API peer
      // from the package it builds, including this isolated fixture.
      symlinkSync(dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
        join(packageRoot, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = 42;\n');
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ['src/index.ts'],
      }));
      await buildCliDist({
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: mode, npm_lifecycle_event: 'build:prepared' },
        resolveTypeScriptCliInvocationImpl: () => ({ argsPrefix: [compiler] }),
      });
      expect(existsSync(checked)).toBe(false);
      expect(readFileSync(join(packageRoot, 'dist', 'index.mjs'), 'utf8')).toContain('runtime = 42');
      expect(existsSync(join(packageRoot, 'dist', 'index.d.cts'))).toBe(false);
      expect(JSON.parse(readFileSync(join(packageRoot, 'dist', '.build-manifest.json'), 'utf8')).stalePackages).toBeUndefined();
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });
  it.each(['strict', 'release'] as const)('rejects semantic errors in strict publication (%s)', async (mode) => {
    const packageRoot = createTempDirSync('happier-cli-qa-typecheck-');
    try {
      writeBuildPackageManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'));
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const invalid: string = 42;\n');
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), JSON.stringify({
        compilerOptions: { strict: true, declaration: true, noEmit: true, rootDir: 'src', types: [], skipLibCheck: true },
        include: ['src/index.ts'],
      }));
      let diagnostics = '';
      const options = {
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: mode === 'strict' ? 'strict' : 'qa-runtime',
          npm_lifecycle_event: mode === 'release' ? 'prepack' : 'build:prepared' },
        // Keep the real TypeScript process, source snapshot, lock and manifest.
        // Pkgroll is the external compiler boundary.
        runTypecheckImpl: (scriptPath: string, args: string[], options: { command?: string; cwd: string; env: NodeJS.ProcessEnv }) => {
          const result = spawnSync(options.command ?? process.execPath, [scriptPath, ...args], {
            cwd: options.cwd, env: options.env, encoding: 'utf8',
          });
          diagnostics = `${result.stdout}\n${result.stderr}`;
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(`Compiler exited with status ${result.status}`);
        },
        runPkgrollBuildImpl: ({ packageJsonPath, outputDir }: { packageJsonPath: string; outputDir: string }) => {
          const output = join(dirname(packageJsonPath), outputDir);
          mkdirSync(output, { recursive: true });
          writeFileSync(join(output, 'index.mjs'), 'export const runtime = 42;\n');
        },
      };
      await expect(buildCliDist(options)).rejects.toThrow(/exited with status [12]/u);
      expect(diagnostics).toContain('TS2322');
      expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });

  it('checks captured CLI source with the original published dependency declaration identities', async () => {
    const packageRoot = createTempDirSync('happier-cli-snapshot-declaration-identity-');
    try {
      writeBuildPackageManifest(packageRoot);
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const repoRoot = resolve(cliDir, '../..');
      const originalConfig = ts.readConfigFile(join(cliDir, 'tsconfig.json'), ts.sys.readFile);
      if (originalConfig.error) throw new Error(ts.flattenDiagnosticMessageText(originalConfig.error.messageText, '\n'));
      const paths = Object.fromEntries(Object.entries(originalConfig.config.compilerOptions.paths as Record<string, string[]>)
        .map(([name, targets]) => [name, targets.map(target => relative(packageRoot, resolve(cliDir, target)).replaceAll('\\', '/'))]));
      paths['@/*'] = ['./src/*'];
      mkdirSync(join(packageRoot, 'src'));
      mkdirSync(join(packageRoot, 'node_modules'));
      symlinkSync(dirname(createRequire(import.meta.url).resolve('zod/package.json')),
        join(packageRoot, 'node_modules/zod'), process.platform === 'win32' ? 'junction' : 'dir');
      syncBundledWorkspacePackages({ repoRoot, hostPackageDirs: [packageRoot], packages: ['agents', 'protocol'], pruneStale: true });
      writeFileSync(join(packageRoot, 'src/local.ts'), 'export const generation = "captured";\n');
      writeFileSync(join(packageRoot, 'src/index.ts'), [
        "import { generation } from '@/local';",
        "import { z } from 'zod/mini';",
        "import { StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';",
        'const exactGeneration: "captured" = generation;',
        // Match the published API owner: re-export its declaration identity,
        // rather than inventing a new inferred schema value in the consumer.
        "export { StoredMachinePublishedMetadataV1Schema as MachineMetadataSchema } from '@happier-dev/protocol/machines/machinePublishedContentV1';",
        'export type MachineMetadata = z.infer<typeof StoredMachinePublishedMetadataV1Schema>;',
      ].join('\n'));
      const authoredConfig = JSON.stringify({
        compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src',
          strict: true, declaration: true, noEmit: true, skipLibCheck: true, types: [], paths },
        include: ['src/index.ts'],
      });
      writeFileSync(join(packageRoot, 'tsconfig.json'), authoredConfig);
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), '{"extends":"./tsconfig.json"}');
      let diagnostics = '';
      await buildCliDist({
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', npm_lifecycle_event: 'build:prepared' },
        runTypecheckImpl: (scriptPath: string, args: string[], options: { command?: string; cwd: string; env: NodeJS.ProcessEnv }) => {
          // The captured source must remain authoritative when the live file changes.
          writeFileSync(join(packageRoot, 'src/local.ts'), 'export const generation = "newer";\n');
          const result = spawnSync(options.command ?? process.execPath, [scriptPath, ...args], {
            cwd: options.cwd, env: options.env, encoding: 'utf8',
          });
          diagnostics = `${result.stdout}\n${result.stderr}`;
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(diagnostics);
        },
        // Replace only the external executable bundler, after the real native checker.
        runPkgrollBuildImpl: ({ packageJsonPath, outputDir }: { packageJsonPath: string; outputDir: string }) => {
          const output = join(dirname(packageJsonPath), outputDir);
          mkdirSync(output, { recursive: true });
          writeFileSync(join(output, 'index.mjs'), 'export const checked = true;\n');
        },
      });
      expect(diagnostics).not.toMatch(/TS2883|TS2322/);
      expect(readFileSync(join(packageRoot, 'dist/index.mjs'), 'utf8')).toContain('checked = true');
      expect(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')).toBe(authoredConfig);
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });

  it.each(['source-dev', 'qa-runtime'])('rejects invalid syntax at the executable compiler (%s)', async (mode) => {
    const packageRoot = createTempDirSync('happier-cli-qa-bundler-');
    try {
      writeBuildPackageManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'));
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const = ;\n');
      await expect(buildCliDist({
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: mode, npm_lifecycle_event: 'build:prepared' },
        runPkgrollBuildImpl: ({ packageJsonPath, outputDir }: { packageJsonPath: string; outputDir: string }) => bundle({
          entryPoints: [join(dirname(packageJsonPath), 'src', 'index.ts')],
          outfile: join(dirname(packageJsonPath), outputDir, 'index.mjs'),
          format: 'esm', bundle: true, logLevel: 'silent',
        }),
      })).rejects.toThrow('Build failed');
      expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });

  it.each(['strict', 'qa-runtime'])('rejects a compiler process failure (%s)', async (mode) => {
    const packageRoot = createTempDirSync('happier-cli-qa-process-failure-');
    try {
      writeBuildPackageManifest(packageRoot);
      const compiler = join(packageRoot, 'compiler.cjs');
      writeFileSync(compiler, 'process.stderr.write("Compiler startup failed\\n"); process.exit(2);');
      await expect(buildCliDist({
        packageRoot, repoRoot: packageRoot, lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: mode, npm_lifecycle_event: 'build:prepared' },
        // Execute a real failing process at the compiler boundary.
        resolveTypeScriptCliInvocationImpl: () => ({ argsPrefix: [compiler] }),
        runPkgrollBuildImpl: () => {
          const result = spawnSync(process.execPath, [compiler], { encoding: 'utf8' });
          if (result.status !== 0) throw new Error(`Bundler exited with status ${result.status}`);
        },
      })).rejects.toThrow('exited with status 2');
      expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });

  it('keeps explicit compiler emission out of the TypeScript source tree', () => {
    const packageRoot = createTempDirSync('happier-cli-compiler-output-contract-');
    try {
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const repoRoot = resolve(cliDir, '..', '..');
      const cliConfigRaw = readFileSync(join(cliDir, 'tsconfig.json'), 'utf8');
      const configuredOutDir = cliConfigRaw.match(/"outDir"\s*:\s*"([^"]+)"/)?.[1];
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          rootDir: 'src',
          outDir: configuredOutDir,
          declaration: true,
          sourceMap: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }), 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime = "current";\n', 'utf8');

      const compilerRunner = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
      const emitted = spawnSync(
        process.execPath,
        [compilerRunner, '-p', 'tsconfig.json', '--noEmit', 'false'],
        {
          cwd: packageRoot,
          encoding: 'utf8',
        },
      );

      expect(emitted.status, emitted.stderr || emitted.stdout).toBe(0);
      expect(existsSync(join(packageRoot, 'src', 'index.js'))).toBe(false);
      expect(existsSync(join(packageRoot, 'src', 'index.d.ts'))).toBe(false);
      expect(configuredOutDir).toBe('dist/.tsc');
      expect(existsSync(join(packageRoot, 'dist', '.tsc', 'index.js'))).toBe(true);
      expect(existsSync(join(packageRoot, 'dist', '.tsc', 'index.d.ts'))).toBe(true);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('admits test-only type errors while runtime type errors still fail', () => {
    const packageRoot = createTempDirSync('happier-cli-runtime-tsconfig-contract-');
    try {
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const repoRoot = resolve(cliDir, '..', '..');
      const buildConfig = JSON.parse(readFileSync(join(cliDir, 'tsconfig.build.json'), 'utf8')) as {
        include?: string[];
        exclude?: string[];
      };
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts'],
      }), 'utf8');
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), JSON.stringify({
        extends: './tsconfig.json',
        include: buildConfig.include,
        exclude: buildConfig.exclude,
      }), 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = "valid";\n', 'utf8');
      writeFileSync(join(packageRoot, 'src', 'runtime.test.ts'), 'export const testOnly: string = 1;\n', 'utf8');

      const compilerRunner = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
      const testOnlyError = spawnSync(process.execPath, [compilerRunner, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(testOnlyError.status, testOnlyError.stderr || testOnlyError.stdout).toBe(0);

      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = 1;\n', 'utf8');
      const runtimeError = spawnSync(process.execPath, [compilerRunner, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(runtimeError.status).not.toBe(0);
      expect(`${runtimeError.stdout}\n${runtimeError.stderr}`).toContain('index.ts');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('reuses the locked compiler cache without admitting changed errors or retaining deleted sources', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-incremental-');
    try {
      writeBuildPackageManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          incremental: true,
          declaration: true,
          rootDir: 'src',
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }));
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: { tsBuildInfoFile: 'node_modules/.cache/tsc/cli.build.typecheck.tsbuildinfo' },
      }));
      const sourcePath = join(packageRoot, 'src', 'index.ts');
      writeFileSync(sourcePath, 'export const runtime: string = "first";\n');
      writeFileSync(join(packageRoot, 'src', 'deleted.ts'), 'export const removed = true;\n');
      const compiledRoots: string[] = [];
      const options = {
        packageRoot,
        repoRoot: packageRoot,
        lockPath: join(packageRoot, 'build.lock'),
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: '', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
        // Pkgroll is the compiler/process boundary. Keep source admission,
        // TypeScript, cache handling, the lock and publication real.
        runPkgrollBuildImpl: ({ packageJsonPath, outputDir }: { packageJsonPath: string; outputDir: string }) => {
          const compiledRoot = dirname(packageJsonPath);
          compiledRoots.push(compiledRoot);
          mkdirSync(join(compiledRoot, outputDir), { recursive: true });
          for (const name of ['index.mjs', 'index.cjs']) {
            writeFileSync(join(compiledRoot, outputDir, name), name.endsWith('.mjs')
              ? 'export const built = true;\n'
              : 'module.exports = {};\n');
          }
        },
      };
      await buildCliDist(options);
      const compilerCache = join(compiledRoots[0], 'node_modules/.cache/tsc/cli.build.typecheck.tsbuildinfo');
      expect(existsSync(compilerCache)).toBe(true);
      await buildCliDist(options);
      expect(compiledRoots[1]).toBe(compiledRoots[0]);

      writeFileSync(sourcePath, 'export const runtime: string = 42;\n');
      await expect(buildCliDist(options)).rejects.toThrow(/exited with status [12]/u);
      await expect(buildCliDist(options)).rejects.toThrow(/exited with status [12]/u);
      expect(compiledRoots).toHaveLength(2);
      expect(existsSync(join(packageRoot, 'dist', 'index.mjs'))).toBe(true);

      writeFileSync(sourcePath, 'export const runtime: string = "recovered";\n');
      rmSync(join(packageRoot, 'src', 'deleted.ts'));
      await buildCliDist({
        ...options,
        runPkgrollBuildImpl: (params: { packageJsonPath: string; outputDir: string }) => {
          expect(existsSync(join(dirname(params.packageJsonPath), 'src', 'deleted.ts'))).toBe(false);
          options.runPkgrollBuildImpl(params);
        },
      });
      expect(compiledRoots[2]).toBe(compiledRoots[0]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('holds the CLI dist build lock across typecheck, bundle, and finalize without publishing package dist', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-lock-section-');
    try {
      writeBuildPackageManifest(packageRoot);
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const eventsPath = join(packageRoot, 'events.txt');
      const typecheckInvocations: unknown[][] = [];
      let wrapperOutputDir = '';
      let checkedDeclarationSourceDir = '';

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
        lockPath,
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {
          writeFileSync(eventsPath, 'rm\n', { flag: 'a' });
        },
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (...args: unknown[]) => {
          typecheckInvocations.push(args);
          writeFileSync(eventsPath, 'typecheck\n', { flag: 'a' });
        },
        runPkgrollBuildImpl: ({ outputDir, declarationSourceDir }: { outputDir: string; declarationSourceDir: string }) => {
          wrapperOutputDir = outputDir;
          checkedDeclarationSourceDir = declarationSourceDir;
          expect(existsSync(lockPath)).toBe(true);
          expect(existsSync(declarationSourceDir)).toBe(true);
          writeFileSync(eventsPath, 'bundle\n', { flag: 'a' });
        },
        finalizeDistImpl: () => {
          expect(existsSync(lockPath)).toBe(true);
          writeFileSync(eventsPath, 'finalize\n', { flag: 'a' });
        },
      });

      expect(readFileSync(eventsPath, 'utf8')).toBe('rm\ntypecheck\nbundle\nfinalize\n');
      expect(wrapperOutputDir).toBe(`dist.staging.${process.pid}`);
      expect(typecheckInvocations).toEqual([
        [
          '/canonical/runTypeScriptCli.mjs',
          ['-p', 'tsconfig.build.json', '--noEmit', 'false', '--emitDeclarationOnly', '--singleThreaded', '--noCheck', 'false', '--outDir', checkedDeclarationSourceDir],
          expect.objectContaining({ cwd: realpathSync.native(packageRoot) }),
        ],
      ]);
      expect(existsSync(checkedDeclarationSourceDir)).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('finalizes the admitted immutable CLI build when live runtime inputs change during the build', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-input-currentness-');
    try {
      writeBuildPackageManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "admitted";\n', 'utf8');
      const initialFingerprint = 'a'.repeat(64);
      let finalized = false;
      let bundledSource = '';
      let typecheckCwd = '';

      let finalizedInputFingerprint: string | undefined;
      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (
          _scriptPath: string,
          _args: string[],
          options: { cwd: string },
        ) => {
          typecheckCwd = options.cwd;
          writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "newer";\n', 'utf8');
        },
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          bundledSource = readFileSync(join(dirname(packageJsonPath), 'src', 'index.ts'), 'utf8');
        },
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: initialFingerprint,
          newestMtimeNs: 1n,
        }),
        finalizeDistImpl: (options: { inputFingerprint?: string }) => {
          finalized = true;
          finalizedInputFingerprint = options.inputFingerprint;
        },
      });

      expect(finalized).toBe(true);
      expect(finalizedInputFingerprint).toBe(initialFingerprint);
      expect(typecheckCwd).not.toBe(packageRoot);
      expect(dirname(typecheckCwd)).toBe(realpathSync.native(packageRoot));
      expect(bundledSource).toContain('"admitted"');
      expect(readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')).toContain('"newer"');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('publishes the post-prebuild generation that the immutable CLI source snapshot actually contains', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-prebuild-fingerprint-');
    try {
      writeBuildPackageManifest(packageRoot);
      const postPrebuildFingerprint = 'b'.repeat(64);
      const workspaceRuntimeFingerprint = 'c'.repeat(64);
      const workspaceRuntimePackages = ['@happier-dev/protocol'] as const;
      let finalized = false;
      let finalizedInputFingerprint: string | undefined;
      let finalizedWorkspaceRuntimePackages: readonly string[] | undefined;

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {},
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: postPrebuildFingerprint,
          newestMtimeNs: 2n,
        }),
        readWorkspaceRuntimeIdentityImpl: () => ({
          fingerprint: workspaceRuntimeFingerprint,
          packageCount: workspaceRuntimePackages.length,
          packageNames: workspaceRuntimePackages,
        }),
        finalizeDistImpl: (options: {
          inputFingerprint?: string;
          workspaceRuntimePackages?: readonly string[];
        }) => {
          finalized = true;
          finalizedInputFingerprint = options.inputFingerprint;
          finalizedWorkspaceRuntimePackages = options.workspaceRuntimePackages;
        },
      });

      expect(finalized).toBe(true);
      expect(finalizedInputFingerprint).toBe(postPrebuildFingerprint);
      expect(finalizedWorkspaceRuntimePackages).toEqual(workspaceRuntimePackages);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('refuses to publish when the workspace runtime changes during bundling', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-workspace-runtime-race-');
    try {
      const dependencyName = '@happier-dev/build-dependency';
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/build-fixture', version: '0.0.0', main: './dist/index.cjs',
        dependencies: { [dependencyName]: '0.0.0' }, bundledDependencies: [dependencyName],
      }));
      const dependencyRoots = [
        join(packageRoot, 'packages', 'build-dependency'),
        join(packageRoot, 'node_modules', '@happier-dev', 'build-dependency'),
      ];
      for (const root of dependencyRoots) {
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({
          name: dependencyName, version: '0.0.0', type: 'module', exports: './dist/index.js',
        }));
        writeFileSync(join(root, 'dist', 'index.js'), 'export const generation = "admitted";\n');
      }
      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {
          // A real external bundler process can overlap prepared publication.
          // Keep the physical dependency reader and refusal fence real.
          writeFileSync(join(dependencyRoots[1], 'dist', 'index.js'), 'export const generation = "newer";\n');
        },
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: 'c'.repeat(64),
          newestMtimeNs: 1n,
        }),
        finalizeDistImpl: () => {
          throw new Error('mixed workspace runtime must not be finalized');
        },
      })).rejects.toThrow(/workspace runtime publication changed during the CLI build/i);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('removes its default private stage and abandoned build generations when bundling fails', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-stage-cleanup-');
    try {
      writeBuildPackageManifest(packageRoot);
      const stagingDir = join(packageRoot, `dist.staging.${process.pid}`);
      const abandonedSourceDir = join(packageRoot, '.tmp.hstack-cli-build-source.abandoned');
      const abandonedStagingDir = join(packageRoot, 'dist.staging.1001');
      mkdirSync(abandonedSourceDir, { recursive: true });
      writeFileSync(join(abandonedSourceDir, 'partial.ts'), 'abandoned\n', 'utf8');
      mkdirSync(abandonedStagingDir, { recursive: true });
      writeFileSync(join(abandonedStagingDir, 'partial.mjs'), 'abandoned\n', 'utf8');

      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: ({ outputDir }: { outputDir: string }) => {
          mkdirSync(join(packageRoot, outputDir), { recursive: true });
          writeFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('bundle failed');
        },
        finalizeDistImpl: () => {
          throw new Error('finalize must not run');
        },
      })).rejects.toThrow('bundle failed');

      expect(existsSync(stagingDir)).toBe(false);
      expect(existsSync(abandonedSourceDir)).toBe(false);
      expect(existsSync(abandonedStagingDir)).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('preserves a caller-owned explicit build output when bundling fails', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-caller-stage-');
    try {
      writeBuildPackageManifest(packageRoot);
      const outputDir = 'caller-output';
      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: outputDir },
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {
          mkdirSync(join(packageRoot, outputDir), { recursive: true });
          writeFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('bundle failed');
        },
        finalizeDistImpl: () => {},
      })).rejects.toThrow('bundle failed');

      expect(readFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'utf8')).toBe('partial\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects a production typecheck terminated by a signal before bundling', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-typecheck-signal-');
    try {
      writeBuildPackageManifest(packageRoot);
      const killedCompiler = join(packageRoot, 'killed-compiler.mjs');
      writeFileSync(killedCompiler, 'process.kill(process.pid, "SIGTERM");\n', 'utf8');
      let bundleStarted = false;

      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: [killedCompiler],
        }),
        runPkgrollBuildImpl: () => {
          bundleStarted = true;
        },
        finalizeDistImpl: () => {},
        syncPackageDistImpl: () => {},
      })).rejects.toThrow(/terminated by signal SIGTERM/);
      expect(bundleStarted).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes a directory alias before lock, cwd, and wrapper decisions', async () => {
    const fixtureRoot = createTempDirSync('happier-cli-build-physical-root-');
    const aliasRoot = createTempDirSync('happier-cli-build-alias-root-');
    const physicalPackageRoot = join(fixtureRoot, 'apps', 'cli');
    const aliasPackageRoot = join(aliasRoot, 'apps', 'cli');
    mkdirSync(join(fixtureRoot, 'apps'), { recursive: true });
    mkdirSync(join(aliasRoot, 'apps'), { recursive: true });
    mkdirSync(physicalPackageRoot, { recursive: true });
    writeBuildPackageManifest(physicalPackageRoot);
    writeFileSync(join(fixtureRoot, 'package.json'), '{"private":true}\n', 'utf8');
    writeFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
    writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    symlinkSync(
      physicalPackageRoot,
      aliasPackageRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const observed: {
      typecheckCwd?: string;
      packageJsonPath?: string;
      finalizeRoot?: string;
    } = {};
    try {
      await buildCliDist({
        packageRoot: aliasPackageRoot,
        env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (_script: string, _args: string[], options: { cwd: string }) => {
          observed.typecheckCwd = options.cwd;
        },
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          observed.packageJsonPath = packageJsonPath;
        },
        finalizeDistImpl: ({ packageRoot }: { packageRoot: string }) => {
          observed.finalizeRoot = packageRoot;
        },
      });

      expect(observed).toEqual({
        typecheckCwd: realpathSync.native(physicalPackageRoot),
        packageJsonPath: realpathSync.native(join(physicalPackageRoot, 'package.json')),
        finalizeRoot: realpathSync.native(physicalPackageRoot),
      });
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails on a missing package manifest before waiting for the outer build lock', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-missing-manifest-');
    const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const { withWorkspaceBundleLock } = await import('../../../scripts/workspaces/workspaceBundleLock.mjs');
    try {
      await withWorkspaceBundleLock(
        async () => {
          await expect(buildCliDist({
            packageRoot,
            repoRoot: packageRoot,
            lockPath,
            lockTimeoutMs: 60,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 5_000,
          })).rejects.toThrow(/ENOENT|no such file or directory/i);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 5_000,
        },
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
