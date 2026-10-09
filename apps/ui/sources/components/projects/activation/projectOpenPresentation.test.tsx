import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({
  push: vi.fn(),
  device: 'tablet' as 'phone' | 'tablet',
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: boundary.push } }).module;
});
// The window's size and kind is the boundary that decides phone or computer.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
  useDeviceType: () => boundary.device,
}));
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);

const { useNavigateToProjectOpen } = await import('./projectOpenPresentation');
const { Modal } = await import('@/modal');

const route = {
  pathname: '/projects/open' as const,
  params: { draftId: '00000000-0000-4000-8000-000000000081', serverId: 'home' },
};

afterEach(() => {
  standardCleanup();
  boundary.push.mockReset();
  vi.mocked(Modal.show).mockClear();
});

describe('Open entrances', () => {
  it('open the Open dialog over the current page on a computer, addressed by the retained draft', async () => {
    boundary.device = 'tablet';
    const hook = await renderHook(() => useNavigateToProjectOpen());
    hook.getCurrent()(route);
    expect(boundary.push).not.toHaveBeenCalled();
    expect(vi.mocked(Modal.show)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Modal.show).mock.calls[0]![0]).toMatchObject({
      props: { routeParams: route.params },
      chrome: {
        kind: 'card',
        testID: 'projects.open.dialog',
        title: 'projects.open.title',
        subtitle: 'projects.open.purpose',
      },
    });
    await hook.unmount();
  });

  it('push the Open page on a phone, where Back is the cancel', async () => {
    boundary.device = 'phone';
    const hook = await renderHook(() => useNavigateToProjectOpen());
    hook.getCurrent()(route);
    expect(boundary.push).toHaveBeenCalledWith(route);
    expect(vi.mocked(Modal.show)).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
