import { describe, expect, it } from 'vitest';
import { delimiter, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { buildCodexAcpEnvOverrides } from './env';
import { projectPath } from '@/projectPath';

describe('buildCodexAcpEnvOverrides', () => {
  it('prepends the CLI shims directory to PATH', () => {
    const projectDir = '/tmp/happier-cli';
    const basePath = '/usr/bin:/bin';
    const out = buildCodexAcpEnvOverrides({ projectDir, baseEnv: { PATH: basePath } });
    const shimsDir = resolve(projectDir, 'scripts', 'shims');
    expect(out.PATH).toBe(`${shimsDir}${delimiter}${basePath}`);
  });

  it('falls back to only shims dir when PATH is missing', () => {
    const projectDir = '/tmp/happier-cli';
    const out = buildCodexAcpEnvOverrides({ projectDir, baseEnv: {} });
    const shimsDir = resolve(projectDir, 'scripts', 'shims');
    expect(out.PATH).toBe(shimsDir);
  });

  it('unsets Codex thread env keys so Codex ACP starts a fresh thread', () => {
    const projectDir = '/tmp/happier-cli';
    const out = buildCodexAcpEnvOverrides({ projectDir, baseEnv: { PATH: '/usr/bin:/bin' } }) as Record<string, string | undefined>;

    const keys = ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SHELL'] as const;
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(true);
      expect(out[key]).toBeUndefined();
    }
  });

  it('ships a git shim in the shims directory', () => {
    const shimsDir = resolve(projectPath(), 'scripts', 'shims');
    expect(existsSync(resolve(shimsDir, 'git'))).toBe(true);
  });
});
