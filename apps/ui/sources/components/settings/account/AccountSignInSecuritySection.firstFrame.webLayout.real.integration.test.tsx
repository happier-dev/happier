// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const native = await import('react-native');
  const mock = createReanimatedModuleMock();
  const Animated = {
    ...mock.default,
    View: native.View,
    ScrollView: native.ScrollView,
    Text: native.Text,
  };
  return { ...mock, ...Animated, default: Animated };
});
// The Home's sign-in entry is a network read (the boundary); held open, so its connection rows keep their placeholder.
vi.mock('@/auth/entry/authEntryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/entry/authEntryClient')>()),
  fetchHomeAuthEntry: () => new Promise(() => {}),
}));

installWebLayoutBridge();
const { AccountSignInSecuritySection } =
  await import('./AccountSignInSecuritySection');
const { ListPresentationProvider } =
  await import('@/components/ui/lists/listPresentation');

// Delta 25 (Account › Devices at 390): "More security" drew its contents summary beside its name, then moved it beneath
// once the row had measured itself, so Devices and everything under it shifted after the first frame.
it.each([390, 1440])(
  'draws the More security row at its settled height on the first frame at %s px',
  async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const viewport = { width, height: 900 };
    try {
      await act(async () =>
        root.render(
          <View style={{ width }}>
            <ListPresentationProvider value="page">
              <AccountSignInSecuritySection
                homeName="Studio"
                security={{ kind: 'unavailable' }}
                profile={{ ...profileDefaults, id: 'prof_1' }}
                credentials={null}
                applyProfile={() => {}}
              />
              <View testID="next-section" style={{ height: 20 }} />
            </ListPresentationProvider>
          </View>,
        ),
      );
      const first = await measureWebLayout(host, { viewport });
      const settled = await measureWebLayout(host, {
        viewport,
        settle: (replay) => act(replay),
      });
      for (const id of ['settings-account-more-security', 'next-section']) {
        const box = ({ top, height }: { top: number; height: number }) => ({
          top,
          height,
        });
        expect(box(settled.rect(id)), id).toEqual(box(first.rect(id)));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
  180_000,
);
