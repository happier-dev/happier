import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const routeParams = vi.hoisted(() => ({
  value: {} as Record<string, string | string[] | undefined>,
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: () => routeParams.value }).module;
});

// Load the route during collection, outside the behavior deadlines. The body is the route's whole
// behavior; the workspace entry around it is shared by every route.
const { WorkspaceRouteBody } = await import('./delegation');

afterEach(() => {
  routeParams.value = {};
  standardCleanup();
});

async function redirectHref() {
  const screen = await renderScreen(React.createElement(WorkspaceRouteBody));
  return screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]
    ?.props.href;
}

describe('/settings/delegation', () => {
  it('opens Subagents, the page that now holds Work depth and Approval reviewer', async () => {
    expect(await redirectHref()).toBe('/settings/sub-agent');
  });

  it('keeps the setting a saved link or search result asked for', async () => {
    routeParams.value = { setting: 'delegation.workDepthLimit' };
    expect(await redirectHref()).toBe(
      '/settings/sub-agent?setting=delegation.workDepthLimit',
    );
  });
});
