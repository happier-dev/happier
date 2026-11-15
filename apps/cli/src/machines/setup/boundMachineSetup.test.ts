import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createBoundMachineSetupTarget } from './boundMachineSetup';

it.skipIf(process.platform === 'win32')('executes quoted target commands and delivers configuration through the existing bootstrap transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bound-setup-'));
  try {
    const target = createBoundMachineSetupTarget({ administrator: false, transport: {
      // OS transport boundary: a local shell stands in for the guest shell.
      exec: async request => {
        try {
          const result = await promisify(execFile)('/bin/sh', ['-c', request.command], { signal: request.signal });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
          return { status: error.code, stdout: '', stderr: '' };
        }
      },
      putFile: async request => { await writeFile(request.path, request.bytes); },
    } });
    const cwd = join(home, "guest's directory");
    await mkdir(cwd);
    const value = "literal ' $() `command`\nvalue";
    expect(await target.run({ command: '/bin/sh', args: ['-c', 'printf %s "$VALUE"'], cwd, env: { VALUE: value } }))
      .toMatchObject({ exitCode: 0, stdout: value });
    expect(await target.run({ command: '/bin/sh', args: ['-c', 'exit 19'], cwd, env: {} }))
      .toMatchObject({ exitCode: 19 });
    const path = join(cwd, '.config/mise/config.toml');
    await target.writeConfiguration(path, '[env]\nVALUE = "target"\n', new AbortController().signal);
    expect(await readFile(path, 'utf8')).toBe('[env]\nVALUE = "target"\n');
    const stopped = new AbortController();
    stopped.abort();
    await expect(target.run({ command: '/bin/true', args: [], cwd, env: {}, signal: stopped.signal })).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
