import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { MachineElevatedResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { prepareActionCompletionV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { getActionSpec, MachineSetupApplyInputV1Schema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildMachineSetupWorkflow } from './composeMachineSetup';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { MachineElevationDependencies, MachineElevationSpawn } from '../adminAccess/runElevatedEffect';
import { runMachineSetupEffectInternal } from './effectInternal';
import { applyMachineSetup } from './applyMachineSetup';

// Only sudo's process streams and native commands are substituted. The package
// owner, both interpreters, strict IPC, task and Action completion remain real.
describe('Software Apply native package failure retention', () => {
  it.each(['check', 'install'] as const)('retains apt lock diagnosis from root %s through Action completion', async phase => {
    let rootChecking = false;
    const runNative = async ({ executable, args }: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (executable === 'dpkg') return ok('amd64\n');
      if (executable === 'apt-get' && args[0] === '--version') return ok('apt 3.2\n');
      if (executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
      if (executable === 'lslocks') return ok(rootChecking && phase === 'check'
        ? '{"locks":[{"path":"/var/lib/dpkg/lock-frontend"}]}' : '{"locks":[]}');
      if (executable === 'apt-cache' && args[0] === 'policy') return ok('Candidate: 1\n  1 500\n');
      if (executable === 'apt-cache') return ok('Package: wanted\nVersion: 1\nArchitecture: amd64\n');
      expect(executable).toBe('apt-get');
      expect(args[0]).toBe('install');
      return { code: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 42 (private-owner)' };
    };
    const selection = { ref: { pluginId: 'com.example.tools', recipeId: 'package', revision: '1' }, inputs: {} };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0, selection },
      steps: [{ id: 'software', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }],
      backend: createMachineSetupNativeBackend({ run: runNative }) });
    rootChecking = true;
    const spawn: MachineElevationSpawn = launch => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
        { stdin, stdout, runNative, readUid: () => 0 }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
    };
    const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn() { throw new Error('No script should execute'); } },
      config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000, urlParseBufferLimit: 32768,
        maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    try {
      const result = await applyMachineSetup({ homeId: 'home', machineId: 'guest', requesterAccountId: 'owner', userHomeDirectory: '/fixture',
        setup: { items: [{ kind: 'setupRecipe', selection }] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], elevation,
        terminalSessions: terminals, isCurrent: async () => true,
        operation: { actionRequestId: `apt-failure-${phase}`, signal: new AbortController().signal,
          operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } });
      const failure = { kind: phase === 'check' ? 'native_check_unavailable' : 'native_effect_failed',
        reason: 'package_manager_busy', requiredFact: 'packageManagerLocks', remedy: 'Retry after first-boot or other package-manager updates finish.',
        ...(phase === 'install' ? { nativeCommand: { command: 'apt-get', phase: 'install', exitCode: 100, category: 'package_manager_busy' } } : {}) };
      expect(result).toMatchObject({ ok: false, details: { kind: 'machineSetup', failure } });
      expect(MachineElevatedResultV1Schema.safeParse({ outcome: 'outcome_unknown', failure }).success).toBe(true);
      expect(prepareActionCompletionV1(getActionSpec('machines.setup.apply').completion, result)).toMatchObject({
        kind: 'failed', value: { kind: 'machineSetup', failure },
      });
      const store = createInMemoryWorkflowCoordinatorStore();
      // Capture the genuine target-daemon reply at its RPC boundary, then let
      // the real Action/Workflow owners retain it without executing it again.
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupApply: async () => result });
      const coordinator = createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Software Apply has no Agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'guest', directory: '/fixture', checkoutRootPath: '/fixture' } }),
        action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true }),
          observeRun: async () => { throw new Error('A failed native reply has no launched Run'); } } });
      const reviewed = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'guest', targets: [{
        homeId: 'home', machineId: 'guest', desiredRevision: 0, exclusions: [],
        sources: [{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection }] } }],
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
      }] });
      await coordinator.run({ runId: `apt-${phase}`, definition: buildMachineSetupWorkflow(reviewed), inputs: {},
        executionTarget: { kind: 'session' }, authorization: { principal: { kind: 'host' } } });
      expect(store.list().find(row => row.blockKind === 'action')).toMatchObject({ result: { kind: 'machineSetup', failure } });
      expect(JSON.stringify(result)).not.toContain('private-owner');
      expect(JSON.stringify(result)).not.toContain('process 42');
    } finally { terminals.dispose(); }
  });
});
