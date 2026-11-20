import * as React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({});
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);
// The Machine RPC transport is the boundary; nothing is reachable in this test.
vi.mock('@/sync/ops/scm/machineScm', () => ({
  machineScmHostingRepositoryDescribePublishTargets: vi.fn<typeof import('@/sync/ops/scm/machineScm').machineScmHostingRepositoryDescribePublishTargets>(async () => ({
    success: false,
    error: 'Machine unavailable',
  })),
}));

afterEach(() => standardCleanup());

const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { NewAppScreen } = await import('./NewAppScreen');

describe('New app registry gallery', () => {
  it('renders safely and cannot advance without an available starter selection', async () => {
    // A fresh client without a registry supplier has no bundled synchronous fallback.
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    // Continue waits for a choice; the other ways in (Already built, the catalog) keep it on the dialog.
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(true);
    expect(screen.findByTestId('newApp.description')).toBeNull();
    expect(screen.findByTestId('newApp.create')).toBeNull();
  });
});

async function starterHome(serverUrl: string, catalogResponse?: Promise<Response>, onRead?: () => void) {
  const catalog = JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8'));
  return createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
    key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{
      id: 'starter-catalog', title: 'Project starters', format: 'happier-catalog', kinds: ['starter'],
      url: serverUrl + '/starters.json', enabled: true, addedAt: 0,
    }] },
  }, 'updated', { handleRequest: async path => {
    if (path !== '/starters.json') return null;
    onRead?.();
    return catalogResponse ?? Response.json(catalog);
  } });
}

it('reads starters only when the gallery opens and keeps the deep-linked starter for configuration', async () => {
  const reads = vi.fn();
  const fixture = await starterHome('https://new-app-starter-demand.test', undefined, reads);
  const screen = await renderScreen(<NewAppScreen onClose={() => {}} startOn="describe" starterId="static-website" />);
  try {
    expect(screen.findByTestId('newApp.auto.description')).toBeTruthy();
    await flushHookEffects({ cycles: 8 });
    expect(reads).not.toHaveBeenCalled();

    await screen.pressByTestIdAsync('newApp.back');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(false));
    expect(reads).toHaveBeenCalledTimes(1);
    await screen.pressByTestIdAsync('newApp.continue');
    expect(screen.findByTestId('newApp.details')).toBeTruthy();
    await flushHookEffects({ cycles: 8 });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('names the failed app catalog without saying visible catalog apps are hidden', async () => {
  const { deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
  const { BUILT_IN_REGISTRY_SOURCES_V1 } = await import('@happier-dev/protocol/registries');
  const { t } = await import('@/text');
  const serverUrl = 'https://new-app-app-catalog-failure.test';
  const readyUrl = serverUrl + '/ready.json';
  const failedUrl = serverUrl + '/failed.json';
  const readySource = deriveMarketplaceSourceId(readyUrl);
  const failedSource = deriveMarketplaceSourceId(failedUrl);
  const failedTitle = 'Workshop catalog';
  const failed = vi.fn(() => new Response(null, { status: 503 }));
  const sourceReads = vi.fn(() => Response.json({ schemaVersion: 1, apps: [{ itemId: 'workshop-web', app: {
    schemaVersion: 1, title: 'Workshop Web', compose: { document: 'services:\n  app:\n    image: nginx:1\n', profiles: [], services: ['app'] },
    variables: [], generatedSecrets: [], domains: [], volumes: [],
  } }] }));
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
    key: 'registry-sources', value: { v: 2,
      disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id),
      sources: [
        { id: readySource, url: readyUrl, title: 'Public catalog', format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 1 },
        { id: failedSource, url: failedUrl, title: failedTitle, format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 1 },
      ],
    },
  }, 'updated', { handleRequest: async path => path === '/ready.json' ? sourceReads() : path === '/failed.json' ? failed() : null });
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    try {
      await waitForHomeGovernance(() => {
        expect(failed).toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Workshop Web');
        expect(screen.findByTestId('newApp.appCatalogFailure:' + failedSource)).not.toBeNull();
      });
      const text = screen.getTextContent();
      expect(text).not.toContain(t('capabilities.store.sourcesHidden', { count: 1 }));
      expect(text).toContain(t('promptLibrary.registriesStatus.unreachableSource', { source: failedTitle }));
      expect(sourceReads).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); }
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

async function describeApp(onClose: () => void) {
  const screen = await renderScreen(<NewAppScreen onClose={onClose} />);
  await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy());
  await screen.pressByTestIdAsync('newApp.starter:static-website');
  await screen.pressByTestIdAsync('newApp.continue');
  await act(async () => {
    screen.changeTextByTestId('newApp.description', 'An order page for my bakery.');
    screen.changeTextByTestId('newApp.nameField', 'Rye orders');
  });
  return screen;
}

