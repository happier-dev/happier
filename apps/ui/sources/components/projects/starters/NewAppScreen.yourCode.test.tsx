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

afterEach(() => {
  routerMock.resetParams();
  standardCleanup();
});

const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { NewAppScreen } = await import('./NewAppScreen');
const { WorkspaceRouteBody: NewAppRouteBody } = await import('@/app/(app)/projects/new-app');

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

it("Deploy an app: your code continues to Where it runs inside the dialog, with no page switch (journey-deploy D3)", async () => {
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
    const onClose = vi.fn();
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
    // The dialog stays and hosts the Environment draft's Where step under the flow's summary.
    await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft')).toBeTruthy());
    expect(screen.findByTestId('newApp.deploy.summary.source')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(routerMock.spies.push).not.toHaveBeenCalled();
    // Change on the summary's Source goes back to the source step.
    await screen.pressByTestIdAsync('newApp.deploy.changeSource');
    expect(screen.findByTestId('newApp.code:source-invoices')).toBeTruthy();
    expect(screen.findByTestId('project-deployments.draft')).toBeNull();
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('the Deploy route keeps its Machine through Your code and the catalog (lab dMachine "Deploy an app here")', async () => {
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    'https://deploy-here-machine.test',
    { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } },
    'updated',
    { handleRequest: async (path) => path.startsWith('/v1/projects/sources') ? Response.json({ ok: true,
      sources: [{ id: 'source-invoices', revision: 2, name: 'invoices', repository, defaultRef: 'main', audience: [], createdByAccountId: 'alice' }],
      coverage: { complete: true, nextCursor: null } }) : null },
  );
  try {
    const machine = { serverId: fixture.home.id, machineId: 'hetzner-fsn1' };
    routerMock.spies.push.mockClear();
    routerMock.spies.setParams(machine);
    const screen = await renderScreen(<NewAppRouteBody />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.code:source-invoices')).toBeTruthy());
    const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
    const draftMachine = () => screen.findAllByType(SessionMachineField)
      .find((node) => node.props.testID === 'project-deployments.draft.machine')?.props.machineId;
    await screen.pressByTestIdAsync('newApp.code:source-invoices');
    await screen.pressByTestIdAsync('newApp.continue');
    await waitForHomeGovernance(() => expect(draftMachine()).toBe('hetzner-fsn1'));
    expect(routerMock.spies.push).not.toHaveBeenCalled();
    // QA-DEPLOY-1114 #25: an Already built door (Compose file) keeps the Machine too, not the draft's default one.
    await screen.pressByTestIdAsync('newApp.deploy.changeSource');
    await screen.pressByTestIdAsync('newApp.built.compose');
    await screen.pressByTestIdAsync('newApp.continue');
    await waitForHomeGovernance(() => expect(draftMachine()).toBe('hetzner-fsn1'));
    expect(routerMock.spies.push).not.toHaveBeenCalled();
    routerMock.spies.setParams({ ...machine, machineId: 'second-machine' });
    await screen.update(<NewAppRouteBody />);
    expect(draftMachine()).toBeUndefined();
    await screen.pressByTestIdAsync('newApp.built.compose');
    await screen.pressByTestIdAsync('newApp.continue');
    await waitForHomeGovernance(() => expect(draftMachine()).toBe('second-machine'));
    await screen.pressByTestIdAsync('newApp.deploy.changeSource');
    await screen.pressByTestIdAsync('newApp.fromCatalog');
    expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringMatching(/kind=app.*machine=/));
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it("a Project's Deploy an app opens with that Project's code already chosen (journey-deploy proj)", async () => {
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    'https://deploy-project-code.test',
    { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } },
    'updated',
    { handleRequest: async (path) => path.startsWith('/v1/projects/sources') ? Response.json({ ok: true,
      sources: [
        { id: 'source-billing', revision: 1, name: 'billing-api', repository, defaultRef: 'main', audience: [], createdByAccountId: 'alice' },
        { id: 'source-invoices', revision: 2, name: 'invoices', repository, defaultRef: 'main', audience: [], createdByAccountId: 'alice' },
      ],
      coverage: { complete: true, nextCursor: null } }) : null },
  );
  try {
    const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
    const screen = await renderScreen(<NewAppScreen projectSourceId="source-invoices" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.code:source-invoices')).toBeTruthy());
    const yourCode = screen.findAllByType(SelectionTiles).find((node) => node.props.testIdPrefix === 'newApp.code');
    expect(yourCode?.props.value).toBe('source-invoices');
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
