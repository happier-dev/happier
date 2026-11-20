import '../../../../ui/sources/dev/vitestSetup';
import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';
import {
  ActionOperationSnapshotV1Schema,
  projectActionOperationSnapshotForV1Reader,
  readActionOperationTerminalResultV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { buildStartPendingStatus } from '@/api/machine/sessionHandoff/prepareTargetState';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { coordinateTrackedSessionHandoff } from './sessionHandoffCoordinator';
import { ActionOperationSnapshotV1Schema as PredecessorSnapshotSchema } from './testFixtures/predecessorActionOperationV1';
import type { SessionHandoffProgressModal } from '../../../../ui/sources/components/sessions/handoff/SessionHandoffProgressModal';
import { installSessionHandoffCommonModuleMocks } from '../../../../ui/sources/components/sessions/handoff/sessionHandoffTestHelpers';
import { renderScreen, standardCleanup } from '../../../../ui/sources/dev/testkit';

type ProgressProps = React.ComponentProps<typeof SessionHandoffProgressModal>;
const modal = vi.hoisted(() => ({
  show: vi.fn<(input: { component: React.ComponentType<ProgressProps>; props: ProgressProps }) => string>(() => 'handoff-modal'),
  update: vi.fn<(id: string, props: Partial<ProgressProps>) => void>(),
}));
installSessionHandoffCommonModuleMocks({
  storage: importOriginal => importOriginal(),
  modal: async () => {
    const { createModalModuleMock } = await import('../../../../ui/sources/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        show: (...args: unknown[]) => modal.show(args[0] as Parameters<typeof modal.show>[0]),
        update: (...args: unknown[]) => modal.update(args[0] as string, args[1] as Partial<ProgressProps>),
      },
    }).module;
  },
});

const { installSessionOpsNetworkBoundary } = await import('../../../../ui/sources/dev/testkit/harness/sessionOpsNetworkBoundary');
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { openObservedSessionHandoffProgressModal } = await import('../../../../ui/sources/components/sessions/handoff/openSessionHandoffProgressModal');
const { createActionOperationStore: createUiOperationStore } = await import('../../../../ui/sources/sync/domains/actionOperations/actionOperationStore');
const { useSessionResumeRequestListener } = await import('../../../../ui/sources/components/sessions/model/sessionResumeRequests');

const home = 'home-handoff';
const scope = { accountId: 'account-handoff', machineId: 'source-machine', sessionId: 'session-handoff' };
const handoffId = 'handoff-1';
const targetMachineId = 'target-machine';
const prepared = {
  handoffId,
  status: { handoffId, phase: 'staging_target', status: 'ready_for_cutover' },
  remoteSessionId: 'remote-1',
  directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
  resume: {
    directory: '/repo', agent: 'claude', resume: 'remote-1', transcriptStorage: 'persisted', approvedNewDirectoryCreation: true,
  },
};
const unexpected = async (): Promise<never> => { throw new Error('Unexpected handoff phase'); };
const recovery = { kind: 'session_handoff_source_stopped' };

afterEach(() => {
  standardCleanup();
  vi.clearAllMocks();
});
afterAll(() => network.dispose());

