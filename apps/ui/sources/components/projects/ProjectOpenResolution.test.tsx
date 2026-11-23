import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { OpenProjectOptions } from './useOpenProject';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({});
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { storage } = await import('@/sync/domains/state/storage');
const { openProjectCandidate, ProjectOpenResolutionCard } = await import('./ProjectOpenResolution');

function checkout(machineId: string, rootPath: string): WorkspaceRefV1 {
  return {
    id: 'ref-shared',
    serverId: 'server-1',
    machineId,
    rootPath,
    createdAtMs: 1,
  };
}

describe('ProjectOpenResolutionCard (lab p-projects OPEN_S 2)', () => {
  it('opens the selected managed checkout when an unqualified id matches both Homes', async () => {
    const machine = checkout('m1', '/repo');
    const managed = {
      v: 2, kind: 'managed', id: machine.id, serverId: 'server-2',
      managedId: 'guest', controller: { machineId: 'm1', installationId: 'controller-installation' },
      rootPath: '/repo', createdAtMs: 1,
    } satisfies WorkspaceRefV1;
    const refs = [machine, managed];
    const issue = resolveWorkspaceRefV1(refs, { id: managed.id });
    expect(issue.kind).toBe('ambiguous');
    if (issue.kind !== 'ambiguous') throw new Error('Expected an ambiguous Project address');
    const open = vi.fn(async (_id: string, options?: OpenProjectOptions) => {
      const address = options?.workspaceAddress;
      if (!address) throw new Error('Missing exact Project address');
      const result = resolveWorkspaceRefV1(refs, address);
      expect(result).toEqual({ kind: 'resolved', ref: managed });
      return true;
    });
    const screen = await renderScreen(<ProjectOpenResolutionCard testID="resolution" issue={issue}
      onChoose={candidate => { void openProjectCandidate(open, candidate); }} />);

    await act(async () => {
      screen.findByTestId('resolution-candidate-1')!.props.onPress();
    });
    expect(open).toHaveBeenCalledWith(managed.id, { serverId: managed.serverId,
      workspaceAddress: { v: 2, kind: 'managed', serverId: managed.serverId, workspaceId: managed.id,
        managedId: managed.managedId, controller: managed.controller, rootPath: managed.rootPath } });
  });

  it('offers every matching checkout with where it lives and opens only the one chosen', async () => {
    storage
      .getState()
      .applyMachines(
        [
          createMachineFixture({
            id: 'm1',
            metadata: {
              host: 'studio',
              platform: 'darwin',
              happyCliVersion: '0',
              happyHomeDir: '/tmp/.happy',
              homeDir: '/Users/tester',
            },
          }),
          createMachineFixture({
            id: 'm2',
            metadata: {
              host: 'devbox',
              platform: 'linux',
              happyCliVersion: '0',
              happyHomeDir: '/tmp/.happy',
              homeDir: '/home/tester',
            },
          }),
        ],
        true,
      );
    const candidates = [
      checkout('m1', '/Users/tester/happier'),
      checkout('m2', '/home/tester/happier'),
    ];
    const onChoose = vi.fn();
    const screen = await renderScreen(
      <ProjectOpenResolutionCard
        testID="resolution"
        issue={{ kind: 'ambiguous', candidates }}
        onChoose={onChoose}
      />,
    );

    const second = screen.findAllByTestId('resolution-candidate-1')[0]!;
    expect(String(second.props.subtitle)).toContain('~/happier');
    expect(
      String(
        screen.findAllByTestId('resolution-candidate-0')[0]!.props.subtitle,
      ),
    ).not.toBe(String(second.props.subtitle));
    expect(onChoose).not.toHaveBeenCalled();

    await act(async () => {
      second.props.onPress();
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(candidates[1]);
  });

  it('never offers a guessed neighbour when the checkout is gone: only the way back', async () => {
    const onChoose = vi.fn();
    const back = vi.fn();
    const screen = await renderScreen(
      <ProjectOpenResolutionCard
        testID="resolution"
        issue={{ kind: 'missing' }}
        onChoose={onChoose}
        action={{ label: 'back', onPress: back }}
      />,
    );
    expect(screen.findByTestId('resolution-candidate-0')).toBeFalsy();
    await screen.pressByTestIdAsync('resolution-action');
    expect(back).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
