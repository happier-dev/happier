import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { coder as recipe } from './coder.js';
import { createMachineSetupNativeBackend, checkMachineSetupEffectPlan, applyMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { MachineRecipeStepV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

it.skipIf(process.platform === 'win32').each([false, true])('installs Coder idempotently and preserves installer failures (failure=%s)', async fail => {
  expect(recipe).toBeDefined();
  const authored = recipe?.steps.find(step => step.id === 'install');
  if (!authored || authored.kind !== 'script') throw new Error('Missing Coder installer');
  const root = mkdtempSync(join(tmpdir(), 'coder-recipe-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  const installed = join(root, 'installed');
  writeFileSync(calls, '');
  const executable = (name: string, body: string) => writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  executable('apt-get', 'exit 0');
  executable('coder', `test -f '${installed}' || exit 1; echo 'Coder v2.39.0'`);
  executable('curl', `printf 'download\n' >> '${calls}'
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; target=$1; fi
  shift
done
printf '%s\n' 'exit ${fail ? 42 : 0}' > "$target"
${fail ? '' : `printf installed > '${installed}'`}`);
  const step = MachineRecipeStepV1Schema.parse(authored);
  // Run the real shell and interpreter, substituting only network/process binaries.
  const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd', run: async command => {
    const result = spawnSync(command.executable, command.args, { input: command.inputBytes, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } });
  const basis = { kind: 'setup' as const, machineId: 'coder-fixture', desiredRevision: 0 };
  for (let attempt = 0; attempt < (fail ? 1 : 2); attempt++) {
    const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
    const result = await applyMachineSetupEffectPlan({ plan, backend });
    expect(result).toMatchObject({ status: fail ? 'failed' : 'applied' });
    if (fail) expect(result).toMatchObject({ reason: 'native_effect_failed' });
  }
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['download']);
});

it('renders the external URL through the recipe input owner', () => {
  const config = recipe?.steps.find(step => step.id === 'config');
  if (!config) throw new Error('Missing Coder configuration');
  expect(resolveMachineRecipeStepInputsV1(config, { accessUrl: 'https://coder.example.com' })).toMatchObject({
    content: { kind: 'literal', value: 'CODER_ACCESS_URL=https://coder.example.com\nCODER_HTTP_ADDRESS=127.0.0.1:3000\n' },
  });
});
