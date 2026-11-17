import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';

const navigation = vi.hoisted(() => ({ push: [] as unknown[] }));
vi.mock('expo-router', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock();
  mock.spies.push.mockImplementation((href: unknown) => {
    navigation.push.push(href);
  });
  return mock.module;
});
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

const { WorkflowEventStartedRuns } = await import('./WorkflowEventStartedRuns');

afterEach(() => standardCleanup());

const run = (id: string) =>
  ({
    id,
    state: 'running',
    stepProgress: null,
    origin: { kind: 'direct' },
  }) as unknown as WorkflowRunSummaryV1;

// Lab `events` detail: "Started from it" lists the Runs the picked fact started and opens each one.
describe('Started from it', () => {
  it('says nothing while no Run names the fact as its cause', async () => {
    const screen = await renderScreen(
      <WorkflowEventStartedRuns runs={[]} scope={null} testID="ev" />,
    );
    expect(screen.findByTestId('ev:started')).toBeNull();
  });

  it('lists each started Run and opens it on its Home', async () => {
    const scope = { serverId: 'home-1', accountId: 'account-1' } as never;
    const screen = await renderScreen(
      <WorkflowEventStartedRuns
        runs={[run('run-a'), run('run-b')]}
        scope={scope}
        testID="ev"
      />,
    );
    expect(screen.findByTestId('ev:started')).not.toBeNull();
    const row = screen.findByTestId('ev:started:run-b');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.props.onPress();
    });
    expect(navigation.push.at(-1)).toBe(
      '/workflows/runs/run-b?serverId=home-1',
    );
  });
});
