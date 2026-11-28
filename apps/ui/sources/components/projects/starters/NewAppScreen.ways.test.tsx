import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';

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

it('runs an app that already exists: Already built continues to Where it runs in the dialog, Browse opens the catalog (journey-deploy D3)', async () => {
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
        screen.findByTestId('newApp.built.compose'),
        'Already built renders for the Account',
      ).toBeTruthy(),
    );
    // Nothing chosen: Continue waits for a choice instead of disappearing.
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('newApp.built.compose');
    await screen.pressByTestIdAsync('newApp.continue');
    // The stored-definition draft is hosted here; it asks which Project it belongs to on its Configure step.
    await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(routerMock.spies.push).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('newApp.deploy.changeSource');
    // Browse all apps opens the Store's Add dialog in choose mode over this dialog (owner 11-28); nothing leaves.
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.show).mockClear();
    await screen.pressByTestIdAsync('newApp.fromCatalog');
    expect(onClose).not.toHaveBeenCalled();
    expect(routerMock.spies.push).not.toHaveBeenCalled();
    const chooser = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    expect(chooser?.chrome && 'testID' in chooser.chrome ? chooser.chrome.testID : null).toBe('newApp.chooseApp');
    // The chosen app comes back to step 1 selected, even though it is not among the first catalog apps.
    const { onChoose } = (chooser!.props as { params: { onChoose: (item: unknown) => void } }).params;
    await act(async () => onChoose({ kind: 'app', sourceId: 'store-apps', itemId: 'plausible', title: 'Plausible Analytics' }));
    expect(screen.findByTestId('newApp.catalog.plausible')).toBeTruthy();
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(false);
    // Continue takes the chosen app into this dialog's deploy steps, where its catalog listing is read.
    await screen.pressByTestIdAsync('newApp.continue');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.deploy.changeSource')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
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
    // Every starter is a way out to the Store's starter kind; going back first would race the push.
    await screen.pressByTestIdAsync('newApp.allStarters');
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      expect.stringMatching(/view=kind.*kind=starter/),
    );
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
