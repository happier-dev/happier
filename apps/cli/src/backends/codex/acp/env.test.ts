import { afterEach, describe, expect, it, vi } from 'vitest';
import { delimiter, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { buildCodexAcpEnvOverrides } from './env';
import { projectPath } from '@/projectPath';

describe('buildCodexAcpEnvOverrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prepends the CLI shims directory to PATH', () => {
    const projectDir = '/tmp/happier-cli';
    const basePath = '/usr/bin:/bin';
    const out = buildCodexAcpEnvOverrides({ projectDir, baseEnv: { PATH: basePath } });
    const shimsDir = resolve(projectDir, 'scripts', 'shims');
    expect(out.PATH).toBe(`${shimsDir}${delimiter}${basePath}`);
  });

  it('falls back to process PATH when baseEnv omits PATH', () => {
    const projectDir = '/tmp/happier-cli';
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
    const out = buildCodexAcpEnvOverrides({ projectDir, baseEnv: {} });
    const shimsDir = resolve(projectDir, 'scripts', 'shims');
    expect(out.PATH).toBe(`${shimsDir}${delimiter}/usr/local/bin:/usr/bin:/bin`);
  });

  it('removes Codex thread env keys so Codex ACP starts a fresh thread', () => {
    const projectDir = '/tmp/happier-cli';
    const out = buildCodexAcpEnvOverrides({
      projectDir,
      baseEnv: {
        PATH: '/usr/bin:/bin',
        CODEX_THREAD_ID: 'thread-123',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'originator',
        CODEX_SHELL: '/bin/zsh',
      } as unknown as { PATH?: string },
    }) as Record<string, string | undefined>;

    const keys = ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SHELL'] as const;
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(false);
      expect(out[key]).toBeUndefined();
    }
  });

  it('ships a git shim in the shims directory', () => {
    const shimsDir = resolve(projectPath(), 'scripts', 'shims');
    expect(existsSync(resolve(shimsDir, 'git'))).toBe(true);
  });
});
