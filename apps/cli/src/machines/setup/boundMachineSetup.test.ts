import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
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

it('applies the admitted bootstrap plan inside the target interpreter without inventing a guest Machine identity', async () => {
  const { PassThrough } = await import('node:stream');
  const { runMachineSetupEffectInternal } = await import('./effectInternal');
  // UID and remote process execution are OS boundaries. Planning, request
  // parsing and the privileged interpreter remain real.
  let installed = false;
  const runNative = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
    if (command.executable === 'guest-check') return { code: installed ? 0 : 1, stdout: '', stderr: '' };
    if (command.executable === 'guest-install') { installed = true; return { code: 0, stdout: '', stderr: '' }; }
    throw new Error('Unexpected target command');
  };
  const basis = { kind: 'bootstrap' as const, managedId: 'retained-resource', operationId: 'session-operation', admittedInputDigest: 'a'.repeat(64) };
  const steps = [{ id: 'tool', kind: 'command' as const, executable: 'guest-install', args: [],
    check: { executable: 'guest-check', args: [], unsatisfiedExitCodes: [1] } }];
  const backend = createMachineSetupNativeBackend({ run: runNative });
  const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
  const target = createBoundMachineSetupTarget({ administrator: true, effectCli: {
    binaryPath: '/guest/happier', operationId: basis.operationId,
  }, transport: {
    exec: async request => {
      expect(request.command).toContain('sudo -n --');
      expect(request.command).not.toContain('--installation-id');
      const stdin = new PassThrough(), stdout = new PassThrough();
      let text = '';
      stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); request.onStdoutChunk?.(chunk.toString('utf8')); });
      stdin.end(request.input);
      const status = await runMachineSetupEffectInternal([`--operation-id=${basis.operationId}`], { stdin, stdout, runNative, readUid: () => 0 });
      return { status, stdout: text, stderr: '' };
    },
    putFile: async () => { throw new Error('Native plans must not write through controller filesystem'); },
  } });
  expect(await target.applyPlans!([plan], new AbortController().signal, () => undefined)).toMatchObject({ status: 'applied', completedStepIds: ['tool'] });
  expect(installed).toBe(true);
});
