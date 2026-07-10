import { describe, expect, it } from 'vitest';
import { readFileSync, realpathSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  copyCliBinRuntimeFiles,
  copyCliWorkspaceSyncRuntimeFiles,
  createCliBinPreflightSandbox,
  runHappierBin,
  writeCliProjectFixture,
  writeNodeModuleStub,
  writeProtocolBundleStub,
} from './testkit/cliBinPreflightSandbox';

describe('apps/cli bin/happier.mjs preflight', () => {
  it('runs from packaged package-dist entrypoints when dist is absent', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'package-dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('allows @happier-dev/protocol to be hoisted to the repo root node_modules', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });

      // Simulate the `hstack` clone setup behavior: only root node_modules exist.
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('exits after the delegated runtime succeeds even when wrapper preflight leaves active handles', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const wrapperOnlyActiveHandleProbe = [
        "if (String(process.argv[1] ?? '').endsWith('/happier.mjs')) {",
        '  setInterval(() => {}, 1000);',
        '}',
      ].join('\n');
      const res = runHappierBin({
        binDir,
        cwd: projectRoot,
        args: ['--help'],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(wrapperOnlyActiveHandleProbe)}`,
        },
        timeout: 2000,
      });

      expect(res.status).toBe(0);
      expect(res.signal).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('prints a helpful error if @happier-dev/protocol cannot be resolved', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Missing bundled package: @happier-dev/protocol');
      expect(res.stderr).toContain('Reinstall @happier-dev/cli to repair your installation.');
    } finally {
      cleanup();
    }
  });

  it('launches a manifest-backed local snapshot without refreshing bundled workspaces', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const binDir = join(projectRoot, 'bin');
      const bundledProtocolDir = join(projectRoot, 'node_modules', '@happier-dev', 'protocol');
      const workspaceProtocolDir = join(tmp, 'packages', 'protocol');
      const scriptsDir = join(tmp, 'scripts', 'workspaces');

      mkdirSync(join(workspaceProtocolDir, 'dist'), { recursive: true });
      mkdirSync(scriptsDir, { recursive: true });

      writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: "import '@happier-dev/protocol/changes'; console.log('ok');\n",
      });
      writeFileSync(
        join(projectRoot, 'dist', '.build-manifest.json'),
        `${JSON.stringify({ fingerprint: '0123456789abcdef', builtAt: '2026-07-09T00:00:00.000Z', fileCount: 1, toolVersion: '1' })}\n`,
        'utf8',
      );
      writeFileSync(
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/protocol'] }, null, 2)}\n`,
        'utf8',
      );
      copyCliBinRuntimeFiles({ binDir });
      copyCliWorkspaceSyncRuntimeFiles({ scriptsDir });

      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(join(tmp, 'yarn.lock'), '# lock\n', 'utf8');
      writeProtocolBundleStub({
        packageDir: workspaceProtocolDir,
        exportsMap: {
          '.': './dist/index.js',
          './changes': './dist/changes/index.js',
        },
        distFiles: {
          'dist/changes/index.js': 'export const change = true;\n',
        },
      });
      writeProtocolBundleStub({
        packageDir: bundledProtocolDir,
        exportsMap: {
          '.': './dist/index.js',
          './changes': './dist/changes/index.js',
        },
        distFiles: { 'dist/changes/index.js': 'export const change = true;\n' },
      });

      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({
        binDir,
        cwd: projectRoot,
        args: ['--help'],
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('ok');
      expect(existsSync(join(bundledProtocolDir, 'dist', 'index.js'))).toBe(true);
      expect(existsSync(join(bundledProtocolDir, 'dist', 'changes', 'index.js'))).toBe(true);
      const bundledPackageJson = JSON.parse(readFileSync(join(bundledProtocolDir, 'package.json'), 'utf8')) as {
        exports?: Record<string, string>;
        main?: string;
      };
      expect(bundledPackageJson.main).toBe('./dist/index.js');
      expect(bundledPackageJson.exports).toEqual({
        '.': './dist/index.js',
        './changes': './dist/changes/index.js',
      });
    } finally {
      cleanup();
    }
  });

  it('preserves the original invoked CLI path for the runtime entrypoint', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: [
          'console.log(JSON.stringify({',
          '  invokedPath: process.env.HAPPIER_CLI_INVOKED_PATH ?? null,',
          '  invokerName: process.env.HAPPIER_CLI_INVOKER_NAME ?? null,',
          '  argv1: process.argv[1] ?? null,',
          '}));',
          'process.exit(0);',
        ].join('\n'),
      });

      copyCliBinRuntimeFiles({ binDir });
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['doctor', '--json'] });

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout.trim()) as { invokedPath: string | null; invokerName: string | null; argv1: string | null };
      expect(parsed.invokedPath).toBe(join(binDir, 'happier.mjs'));
      expect(parsed.invokerName).toBe('happier');
      expect(realpathSync(parsed.argv1!)).toBe(realpathSync(join(binDir, 'happier.mjs')));
    } finally {
      cleanup();
    }
  });
});
