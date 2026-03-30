import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  copyCliBinRuntimeFiles,
  createCliBinPreflightSandbox,
  runHappierBin,
  writeCliProjectFixture,
  writeNodeModuleStub,
  writeProtocolBundleStub,
} from './testkit/cliBinPreflightSandbox';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('happier bin preflight', () => {
  it('works when protocol deps are vendored under protocol/node_modules (not hoisted to the CLI root)', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const { rootDir: tempRoot, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');

    try {
      const { binDir } = writeCliProjectFixture({
        projectRoot: tempRoot,
        entrypointDir: 'dist',
        entrypointContent: "console.log('ok');\n",
      });

      copyCliBinRuntimeFiles({ repoRoot, binDir });

      // Global-install / packed layout:
      // - protocol is present as a bundled workspace package
      // - protocol runtime deps are vendored under protocol/node_modules
      writeProtocolBundleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', 'tweetnacl'),
        manifest: { name: 'tweetnacl', version: '0.0.0', main: 'index.js' },
        files: {
          'index.js': 'module.exports = {};\n',
        },
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'base64-js'),
        manifest: { name: 'base64-js', version: '0.0.0', main: 'index.js' },
        files: {
          'index.js': 'module.exports = {};\n',
        },
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes', version: '0.0.0', main: 'index.js' },
        files: {
          'hmac.js': 'export {};\n',
          'sha512.js': 'export {};\n',
        },
      });

      const result = runHappierBin({
        binDir,
        cwd: tempRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ok');
    } finally {
      cleanup();
    }
  });

  it('prints a helpful error when tweetnacl is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const { rootDir: tempRoot, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');

    try {
      const { binDir } = writeCliProjectFixture({
        projectRoot: tempRoot,
        entrypointDir: 'dist',
        entrypointContent: "console.log('ok');\n",
      });

      copyCliBinRuntimeFiles({ repoRoot, binDir });

      writeProtocolBundleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'),
      });

      const result = runHappierBin({
        binDir,
        cwd: tempRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing required dependency: tweetnacl');
    } finally {
      cleanup();
    }
  });

  it('prints a helpful error when base64-js is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const { rootDir: tempRoot, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');

    try {
      const { binDir } = writeCliProjectFixture({
        projectRoot: tempRoot,
        entrypointDir: 'dist',
        entrypointContent: "console.log('ok');\n",
      });

      copyCliBinRuntimeFiles({ repoRoot, binDir });

      writeProtocolBundleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', 'tweetnacl'),
        manifest: { name: 'tweetnacl', version: '0.0.0', main: 'index.js' },
        files: {
          'index.js': 'module.exports = {};\n',
        },
      });

      const result = runHappierBin({
        binDir,
        cwd: tempRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing required dependency: base64-js');
    } finally {
      cleanup();
    }
  });

  it('prints a helpful error when @noble/hashes/hmac is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const { rootDir: tempRoot, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');

    try {
      const { binDir } = writeCliProjectFixture({
        projectRoot: tempRoot,
        entrypointDir: 'dist',
        entrypointContent: "console.log('ok');\n",
      });

      copyCliBinRuntimeFiles({ repoRoot, binDir });

      writeProtocolBundleStub({
        packageDir: resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', 'tweetnacl'),
        manifest: { name: 'tweetnacl', version: '0.0.0', main: 'index.js' },
        files: {
          'index.js': 'module.exports = {};\n',
        },
      });
      writeNodeModuleStub({
        packageDir: resolve(tempRoot, 'node_modules', 'base64-js'),
        manifest: { name: 'base64-js', version: '0.0.0', main: 'index.js' },
        files: {
          'index.js': 'module.exports = {};\n',
        },
      });

      const result = runHappierBin({
        binDir,
        cwd: tempRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing required dependency: @noble/hashes/hmac');
    } finally {
      cleanup();
    }
  });
});
