import type { PluginSessionResourceTargetV1, PluginUiResourceSubscriptionEventV1 } from '@happier-dev/protocol/plugins/ui';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { Text } from '../components/index.js';
import {
  createPluginUiHostApiFacade,
  PluginHostApiProvider,
  type PluginUiHostApi,
  usePluginHostApi,
  usePluginResource,
} from './index.js';

function createHostApiStub() {
  const listeners = new Map<string, (event: PluginUiResourceSubscriptionEventV1) => void>();
  const unsubscribe = vi.fn((subscriptionId: string) => {
    listeners.delete(subscriptionId);
  });
  let nextSubscription = 0;

  const api: PluginUiHostApi = {
    request: vi.fn(async () => undefined),
    getSurfaceContext: vi.fn(async () => ({
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      surfaceId: 'surface-1',
      placement: 'sessionPane',
      platform: 'web',
      channel: 'internal',
      resourceScope: [],
      diagnostics: [],
    })),
    requestSessionResource: vi.fn(async () => undefined),
    dispatchAction: vi.fn(async () => undefined),
    openSurface: vi.fn(async () => undefined),
    logDiagnostic: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    subscribeResource: vi.fn((resource, listener) => {
      nextSubscription += 1;
      const subscriptionId = `subscription-${nextSubscription}`;
      listeners.set(subscriptionId, listener);
      return {
        subscriptionId,
        unsubscribe: () => unsubscribe(subscriptionId),
      };
    }),
  };

  return {
    api,
    emit(subscriptionId: string, event: PluginUiResourceSubscriptionEventV1) {
      listeners.get(subscriptionId)?.(event);
    },
    unsubscribe,
  };
}

describe('plugin host API hooks', () => {
  it('creates a first-class facade for every canonical host API method', async () => {
    const unsubscribe = vi.fn();
    const surface = {
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      surfaceId: 'surface-1',
      placement: 'sessionPane',
      platform: 'web',
      channel: 'internal',
      resourceScope: [],
      diagnostics: [],
    } as const;
    const request = vi.fn(async (method: string) => method === 'getSurfaceContext' ? surface : { method });
    const subscribeResource = vi.fn(() => ({
      subscriptionId: 'subscription-1',
      unsubscribe,
    }));
    const api = createPluginUiHostApiFacade({
      request,
      subscribeResource,
    });
    const resource: PluginSessionResourceTargetV1 = {
      kind: 'sessionResource',
      resourceKind: 'reviewSummary',
    };

    await expect(api.getSurfaceContext()).resolves.toEqual(surface);
    await expect(api.requestSessionResource(resource)).resolves.toEqual({ method: 'requestSessionResource' });
    expect(api.subscribeResource(resource, vi.fn()).subscriptionId).toBe('subscription-1');
    await expect(api.dispatchAction({ actionId: 'plugin.preview.open' })).resolves.toEqual({ method: 'dispatchAction' });
    await expect(api.openSurface({ contributionId: 'details' })).resolves.toEqual({ method: 'openSurface' });
    await expect(api.logDiagnostic({ severity: 'info', message: 'rendered' })).resolves.toEqual(undefined);
    await expect(api.copy({ text: 'copied text' })).resolves.toEqual({ method: 'copy' });
    await expect(api.openExternal({ url: 'https://docs.example.test/plugin' })).resolves.toEqual({ method: 'openExternal' });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'getSurfaceContext',
      'requestSessionResource',
      'dispatchAction',
      'openSurface',
      'logDiagnostic',
      'copy',
      'openExternal',
    ]);
    expect(request).toHaveBeenCalledWith('requestSessionResource', { resource }, undefined);
    expect(subscribeResource).toHaveBeenCalledWith(resource, expect.any(Function));
  });

  it('fails clearly when a host API provider is missing', () => {
    function Probe() {
      usePluginHostApi();
      return null;
    }

    expect(() => {
      act(() => {
        renderer.create(<Probe />);
      });
    }).toThrow(/PluginHostApiProvider/);
  });

  it('subscribes after mount, applies snapshots, and disposes on unmount', async () => {
    const host = createHostApiStub();
    const resource: PluginSessionResourceTargetV1 = {
      kind: 'sessionResource',
      resourceKind: 'reviewSummary',
    };
    const observedStatuses: string[] = [];
    let subscribedDuringRender = false;
    let isRendering = false;

    const unsubscribe = vi.fn();
    host.api.subscribeResource = vi.fn((target, listener) => {
      if (isRendering) subscribedDuringRender = true;
      return {
        subscriptionId: 'subscription-1',
        unsubscribe,
      };
    });

    function Probe() {
      isRendering = true;
      const summary = usePluginResource<Record<string, string>>(resource);
      isRendering = false;
      observedStatuses.push(summary.status);
      return <Text value={summary.status} />;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProvider client={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });

    expect(subscribedDuringRender).toBe(false);
    expect(host.api.subscribeResource).toHaveBeenCalledTimes(1);
    expect(host.api.subscribeResource).toHaveBeenCalledWith(resource, expect.any(Function));

    const listener = vi.mocked(host.api.subscribeResource).mock.calls[0]?.[1];
    await act(async () => {
      listener?.({
        version: 1,
        subscriptionId: 'subscription-1',
        kind: 'snapshot',
        snapshot: {
          resource,
          state: 'available',
          capturedAtMs: 1,
          payload: { status: 'ready' },
          diagnostics: [],
        },
      });
    });

    expect(observedStatuses).toContain('ready');

    await act(async () => {
      tree?.unmount();
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical resource targets', () => {
    const host = createHostApiStub();

    function Probe() {
      usePluginResource({
        kind: 'session.reviewSummary',
      } as unknown as PluginSessionResourceTargetV1);
      return null;
    }

    expect(() => {
      act(() => {
        renderer.create(
          <PluginHostApiProvider client={host.api}>
            <Probe />
          </PluginHostApiProvider>,
        );
      });
    }).toThrow(/canonical PluginSessionResourceTargetV1/);
  });
});
