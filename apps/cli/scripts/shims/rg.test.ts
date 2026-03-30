import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';

describe('rg shim', () => {
  it('rewrites --fixed-string to --fixed-strings before invoking the packaged ripgrep binary', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-rg-shim-');
    try {
      const scriptDir = join(root, 'scripts', 'shims');
      const toolsDir = join(root, 'tools', 'unpacked');
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(toolsDir, { recursive: true });

      const shimSource = fileURLToPath(new URL('./rg', import.meta.url));
      const shimPath = join(scriptDir, 'rg');
      copyFileSync(shimSource, shimPath);
      chmodSync(shimPath, 0o755);

      const argsFile = join(root, 'rg-args.txt');
      const rgPath = join(toolsDir, 'rg');
      writeFileSync(
        rgPath,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
`,
        'utf8',
      );
      chmodSync(rgPath, 0o755);

      const result = spawnSync('bash', [shimPath, '--fixed-string', 'needle', '--glob', '*.ts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(result.status).toBe(0);
      const forwardedArgs = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(forwardedArgs).toEqual(['--fixed-strings', 'needle', '--glob', '*.ts']);
    } finally {
      removeTempDirSync(root);
    }
  });
});
