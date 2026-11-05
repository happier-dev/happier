import { expect, it } from 'vitest';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { resolveMachineSetupNativeEffects } from './machineSetupNativeEffects';

it('admits a reviewed root installer before Docker exists and reserves an existing engine through the same impact owner', async () => {
  const plan = createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'fresh', desiredRevision: 0 },
    steps: [{ id: 'install', kind: 'script', shell: 'bash', body: 'official installer\n', affects: 'dockerEngine' }],
    nativeFacts: [{ stepId: 'install', status: 'drifted', facts: {} }] });
  const input = { userHomeDirectory: '/home/operator', hostEnvironment: {}, plans: [plan] };
  expect(await resolveMachineSetupNativeEffects({ ...input,
    environmentIo: { async run() { throw Object.assign(new Error('no Docker CLI'), { code: 'ENOENT' }); } } }))
    .toEqual({ keys: [{ kind: 'machineSetup' }], allNative: true });
  expect(await resolveMachineSetupNativeEffects({ ...input,
    environmentIo: { async run() { return { exitCode: 0, stdout: '{"ID":"existing-engine"}' }; } } }))
    .toEqual({ keys: [{ kind: 'machineSetup' }, { kind: 'dockerEngine', dockerEndpoint: 'existing-engine' }] });
});
