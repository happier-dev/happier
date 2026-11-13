import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const viewport = vi.hoisted(() => ({
  width: 390,
  height: 844,
  scale: 1,
  fontScale: 1,
}));

// Home and machine transports enter through static imports; hoist the genuine Socket.IO SDK boundary.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
// A phone-sized window: the trigger form opens as the real phone sheet (no popover mock).
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
  }),
);
// Radix is the DOM SDK boundary; the modal provider and sheet chrome remain real.
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

await import('@/sync/syncEngine');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { setRuntimeFetch, resetRuntimeFetch } =
  await import('@/utils/system/runtimeFetch');
const { TriggerPopover } = await import('./TriggerPopover');
const { Text } = await import('@/components/ui/text/Text');
type ExistingTriggerSubmit = Extract<
  React.ComponentProps<typeof TriggerPopover>,
  { creatingSession?: false }
>['onSubmit'];

let previousState = getStorage().getState();
beforeEach(async () => {
  previousState = getStorage().getState();
  await home.reset();
  const serverId = await home.addHome({
    name: 'Trigger sheet',
    serverUrl: `https://trigger-sheet-${crypto.randomUUID()}.test`,
    accountId: 'account-a',
  });
  home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
  home.answer(serverId, '/v1/account/encryption/currentness', {
    body: createPlainAccountEncryptionCurrentnessFixture(),
  });
  setRuntimeFetch(home.request);
  getStorage().setState({
    profileScope: { serverId, accountId: 'account-a' },
    settingsScope: { serverId, accountId: 'account-a' },
  });
});
afterEach(async () => {
  await standardCleanup();
  resetRuntimeFetch();
  await home.reset();
  getStorage().setState(previousState);
});

describe('a trigger form on a phone sheet', () => {
  it('opens a pushed page (History) under the sheet header Back, not a second Back in its body', async () => {
    const onBack = vi.fn();
    const screen = await renderScreen(
      <TriggerPopover
        testID="phone-trigger"
        anchorRef={React.createRef()}
        onRequestClose={vi.fn()}
        whenKinds={['schedule']}
        sessionId={null}
        showThen={false}
        initial={{
          when: {
            kind: 'schedule',
            schedule: null,
            expression: '',
            everyMs: 3_600_000,
            timezone: 'Europe/Zurich',
          },
          then: { kind: 'runWorkflow', ref: null, inputs: {} },
          enabled: true,
        }}
        workflowOptions={[]}
        onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})}
        pushedPage={{
          title: 'History',
          onBack,
          content: <Text>Nothing has run yet</Text>,
        }}
      />,
    );
    expect(screen.getTextContent()).toContain('Nothing has run yet');
    expect(screen.findByTestId('phone-trigger-back')).toBeNull();
    await screen.pressByTestIdAsync('popover-sheet.back');
    expect(onBack).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
