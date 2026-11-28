import { describe, expect, it, vi } from 'vitest';
import { withAdmittedSessionRun } from './bridges/executionRun/testkit/admittedSessionRun.composed';
import { createCapabilitySelectionSynchronizer, type CapabilitySelectionSynchronizerInput } from './capabilitySelectionSynchronizer';
import { createSessionProviderInputConsumerSessionAdapter } from './waitForNextPermissionModeMessage';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ExecutionRunListResponseSchema, ExecutionRunStartResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { createSessionRunnerRestartAdmission, prepareSessionRunnerRestartAdmission, registerSessionProviderInputAdmissionRpc } from './session/input/sessionProviderInputAdmissionRpc';
import { createSessionProviderInputConsumer } from './session/input/sessionProviderInputConsumer';
import { MessageQueue2 } from './modeMessageQueue';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

describe('capability refresh during real Run admission', () => {
  it.each((['capability_selection_change', 'version_runtime_refresh', 'connected_service_switch'] as const)
    .flatMap(reason => [false, true].map(providerSafe => ({ reason, providerSafe }))))(
    'protects creation arriving after the first activity check ($reason, providerSafe=$providerSafe)', async ({ reason, providerSafe }) => {
      let armed = false;
      let entered!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await withAdmittedSessionRun({
        beforeRunReportPreferencesRead: async () => { if (armed) { entered(); await held; } },
        async run({ rpc, start, session, agentIdentity, trackedSessions }) {
          const lifetime = new AbortController();
          const startCreation = providerSafe ? async () => ExecutionRunStartResponseSchema.parse(await rpc.invokeLocal(
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1, { runId: null, resume: false, start: {
              sessionId: session.sessionId, intent: 'delegate', backendTarget: { kind: 'agent', identity: agentIdentity },
              instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
              runClass: 'bounded', ioMode: 'request_response', modelSelection: null, connectedServices: null,
            } }, { verifiedPeerAuthority: 'present_user' })) : start;
          registerSessionProviderInputAdmissionRpc({ rpcHandlerRegistrar: rpc,
            runnerRestartAdmission: createSessionRunnerRestartAdmission(() => rpc),
            consumer: createSessionProviderInputConsumer({ session: createSessionProviderInputConsumerSessionAdapter(session), messageQueue: new MessageQueue2(() => 'fixture') }) });
          const tracked = trackedSessions.find(child => child.happySessionId === session.sessionId && child.pid === process.pid);
          if (!tracked) throw new Error('Missing daemon-tracked fixture Session');
          let creating: ReturnType<typeof start> | undefined;
          let restarting: ReturnType<typeof requestPlannedRunnerRestart> | undefined;
          let inFlightAtSignal: number | undefined;
          const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
            inFlightAtSignal = rpc.getInFlightRequestCount();
            return true;
          });
          const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
          if (reason === 'connected_service_switch') {
            queue.recordTurnLifecycleEvent({ sessionId: session.sessionId, event: 'task_started' });
          }
          try {
            restarting = requestPlannedRunnerRestart({ sessionId: session.sessionId, tracked, reason,
              deferral: reason === 'connected_service_switch'
                ? { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_idle',
                  target: { serviceId: 'fixture', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue: queue }
                : { kind: 'none' },
              restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
              isProcessSafeToSignal: async () => {
                if (!creating) {
                  armed = true;
                  creating = startCreation();
                  await Promise.race([reading, creating.then(() => { throw new Error('Expected held creation'); })]);
                }
                return true;
              },
              prepareSignal: signal => prepareSessionRunnerRestartAdmission({ expectedPid: tracked.pid, signal: AbortSignal.any([signal, lifetime.signal]),
                onHold: attempt => { tracked.plannedRestartAdmission = attempt; },
                callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request,
                  { ...(signal ? { signal } : {}), verifiedPeerAuthority: 'present_user' }) }),
              canSignal: async () => {
                const { runs } = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
                  { verifiedPeerAuthority: 'present_user' }));
                expect(rpc.getInFlightRequestCount()).toBe(1); // the restart hold itself
                expect(runs.length).toBeGreaterThanOrEqual(1);
                return true;
              },
              captureRunnerRemainder: async () => {
                const caller = new AbortController();
                const waiting = rpc.invokeLocal(providerSafe ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1
                  : SESSION_RPC_METHODS.EXECUTION_RUN_START, {}, { signal: caller.signal });
                await new Promise<void>(resolve => setImmediate(resolve));
                caller.abort();
                const late = await waiting as { details?: unknown };
                expect(late).toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
                expect(readExecutionRunStartRunCreation(late.details)).toBe('noRunCreated');
                return { scope: 'subtree', roots: [], ownership: [] };
              },
              requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
                shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
            });
            void restarting.catch(() => undefined);
            if (reason === 'connected_service_switch') {
              queue.recordTurnLifecycleEvent({ sessionId: session.sessionId, event: 'assistant_message_end' });
            }
            await reading;
            // The original signal gate sees an empty List while Start owns preparation.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(inFlightAtSignal).toBeUndefined();
            release();
            const admitted = await creating;
            await restarting;
            expect(inFlightAtSignal).toBe(1);
            const caller = new AbortController();
            const waiting = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}, { signal: caller.signal });
            caller.abort();
            await expect(waiting)
              .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
            const after = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
              { verifiedPeerAuthority: 'present_user' }));
            expect(after.runs.some(run => run.runId === admitted?.runId)).toBe(true);
          } finally {
            lifetime.abort();
            release();
            const admitted = await creating;
            await restarting?.catch(() => undefined);
            kill.mockRestore();
            if (admitted) await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: admitted.runId },
              { verifiedPeerAuthority: 'present_user' });
            await queue.cancelAll('daemon_shutdown');
          }
        },
      });
    });
  it('waits for Run creation custody to settle and retains the admitted Run', async () => {
    let armed = false;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    await withAdmittedSessionRun({
      beforeRunReportPreferencesRead: async () => { if (armed) { entered(); await response; } },
      async run({ rpc, start, session, trackedSessions }) {
        // Retained terminal peers belong to this Session and must not make
        // custody assertions depend on which other cases ran first.
        const peer = await start();
        await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: peer.runId },
          { verifiedPeerAuthority: 'present_user' });
        const baseline = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
          { verifiedPeerAuthority: 'present_user' })).runs.map(run => run.runId);
        expect(baseline).toContain(peer.runId);
        registerSessionProviderInputAdmissionRpc({ rpcHandlerRegistrar: rpc,
          runnerRestartAdmission: createSessionRunnerRestartAdmission(() => rpc),
          consumer: createSessionProviderInputConsumer({ session: createSessionProviderInputConsumerSessionAdapter(session), messageQueue: new MessageQueue2(() => 'fixture') }) });
        armed = true;
        const creating = start();
        await Promise.race([reading, creating.then(() => { throw new Error('Run admission did not reach the held Home read'); })]);
        let metadata = createTestMetadata();
        let enabled = true;
        const context = { machineId: 'admitted-machine', machinePlatform: 'posix' as const,
          directory: '/repo', projectKey: null, agentId: 'fixture' };
        const skillRules = () => [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' as const },
          enabled, createdAt: 1, updatedAt: enabled ? 1 : 2 }];
        let gateEntered!: () => void;
        const atGate = new Promise<void>(resolve => { gateEntered = resolve; });
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const restart = vi.fn<NonNullable<CapabilitySelectionSynchronizerInput['requestRestart']>>(async (_request, options) => {
          const restartSignal = options.signal;
          if (!restartSignal) throw new Error('Expected the synchronizer restart lifetime signal');
          const tracked = trackedSessions.find(child => child.happySessionId === session.sessionId && child.pid === process.pid);
          if (!tracked) throw new Error('Missing daemon-tracked fixture Session');
          const result = await requestPlannedRunnerRestart({ sessionId: session.sessionId, tracked,
            reason: 'capability_selection_change', deferral: { kind: 'none' }, restartRequestedSessions: new Set(),
            trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), isProcessSafeToSignal: async () => true,
            prepareSignal: async () => {
              gateEntered();
              return await prepareSessionRunnerRestartAdmission({ expectedPid: tracked.pid, signal: restartSignal,
                onHold: attempt => { tracked.plannedRestartAdmission = attempt; },
                callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request, { signal }) });
            },
            canSignal: async () => {
              const { runs } = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
                { verifiedPeerAuthority: 'present_user' }));
              expect(runs.filter(run => !baseline.includes(run.runId))).toHaveLength(1);
              return true;
            },
            requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
              shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
          });
          expect(result).toEqual({ signaled: true });
          return { ok: true as const, status: 'restarted' as const, sessionId: session.sessionId };
        });
        const sync = createCapabilitySelectionSynchronizer({
          session: { sessionId: session.sessionId, getMetadataSnapshot: () => metadata,
            updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
          agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
          isStarted: () => true, isSettled: () => true, requestRestart: restart,
          initialSkillRules: { context, rules: skillRules() },
          readSkillRules: () => ({ context, rules: skillRules() }),
        });
        enabled = false;
        const applying = sync.flushAfterSettledTurn();
        try {
          await Promise.race([atGate, applying]);
          expect(kill).not.toHaveBeenCalled();
          const before = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
            { verifiedPeerAuthority: 'present_user' }));
          expect(before.runs.map(run => run.runId)).toEqual(baseline);
          release();
          const admitted = await creating;
          await applying;
          expect(restart).toHaveBeenCalledTimes(1);
          const after = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
            { verifiedPeerAuthority: 'present_user' }));
          expect(after.runs.map(run => run.runId).filter(id => !baseline.includes(id))).toEqual([admitted.runId]);
        } finally { release(); await creating; await sync.dispose(); await applying; kill.mockRestore(); }
      },
    });
  });
});
