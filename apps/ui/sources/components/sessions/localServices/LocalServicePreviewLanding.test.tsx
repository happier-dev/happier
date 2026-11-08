import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const routerMock = vi.hoisted(() => ({
  value: null as null | ReturnType<
    typeof import('@/dev/testkit/mocks/router').createExpoRouterMock
  >,
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock();
  routerMock.value = mock;
  return mock.module;
});

// The Home's admission endpoint is the network boundary; the landing's own mapping of its refusal stays real.
const fetchBoundary = vi.hoisted(() => ({ reasonCode: 'expired' as string }));
vi.mock('@/sync/http/client', () => ({
  serverFetch: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: 'public_preview_admission_denied',
          reasonCode: fetchBoundary.reasonCode,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
  ),
}));

const credentials = {
  token: 'token',
  secret: 'secret',
} as unknown as AuthCredentials;

async function renderLanding(reasonCode: string) {
  fetchBoundary.reasonCode = reasonCode;
  const { LocalServicePreviewLanding } =
    await import('./LocalServicePreviewLanding');
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={credentials}>
      <LocalServicePreviewLanding exposureId="exp-1" />
    </InjectedAuthProvider>,
  );
  await vi.waitFor(() =>
    expect(screen.getTextContent()).not.toContain(
      'localServices.publicPreview.landing.opening',
    ),
  );
  return screen;
}

describe('LocalServicePreviewLanding', () => {
  it.each([
    ['expired', 'ended'],
    ['not_in_audience', 'no-access'],
  ])(
    'offers a way into Happier when the link (%s) leads nowhere',
    async (reasonCode, state) => {
      const screen = await renderLanding(reasonCode);
      expect(screen.getTextContent()).toContain(
        'localServices.publicPreview.landing.openHappier',
      );
      routerMock.value?.spies.replace.mockClear();
      await screen.pressByTestIdAsync(
        `local-service-preview-landing-${state}-open-happier`,
      );
      expect(routerMock.value?.spies.replace).toHaveBeenCalledWith('/');
    },
  );

  it('retries an unreachable preview with the shared Retry', async () => {
    const screen = await renderLanding('preview_unreachable');
    expect(screen.getTextContent()).toContain('common.retry');
  });
});