describe('observed handoff recovery', () => {
  it.each([
    { phase: 'prepare', source: 'stopped', targetAbortStatus: 'aborted', showsRecovery: true },
    { phase: 'resume', source: 'stopped', targetAbortStatus: 'aborted', showsRecovery: true },
    { phase: 'resume', source: 'stopped', targetAbortStatus: 'failed', showsRecovery: false },
    { phase: 'prepare', source: 'already_inactive', targetAbortStatus: 'aborted', showsRecovery: false },
  ] as const)('handles recovery after target $phase fails with source $source and target abort $targetAbortStatus', async ({ phase, source, targetAbortStatus, showsRecovery }) => {
    const uiStore = createUiOperationStore();
    const requestId = 'handoff-request';
    const presentation = openObservedSessionHandoffProgressModal({ requestId, ...scope, serverId: home, store: uiStore });
    const daemonStore = createActionOperationStore();
    const spec = getActionSpec('session.handoff');
    const runner = createActionOperationRunner({ store: daemonStore, generateOperationId: () => 'handoff-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const input = { sessionId: scope.sessionId, targetMachineId, targetPath: '/repo' };
    let sourceReached = false;
    const errorCode = phase === 'prepare' ? 'session_handoff_prepare_failed' : 'session_handoff_resume_failed';
    const failTarget = async () => {
      expect(sourceReached).toBe(true);
      return { ok: false, errorCode, error: errorCode,
        ...(showsRecovery ? {} : { details: { handoffRecovery: recovery } }),
      };
    };
    const abort = vi.fn(async ({ machineId }: { machineId: string }) => ({ handoffId, status: {
      handoffId, phase: 'staging_target', status: machineId === targetMachineId ? targetAbortStatus : 'aborted',
    } }));
    try {
      await runner.observe({
        actionId: spec.id, scope, requestId, input, response: 'terminal',
        execute: ({ signal, publishOwnerUpdate }) => coordinateTrackedSessionHandoff({
          input, signal, publishOwnerUpdate,
          resolveSource: async () => ({ ok: true, sourceMachineId: scope.machineId, sessionStorageMode: 'persisted' }),
          start: async () => {
            sourceReached = true;
            return { ok: true, result: { handoffId, targetPath: '/repo', status: {
              ...buildStartPendingStatus({ handoffId, sourceStopState: source }), transportStrategy: 'server_routed_stream',
            } } };
          },
          workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never, bootstrap: unexpected }),
          checkExistingTarget: unexpected,
          prepareTarget: phase === 'prepare' ? failTarget : async () => prepared,
          getPreparedTargetResult: unexpected, getTargetStatus: unexpected,
          resumeTarget: phase === 'resume' ? failTarget : unexpected,
          confirmTarget: unexpected, commitTarget: unexpected, cleanupSource: unexpected, abort,
        }),
      });
      expect(abort.mock.calls).toHaveLength(2);
      const snapshot = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(daemonStore.get(scope, 'handoff-operation'))));
      expect(snapshot).toMatchObject({ state: 'failed', error: { errorCode } });
      if (showsRecovery) {
        expect.soft(snapshot.error).toMatchObject({ handoffRecovery: recovery });
        expect.soft(readActionOperationTerminalResultV1(snapshot)).toMatchObject({ ok: false, errorCode, details: { handoffRecovery: recovery } });
        expect(PredecessorSnapshotSchema.parse(projectActionOperationSnapshotForV1Reader(snapshot)).error).toEqual({ errorCode, error: errorCode });
      } else {
        expect(snapshot.error).not.toHaveProperty('handoffRecovery');
      }
      uiStore.mergeSnapshots({ serverId: home, snapshots: [snapshot] });
      const shown = modal.show.mock.calls[0]?.[0];
      const updated = modal.update.mock.calls.at(-1)?.[1];
      if (!shown || !updated) throw new Error('Handoff operation did not reach the progress modal');
      const Progress = shown.component;
      const resume = vi.fn(async () => true);
      const otherHomeResume = vi.fn(async () => true);
      function ObserveProgress() {
        useSessionResumeRequestListener(scope.sessionId, resume, home);
        useSessionResumeRequestListener(scope.sessionId, otherHomeResume, 'other-home');
        return <Progress {...shown!.props} {...updated} onClose={vi.fn()} setChrome={vi.fn()} />;
      }
      const screen = await renderScreen(<ObserveProgress />);
      if (showsRecovery) {
        expect.soft(screen.getTextContent()).toContain('sessionHandoff.recovery.messageAfterSourceStop');
        await screen.pressByTestIdAsync('session-handoff-progress-resume');
        expect(resume).toHaveBeenCalledOnce();
        expect(otherHomeResume).not.toHaveBeenCalled();
      } else {
        expect(screen.getTextContent()).not.toContain('sessionHandoff.recovery.messageAfterSourceStop');
        expect(screen.findByTestId('session-handoff-progress-resume')).toBeNull();
      }
    } finally {
      presentation.close();
    }
  });
});
