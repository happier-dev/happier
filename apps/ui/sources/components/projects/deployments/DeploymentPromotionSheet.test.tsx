import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
afterEach(standardCleanup);

const { showDeploymentPromotionSheet } =
  await import('./DeploymentPromotionSheet');
const { ModalProvider } = await import('@/modal');
const { View } = await import('react-native');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};

describe('Promote', () => {
  it('asks for the exact images first and offers a reviewed rebuild only after they cannot reach the destination', async () => {
    const destination = createDeploymentEnvironmentHeaderV1({
      id: 'production',
    });
    const controller = createDeploymentReadControllerV1({
      scope,
      transport: {
        listEnvironments: async () => ({
          ok: true,
          value: {
            items: [{ environment: destination, title: 'Production' }],
            nextCursor: null,
          },
        }),
        readEnvironment: async () => ({
          ok: false,
          failure: { code: 'deployment_unavailable', retryable: false },
        }),
        listHistory: async () => ({
          ok: true,
          value: { ok: true, items: [], nextCursor: null },
        }),
        readReceipt: async () => ({
          ok: false,
          failure: { code: 'deployment_unavailable', retryable: false },
        }),
      },
    });
    // The Action owner's answer is the boundary: the exact images are unavailable, then the rebuild opens its review.
    const promote = vi.fn(async (input: { artifact: 'image' | 'rebuild' }) =>
      input.artifact === 'image'
        ? { ok: false as const, error: 'rollback_image_unavailable' }
        : { ok: true as const, deploymentId: 'promoted' },
    );
    // The modal host renders the sheet the way the app shell does.
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => {
        showDeploymentPromotionSheet({
          controller,
          sourceEnvironmentId: 'staging',
          sourceDeploymentId: 'receipt-61',
          name: 'Staging',
          version: '7f3e2b1',
          promote: promote as never,
          review: { pendingId: null, request() {}, open() {} },
          onOpenReceipt: () => {},
        });
      });
      const row = `project-deployments.promote.destination:${destination.id}`;
      await act(async () => {
        await Promise.race([
          waitForTestEvent(
            screen.subscribe,
            () => screen.findByTestId(row),
            (node) => node !== null,
          ),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(
        screen.findByTestId('project-deployments.promote.rebuild'),
      ).toBeNull();
      await screen.pressByTestIdAsync(row);
      await screen.pressByTestIdAsync('project-deployments.promote.confirm');
      expect(promote).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ artifact: 'image' }),
        expect.anything(),
      );
      expect(
        screen.findByTestId('project-deployments.promote.rebuild'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync(
        'project-deployments.promote.rebuild.confirm',
      );
      expect(promote).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ artifact: 'rebuild' }),
        expect.anything(),
      );
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});
