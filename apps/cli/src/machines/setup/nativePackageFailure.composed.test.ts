import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { MachineElevatedResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { ActionOperationFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';
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
import { unwrapActionResultForRpc } from '@/rpc/handlers/registerActionSpecRpcHandlers';

// Only sudo's process streams and native commands are substituted. The package
// owner, both interpreters, strict IPC, task and Action completion remain real.
describe('Software Apply native package failure retention', () => {
  // An uncertain install retains this daemon's native admission; keep it last.
  it.each(['check', 'availability', 'daemon', 'fresh', 'install'] as const)('preserves the native %s outcome through privileged Software Apply', async phase => {
    const machineId = `guest-${phase}`;
    let rootChecking = false;
    let mutations = 0;
    let refreshed = false, installed = false;
    const runNative = async ({ executable, args }: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (executable === 'dpkg') return ok('amd64\n');
      if (executable === 'apt-get' && args[0] === '--version') return ok('apt 3.2\n');
      if (executable === 'dpkg-query') return installed ? ok('wanted\tinstall ok installed\t1\tamd64\n') : { code: 1, stdout: '', stderr: '' };
      if (executable === 'lslocks' && !rootChecking && (phase === 'availability' || phase === 'fresh')) return ok('{"locks":[{"path":"/run..."}]}');
      if (executable === 'lslocks') return ok(rootChecking && phase === 'check'
        ? '{"locks":[{"path":"/var/lib/dpkg/lock-frontend"}]}' : '{"locks":[]}');
      if (executable === 'apt-cache' && args[0] === 'policy') return ok(rootChecking && (phase === 'availability' || phase === 'fresh' && !refreshed)
        ? 'docker.io:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n' : 'Candidate: 1\n  1 500\n');
      if (executable === 'apt-cache') return ok('Package: wanted\nVersion: 1\nArchitecture: amd64\n');
      expect(executable).toBe('apt-get');
      if (phase === 'fresh') {
        mutations++;
        if (args[0] === 'update') refreshed = true;
        else { expect(args[0]).toBe('install'); expect(refreshed).toBe(true); installed = true; }
        return ok();
      }
      if (phase === 'availability') {
        expect(args[0]).toBe('update');
        mutations++;
        return ok();
      }
      expect(args[0]).toBe('install');
      mutations++;
      return { code: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 42 (private-owner)' };
    };
    const selection = { ref: { pluginId: 'com.example.tools', recipeId: 'package', revision: '1' }, inputs: {} };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId, desiredRevision: 0, selection },
      steps: phase === 'daemon' ? [{ id: 'software', kind: 'package', manager: 'brew', packages: [{ name: 'wanted', kind: 'formula' }],
        requiredFacts: [{ kind: 'command', executable: 'separate-prerequisite' }] }]
        : [{ id: 'software', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }],
      backend: createMachineSetupNativeBackend({ run: runNative }) });
    if (phase === 'availability') expect(plan.nativeFacts).toMatchObject([{ status: 'unavailable', reason: 'needs_admin_to_check' }]);
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
      const result = await applyMachineSetup({ homeId: 'home', machineId, requesterAccountId: 'owner', userHomeDirectory: '/fixture',
        setup: { items: [{ kind: 'setupRecipe', selection }] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], elevation,
        environmentIo: { resolveTool: async () => null, run: async () => { throw new Error('No implicit native probe'); } },
        terminalSessions: terminals, isCurrent: async () => true,
        operation: { actionRequestId: `apt-failure-${phase}`, signal: new AbortController().signal,
          operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } });
      if (phase === 'fresh') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(mutations).toBe(2);
        expect(installed).toBe(true);
        return;
      }
      const failure = phase === 'daemon' ? { kind: 'native_check_unsupported', reason: 'required_fact_unavailable', requiredFact: 'software' }
        : phase === 'availability' ? { kind: 'native_check_unsupported', reason: 'required_fact_unavailable',
        requiredFact: 'packageAvailability', remedy: 'Check the selected packages and enabled apt repositories, then review and retry.' }
        : { kind: phase === 'check' ? 'native_check_unavailable' : 'native_effect_failed',
        reason: 'package_manager_busy', requiredFact: 'packageManagerLocks', remedy: 'Retry after first-boot or other package-manager updates finish.',
        ...(phase === 'install' ? { nativeCommand: { command: 'apt-get', phase: 'install', exitCode: 100, category: 'package_manager_busy' } } : {}) };
      if (phase === 'daemon') expect(result).toMatchObject({ ok: false,
        errorCode: 'native_check_unsupported', error: 'native_check_unsupported', details: { kind: 'machineSetup', failure } });
      expect(result).toMatchObject({ ok: false, details: { kind: 'machineSetup', failure } });
      expect(ActionOperationFailureV1Schema.safeParse(result.ok ? undefined : {
        errorCode: result.errorCode, error: result.error, details: result.details,
      }).success).toBe(true);
      expect(mutations).toBe(phase === 'install' || phase === 'availability' ? 1 : 0);
      expect(MachineElevatedResultV1Schema.safeParse({ outcome: 'outcome_unknown', failure }).success).toBe(true);
      expect(prepareActionCompletionV1(getActionSpec('machines.setup.apply').completion, result)).toMatchObject({
        kind: 'failed', value: { kind: 'machineSetup', failure },
      });
      const store = createInMemoryWorkflowCoordinatorStore();
      // Capture the genuine target-daemon reply at its RPC boundary, then let
      // the real Action/Workflow owners retain it without executing it again.
      const rpcResult = unwrapActionResultForRpc('machines.setup.apply', result);
      expect(rpcResult).toEqual(result);
      expect(unwrapActionResultForRpc('machines.setup.remove', result)).toEqual(result);
      expect(unwrapActionResultForRpc('machines.setup.updates.apply', result)).toEqual(result);
      expect(unwrapActionResultForRpc('machines.setup.apply', { ...result, ok: false,
        errorCode: failure.kind, error: failure.kind,
        details: { kind: 'machineSetup', failure: { ...failure, rawOutput: 'private-owner' } } })).not.toHaveProperty('details');
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupApply: async () => rpcResult });
      const coordinator = createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Software Apply has no Agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/fixture', checkoutRootPath: '/fixture' } }),
        action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true }),
          observeRun: async () => { throw new Error('A failed native reply has no launched Run'); } } });
      const reviewed = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId, targets: [{
        homeId: 'home', machineId, desiredRevision: 0, exclusions: [],
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
