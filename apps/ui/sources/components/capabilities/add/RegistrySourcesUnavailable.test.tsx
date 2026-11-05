import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const { RegistrySourcesUnavailable } =
  await import('./RegistrySourcesUnavailable');
const { CorePluginUiPresentationScope } =
  await import('@/components/plugins/surfaces/CorePluginUiPresentationScope');

function render(
  failures: React.ComponentProps<typeof RegistrySourcesUnavailable>['failures'],
) {
  return renderScreen(
    React.createElement(
      CorePluginUiPresentationScope,
      null,
      React.createElement(RegistrySourcesUnavailable, {
        failures,
        testID: 'outage',
      }),
    ),
  );
}

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string {
  return screen.getTextContent();
}

describe('RegistrySourcesUnavailable', () => {
  it('as a page state, names the catalog and gives its reason as the sentence under it', async () => {
    const screen = await renderScreen(React.createElement(CorePluginUiPresentationScope, null,
      React.createElement(RegistrySourcesUnavailable, { testID: 'outage', size: 'page', failures: [{
        key: 'curated', message: 'Curated · Unreachable.', source: 'Curated', reason: 'Unreachable.', onRetry: () => {},
      }] })));
    const content = screen.getTextContent();
    expect(content).toContain('Curated');
    expect(content).toContain('Unreachable.');
    expect(content).not.toContain('Curated · Unreachable.');
  });

  it('keeps a source\'s technical detail behind Details', async () => {
    const screen = await render([{ key: 'curated', message: 'Curated · Unreachable.', details: ['getaddrinfo ENOTFOUND'], onRetry: () => {} }]);
    expect(texts(screen)).not.toContain('getaddrinfo ENOTFOUND');
    await screen.pressByTestIdAsync('outage.details');
    expect(texts(screen)).toContain('getaddrinfo ENOTFOUND');
  });

  it('names a single unreachable source on its one line', async () => {
    const screen = await render([
      {
        key: 'mcp',
        message: 'MCP Registry · Couldn’t reach this registry.',
        onRetry: () => {},
      },
    ]);
    expect(texts(screen)).toContain('MCP Registry');
    expect(screen.findAllByTestId('outage').length).toBeGreaterThan(0);
  });

  it('says several unreachable sources once, retries each distinct read once, and names them only on demand', async () => {
    const shared = vi.fn();
    const other = vi.fn();
    const screen = await render([
      {
        key: 'a',
        message: 'MCP Registry · Couldn’t reach this registry.',
        onRetry: shared,
      },
      {
        key: 'b',
        message: 'skills.sh · Couldn’t reach this registry.',
        onRetry: shared,
      },
      {
        key: 'c',
        message: 'QA Skills updates · Couldn’t reach this registry.',
        onRetry: other,
      },
    ]);
    expect(texts(screen)).not.toContain('skills.sh');

    await screen.pressByTestIdAsync('outage.retry');
    expect(shared).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);

    await screen.pressByTestIdAsync('outage.details');
    expect(texts(screen)).toContain('skills.sh');
    expect(texts(screen)).toContain('QA Skills updates');
  });
});
