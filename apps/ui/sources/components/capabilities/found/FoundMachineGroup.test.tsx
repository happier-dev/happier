import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

import { FoundMachineGroup, type FoundMachineGroupCopy } from './FoundMachineGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => {
  standardCleanup();
});

const copy: FoundMachineGroupCopy = {
  looking: 'Looking…',
  nothingHere: 'Nothing here.',
  scanFailed: 'Couldn’t read build-box’s skills',
  tryAgain: 'Try again',
  olderMachine: 'Older machine',
  lastKnown: (time) => `last known ${time}`,
  offlineBring: 'Bring it online.',
};
const machine = { machineId: 'm1', name: 'build-box', online: true, offline: false, lastSeenAt: null } as unknown as ReachMachine;

async function renderFailed(cause: string | null) {
  return renderScreen(
    <FoundMachineGroup machine={machine} body={{ kind: 'failed' }} failed hasLastKnown={false} count={null}
      copy={copy} cause={cause} onTryAgain={() => {}} testIDPrefix="found" />,
  );
}

describe('FoundMachineGroup failed machine', () => {
  it('says in plain words that the machine did not answer, keeps the typed cause under Details and offers Try again', async () => {
    const screen = await renderFailed('RPC_TRANSPORT_UNAVAILABLE');
    expect(screen.getTextContent()).toContain('It didn’t answer, or the connection dropped before it did.');
    expect(screen.getTextContent()).toContain('Try again');
    expect(screen.findByTestId('found.failed.m1-diagnostic-RPC_TRANSPORT_UNAVAILABLE')).not.toBeNull();
  });

  it('keeps an unrecognised cause out of the sentence, behind Details only', async () => {
    const screen = await renderFailed('invalid_action_output');
    expect(screen.getTextContent()).not.toContain('It didn’t answer');
    expect(screen.findByTestId('found.failed.m1-diagnostic-invalid_action_output')).not.toBeNull();
  });
});
