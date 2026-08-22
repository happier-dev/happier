import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { handlePluginsCommand } from './plugins';

describe('plugins create UI mode', () => {
  it('creates the requested UI scaffold from equals-form valued options', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-equals-ui-'));
    const targetDir = join(parentDir, 'equals-ui-plugin');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
          targetDir,
          '--id=acme.equals-ui',
          '--name=Equals UI',
          '--ui=reactNative',
          '--json',
        ]);

        expect(output.json()).toMatchObject({
          ok: true,
          kind: 'plugins_create',
          data: {
            plugin: {
              pluginId: 'acme.equals-ui',
              title: 'Equals UI',
            },
            scaffold: {
              uiEntryPath: expect.stringMatching(/renderSurface\.tsx$/u),
            },
          },
        });
        expect(process.exitCode).not.toBe(1);
      } finally {
        output.restore();
      }

      await expect(lstat(join(targetDir, 'pluginUiBuild.mjs'))).resolves.toMatchObject({});
      const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(packageJson.dependencies).toHaveProperty('@happier-dev/plugin-ui');
    } finally {
      process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['at the end of the command', ['--json', '--ui']],
    ['before another option', ['--ui', '--json']],
  ])('rejects --ui without a mode %s instead of silently generating a no-UI plugin', async (_caseName, uiArgs) => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-missing-ui-'));
    const targetDir = join(parentDir, 'missing-ui-plugin');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
          targetDir,
          '--id',
          'acme.missingui',
          '--name',
          'Missing UI',
          ...uiArgs,
        ]);

        const parsed = output.json<{
          ok: boolean;
          kind: string;
          error?: { code?: string; message?: string };
        }>();

        expect(parsed).toMatchObject({
          ok: false,
          kind: 'plugins_create',
          error: {
            code: 'invalid_option',
            message: expect.stringMatching(/--ui requires/i),
          },
        });
        expect(process.exitCode).toBe(1);
      } finally {
        output.restore();
      }

      await expect(readFile(join(targetDir, 'package.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});
