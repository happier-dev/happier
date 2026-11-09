import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, createMachineFixture } from '@/dev/testkit';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { WaitActionInputV1Schema, WaitActionResultV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AppPaneAction } from '@/components/appShell/panes/model/appPaneReducer';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

let viewportWidth = 1200;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Dimensions: {
    get: () => ({ width: viewportWidth, height: 900, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove() {} }),
  },
  useWindowDimensions: () => ({ width: viewportWidth, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Xterm is the platform boundary. The output pane, terminal controller, stream and frame remain real.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
  XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle, { onReady: (cols: number, rows: number) => void }>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ write: () => true, clear: () => {}, hasSelection: () => false, getSelectionText: () => '' }), []);
    React.useEffect(() => props.onReady(80, 24), [props.onReady]);
    return React.createElement('TerminalRenderer');
  }),
}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { EMPTY_TERMINAL_WORKSPACE } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
const { readSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');

beforeEach(async () => {
  viewportWidth = 1200;
  await loadSyncSingletonForTests();
  await homes.reset();
  actionOperationStore.reset();
  rpc.mockImplementation(async ({ method, payload }) => {
    if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES || method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ) {
      return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: payload.terminalId, frames: [
        { t: 'exit', terminalId: payload.terminalId, byteOffset: 0, exitCode: 1, signal: null },
      ], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
    }
    if (method === ACTION_OPERATION_RPC_METHODS_V2.get) {
      const operation = [...actionOperationStore.getSnapshot().operationsByKey.values()].find(value => value.snapshot.operationId === payload.operationId);
      return operation ? { kind: 'found', operation: operation.snapshot } : { kind: 'not_found' };
    }
    if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return { items: [], nextCursor: null };
    throw new Error(`unexpected_rpc:${method}`);
  });
  (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), storage.getState().applyLocalSettings({ }));
});

describe('terminal-less Project command output', () => {
  it.each(['projectCommand', 'machineSetup', 'directMachineSetup'] as const)('shows canonical terminal-less $0 review, uncertainty and settled states', async (variant) => {
    const kind = variant === 'directMachineSetup' ? 'machineSetup' : variant;
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const base: ActionOperationProjection = {
      serverId: 'home', observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'op', revision: 1, actionId: kind === 'machineSetup' ? 'machines.setup.apply' : 'projects.prepare', state: 'accepted',
        scope: { accountId: 'account', machineId: 'machine' }, title: 'Setup', createdAt: 1, cancellation: 'supported',
        domainRef: kind === 'machineSetup' ? { kind, serverId: 'home', machineId: 'machine',
            ...(variant === 'machineSetup' ? { preset: { id: 'preset', revision: 4 } } : {}) }
            : { kind, purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' } },
    };
    for (const snapshot of [
      { ...base.snapshot, state: 'failed' as const, settledAt: 2 },
      { ...base.snapshot, state: 'cancelled' as const, settledAt: 2 },
      { ...base.snapshot, state: 'succeeded' as const, settledAt: 2 },
      { ...base.snapshot, setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const, reviewedEffectDigest: 'effect', reviewedEffect: {} } },
      { ...base.snapshot, observation: { kind: 'outcome_uncertain' as const, code: 'lost' } },
    ]) {
      const screen = await renderScreen(<ProjectCommandOutputPane operation={{ ...base, snapshot }} title="Setup" />);
      expect(screen.findByTestId('project-command-output.pending')).toBeNull();
      expect(screen.findByTestId('project-command-output.status')).not.toBeNull();
      await screen.unmount();
    }
    const accepted = await renderScreen(<ProjectCommandOutputPane operation={base} title="Setup" />);
    expect(accepted.findByTestId('project-command-output.pending')).not.toBeNull();
  });
});

