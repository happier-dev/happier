import * as React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
  machineScmHostingRepositoryDescribePublishTargets: vi.fn(async () => ({
    success: false,
    errorCode: 'machine_unreachable',
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
    expect(screen.findByTestId('newApp.continue')?.props.disabled).toBe(true);
    expect(screen.findByTestId('newApp.description')).toBeNull();
    expect(screen.findByTestId('newApp.create')).toBeNull();
  });
});

it('renders the shipped starter catalog through the real Home registry and advances after selection', async () => {
  const catalog = JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8'));
  const serverUrl = 'https://new-app-starter-registry.test';
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
    key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{
      id: 'starter-catalog', title: 'Project starters', format: 'happier-catalog', kinds: ['starter'],
      url: serverUrl + '/starters.json', enabled: true, addedAt: 0,
    }] },
  }, 'updated', { handleRequest: async path => path === '/starters.json' ? Response.json(catalog) : null });
  try {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy());
    await screen.pressByTestIdAsync('newApp.starter:static-website');
    await screen.pressByTestIdAsync('newApp.continue');
    expect(screen.findByTestId('newApp.description')).toBeTruthy();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
