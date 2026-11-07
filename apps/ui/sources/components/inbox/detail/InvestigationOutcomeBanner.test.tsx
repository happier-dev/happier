import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

afterEach(() => {
  standardCleanup();
});

const { InvestigationOutcomeBanner } =
  await import('./InvestigationOutcomeBanner');

function render(code: string) {
  return renderScreen(
    <InvestigationOutcomeBanner
      outcome={{ kind: 'unavailable', code }}
      serverId="home-a"
      onChoosePlacement={() => {}}
      pending={false}
    />,
  );
}

describe('Investigation outcome banner', () => {
  it('tells the person the catalog could not be reached, not that nothing is set up', async () => {
    // `catalogUnavailable` is the read that did not answer (for example while the Account reconnects).
    const screen = await render('catalogUnavailable');
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.unavailableTitle',
    );
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });

  it('keeps the set-up step for a catalog that answered with no investigation', async () => {
    const screen = await render('configuredActionUnavailable');
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });
});