it('offers only app starters under Start something new: a starter that declares no app deploy shape is not one (journey-deploy src)', async () => {
  const fixture = await starterHome('https://new-app-app-starters.test');
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy());
    expect(screen.findByTestId('newApp.starter:expo-blank')).toBeTruthy();
    expect(screen.findByTestId('newApp.starter:coder-docker'), 'a workspace template is not an app starter').toBeNull();
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('keeps the selected starter and writing while adding a Machine, including cancellation', async () => {
  const fixture = await starterHome('https://new-app-starter-machine.test');
  try {
    const onClose = vi.fn();
    const screen = await describeApp(onClose);
    await screen.pressByTestIdAsync('newApp.addComputer');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.findByTestId('newApp.addMachine')).toBeTruthy();
    await screen.pressByTestIdAsync('newApp.back');
    expect(screen.findByTestId('newApp.description')?.props.value).toBe('An order page for my bakery.');
    expect(screen.findByTestId('newApp.nameField')?.props.value).toBe('Rye orders');
    await screen.pressByTestIdAsync('newApp.back');
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(false);
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('keeps the draft through GitHub setup and rechecks the SCM owner on return', async () => {
  const fixture = await starterHome('https://new-app-starter-connect.test');
  try {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { machineScmHostingRepositoryDescribePublishTargets: describeTargets } = await import('@/sync/ops/scm/machineScm');
    const { ScmHostingRepositoryDescribePublishTargetsResponseSchema } = await import('@happier-dev/protocol/scm');
    const { Modal } = await import('@/modal');
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected admitted Home Account');
    vi.mocked(describeTargets).mockResolvedValue(ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse({
      success: true, auth: { state: 'authentication_required', profileKind: 'connected_account' },
      defaultRepositoryName: 'rye-orders', targets: [],
    }));
    await publishMachineInventoryForTest(scope, [createMachineFixture({ activeAt: Date.now() })]);
    const onClose = vi.fn();
    const screen = await describeApp(onClose);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.connectGithub')).toBeTruthy());
    await screen.pressByTestIdAsync('newApp.connectGithub');
    expect(onClose).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.chrome).toMatchObject({ testID: 'connect-sheet' }));
    const setup = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    vi.mocked(describeTargets).mockClear();
    await act(async () => setup?.onRequestClose?.());
    await waitForHomeGovernance(() => expect(describeTargets).toHaveBeenCalled());
    expect(screen.findByTestId('newApp.description')?.props.value).toBe('An order page for my bakery.');
    expect(screen.findByTestId('newApp.nameField')?.props.value).toBe('Rye orders');
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('shows the catalog loading state until its first registry response arrives', async () => {
  let releaseCatalog: (response: Response) => void = () => {};
  const catalogResponse = new Promise<Response>(resolve => { releaseCatalog = resolve; });
  const fixture = await starterHome('https://new-app-starter-loading.test', catalogResponse);
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.loading')).toBeTruthy());
    const catalog = JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8'));
    await act(async () => releaseCatalog(Response.json(catalog)));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy());
    expect(screen.findByTestId('newApp.loading')).toBeNull();
  } finally {
    releaseCatalog(Response.json({}));
    await standardCleanup();
    await fixture.dispose();
  }
});

it('searches starters with the same field as Your code (lab f1src: one search)', async () => {
  const fixture = await starterHome('https://new-app-starter-search.test');
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:expo-blank')).toBeTruthy());
    expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy();
    await act(async () => { screen.changeTextByTestId('newApp.code.address', 'expo'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:static-website')).toBeNull());
    expect(screen.findByTestId('newApp.starter:expo-blank')).toBeTruthy();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

// COR4B (UI refinements 11-15 17:35Z): a pasted repository link is not a search term. The starters and the catalog
// stay as they were instead of searching for the link and showing nothing.
it('keeps starters listed while the shared field holds a pasted repository link', async () => {
  const fixture = await starterHome('https://new-app-starter-pasted-link.test');
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:expo-blank')).toBeTruthy());
    await act(async () => { screen.changeTextByTestId('newApp.code.address', 'https://github.com/acme/ops-tools'); });
    await flushHookEffects({ cycles: 8 });
    expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy();
    expect(screen.findByTestId('newApp.starter:expo-blank')).toBeTruthy();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('says starters come from an online Machine when none is online, and an empty Store only when one is (AUTO-LIVE F2)', async () => {
  for (const online of [false, true]) {
    // No starter source answers yet: nothing supplies the starters package on this fresh Home.
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://new-app-starters-${online ? 'online' : 'none'}.test`, {
      key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } }, 'updated');
    try {
      if (online) {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Expected admitted Home Account');
        await publishMachineInventoryForTest(scope, [createMachineFixture({ activeAt: Date.now() })]);
      }
      const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
      const settled = online ? 'newApp.startersEmpty' : 'newApp.needsMachine';
      await waitForHomeGovernance(() => expect(screen.findByTestId(settled)).toBeTruthy());
      expect(screen.findByTestId(online ? 'newApp.needsMachine' : 'newApp.startersEmpty')).toBeNull();
      await screen.unmount();
    } finally {
      await standardCleanup();
      await fixture.dispose();
    }
  }
});

it('makes an unavailable starter supplier visible instead of an empty gallery', async () => {
  const fixture = await starterHome('https://new-app-starter-failure.test', Promise.resolve(new Response('Unavailable', { status: 503 })));
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.catalogFailure:starter-catalog')).toBeTruthy());
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(true);
    expect(screen.findByTestId('newApp.loading')).toBeNull();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('shows a single starter state while a search replaces an unavailable Machine supplier', async () => {
  const { BUILT_IN_REGISTRY_SOURCES_V1 } = await import('@happier-dev/protocol/registries');
  const { deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
  const serverUrl = 'https://new-app-starters-retry-state.test';
  const url = serverUrl + '/starters.json';
  let release: (response: Response) => void = () => {};
  const response = new Promise<Response>(resolve => { release = resolve; });
  let retrying = false;
  const fetchStarters = vi.fn(async () => {
    if (!retrying) throw new TypeError('Browser cannot read this source');
    return response;
  });
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
    key: 'registry-sources', value: { v: 2,
      disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id),
      sources: [{ id: deriveMarketplaceSourceId(url), title: 'Project starters', format: 'happier-catalog',
        kinds: ['starter'], url, enabled: true, addedAt: 1 }],
    },
  }, 'updated', { handleRequest: async path => path === '/starters.json' ? fetchStarters() : null });
  const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
  try {
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.needsMachine')).not.toBeNull());
    retrying = true;
    await act(async () => screen.changeTextByTestId('newApp.code.address', 'Expo'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.loading')).not.toBeNull());
    expect(screen.findByTestId('newApp.needsMachine')).toBeNull();
    const catalog = JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8'));
    await act(async () => release(Response.json(catalog)));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:expo-blank')).not.toBeNull());
    expect(screen.findByTestId('newApp.loading')).toBeNull();
  } finally {
    release(Response.json({}));
    await screen.unmount();
    await fixture.dispose();
  }
});

it('leaves Back with the Machine owner once a managed creation draft exists', async () => {
  const fixture = await starterHome('https://new-app-starter-managed-back.test');
  try {
    const { NewAppMachineSetup } = await import('./NewAppMachineSetup');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected admitted Home Account');
    const screen = await describeApp(vi.fn());
    await screen.pressByTestIdAsync('newApp.addComputer');
    await waitForHomeGovernance(() => expect(screen.findAllByType(NewAppMachineSetup)).toHaveLength(1));
    expect(screen.findByTestId('newApp.back')).toBeTruthy();
    await act(async () => screen.findByType(NewAppMachineSetup).props.onDraftChange({
      kind: 'created', serverId: scope.serverId, managedId: 'new-app-created-machine',
    }));
    expect(screen.findByTestId('newApp.back')).toBeNull();
    expect(screen.findByTestId('newApp.addMachine')).toBeTruthy();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('refuses a Machine arriving in another Home while preserving the New app draft', async () => {
  const fixture = await starterHome('https://new-app-starter-foreign-arrival.test');
  try {
    const { MachineAddForm } = await import('@/components/machines/add/MachineAddForm');
    const screen = await describeApp(vi.fn());
    await screen.pressByTestIdAsync('newApp.addComputer');
    await waitForHomeGovernance(() => expect(screen.findAllByType(MachineAddForm)).toHaveLength(1));
    // The real connection owner reports its exact Home; it may be a retained task from another Home.
    await act(async () => screen.findByType(MachineAddForm).props.onArrived({
      serverId: 'another-home', machineId: 'another-home-machine',
    }));
    expect(screen.findByTestId('newApp.addMachine')).toBeTruthy();
    expect(screen.findByTestId('newApp.machineHomeMismatch')).toBeTruthy();
    await screen.pressByTestIdAsync('newApp.back');
    expect(screen.findByTestId('newApp.description')?.props.value).toBe('An order page for my bakery.');
    expect(screen.findByTestId('newApp.nameField')?.props.value).toBe('Rye orders');
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
