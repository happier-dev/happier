import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { SessionInfoIdentity } = await import('./SessionInfoIdentity');

afterEach(() => vi.unstubAllGlobals());

it("reaches the touch target for the context action through the space above it, not through the meta line below", async () => {
  // The primary pointer is read once per app load, so this lives in its own file.
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const screen = await renderScreen(
    <SessionInfoIdentity
      presentation="pane"
      session={createSessionFixture({ id: 's1' })}
      sessionName="Session"
      agentId={null}
      status={{ isConnected: false, statusText: 'Stopped', statusColor: '#000', statusDotColor: '#000', isPulsing: false } as never}
      meta={['Codex', 'machine']}
      path={null}
      contextAction={{ id: 'open-to-resume', label: 'Open to resume', icon: 'play', loading: false, onPress: () => {} }}
      menuActions={[]}
      onClose={() => {}}
    />,
  );
  const area = await layoutHitArea(
    () => screen.findHostByTestId('session-info-context-action:open-to-resume'),
    { width: 120, height: 32 },
  );
  // Nothing is free below (the next line is the meta text): the 12 px target deficit comes from the 12 px above.
  expect(area.insets.bottom).toBe(0);
  expect(area.insets.top).toBe(12);
});
