import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { act } from 'react-test-renderer';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RunClock } from './ProjectRunMarks';

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

// The device class is a platform adapter boundary; only the phone case sets it.
const device = vi.hoisted(() => ({ current: null as 'phone' | null }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => device.current ?? actual.useDeviceType() };
});

// Machine RPC is the external boundary; the output Action, its custody check and presentation stay real.
const outputRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: outputRpc }));

import { ProjectScriptRow } from './ProjectScriptRow';
import { ProjectCommandOutputPage } from '@/components/inbox/actionOperations/ProjectCommandOutputPage';
import { ActionOperationDetailModal } from '@/components/inbox/actionOperations/ActionOperationDetailModal';

afterEach(() => { standardCleanup(); modal.show.mockClear(); outputRpc.mockReset(); device.current = null; });

describe('Run clock presentation demand', () => {
  it('uses zero timers and commits while hidden, then samples elapsed time when presented again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const census = installTimerCensus();
    let commits = 0;
    const clock = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
      <React.Profiler id="run-clock" onRender={() => { commits += 1; }}><RunClock startedAt={1_000} /></React.Profiler>
    </PluginSurfaceFocusEligibilityProvider>;
    try {
      const screen = await renderScreen(clock(false));
      expect(census.read()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      commits = 0;
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(commits).toBe(0);
      await screen.update(clock(true));
      expect(screen.getTextContent()).toContain('1:00');
      expect(census.read()).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(screen.getTextContent()).toContain('1:01');
      await screen.update(clock(false));
      expect(census.read()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      commits = 0;
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(commits).toBe(0);
      await screen.update(clock(true));
      expect(screen.getTextContent()).toContain('2:01');
      await screen.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally { census.stop(); vi.useRealTimers(); }
  });
});

describe('Script row title line', () => {
  const workspace: WorkspaceAddressV1 = { serverId: 'home', machineId: 'machine', workspaceId: 'ws', rootPath: '/repo' };
  const row = () => <ProjectScriptRow testID="script" workspace={workspace} name="test" badge="package.json" command="yarn test"
    portable operation={null} idleText="Not run" pending={false} failureCode={null} compact={false} onRun={() => {}} />;

  it('names the worker pool beside a portable script on a wide page', async () => {
    const screen = await renderScreen(row());
    expect(screen.getTextContent()).toContain('projects.scripts.anyWorker');
    await screen.unmount();
  });

  it('leaves the phone row to its name and source badge, so the name never wraps by letter', async () => {
    device.current = 'phone';
    const screen = await renderScreen(row());
    expect(screen.getTextContent()).toContain('package.json');
    expect(screen.getTextContent()).not.toContain('projects.scripts.anyWorker');
    await screen.unmount();
  });
});

describe('Running script row anatomy', () => {
  const workspace: WorkspaceAddressV1 = { serverId: 'home', machineId: 'machine', workspaceId: 'ws', rootPath: '/repo' };
  const running: ActionOperationProjection = {
    serverId: 'home', observation: 'available', isUnavailableProjection: false,
    snapshot: { version: 1, operationId: 'test-run', revision: 2, actionId: 'projects.script.run', state: 'running',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'test', createdAt: 1_000, startedAt: 1_100, cancellation: 'supported',
      progress: { kind: 'output', label: 'ok src/cart.test.tsx (14 tests)' } as never,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine',
        workspaceRefId: 'ws', cwd: '/repo', terminalId: 'pty' } },
  };
  const row = () => <ProjectScriptRow testID="script" workspace={workspace} name="test" badge="package.json" command="yarn test"
    portable operation={running} idleText="Not run" pending={false} failureCode={null} compact={false} onRun={() => {}} />;

  it('lets a wide row open into its output with a caret and the latest output line under its status', async () => {
    const screen = await renderScreen(row());
    expect(screen.findByTestId('script.caret')).toBeTruthy();
    expect(screen.findByTestId('script.tail')).toBeTruthy();
    await screen.unmount();
  });

  it('keeps the phone row to its status and Run control: the row press opens the output, no caret or output line', async () => {
    device.current = 'phone';
    const screen = await renderScreen(row());
    expect(screen.findByTestId('script.caret')).toBeFalsy();
    expect(screen.findByTestId('script.tail')).toBeFalsy();
    expect(screen.findByTestId('script.run')).toBeTruthy();
    await screen.unmount();
  });
});

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
      // The stage reads once, in the row's status; the expanded body adds nothing that restates it.
      const stage = phase === 'queued' ? 'projectWorkers.queuedOn' : phase === 'copying' ? 'projectWorkers.copying' : 'projectWorkers.preparing';
      expect(screen.getTextContent().split(stage).length - 1).toBe(1);
      expect(screen.getTextContent()).toContain('machine=target-machine');
      if (phase === 'queued') expect(screen.getTextContent()).toContain('count=2');
      expect(screen.findAllByTestId('script.noOutput')).toHaveLength(0);
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
    await vi.waitFor(() => expect(modal.show).toHaveBeenCalledOnce());
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const summary: WorkspaceSyncRelationshipSummary = {
      serverId: workspace.serverId, relationshipId: 'worker-link', status: null,
      relationship: { v: 1, relationshipId: 'worker-link', controllerMachineId: 'source-machine',
        alphaWorkspaceRefId: workspace.workspaceId, betaWorkspaceRefId: 'worker-copy', mode: 'keep_synced',
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
        enabled: true, createdAtMs: 1, updatedAtMs: 1,
        provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: workspace.workspaceId, targetWorkspaceRefId: 'worker-copy' } },
      alpha: { workspaceRefId: workspace.workspaceId, workspaceRef: { id: workspace.workspaceId, serverId: workspace.serverId,
        machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }, label: 'Source', name: 'Source', machineName: 'Source' },
      beta: { workspaceRefId: 'worker-copy', workspaceRef: { id: 'worker-copy', serverId: workspace.serverId,
        machineId: 'worker-machine', rootPath: '/worker', createdAtMs: 1 }, label: 'Worker', name: 'Worker', machineName: 'Worker' },
    };
    const firstModal = modal.show.mock.calls[0]?.[0];
    if (!firstModal?.props) throw new Error('Expected worker-copy modal props');
    firstModal.props.onOpenExisting(summary);
    expect(modal.show).toHaveBeenCalledTimes(2);
    expect(modal.show.mock.calls[1]?.[0].props?.resource).toMatchObject({
      kind: 'workspaceSyncConflicts', serverId: workspace.serverId,
      workspaceRefId: workspace.workspaceId, controllerMachineId: 'source-machine',
    });
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe('A refusal newer than the retained run', () => {
  const workspace: WorkspaceAddressV1 = { serverId: 'home', machineId: 'machine', workspaceId: 'ws', rootPath: '/repo' };
  const finished: ActionOperationProjection = {
    serverId: 'home', observation: 'available', isUnavailableProjection: false,
    snapshot: {
      version: 1, operationId: 'earlier', revision: 2, actionId: 'projects.script.run', state: 'succeeded',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'verify', createdAt: 1_000, startedAt: 1_100, settledAt: 2_000,
      cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine', workspaceRefId: 'ws', cwd: '/repo' },
    },
  };
  const row = (failureCode: string | null) => <ProjectScriptRow testID="script" workspace={workspace} name="verify" badge={null}
    command="devenv shell" portable={false} operation={finished} idleText="Not run" pending={false} failureCode={failureCode}
    failureText={failureCode ? 'refusal sentence' : null} compact={false} onRun={() => {}} />;

  it('says the refusal and keeps the earlier run\'s output out from under it', async () => {
    const earlier = await renderScreen(row(null));
    await earlier.pressByTestIdAsync('script');
    expect(earlier.findAllByTestId('script.noOutput').length).toBeGreaterThan(0);
    await earlier.unmount();
    const refused = await renderScreen(row('native_tool_unavailable'));
    await refused.pressByTestIdAsync('script');
    expect(refused.getTextContent()).toContain('refusal sentence');
    expect(refused.findAllByTestId('script.noOutput')).toHaveLength(0);
    await refused.unmount();
  });
});

