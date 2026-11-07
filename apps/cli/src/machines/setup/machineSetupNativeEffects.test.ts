import { expect, it } from 'vitest';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { resolveMachineSetupNativeEffects } from './machineSetupNativeEffects';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

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

it.each([true, false])('resolves selected engine B despite retained A and excludes overlapping effects (readable=%s)', async readable => {
  let reads = 0;
  const scope = await machineNativeEffectAdmission.run({ operation: { operationId: 'retained-a', kind: 'deploy' },
    keys: [{ kind: 'dockerEngine', dockerEndpoint: 'engine-a' }] }, () => resolveMachineSetupNativeEffects({
    userHomeDirectory: '/home/operator', hostEnvironment: { DOCKER_HOST: 'tcp://engine-b:2375' }, includeDockerEngine: true,
    environmentIo: { async run(request) {
      reads++;
      expect(request.env?.DOCKER_HOST).toBe('tcp://engine-b:2375');
      return readable ? { exitCode: 0, stdout: '{"ID":"engine-b"}' }
        : { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    } },
  }));
  expect(reads).toBe(1);
  if (readable) expect(scope.keys).toContainEqual({ kind: 'dockerEngine', dockerEndpoint: 'engine-b' });
  else expect(scope.allNative).toBe(true);
  await machineNativeEffectAdmission.run({ operation: { operationId: 'setup-b', kind: 'setup' }, ...scope }, async () => {
    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'deploy-b', kind: 'deploy' },
      keys: [{ kind: 'dockerEngine', dockerEndpoint: 'engine-b' }] }, async () => 'overlapping effect'))
      .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'setup-b' });
    if (!readable) await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'unrelated-engine', kind: 'deploy' },
      keys: [{ kind: 'dockerEngine', dockerEndpoint: 'engine-c' }] }, async () => 'overlapping effect'))
      .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'setup-b' });
  });
});
