import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeSessionReadinessV1,
  type SessionReadinessFactsV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () =>
  (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock({ router: { push: navigation.push } }).module,
);

const scope = { serverId: 'home-1', accountId: 'alice' };
const readiness = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  current: null as unknown,
}));
// The Account binding and the status read are the data seams this pane consumes; the pane, its row
// and the checklist beneath it are the real components.
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', async (importOriginal) => ({
  // Only the pane's own binding read is the seam; the checklist's readers keep the real module.
  ...(await importOriginal<typeof import('@/sync/domains/scope/useServerCredentialAccountScopes')>()),
  useServerCredentialAccountScopeBindings: () =>
    new Map([
      [
        'home-1',
        {
          scope: { serverId: 'home-1', accountId: 'alice' },
          isCurrent: () => true,
          onRetire: () => ({ dispose() {} }),
        },
      ],
    ]),
}));
vi.mock('@/components/sessions/model/useSessionReadiness', () => ({
  useSessionReadiness: () => readiness.current,
}));

const { SessionPeopleReadinessSection } = await import(
  './SessionPeopleReadinessSection'
);

const yes = true;
const signIn = {
  actionId: 'machines.agents.signIn.start',
  input: { machineId: 'm1', agentId: 'codex', method: 'native' },
} as const;
const facts: SessionReadinessFactsV1 = {
  configured: true,
  operation: 'conversation',
  machine: { status: 'ready', machineId: 'm1' },
  agent: {
    agentId: 'codex',
    state: 'needsSignIn',
    current: true,
    observedAtMs: 1,
    repair: signIn,
  },
  invocation: {
    v: 1,
    level: 'owner',
    sources: [{ kind: 'owner' }],
    capabilities: {
      readTranscript: yes,
      submitAgentInput: yes,
      editSessionRecords: yes,
      approveRuntimePermissions: yes,
      manageAccess: yes,
      managePermissionDelegation: yes,
      managePublicLink: yes,
      archiveSession: yes,
      renameSession: yes,
      assignResponsibility: yes,
      stopSession: yes,
      deleteSession: yes,
    },
  },
  credential: { kind: 'not_required' },
};

function showNotReady() {
  readiness.current = {
    readiness: composeSessionReadinessV1(facts),
    repair: signIn,
    loading: false,
    unavailableReason: null,
    refresh: readiness.refresh,
  };
}

afterEach(() => {
  standardCleanup();
  readiness.refresh.mockClear();
  navigation.push.mockClear();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Every host element above `id`: the controls that would contain it in the DOM. */
function ancestorsOf(screen: Screen, id: string) {
  const chain: unknown[] = [];
  let node = screen.findHostByTestId(id)?.parent;
  while (node) {
    chain.push(node);
    node = node.parent;
  }
  return chain;
}

describe('SessionPeopleReadinessSection when the Bot is not ready', () => {
  it('keeps Repair its own control: not inside the check-again row, and pressing it never checks again', async () => {
    showNotReady();
    const screen = await renderScreen(
      <SessionPeopleReadinessSection scope={scope} sessionId="s1" />,
    );
    const row = screen.findHostByTestId('session-people-readiness-row');
    const repair = screen.findHostByTestId('session-readiness-repair');
    expect(row?.type).toBe('Pressable');
    expect(repair?.type).toBe('Pressable');

    // No interactive control contains another (a <button> in a <button> on the web).
    const containers = ancestorsOf(screen, 'session-readiness-repair');
    expect(containers).not.toContain(row);
    expect(
      containers.filter((node) => (node as { type: unknown }).type === 'Pressable'),
    ).toEqual([]);

    await act(async () => repair?.props.onPress());
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(readiness.refresh).not.toHaveBeenCalled();
  });

  it('still checks again from the summary line', async () => {
    showNotReady();
    const screen = await renderScreen(
      <SessionPeopleReadinessSection scope={scope} sessionId="s1" />,
    );
    await act(async () =>
      screen.findHostByTestId('session-people-readiness-row')?.props.onPress(),
    );
    expect(readiness.refresh).toHaveBeenCalledTimes(1);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('keeps the checklist, with its Repair, under the summary line in one section', async () => {
    showNotReady();
    const screen = await renderScreen(
      <SessionPeopleReadinessSection scope={scope} sessionId="s1" />,
    );
    const section = screen.findHostByTestId('session-people-readiness');
    expect(
      ancestorsOf(screen, 'session-readiness-checklist'),
    ).toContain(section);
    expect(screen.findHostByTestId('session-readiness-repair')).toBeTruthy();
  });
});

describe('SessionPeopleReadinessSection when nothing needs anyone', () => {
  // People speaks about readiness only when asking this Session can't work now: a ready, unchecked
  // or unreadable state is no reason to put a row between its conversations and who follows it.
  it.each([
    ['ready', () => ({ readiness: composeSessionReadinessV1({ ...facts, agent: { agentId: 'codex', state: 'ready', current: true, observedAtMs: 1 } }), repair: null, loading: false, unavailableReason: null })],
    ['still reading', () => ({ readiness: null, repair: null, loading: true, unavailableReason: null })],
    ['read failed', () => ({ readiness: null, repair: null, loading: false, unavailableReason: 'unavailable' })],
  ] as const)('says nothing when %s', async (_state, current) => {
    readiness.current = { ...current(), refresh: readiness.refresh };
    const screen = await renderScreen(
      <SessionPeopleReadinessSection scope={scope} sessionId="s1" />,
    );
    expect(screen.findHostByTestId('session-people-readiness')).toBeFalsy();
  });
});
