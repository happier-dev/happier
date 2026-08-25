import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('daemon source imports', () => {
  it('loads the daemon voice bootstrap through the TSX source loader', async () => {
    const cliRoot = projectPath();
    const tsconfigPath = join(cliRoot, 'tsconfig.json');
    const tsxCommandPath = resolve(
      cliRoot,
      '..',
      '..',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const daemonBootstrapUrl = pathToFileURL(join(
      cliRoot,
      'src',
      'daemon',
      'startup',
      'createDaemonMachineBootstrapRuntime.ts',
    )).href;

    await withTempDir('happier-daemon-source-import-', async (tempDir) => {
      const probePath = join(tempDir, 'daemon-source-import.ts');
      await writeFile(
        probePath,
        [
          '(async () => {',
          `  await import(${JSON.stringify(daemonBootstrapUrl)});`,
          '})().catch((error) => {',
          '  console.error(error);',
          '  process.exitCode = 1;',
          '});',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(tsxCommandPath, ['--tsconfig', tsconfigPath, probePath], {
        cwd: cliRoot,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: tsconfigPath,
        },
        encoding: 'utf8',
        timeout: 20_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    });
  });
});
