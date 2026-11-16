import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { handlePluginsCommand } from './plugins';

describe('plugins create template', () => {
  it.each([1, 2])('reads a portable theme batch from %i exported files for the themes template', async (count) => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-themes-'));
    const previousExitCode = process.exitCode;
    const output = captureConsoleJsonOutput();
    try {
      const theme = { schemaVersion: 1, id: 'paper', name: 'Paper', createdAt: '2026-11-16T00:00:00Z',
        updatedAt: '2026-11-16T00:00:00Z', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
        css: '[data-surface="session"] {\n color: red;\n}' };
      const themes = Array.from({ length: count }, (_, index) => ({ ...theme, id: `paper_${index}` }));
      const fileArgs: string[] = [];
      for (const [index, profile] of themes.entries()) {
        const themesFile = join(parentDir, `theme-${index}.json`);
        await writeFile(themesFile, JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile }));
        fileArgs.push('--themes-file', themesFile);
      }
      await handlePluginsCommand(['create', join(parentDir, 'themes'), '--template=themes',
        ...fileArgs, '--json']);
      expect(output.json()).toMatchObject({ ok: true, kind: 'plugins_create' });
      const manifest = JSON.parse(await readFile(join(parentDir, 'themes/.happier-plugin/plugin.json'), 'utf8'));
      expect(manifest.contributes.themes).toEqual(themes.map((theme, index) => ({ id: `theme-${index + 1}`, theme })));
    } finally {
      output.restore(); process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });
  it('threads the session-agent template through the public CLI command', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-plugin-create-session-agent-'));
    const targetDir = join(parentDir, 'session-agent-plugin');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand([
          'create',
          targetDir,
          '--id=acme.cli-session-agent',
          '--name=CLI Session Agent',
          '--template=session-agent',
          '--json',
        ]);

        expect(output.json()).toMatchObject({
          ok: true,
          kind: 'plugins_create',
          data: { plugin: { pluginId: 'acme.cli-session-agent', title: 'CLI Session Agent' } },
        });
        expect(process.exitCode).not.toBe(1);
      } finally {
        output.restore();
      }

      await expect(lstat(join(targetDir, 'src', 'agent', 'sessionAgent.ts'))).resolves.toMatchObject({});
      await expect(readFile(join(targetDir, 'src', 'index.ts'), 'utf8'))
        .resolves.toContain('module: "./agent/sessionAgent.js"');
    } finally {
      process.exitCode = previousExitCode;
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});
