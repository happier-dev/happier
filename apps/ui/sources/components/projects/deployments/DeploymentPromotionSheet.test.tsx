import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
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
          serverId: 'home',
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

  it('says which source variables the chosen destination lacks, links to its Variables and keeps the choice on return (#3)', async () => {
    const { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1, createDeploymentTargetLinkHeaderV1 } =
      await import('@happier-dev/deployment-protocol/testing/v1');
    const production = createDeploymentEnvironmentHeaderV1({ id: 'production', projectSourceId: 'source-app' });
    const detail = (id: string, bindings: unknown[]) => {
      const base = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id }),
        targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ environmentId: id }), content: {} }] });
      return { ...base, content: { ...base.content, bindings } };
    };
    const token = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'token', resourceRevision: 1 });
    const controller = createDeploymentReadControllerV1({
      scope,
      transport: {
        listEnvironments: async () => ({ ok: true, value: { items: [{ environment: production, title: 'Production' }], nextCursor: null } }),
        // The two Environment records are the boundary: Staging sets TOKEN, Production doesn't.
        readEnvironment: async (_scope, id) => ({ ok: true, value: detail(id, id === 'staging' ? [token] : []) as never }),
        listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: false, failure: { code: 'deployment_unavailable', retryable: false } }),
      },
    });
    const promote = vi.fn(async () => ({ ok: true as const, deploymentId: 'promoted' }));
    let remembered: Parameters<NonNullable<Parameters<typeof showDeploymentPromotionSheet>[0]['onChooseDestination']>>[0] | null = null;
    const open = () => showDeploymentPromotionSheet({
      controller, serverId: 'home', sourceEnvironmentId: 'staging', sourceDeploymentId: 'receipt-61', name: 'Staging',
      version: '7f3e2b1', promote: promote as never, review: { pendingId: null, request() {}, open() {} }, onOpenReceipt: () => {},
      initialDestination: remembered, onChooseDestination: (chosen) => { remembered = chosen; },
    });
    const notice = 'project-deployments.promote.missingVariables';
    const waitFor = (testID: string) => act(async () => {
      await Promise.race([
        waitForTestEvent(screen.subscribe, () => screen.findByTestId(testID), (node) => node !== null),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => { open(); });
      const row = `project-deployments.promote.destination:${production.id}`;
      await waitFor(row);
      expect(screen.findByTestId(notice)).toBeNull();
      await screen.pressByTestIdAsync(row);
      await waitFor(notice);
      expect(screen.getTextContent()).toContain('TOKEN');
      // Advisory: the promotion's own admission decides, so the review stays available.
      expect(screen.findByTestId('project-deployments.promote.confirm')?.props.disabled).not.toBe(true);
      router.spies.push.mockClear();
      await screen.pressByTestIdAsync(`${notice}.action`);
      expect(router.spies.push).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ deploymentEnvironment: 'production', projectSourceId: 'source-app', deploymentTab: 'variables' }),
      }));
      expect(screen.findByTestId('project-deployments.promote')).toBeNull();
      // Back on the receipt, Promote opens on the same destination and says it again.
      await act(async () => { open(); });
      await waitFor(notice);
      expect(screen.getTextContent()).toContain('TOKEN');
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('promoting a build preview shows what it built, its address and health, above the destinations (deploy auto-mode U9)', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const preview = { ...base, environment: createDeploymentEnvironmentHeaderV1({ ...base.environment, purpose: 'preview',
      previewTemplateEnvironmentId: 'environment-production', previewRepositoryId: base.environment.projectSourceId,
      previewPullRequestId: 'pr:12', previewTargetLinkId: base.environment.runtimeTargetLinkId! }) };
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [{ environment: preview.environment, title: 'Preview 12' }], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: preview }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, failure: { code: 'deployment_unavailable', retryable: false } }),
      listDomains: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    } });
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => {
        showDeploymentPromotionSheet({ controller, serverId: 'home', sourceEnvironmentId: preview.environment.id, sourceDeploymentId: 'receipt-1',
          name: 'Preview 12', version: 'a41c09e', promote: vi.fn() as never,
          review: { pendingId: null, request() {}, open() {} }, onOpenReceipt: () => {} });
      });
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.review.preview.health'), (node) => node !== null);
      });
      expect(screen.findByTestId('project-deployments.review.preview.health')).not.toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});
