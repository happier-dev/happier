import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Platform/text boundaries only; the operation store, selectors and header stay real.
installSessionSubagentCommonModuleMocks({
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
  // Real English copy: the row's words are the contract under test.
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const { ProjectCommandToolTimelineRowHeader } =
  await import('./ProjectCommandToolTimelineRowHeader');
const { readTranscriptProjectCommandCall } =
  await import('@/components/sessions/transcript/references/transcriptProjectCommandReference');

afterEach(() => {
  standardCleanup();
  actionOperationStore.reset();
});

const accepted: ActionOperationSnapshotV1 = {
  version: 1,
  operationId: 'op-test',
  revision: 1,
  actionId: 'projects.script.run',
  state: 'accepted',
  scope: {
    accountId: 'account',
    machineId: 'hz-build-1',
    sessionId: 'session-1',
  },
  title: 'test',
  createdAt: 1,
  cancellation: 'supported',
  domainRef: {
    kind: 'projectCommand',
    purpose: 'script',
    serverId: 'home',
    machineId: 'hz-build-1',
    workspaceRefId: 'checkout',
    cwd: '/copy',
    sourceWorkspace: {
      serverId: 'home',
      machineId: 'devbox',
      workspaceId: 'checkout',
      rootPath: '/src/happier',
    },
    script: { name: 'test', source: { kind: 'command', command: 'yarn test' } },
  },
} as ActionOperationSnapshotV1;
const runTool = {
  name: 'mcp__happier__projects_script_run',
  state: 'completed' as const,
  input: {
    workspace: {
      serverId: 'home',
      machineId: 'devbox',
      workspaceId: 'checkout',
      rootPath: '/src/happier',
    },
    selection: { kind: 'named', name: 'test' },
  },
  result: {
    content: [{ type: 'text', text: JSON.stringify({ operation: accepted }) }],
  },
};
const waitTool = {
  name: 'mcp__happier__wait',
  state: 'running' as const,
  result: null,
  input: {
    target: {
      kind: 'action_operation',
      serverId: 'home',
      machineId: 'hz-build-1',
      operationId: 'op-test',
    },
    condition: { kind: 'terminal' },
  },
};
const header = {
  title: 'MCP: Happier Projects Script Run',
  icon: null,
  density: 'regular' as const,
  onPress: null,
  canOpen: false,
  onOpen: null,
};

describe('agent Project command tool rows', () => {
  it('reads the accepted run and its wait from the one live operation', async () => {
    const screen = await renderScreen(
      <>
        <ProjectCommandToolTimelineRowHeader
          header={{ ...header, testID: 'run' }}
          call={readTranscriptProjectCommandCall(runTool)!}
          tool={runTool}
          serverId="home"
        />
        <ProjectCommandToolTimelineRowHeader
          header={{ ...header, testID: 'wait' }}
          call={readTranscriptProjectCommandCall(waitTool)!}
          tool={waitTool}
          serverId="home"
        />
      </>,
    );
    expect(screen.getTextContent()).toContain(
      'Ran happier project script run test',
    );
    // Before this client knows the operation, the acknowledgement alone says Accepted and where.
    expect(screen.getTextContent()).toContain('Accepted · hz-build-1');
    expect(screen.findByTestId('project-command-tool.live')).toBeNull();

    await act(async () => {
      actionOperationStore.mergeSnapshots({
        serverId: 'home',
        snapshots: [
          {
            ...accepted,
            revision: 2,
            state: 'running',
            startedAt: 5,
            domainRef: {
              ...accepted.domainRef!,
              terminalId: 'term-1',
            } as ActionOperationSnapshotV1['domainRef'],
          },
        ],
      });
    });
    expect(screen.getTextContent()).toContain('Running on hz-build-1');
    expect(screen.getTextContent()).toContain('Waiting for test');
    expect(screen.getTextContent()).toContain('on hz-build-1');
    expect(screen.findByTestId('project-command-tool.live')).not.toBeNull();

    await act(async () => {
      actionOperationStore.mergeSnapshots({
        serverId: 'home',
        snapshots: [
          {
            ...accepted,
            revision: 3,
            state: 'failed',
            startedAt: 5,
            settledAt: 9,
            error: { errorCode: 'project_command_step_failed', error: 'exit' },
            domainRef: {
              ...accepted.domainRef!,
              terminalId: 'term-1',
              exitCode: 1,
            } as ActionOperationSnapshotV1['domainRef'],
          },
        ] as never,
      });
    });
    // A nonzero exit is the run's result, never success; the wait stops ticking.
    expect(screen.getTextContent()).toContain('Exited with code 1');
    expect(screen.findByTestId('project-command-tool.live')).toBeNull();
    await screen.unmount();
  });
});
