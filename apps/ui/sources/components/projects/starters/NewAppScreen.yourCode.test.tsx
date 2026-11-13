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

const repository = {
  provider: {
    id: 'happier.scm.forge.github/github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
  },
  repository: {
    nameWithOwner: 'acme/invoices',
    cloneUrl: 'https://github.com/acme/invoices.git',
    visibility: 'private',
  },
  protocol: 'https',
};

it("Deploy an app: your code opens that Project's new Environment, stepping aside first (lab f1src → f1cfg)", async () => {
  // A Project with a repository is "your code"; a repository-free Project (stored definitions only) is not.
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    'https://deploy-your-code.test',
    {
      key: 'registry-sources',
      value: { v: 2, disabledSourceIds: [], sources: [] },
    },
    'updated',
    {
      handleRequest: async (path) =>
        path.startsWith('/v1/projects/sources')
          ? Response.json({
              ok: true,
              sources: [
                {
                  id: 'source-invoices',
                  revision: 2,
                  name: 'invoices',
                  repository,
                  defaultRef: 'main',
                  audience: [],
                  createdByAccountId: 'alice',
                },
                {
                  id: 'source-stored',
                  revision: 1,
                  name: 'status page',
                  audience: [],
                  createdByAccountId: 'alice',
                },
              ],
              coverage: { complete: true, nextCursor: null },
            })
          : null,
    },
  );
  try {
    const onClose = vi.fn(() =>
      expect(routerMock.spies.push).not.toHaveBeenCalled(),
    );
    routerMock.spies.push.mockClear();
    const screen = await renderScreen(<NewAppScreen onClose={onClose} />);
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('newApp.code:source-invoices'),
        'the repository Project is offered as your code',
      ).toBeTruthy(),
    );
    expect(
      screen.findByTestId('newApp.code:source-stored'),
      'a repository-free Project is not code to deploy',
    ).toBeNull();
    await screen.pressByTestIdAsync('newApp.code:source-invoices');
    await screen.pressByTestIdAsync('newApp.continue');
    expect(onClose).toHaveBeenCalledOnce();
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      `/deployments/source-invoices?serverId=${encodeURIComponent(fixture.home.id)}&newDefinition=repository`,
    );
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
