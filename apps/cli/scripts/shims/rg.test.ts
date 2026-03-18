import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('scripts/shims/rg', () => {
  it('falls back to system rg when packaged tools are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-cli-rg-shim-'));
    tempDirs.add(root);

    const shimsDir = join(root, 'scripts', 'shims');
    await mkdir(shimsDir, { recursive: true });

    const shimPath = join(shimsDir, 'rg');
    await copyFile(join(__dirname, 'rg'), shimPath);
    await chmod(shimPath, 0o755);

    const systemBinDir = join(root, 'system-bin');
    await mkdir(systemBinDir, { recursive: true });

    const systemRgPath = join(systemBinDir, 'rg');
    await writeFile(systemRgPath, '#!/usr/bin/env bash\nprintf \"SYSTEM_RG:%s\\n\" \"$*\"\n', 'utf8');
    await chmod(systemRgPath, 0o755);

    const result = spawnSync(shimPath, ['--fixed-string', 'needle'], {
      env: { ...process.env, PATH: `${shimsDir}:${systemBinDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('SYSTEM_RG:--fixed-strings needle');
  });
});
