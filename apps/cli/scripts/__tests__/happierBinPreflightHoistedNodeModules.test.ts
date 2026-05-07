import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  copyCliBinRuntimeFiles,
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

  it('refreshes stale local bundled workspace packages before launching from a monorepo checkout', () => {
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
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/protocol'] }, null, 2)}\n`,
        'utf8',
      );
      copyCliBinRuntimeFiles({ binDir });
      writeFileSync(
        join(scriptsDir, 'syncBundledWorkspacePackages.mjs'),
        readFileSync(join(process.cwd(), '..', '..', 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        join(scriptsDir, 'vendorBundledWorkspaceRuntimeDependenciesFallback.mjs'),
        readFileSync(join(process.cwd(), '..', '..', 'scripts', 'workspaces', 'vendorBundledWorkspaceRuntimeDependenciesFallback.mjs'), 'utf8'),
        'utf8',
      );

      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(join(tmp, 'yarn.lock'), '# lock\n', 'utf8');
      writeProtocolBundleStub({
        packageDir: workspaceProtocolDir,
        exportsMap: {
          '.': './dist/index.js',
          './changes': './dist/changes.js',
        },
        distFiles: {
          'dist/changes.js': 'export const change = true;\n',
        },
      });
      writeProtocolBundleStub({
        packageDir: bundledProtocolDir,
        exportsMap: {
          '.': './dist/index.js',
          './changes': './dist/changes.js',
        },
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
      expect(existsSync(join(bundledProtocolDir, 'dist', 'changes.js'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
