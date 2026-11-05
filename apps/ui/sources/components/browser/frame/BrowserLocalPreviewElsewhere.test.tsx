import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the machine network is replaced: the Action front door, its approval policy, the Artifact
// store and the public-link controls all run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.rpc);
  },
);
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { ModalProvider } = await import('@/modal');
const { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } =
  await import('@/sync/api/capabilities/serverFeaturesClient');
const { BrowserLocalPreviewPublicLinkControls } =
  await import('./BrowserLocalPreviewElsewhere');

type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;

const target = {
  kind: 'localServicePreview' as const,
  targetId: 'preview-1',
  machineId: 'machine',
  sessionId: 'session-1',
};

let disposeLoader: (() => void) | undefined;
beforeEach(async () => {
  await home.reset();
  transport.rpc.mockReset();
  disposeLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
  disposeLoader?.();
  disposeLoader = undefined;
  standardCleanup();
  await home.reset();
});

describe('BrowserLocalPreviewPublicLinkControls', () => {
  it('loads public-link features only for a presented Session-bound preview', async () => {
    const serverId = await home.addHome({ name: 'Preview Demand Home', serverUrl: 'https://browser-public-link-demand.test',
      accountId: 'owner', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ features: { localServices: {
      enabled: true, inventory: { enabled: true }, managed: { enabled: true }, launcher: { enabled: true },
      actions: { enabled: true, terminate: { enabled: true } }, preview: { enabled: true }, publicPreview: { enabled: true },
    } } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    transport.rpc.mockImplementation(async (rpc: Rpc) => rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS
      ? { protocolVersion: 1, snapshot: { v: 1, machineId: target.machineId, sessionId: target.sessionId,
        previewId: target.targetId, generatedAt: 1_000, refreshState: 'idle',
        policy: { enabled: true, allowedModes: ['secret_link'] }, exposures: [], diagnostics: [] } }
      : new Promise(() => {}));
    const featureReads = () => home.requests.filter(request => request.serverId === serverId && request.path === '/v1/features').length;
    const statusReads = () => transport.rpc.mock.calls.filter(([rpc]: readonly unknown[]) => typeof rpc === 'object' && rpc !== null
      && 'method' in rpc && rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS).length;
    const baseline = featureReads();
    const renderControls = (presented: boolean, sessionBound: boolean) => <ModalProvider>
      <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
        <BrowserLocalPreviewPublicLinkControls
          target={sessionBound ? target : { kind: 'localServicePreview', targetId: target.targetId, machineId: target.machineId }}
          serviceTitle="web" serverId={serverId} testID="browser-public-demand" />
      </PluginSurfaceFocusEligibilityProvider>
    </ModalProvider>;
    const screen = await renderScreen(renderControls(true, false));
    try {
      await flushHookEffects({ cycles: 4, turns: 4 });
      expect(featureReads()).toBe(baseline);
      expect(statusReads()).toBe(0);
      await screen.update(renderControls(true, true));
      await waitForHomeGovernance(() => expect(screen.findByTestId('browser-public-demand-target:preview-1-create')).not.toBeNull());
      expect(featureReads()).toBe(baseline + 1);
      expect(statusReads()).toBe(1);
      await screen.update(renderControls(false, true));
      await act(async () => { deleteServerFeaturesSnapshot({ serverId }); });
      await flushHookEffects({ cycles: 4, turns: 4 });
      expect(featureReads()).toBe(baseline + 1);
      expect(statusReads()).toBe(1);
      await screen.update(renderControls(true, true));
      await waitForHomeGovernance(() => expect(screen.findByTestId('browser-public-demand-target:preview-1-create')).not.toBeNull());
      expect(featureReads()).toBe(baseline + 2);
      expect(statusReads()).toBe(2);
    } finally {
      await screen.unmount();
    }
  });

  it('waits for the approval its Action requires before a public link is created', async () => {
    const serverId = await home.addHome({
      name: 'Preview Home',
      serverUrl: 'https://browser-public-link-approval.test',
      accountId: 'owner',
      currentAccount: true,
    });
    const features = createRootLayoutFeaturesResponse({
      features: {
        localServices: {
          enabled: true,
          inventory: { enabled: true },
          managed: { enabled: true },
          launcher: { enabled: true },
          actions: { enabled: true, terminate: { enabled: true } },
          preview: { enabled: true },
          publicPreview: { enabled: true },
        },
      },
    });
    primeServerFeaturesSnapshot({
      serverId,
      snapshot: { status: 'ready', features },
    });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    // The person keeps Ask first on creating a public link.
    await home.requireUiApproval(
      serverId,
      'localServices.publicPreview.create',
    );
    const creates: unknown[] = [];
    transport.rpc.mockImplementation(async (rpc: Rpc) => {
      if (
        rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS
      )
        return {
          protocolVersion: 1,
          snapshot: {
            v: 1,
            machineId: 'machine',
            sessionId: 'session-1',
            previewId: 'preview-1',
            generatedAt: 1_000,
            refreshState: 'idle',
            policy: { enabled: true, allowedModes: ['secret_link'] },
            exposures: [],
            diagnostics: [],
          },
        };
      if (
        rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE
      ) {
        creates.push(rpc.payload);
        return new Promise(() => {});
      }
      return new Promise(() => {});
    });
    const screen = await renderScreen(
      <ModalProvider>
        <BrowserLocalPreviewPublicLinkControls
          target={target}
          serviceTitle="web"
          serverId={serverId}
          testID="browser-public-link"
        />
      </ModalProvider>,
    );
    const create = 'browser-public-link-target:preview-1-create';
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId(create)).not.toBeNull(),
      );
    });
    await act(async () => {
      screen.pressByTestId(create);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('local-service-exposure-sheet:preview-1-commit'),
        ).not.toBeNull(),
      );
    });
    await act(async () => {
      screen.pressByTestId('local-service-exposure-sheet:preview-1-commit');
    });
    // Ask first: the create becomes an approval request, and nothing reaches the machine.
    await vi.waitFor(
      () => {
        expect(creates).toHaveLength(0);
        expect(home.artifacts(serverId).list()).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    const artifactId = home.artifacts(serverId).list()[0]!.id;
    const creating = () =>
      screen
        .findAllByTestId('browser-public-link-target:preview-1-create')
        .some((node) => node.props.loading === true);
    // Ask first holds: nothing reaches the machine, and the link stays "creating" while it waits.
    // The mounted approval continuation reads the request's Artifact until it is decided.
    await vi.waitFor(
      () =>
        expect(
          home.requests.some((request) =>
            request.path.startsWith(`/v1/artifacts/${artifactId}`),
          ),
        ).toBe(true),
      { timeout: 30_000 },
    );
    expect(creating()).toBe(true);
    expect(creates).toHaveLength(0);
    await expect(
      decideApprovalAsInbox(serverId, artifactId, 'reject'),
    ).resolves.toMatchObject({ ok: true });
    await waitForHomeGovernance(() => expect(creating()).toBe(false));
    expect(creates).toHaveLength(0);
  });
});
