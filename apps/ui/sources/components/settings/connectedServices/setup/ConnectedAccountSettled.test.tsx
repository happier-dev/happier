import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

import { ConnectedAccountSettledView } from './ConnectedAccountSettled';

describe('ConnectedAccountSettledView (lab muse-accounts D8)', () => {
  it('adds one quiet line under the identity when the connection also created an API key', async () => {
    const screen = await renderScreen(
      <ConnectedAccountSettledView
        identity="leeroy@meta.com"
        offer={null}
        primaryAction={null}
        onDismiss={vi.fn()}
        includedApiKey
      />,
    );
    expect(
      screen.findByTestId('connected-services-settle:included-api-key'),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain(
      'Also created an API key for use with other Agents.',
    );
    // Done stays the only way on: the note is a fact, not a choice.
    expect(screen.findByTestId('connected-services-settle:done')).toBeTruthy();
  });

  it('says nothing about a key when the connection created none', async () => {
    const screen = await renderScreen(
      <ConnectedAccountSettledView
        identity="work@example.com"
        offer={null}
        primaryAction={null}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.findByTestId('connected-services-settle:included-api-key'),
    ).toBeNull();
    expect(screen.getTextContent()).not.toContain('API key');
  });
});
