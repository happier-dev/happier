import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveZellijBinary } from './resolveZellijBinary';

describe('resolveZellijBinary', () => {
  it('returns the bundled binary only when the expected version is reported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-zellij-resolve-'));
    const binary = join(root, process.platform === 'win32' ? 'zellij.exe' : 'zellij');
    await writeFile(binary, '#!/bin/sh\necho "zellij 0.44.3"\n', { mode: 0o755 });

    await expect(resolveZellijBinary({
      toolsDir: root,
      platform: process.platform,
      expectedVersion: '0.44.3',
    })).resolves.toBe(binary);
  });

  it('returns null when the binary is missing or version output does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-zellij-resolve-'));
    await expect(resolveZellijBinary({
      toolsDir: root,
      platform: 'linux',
      expectedVersion: '0.44.3',
    })).resolves.toBeNull();
  });
});
