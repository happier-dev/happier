import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { exercisePublicPackagePlanApply, withNativeConfirmation } from '@/testkit/machines/nativeSoftwareInstallFlow';
import { nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import { MachineSetupApplyInputV1Schema, MachineSetupApplyResultV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';

describe('Machine setup Apply settlement', () => {
  it.skipIf(process.platform === 'win32').each(['plain', 'e2ee'] as const)('settles a %s reviewed Apply through the installed daemon and native package effect', async mode => {
    await exercisePublicPackagePlanApply('native-confirm', true, undefined, undefined, undefined, mode);
  });

  it.skipIf(process.platform === 'win32').each([
    { exitCode: 0, disconnectAfterWait: false },
    { exitCode: 23, disconnectAfterWait: false },
    { exitCode: 0, disconnectAfterWait: true },
  ])('observes the signed Workflow child through exit $exitCode with observation disconnect=$disconnectAfterWait', async ({ exitCode, disconnectAfterWait }) => {
    await exercisePublicPackagePlanApply('native-confirm', false, async (fixture, _admitRoot, accountChannel) => {
      let disconnected = false;
      if (disconnectAfterWait) {
        const homePost = vi.mocked(axios.post).getMockImplementation();
        if (!homePost) throw new Error('Native Home HTTP boundary required');
        vi.mocked(axios.post).mockImplementation(async (...args) => {
          const response = await homePost(...args);
          const [url, body] = args;
          if (!disconnected && String(url).endsWith(WORKFLOW_RUN_STORAGE_HTTP_PATH)
            && body && typeof body === 'object' && 'operation' in body && body.operation === 'wait') {
            // Lose only the observation transport after Home authorized the
            // starter's read. No permission or encryption material changed.
            disconnected = true;
            await accountChannel.disconnect();
          }
          return response;
        });
      }
      const context: RpcActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'alice', serverIdentityId: 'srv_home', actionRequestId: 'reviewed-script-apply',
        externalActionTarget: { kind: 'machine', machineId: fixture.machine.id }, signal: new AbortController().signal };
      const sources = [{ kind: 'direct', setup: { scripts: [
        { body: 'printf FIRST', affects: 'none' }, { body: `exit ${exitCode}`, affects: 'none' },
        { body: 'printf THIRD', affects: 'none' },
      ] } }];
      const planned = await fixture.publicExecutor.execute('machines.setup.plan', {
        homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects', sources,
      }, { ...context, actionRequestId: 'reviewed-script-plan' });
      expect(planned).toMatchObject({ ok: true });
      if (!planned.ok) throw new Error('Script Plan failed');
      const review = MachineSetupPlanResultV1Schema.parse(planned.result);
      const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, sources: review.sources,
          desiredRevision: review.desiredRevision, recipePlans: review.recipePlans }] });
      let scriptCount = 0;
      let secondStarted!: () => void;
      const secondScript = new Promise<void>(resolve => { secondStarted = resolve; });
      nativeTerminal.autoExit = false;
      // Only the native PTY boundary is substituted. The real finite process,
      // Setup runner, signed ingress and Workflow coordinator settle the result.
      nativeTerminal.onLaunch = () => {
        scriptCount += 1;
        if (scriptCount === 2) secondStarted();
        else queueMicrotask(() => nativeTerminal.exit?.(0));
      };
      try {
        const applied = await fixture.publicExecutor.execute('machines.setup.apply', input,
          withNativeConfirmation('machines.setup.apply', input, context));
        expect(applied).toMatchObject({ ok: true });
        if (!applied.ok) throw new Error('Script Apply admission failed');
        const receipt = MachineSetupApplyResultV1Schema.parse(applied.result);
        const coordinator = fixture.waitForWorkflowCoordinator();
        await Promise.race([secondScript, ...(coordinator ? [coordinator.then(() => {
          throw new Error(`Workflow settled before the native script: ${JSON.stringify(fixture.workflowDiagnostic())}`);
        })] : [])]);
        expect(fixture.workflowDiagnostic()).toMatchObject({ coordinatePhase: 'run_coordinator' });
        nativeTerminal.exit?.(exitCode);
        const observationRequest = { operationId: receipt.operationId, waitForTerminal: true };
        const settled = ActionOperationGetV1ResponseSchema.parse(disconnectAfterWait
          // The deliberate observation outage must not also cancel the test's
          // separate Operation RPC; inspect the same receiver handler locally.
          ? await fixture.operations.handlers.getV2(observationRequest, fixture.context('machines.setup.apply'))
          : await callExactMachineRpc({ credentials: fixture.credentials,
            serverUrl: 'https://native-software.invalid', machineId: fixture.machine.id,
            method: ACTION_OPERATION_RPC_METHODS_V2.get, request: observationRequest,
            timeoutMs: null, signal: context.signal }));
        await fixture.waitForWorkflowCoordinator();
        expect(disconnected).toBe(disconnectAfterWait);
        expect(settled, JSON.stringify({ settled, workflow: fixture.workflowDiagnostic() })).toMatchObject({
          kind: 'found', operation: { state: exitCode === 0 ? 'succeeded' : 'failed',
            ...(exitCode === 0 ? {} : { error: { errorCode: 'machine_setup_setup_failed',
              details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode } } }) },
        });
        expect(fixture.workflowDiagnostic()).toMatchObject({ coordinateState: exitCode === 0 ? 'succeeded' : 'failed' });
        if (exitCode !== 0) expect(fixture.workflowDiagnostic().invocations).toContainEqual(expect.objectContaining({
          lifecycle: 'failed', reasonCode: 'machine_setup_setup_failed',
        }));
        expect(scriptCount).toBe(exitCode === 0 ? 3 : 2);
        const desired = await fixture.client.getMachineSetupDesiredSnapshot();
        expect(desired).toMatchObject({ status: 'ready', policy: {
          ...(exitCode === 0 ? {} : { sourceFacts: { direct: { pendingScripts: [1, 2] } } }),
        } });
      } finally {
        nativeTerminal.onLaunch = undefined;
        nativeTerminal.autoExit = true;
        nativeTerminal.exit?.(exitCode);
        const observation = fixture.context('machines.setup.apply');
        const operations = await fixture.operations.handlers.listV2({}, observation);
        await Promise.all(operations.items.map(operation => fixture.operations.handlers.getV2(
          { operationId: operation.operationId, waitForTerminal: true }, observation)));
      }
    }, undefined, undefined, 'plain');
  });
});
