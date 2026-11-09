import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

it('launches a configured Windows package shim through the canonical command invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-mcp-windows-'));
  try {
    const shim = join(root, 'npx.cmd');
    const shell = join(root, 'cmd.exe');
    await writeFile(shim, '@echo off');
    await writeFile(shell, 'fixture');
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ command: shim, args: ['-y', 'fixture', '--', '--yes'], env: { PATH: root }, cwd: root }));
    // The spawn adapter is the OS boundary; run the real launcher and Windows invocation owner.
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeSync } from 'node:fs';
      cp.spawn = (command, args, options) => {
        writeSync(1, JSON.stringify({ command, args, cwd: options.cwd, windowsVerbatimArguments: options.windowsVerbatimArguments, windowsHide: options.windowsHide, path: options.env.PATH }));
        process.exit(0);
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'stdioMcpServerLauncher.ts')).href)});
    `;
    const result = spawnSync(process.execPath, ['--import', resolveTsxImportHookPath()!, '--input-type=module', '--eval', script], {
      env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(), COMSPEC: shell, HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: config }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: shell, cwd: root, windowsVerbatimArguments: true, windowsHide: true, path: root });
    expect(JSON.parse(result.stdout).args).toEqual(['/d', '/s', '/c', expect.stringContaining('npx.cmd')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