describe('Project command output with a docked terminal', () => {
  const withTerminal: ActionOperationProjection = {
    serverId: 'home', observation: 'available', isUnavailableProjection: false,
    snapshot: { version: 1, operationId: 'op', revision: 1, actionId: 'projects.script.run', state: 'running',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'Test', createdAt: 1, cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'pty-1' } },
  };
  const render = async (host = true, openInTerminal = true, owner?: 'wait' | 'script') => {
    viewportWidth = openInTerminal ? 1200 : 390;
    const serverId = await homes.addHome({ name: 'Project Home', serverUrl: 'https://project-output.test', accountId: 'account' });
    storage.getState().activateProfileScope({ serverId, accountId: 'account' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const features = createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true }, transport: { byteStream: { enabled: true } } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    homes.answer(serverId, '/v1/machines/machine', { body: { machine: createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }) } });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })]);
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features, serverIdentityId: features.capabilities.serverIdentity.serverIdentityId } });
    const scopeId = buildProjectPaneScopeId('workspace', serverId);
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const { ProjectCommandOutputHost, useProjectCommandOutputOpener } = await import('./projectCommandOutputHost');
    let pane: ReturnType<typeof useAppPaneContext> | undefined;
    function PaneOwner() {
      pane = useAppPaneContext();
      return null;
    }
    const running: ActionOperationProjection = { ...withTerminal, serverId, snapshot: { ...withTerminal.snapshot,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'pty-1' } } };
    const operation: ActionOperationProjection = owner ? { ...running,
      snapshot: ActionOperationSnapshotV1Schema.parse({ ...running.snapshot, state: 'failed', revision: 2, startedAt: 2, settledAt: 3,
        error: { errorCode: 'project_command_step_failed', error: 'failed' },
        domainRef: { ...running.snapshot.domainRef, exitCode: 1 } }) } : running;
    if (owner) {
      actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation.snapshot] });
    }
    const { ProjectCommandToolBody } = await import('@/components/tools/renderers/system/ProjectCommandToolBody');
    const { ProjectCommandToolTimelineRowHeader } = await import('@/components/tools/shell/views/timeline/ProjectCommandToolTimelineRowHeader');
    const { readTranscriptProjectCommandCall } = await import('@/components/sessions/transcript/references/transcriptProjectCommandReference');
    const { ProjectScriptRow } = await import('@/components/projects/projectSetup/ProjectScriptRow');
    function OutputPane() {
      const output = useProjectCommandOutputOpener();
      if (owner === 'wait') {
        const input = WaitActionInputV1Schema.parse({ target: { kind: 'action_operation', serverId, machineId: 'machine', operationId: 'op' }, condition: { kind: 'terminal' } });
        const tool = { name: 'mcp__happier__wait', input, state: 'completed' as const,
          result: WaitActionResultV1Schema.parse({ ...input, disposition: 'matched', snapshot: operation.snapshot }) };
        const call = readTranscriptProjectCommandCall(tool);
        if (!call) throw new Error('Expected the canonical completed wait projection');
        return <>
          <ProjectCommandToolTimelineRowHeader serverId={serverId} tool={tool} call={call}
            header={{ title: 'Wait for test', icon: null, density: 'comfortable', onPress: null, canOpen: false, onOpen: null }} />
          <ProjectCommandToolBody serverId={serverId} call={call} tool={tool} fallback={null} />
        </>;
      }
      if (owner === 'script') return <ProjectScriptRow testID="script" workspace={{ serverId, workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' }}
        name="test" command="exit 1" badge={null} portable={false} operation={operation} idleText="" pending={false} failureCode={null} compact={false} onRun={() => {}} />;
      return <ProjectCommandOutputPane operation={operation} title="test"
        onOpenInTerminal={output.opensInTerminal ? () => {} : undefined} onOpenDetail={() => {}} />;
    }
    const screen = await renderScreen(<AppPaneProvider>
      <PaneOwner />
      <ProjectCommandOutputHost scopeId={host ? scopeId : null}>
        <OutputPane />
      </ProjectCommandOutputHost>
    </AppPaneProvider>);
    const dispatch = async (action: AppPaneAction) => {
      await act(async () => {
        if (!pane) throw new Error('Pane owner is not mounted');
        pane.dispatch(action);
      });
    };
    await dispatch({ type: 'activateScope', scopeId });
    await dispatch({ type: 'setBottomTabState', scopeId, tabId: 'terminal',
      nextState: { ...EMPTY_TERMINAL_WORKSPACE, ownerScope: { serverId, accountId: 'account' } } });
    const openOutput = () => dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
      id: 'output-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-1', terminalKey: 'output-key', cwd: '/repo' },
    } } });
    return { screen, scopeId, dispatch, openOutput };
  };

  const expectInline = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
    expect(Boolean(screen.findHostByTestId('project-command-output'))).toBe(true);
    expect(Boolean(screen.findHostByTestId('project-command-output.docked'))).toBe(false);
  };
  const expectDocked = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
    expect(Boolean(screen.findHostByTestId('project-command-output'))).toBe(false);
    expect(Boolean(screen.findHostByTestId('project-command-output.docked'))).toBe(true);
    expect(Boolean(screen.findByTestId('project-command-output.openInTerminal'))).toBe(true);
  };

  it('mounts the PTY inline when the host tab does not show it', async () => {
    const { screen } = await render();
    expectInline(screen);
    await screen.unmount();
  });

  it('shows the failed target outcome once for a completed wait with empty output', async () => {
    const { screen } = await render(true, true, 'wait');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('tools.structuredResult.exit: 1'));
    expect(screen.getTextContent().split('tools.structuredResult.exit: 1')).toHaveLength(2);
    expect(screen.findByTestId('workspace-embedded-terminal-state-line')).toBeTruthy();
    await screen.unmount();
  });

  it('keeps a failed Scripts row outcome once when its real output pane opens', async () => {
    const { screen } = await render(true, true, 'script');
    await screen.pressByTestIdAsync('script');
    await vi.waitFor(() => expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)).toBe(true));
    expect(screen.getTextContent().split('projects.scripts.run.exited')).toHaveLength(2);
    expect(screen.findByTestId('workspace-embedded-terminal-state-line')).toBeNull();
    await screen.unmount();
  });

  it('keeps one surface for the PTY: the host tab owns it and the page points there', async () => {
    const { screen, openOutput } = await render();
    await openOutput();
    expectDocked(screen);
    await screen.unmount();
  });

  it.each(['bottom', 'right'] as const)('restores inline output when the retained %s pane is hidden and docks it again when reopened', async pane => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    if (pane === 'right') await dispatch({ type: 'openRight', scopeId, tabId: 'terminal' });
    expectDocked(screen);
    await dispatch({ type: pane === 'bottom' ? 'closeBottom' : 'closeRight', scopeId });
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1);
    expectInline(screen);
    await dispatch({ type: pane === 'bottom' ? 'openBottom' : 'openRight', scopeId, tabId: 'terminal' });
    expectDocked(screen);
    await screen.unmount();
  });

  it('restores inline output when another terminal workspace tab is active', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
      id: 'other-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-2', terminalKey: 'other-key', cwd: '/repo' },
    } } });
    expectInline(screen);
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'focus', terminalId: 'output-member' } });
    expectDocked(screen);
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(2);
    await screen.unmount();
  });

  it('restores inline output when its retained pane scope is no longer active', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    expectDocked(screen);
    await dispatch({ type: 'activateScope', scopeId: 'another-project' });
    expectInline(screen);
    await dispatch({ type: 'activateScope', scopeId });
    expectDocked(screen);
    await screen.unmount();
  });

  it.each([
    { kind: 'builtin', id: 'tasks' },
    { kind: 'plugin', destination: { pluginId: 'example', localId: 'terminal' } },
  ] as const)('restores inline output when the bottom pane selects another destination: $kind', async (destination) => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'selectBottomDestination', scopeId, destination });
    expectInline(screen);
    await screen.unmount();
  });

  it('keeps every split member docked while another split member has focus', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
      id: 'split-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-2', terminalKey: 'split-key', cwd: '/repo' },
    }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0]?.focusedTerminalId).toBe('split-member');
    expectDocked(screen);
    await screen.unmount();
  });

  it.each([
    { host: false, openInTerminal: true, name: 'no host' },
    { host: true, openInTerminal: false, name: 'phone/detail fallback' },
  ])('keeps inline output for $name', async ({ host, openInTerminal }) => {
    const { screen, openOutput } = await render(host, openInTerminal);
    await openOutput();
    expectInline(screen);
    await screen.unmount();
  });
});
