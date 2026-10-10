import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// Modal presentation is the external boundary; its real destination/resource owner stays real.
const modal = vi.hoisted(() => ({ show: vi.fn<import('@/modal').IModal['show']>(() => 'modal-id') }));
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modal.show } }).module,
);

import { ProjectScriptRow } from './ProjectScriptRow';

afterEach(() => { standardCleanup(); modal.show.mockClear(); });

describe('Script output before a terminal exists', () => {
  it('shows the observed queue/copy/setup stage and actual target instead of empty output', async () => {
    const workspace: WorkspaceAddressV1 = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
    for (const phase of ['queued', 'copying', 'setup'] as const) {
      const operation: ActionOperationProjection = {
        serverId: 'custody-home', observation: 'available', isUnavailableProjection: false,
        snapshot: {
          version: 1, operationId: `build-${phase}`, revision: 1, actionId: 'projects.script.run',
          state: 'accepted', scope: { accountId: 'account', machineId: 'custody-machine' },
          title: 'Build', createdAt: 1_000, cancellation: 'supported',
          progress: { kind: 'phase', phase, label: phase, ...(phase === 'queued' ? { queueAhead: 2 } : {}) },
          domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'target-home',
            machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/worker' },
        },
      };
      const screen = await renderScreen(<ProjectScriptRow testID="script" workspace={workspace}
        name="Build" badge={null} command="build" portable operation={operation}
        idleText="Not run" pending={false} failureCode={null} compact={false} onRun={() => {}} />);
      await screen.pressByTestIdAsync('script');
      const output = screen.findAllByTestId('script.noOutput').find((node) => typeof node.props.title === 'string');
      const title = output?.props.title as string | undefined;
      expect(title).toContain(phase === 'queued' ? 'projectWorkers.queuedOn'
        : phase === 'copying' ? 'projectWorkers.copying' : 'projectWorkers.preparing');
      expect(title).toContain('machine=target-machine');
      if (phase === 'queued') expect(title).toContain('count=2');
      expect(screen.getTextContent()).not.toContain('projects.scripts.output.empty');
      await screen.unmount();
    }
  });

  it('opens an existing worker-copy link in the canonical qualified Sync destination without rerunning', async () => {
    const workspace: WorkspaceAddressV1 = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
    const onRun = vi.fn();
    const screen = await renderScreen(<ProjectScriptRow testID="script" workspace={workspace}
      name="Build" badge={null} command="build" portable operation={null}
      idleText="Not run" pending={false} failureCode={null} compact={false} onRun={onRun}
      workerRefusal={{ kind: 'no_worker_can_accept', reason: 'worker_copy_missing', unavailable: 'ask',
        workerCopy: { serverId: workspace.serverId, sourceWorkspaceRefId: workspace.workspaceId,
          sourceMachineId: workspace.machineId, targetMachineId: 'worker-machine' } }} />);
    await screen.pressByTestIdAsync('script.noWorker.setUpCopy');
    expect(modal.show).toHaveBeenCalledOnce();
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const summary: WorkspaceSyncRelationshipSummary = {
      serverId: workspace.serverId, relationshipId: 'worker-link', status: null,
      relationship: { v: 1, relationshipId: 'worker-link', controllerMachineId: 'source-machine',
        alphaWorkspaceRefId: workspace.workspaceId, betaWorkspaceRefId: 'worker-copy', mode: 'keep_synced',
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
        enabled: true, createdAtMs: 1, updatedAtMs: 1,
        provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: workspace.workspaceId, targetWorkspaceRefId: 'worker-copy' } },
      alpha: { workspaceRefId: workspace.workspaceId, workspaceRef: { id: workspace.workspaceId, serverId: workspace.serverId,
        machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }, label: 'Source', machineName: 'Source' },
      beta: { workspaceRefId: 'worker-copy', workspaceRef: { id: 'worker-copy', serverId: workspace.serverId,
        machineId: 'worker-machine', rootPath: '/worker', createdAtMs: 1 }, label: 'Worker', machineName: 'Worker' },
    };
    modal.show.mock.calls[0]?.[0].props.onOpenExisting(summary);
    expect(modal.show).toHaveBeenCalledTimes(2);
    expect(modal.show.mock.calls[1]?.[0].props.resource).toMatchObject({
      kind: 'workspaceSyncConflicts', serverId: workspace.serverId,
      workspaceRefId: workspace.workspaceId, controllerMachineId: 'source-machine',
    });
    expect(onRun).not.toHaveBeenCalled();
  });
});
