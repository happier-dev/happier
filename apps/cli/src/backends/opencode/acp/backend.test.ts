import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createOpenCodeBackend } from './backend';

type AcpBackendLike = {
  options: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeUnixExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, params.content, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeWindowsCmdExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, `${params.name}.cmd`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

describe('createOpenCodeBackend command resolution', () => {
  const originalOpenCodePath = process.env.HAPPIER_OPENCODE_PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalOpenCodePath === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = originalOpenCodePath;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'unset override', override: undefined, expected: 'opencode' },
    { label: 'whitespace override', override: '   ', expected: 'opencode' },
    { label: 'non-existent override', override: join(tmpdir(), 'definitely-missing-opencode-binary'), expected: 'opencode' },
  ])('falls back to opencode for $label', ({ override, expected }) => {
    if (override === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = override;

    const backend = createOpenCodeBackend({ cwd: tmpdir(), env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(expected);
  });

  it('handles non-executable override paths with explicit platform semantics', () => {
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const nonExecutablePath = join(binDir, process.platform === 'win32' ? 'opencode.txt' : 'opencode');
    writeFileSync(nonExecutablePath, '#!/bin/sh\necho "ok"\n', 'utf8');

    process.env.HAPPIER_OPENCODE_PATH = nonExecutablePath;

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    if (process.platform === 'win32') {
      // Windows override probing uses existence checks; keep this explicit in the test.
      expect(backend.options.command).toBe(nonExecutablePath);
      return;
    }
    expect(backend.options.command).toBe('opencode');
  });

  it('uses HAPPIER_OPENCODE_PATH when it points to an existing executable', () => {
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const opencodePath = process.platform === 'win32'
      ? makeWindowsCmdExecutable({
          dir: binDir,
          name: 'opencode',
          content: ['@echo off', 'echo ok', ''].join('\r\n'),
        })
      : makeUnixExecutable({
          dir: binDir,
          name: 'opencode',
          content: ['#!/bin/sh', 'echo "ok"', ''].join('\n'),
        });

    process.env.HAPPIER_OPENCODE_PATH = opencodePath;

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(opencodePath);
    expect(backend.options.args).toEqual(['acp']);
    expect(backend.options.env.NODE_ENV).toBe('production');
    expect(backend.options.env.DEBUG).toBe('');
  });
});
