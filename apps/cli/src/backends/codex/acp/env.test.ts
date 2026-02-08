import { describe, expect, it } from 'vitest';
import { delimiter, resolve } from 'node:path';

import { buildCodexAcpEnvOverrides } from './env';

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
});