describe('A new machine created for this Run', () => {
  const workspace: WorkspaceAddressV1 = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
  const render = (progress: import('@/components/settings/machines/managed/managedMachineCreation').ManagedMachineCreationProgress,
    handlers: Readonly<{ onCancel: () => void; onResume: () => void }>) => renderScreen(<ProjectScriptRow testID="script"
    workspace={workspace} name="test" badge={null} command="yarn test" portable operation={null} idleText="Not run"
    pending={progress.kind !== 'failed'} failureCode={null} compact={false} onRun={() => {}}
    managedCreation={{ machineName: 'ci-1', progress }} onCancelManagedRun={handlers.onCancel} onResumeManagedRun={handlers.onResume} />);

  it('says which creation stage the Run waits on and cancels only the continuation', async () => {
    const handlers = { onCancel: vi.fn(), onResume: vi.fn() };
    const screen = await render({ kind: 'approval' }, handlers);
    const banner = screen.findAllByTestId('script.managed').find((node) => typeof node.props.title === 'string');
    expect(banner?.props.title).toContain('managedMachines.creation.approval');
    expect(banner?.props.description).toContain('projectWorkers.runWaitsForMachine');
    expect(screen.findByTestId('script.managed.resume')).toBeNull();
    await screen.pressByTestIdAsync('script.managed.cancel');
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('after the wait was cancelled, continues with the same machine only when asked', async () => {
    const handlers = { onCancel: vi.fn(), onResume: vi.fn() };
    const screen = await render({ kind: 'failed', code: 'continuation_retired', managedId: 'managed-1' }, handlers);
    const banner = screen.findAllByTestId('script.managed').find((node) => typeof node.props.title === 'string');
    expect(banner?.props.title).toContain('projectWorkers.creationStopped');
    expect(handlers.onResume).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('script.managed.resume');
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('script.managed.cancel')).toBeNull();
    await screen.unmount();
  });
});

describe('Script output on a phone', () => {
  it('opens a finished run as its own output page with the script and its command, not the operation detail', async () => {
    device.current = 'phone';
    const serverId = 'srv_phone_output';
    const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const home = await serveActionHomes({ homes: [{ key: 'phone', serverUrl: 'https://phone-output.test', accountId: 'account', serverIdentityId: serverId }],
      route: () => undefined });
    try {
      publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
      const workspace: WorkspaceAddressV1 = { serverId, machineId: 'source-machine', workspaceId: 'ws', rootPath: '/repo' };
      const snapshot = ActionOperationSnapshotV1Schema.parse({
        version: 1, operationId: 'fail-run', revision: 2, actionId: 'projects.script.run',
        state: 'failed', scope: { accountId: 'account', machineId: 'worker-machine' },
        title: 'Run a project script', createdAt: 1_000, startedAt: 1_000, settledAt: 2_000, cancellation: 'supported',
        error: { errorCode: 'project_command_step_failed', error: 'Exited with code 17' },
        domainRef: { kind: 'projectCommand', purpose: 'script', serverId,
          machineId: 'worker-machine', workspaceRefId: 'ws', cwd: '/repo', terminalId: 'fail-pty' },
      });
      outputRpc.mockImplementation(async () => ({ kind: 'found', operation: snapshot }));
      const operation: ActionOperationProjection = { serverId, observation: 'available', isUnavailableProjection: false, snapshot };
      const screen = await renderScreen(<ProjectScriptRow testID="script" workspace={workspace} name="fail" badge={null}
        command="exit 17" portable operation={operation} idleText="Not run" pending={false} failureCode={null}
        compact={false} onRun={() => {}} />);
      await screen.pressByTestIdAsync('script');
      await vi.waitFor(() => expect(modal.show).toHaveBeenCalled());
      const shown = modal.show.mock.calls.map(([config]) => config.component);
      expect(shown).not.toContain(ActionOperationDetailModal);
      expect(modal.show.mock.calls[0]?.[0]).toMatchObject({ component: ProjectCommandOutputPage,
        props: { serverId, operationId: 'fail-run', name: 'fail', command: 'exit 17' } });
      await screen.unmount();
    } finally { await home.dispose(); }
  });
});
