import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import {
  createMachineFixture,
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';

const routerMock: {
  value: ReturnType<
    typeof import('@/dev/testkit/mocks/router').createExpoRouterMock
  > | null;
} = { value: null };
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock();
  routerMock.value = mock;
  return mock.module;
});

const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } =
  await import('@/sync/domains/server/serverRuntime');
const { SessionHeaderSandboxChip } = await import('./SessionHeaderSandboxChip');

function correspondence(origin: 'machine_policy' | 'session_defaults') {
  return buildSessionCreationCorrespondence({
    identity: {
      callerCreationNamespace: 'account',
      creationKey: `sandboxed-${origin}`,
    },
    recipe: {
      execution: { machineId: 'guest', directory: { kind: 'managed' } },
      organization: { folderId: null, tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'fixture.agent', localId: 'coder' },
      },
      managedCreation: {
        homeId: 'home',
        managedId: 'node-22 sandbox',
        controller: {
          machineId: 'devbox',
          installationId: 'devbox-installation',
        },
      },
      managedCreationOrigin: origin,
    },
  });
}

describe('SessionHeaderSandboxChip (F6)', () => {
  let previousState: ReturnType<typeof storage.getState>;
  let serverId: string;
  beforeEach(async () => {
    serverId = (
      await upsertAndActivateServer({
        serverUrl: 'https://sandbox-chip.example.test',
        scope: 'device',
      })
    ).id;
    previousState = storage.getState();
    const devbox = createMachineFixture({
      id: 'devbox',
      active: true,
      activeAt: Date.now(),
      metadata: { ...createMachineFixture().metadata!, displayName: 'devbox' },
    });
    const sandboxed = createSessionFixture({
      id: 'sandboxed',
      serverId,
      metadata: {
        machineId: 'guest',
        path: '',
        host: 'guest',
        homeDir: '/home/agent',
        sessionCreationCorrespondenceV1: correspondence('machine_policy'),
      } as never,
    });
    const direct = createSessionFixture({
      id: 'direct',
      serverId,
      metadata: {
        machineId: 'devbox',
        path: '/repo',
        host: 'devbox',
        homeDir: '/home/me',
        sessionCreationCorrespondenceV1: correspondence('session_defaults'),
      } as never,
    });
    storage.setState({
      sessions: { [sandboxed.id]: sandboxed, [direct.id]: direct },
      machines: { [devbox.id]: devbox },
      machineListByServerId: { [serverId]: [devbox] },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(previousState, true);
  });

  it('names the Session’s sandbox with its host and opens the same managed detail the Sandboxes tab opens', async () => {
    const screen = await renderScreen(
      <SessionHeaderSandboxChip sessionId="sandboxed" serverId={serverId} />,
    );
    const chip = screen.findByTestId('session-header-sandbox-chip');
    expect(chip).not.toBeNull();
    expect(chip!.props.accessibilityLabel).toContain('devbox');
    await act(async () => screen.pressByTestId('session-header-sandbox-chip'));
    expect(routerMock.value!.spies.push).toHaveBeenCalledWith(
      `/settings/machines/managed/${encodeURIComponent('node-22 sandbox')}?serverId=${encodeURIComponent(serverId)}`,
    );
    await screen.unmount();
  });

  it('draws nothing for a Session that runs directly or was placed by Session defaults', async () => {
    const screen = await renderScreen(
      <SessionHeaderSandboxChip sessionId="direct" serverId={serverId} />,
    );
    expect(screen.findByTestId('session-header-sandbox-chip')).toBeNull();
    await screen.unmount();
  });
});
