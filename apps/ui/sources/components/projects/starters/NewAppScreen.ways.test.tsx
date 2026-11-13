import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

afterEach(() => standardCleanup());

const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { NewAppScreen } = await import('./NewAppScreen');

it('runs an app that already exists from the Store catalog, stepping aside first (lab s1 ways)', async () => {
  // An admitted Home Account with no starter source: the repository-free ways stay available.
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    'https://new-app-ways.test',
    {
      key: 'registry-sources',
      value: { v: 2, disabledSourceIds: [], sources: [] },
    },
    'updated',
    { handleRequest: async () => null },
  );
  try {
    const onClose = vi.fn(() =>
      expect(routerMock.spies.push).not.toHaveBeenCalled(),
    );
    routerMock.spies.push.mockClear();
    const screen = await renderScreen(<NewAppScreen onClose={onClose} />);
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('newApp.fromCatalog'),
        'the ways row renders for the Account',
      ).toBeTruthy(),
    );
    // The Store's own repository-free entries sit beside it.
    expect(screen.findByTestId('store.kind.app.pasteCompose')).toBeTruthy();
    expect(screen.findByTestId('store.kind.app.runImage')).toBeTruthy();
    await screen.pressByTestIdAsync('newApp.fromCatalog');
    expect(onClose).toHaveBeenCalledOnce();
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      expect.stringMatching(/view=kind.*kind=app/),
    );
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('as its own page, a way out goes straight to its destination and Back leaves the page (UI-DOMAIN-VIEWER-1113)', async () => {
  // Projects → New app opens this screen as a route, with no modal host to dismiss. Live #141 threw
  // "Cannot read properties of undefined (reading 'canGoBack')" on every way out, raising the dev error viewer.
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    'https://new-app-ways-route.test',
    {
      key: 'registry-sources',
      value: { v: 2, disabledSourceIds: [], sources: [] },
    },
    'updated',
    { handleRequest: async () => null },
  );
  try {
    routerMock.spies.push.mockClear();
    routerMock.spies.back.mockClear();
    routerMock.spies.replace.mockClear();
    const screen = await renderScreen(<NewAppScreen />);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.fromCatalog')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('newApp.fromCatalog');
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      expect.stringMatching(/view=kind.*kind=app/),
    );
    // Going back first would race the push and land on the previous page instead.
    expect(routerMock.spies.back).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('newApp.back');
    expect(
      routerMock.spies.back.mock.calls.length + routerMock.spies.replace.mock.calls.length,
      'Back leaves the New app page',
    ).toBe(1);
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
