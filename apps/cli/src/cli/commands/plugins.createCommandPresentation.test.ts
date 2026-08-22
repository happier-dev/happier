import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildPosixShellCommand,
  buildPowerShellCommand,
  buildWindowsCmdCommand,
} from '@happier-dev/agents/process/shellCommand';
import { describe, expect, it } from 'vitest';

import { formatPluginCreateNextCommands } from './plugins';

const execFileAsync = promisify(execFile);

const nextCommandArgs = (targetDir: string): readonly string[] => [
  'happier',
  'plugins',
  'dev',
  targetDir,
];

describe('plugins create next-command presentation', () => {
  it('retains the POSIX command that changes into the scaffold directory before starting dev mode', () => {
    const targetDir = String.raw`/tmp/author space/$name/'quoted'`;

    expect(formatPluginCreateNextCommands(targetDir, 'linux')).toEqual([
      `cd ${buildPosixShellCommand([targetDir])} && happier plugins dev`,
    ]);
  });

  it('uses the canonical shell serializers and labels each supported Windows shell', () => {
    const targetDir = String.raw`C:\author space\$name\%name% & (plugin) 'quoted'`;

    expect(formatPluginCreateNextCommands(targetDir, 'win32')).toEqual([
      `PowerShell: ${buildPowerShellCommand(nextCommandArgs(targetDir))}`,
      `cmd.exe: ${buildWindowsCmdCommand(nextCommandArgs(targetDir))}`,
    ]);
  });

  it.runIf(process.platform === 'win32')(
    'delivers the exact special-character target directory to happier in each printed Windows shell command',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-plugin-create-next-command-'));
      const targetDir = join(root, "plugin with spaces $name %name% & (parens) 'quoted'");
      const capturePath = join(root, 'captured-argv.json');
      const captureScriptPath = join(root, 'capture-argv.cjs');
      const happierShimPath = join(root, 'happier.cmd');
      const originalPath = process.env.PATH;
      const commands = formatPluginCreateNextCommands(targetDir, 'win32');

      try {
        await writeFile(captureScriptPath, [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.HAPPIER_CAPTURED_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
          '',
        ].join('\r\n'));
        await writeFile(happierShimPath, [
          '@echo off',
          `"${process.execPath}" "${captureScriptPath}" %*`,
          '',
        ].join('\r\n'));

        const environment = {
          ...process.env,
          PATH: `${root};${originalPath ?? ''}`,
          HAPPIER_CAPTURED_ARGV_PATH: capturePath,
        };

        const powerShellCommand = commands[0]?.replace(/^PowerShell:\s*/u, '');
        const cmdCommand = commands[1]?.replace(/^cmd\.exe:\s*/u, '');
        expect(powerShellCommand).toBeDefined();
        expect(cmdCommand).toBeDefined();
        if (!powerShellCommand || !cmdCommand) return;

        await execFileAsync('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          powerShellCommand,
        ], { env: environment, windowsVerbatimArguments: true });
        await expect(readFile(capturePath, 'utf8')).resolves.toBe(JSON.stringify(['plugins', 'dev', targetDir]));

        await execFileAsync(process.env.COMSPEC ?? 'cmd.exe', [
          '/D',
          '/S',
          '/C',
          `"${cmdCommand}"`,
        ], { env: environment, windowsVerbatimArguments: true });
        await expect(readFile(capturePath, 'utf8')).resolves.toBe(JSON.stringify(['plugins', 'dev', targetDir]));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
