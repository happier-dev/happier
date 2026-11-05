import { describe, expect, it } from 'vitest';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { applyMachineSetup } from './applyMachineSetup';

describe('reviewed installer Docker admission', () => {
  it.each([
    { stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock', reason: /permission|access/i },
    { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', reason: /not running|start Docker/i },
  ])('explains the Docker prerequisite before any reviewed installer effect ($stderr)', async ({ stderr, reason }) => {
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'vendor', revision: '1' }, inputs: {},
    } };
    // Substitute only native command/PTY boundaries; CHECK, admission and Apply stay real.
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'install', kind: 'script', shell: 'bash', body: 'echo vendor-install',
        affects: 'dockerEngine', check: { body: 'exit 1', unsatisfiedExitCodes: [1] } }],
      backend: createMachineSetupNativeBackend({ run: async () => ({ code: 1, stdout: '', stderr: '' }) }) });
    let admissions = 0;
    let probes = 0;
    let effects = 0;
    const unexpectedEffect = async (): Promise<never> => { effects++; throw new Error('Installer must not run'); };
    const result = await applyMachineSetup({
      homeId: 'home', machineId: 'guest', requesterAccountId: 'owner', userHomeDirectory: '/fixture',
      setup: { items: [item] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
      onAdmitted: async () => { admissions++; }, isCurrent: async () => true,
      hostEnvironment: {}, platform: 'linux',
      terminalSessions: { ensure: unexpectedEffect, waitForExit: unexpectedEffect,
        requestStop: unexpectedEffect, observeOutput: () => { effects++; throw new Error('Installer must not run'); } },
      environmentIo: { resolveTool: unexpectedEffect, run: async () => {
        probes++;
        return { exitCode: 1, stdout: '', stderr };
      } },
      operation: { actionRequestId: 'docker-admission', signal: new AbortController().signal,
        operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'native_engine_impact_ambiguous',
      error: expect.stringMatching(reason) });
    expect(result).toMatchObject({ error: expect.stringMatching(/review.*apply/i) });
    expect(admissions).toBe(0);
    expect(probes).toBe(1);
    expect(effects).toBe(0);
  });
});
