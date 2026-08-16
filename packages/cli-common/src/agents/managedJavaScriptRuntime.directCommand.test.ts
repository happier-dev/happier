import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDirectJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';

function makeExecutableFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

describe('resolveDirectJavaScriptRuntimeCommand', () => {
  it('returns the direct managed runtime binary instead of its shell wrapper', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', {
      ...originalPlatformDescriptor,
      value: 'win32',
    });
    const root = join(
      tmpdir(),
      `happier-cli-common-direct-js-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const homeDir = join(root, 'home');
      const runtimeRoot = join(homeDir, 'tools', 'js-runtime', 'current');
      const wrapperPath = join(runtimeRoot, 'bin', 'happier-js-runtime.cmd');
      const nodePath = join(runtimeRoot, 'runtime', 'node.exe');
      mkdirSync(join(runtimeRoot, 'bin'), { recursive: true });
      mkdirSync(join(nodePath, '..'), { recursive: true });
      makeExecutableFile(wrapperPath, '@echo off\r\n');
      makeExecutableFile(nodePath, '');

      expect(resolveDirectJavaScriptRuntimeCommand({
        isBunRuntime: true,
        processEnv: {
          PATH: '',
          HAPPIER_HOME_DIR: homeDir,
        },
        currentExecPath: join(root, 'happier.exe'),
      })).toBe(nodePath);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
