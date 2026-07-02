import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEnsureSidechainsLoaded } from './useEnsureSidechainsLoaded';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string, sidechainId: string) => Promise<'loaded' | 'not_ready' | 'in_flight'>>(
    async (_sessionId: string, _sidechainId: string) => 'loaded',
  ),
);
const syncTuningState = vi.hoisted(() => ({
  sidechainDemandHydrationConcurrencyLimit: 2,
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSidechainMessagesLoaded: (sessionId: string, sidechainId: string) =>
      ensureSidechainMessagesLoadedSpy(sessionId, sidechainId),
    getSyncTuning: () => syncTuningState,
  },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    void promise;
  },
}));

function Harness(props: Parameters<typeof useEnsureSidechainsLoaded>[0] & {
  onSnapshot?: (snapshot: unknown) => void;
}) {
  const snapshot = useEnsureSidechainsLoaded(props);
  props.onSnapshot?.(snapshot);
  return null;
}

describe('useEnsureSidechainsLoaded', () => {
  beforeEach(() => {
    ensureSidechainMessagesLoadedSpy.mockReset();
    syncTuningState.sidechainDemandHydrationConcurrencyLimit = 2;
    delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS;
    delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
  });

  async function waitForRetryCycle() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    });
  }

  it('does not re-request the same sidechain when callers pass a new array instance', async () => {
    let tree: renderer.ReactTestRenderer | null = null;

    tree = (await renderScreen(<Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />)).tree;

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.update(
        <Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />,
      );
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);
  });

  it('reports idle, loading, and loaded status without requiring callers to inspect sidechain messages', async () => {
    const snapshots: unknown[] = [];
    const request = createDeferred<'loaded' | 'not_ready' | 'in_flight'>();
    ensureSidechainMessagesLoadedSpy.mockReturnValueOnce(request.promise);

    await renderScreen(
      <Harness
        enabled
        sessionId="session-1"
        sidechainIds={['sidechain-1']}
        onSnapshot={(snapshot) => snapshots.push(snapshot)}
      />,
    );

    expect(snapshots.at(-1)).toMatchObject({
      status: 'loading',
      pendingCount: 1,
      loadedCount: 0,
    });

    await act(async () => {
      request.resolve('loaded');
      await request.promise;
    });
    await flushHookEffects();

    expect(snapshots.at(-1)).toMatchObject({
      status: 'loaded',
      pendingCount: 0,
      loadedCount: 1,
    });
  });

  it('reports a loaded empty sidechain as loaded', async () => {
    const snapshots: unknown[] = [];
    ensureSidechainMessagesLoadedSpy.mockResolvedValueOnce('loaded');

    await renderScreen(
      <Harness
        enabled
        sessionId="session-1"
        sidechainIds={['empty-sidechain']}
        onSnapshot={(snapshot) => snapshots.push(snapshot)}
      />,
    );
    await flushHookEffects();

    expect(snapshots.at(-1)).toMatchObject({
      status: 'loaded',
      pendingCount: 0,
      loadedCount: 1,
      bySidechainId: {
        'empty-sidechain': expect.objectContaining({ status: 'loaded' }),
      },
    });
  });

  it('reports in_flight while another caller owns the sidechain request', async () => {
    const snapshots: unknown[] = [];
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '10';
    ensureSidechainMessagesLoadedSpy
      .mockResolvedValueOnce('in_flight')
      .mockResolvedValueOnce('loaded');

    await renderScreen(
      <Harness
        enabled
        sessionId="session-1"
        sidechainIds={['sidechain-1']}
        onSnapshot={(snapshot) => snapshots.push(snapshot)}
      />,
    );
    await flushHookEffects();

    expect(snapshots.at(-1)).toMatchObject({
      status: 'in_flight',
      pendingCount: 1,
      loadedCount: 0,
      bySidechainId: {
        'sidechain-1': expect.objectContaining({ status: 'in_flight' }),
      },
    });

    await waitForRetryCycle();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({
      status: 'loaded',
      pendingCount: 0,
      loadedCount: 1,
    });
  });

  it('continues polling in_flight sidechains beyond the not_ready retry cap', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '1';
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '1';
    ensureSidechainMessagesLoadedSpy
      .mockResolvedValueOnce('in_flight')
      .mockResolvedValueOnce('in_flight')
      .mockResolvedValueOnce('loaded');

    await renderScreen(<Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />);

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await waitForRetryCycle();
    await waitForRetryCycle();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(3);
  });

  it('does not let in_flight polling consume the not_ready retry budget', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '1';
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '1';
    ensureSidechainMessagesLoadedSpy
      .mockResolvedValueOnce('in_flight')
      .mockResolvedValueOnce('in_flight')
      .mockResolvedValueOnce('not_ready')
      .mockResolvedValueOnce('loaded');

    await renderScreen(<Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />);

    await waitForRetryCycle();
    await waitForRetryCycle();
    await waitForRetryCycle();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(4);
  });

  it('bounds multi-sidechain fanout with the sync tuning limit', async () => {
    syncTuningState.sidechainDemandHydrationConcurrencyLimit = 2;
    const requests = Array.from({ length: 4 }, () => createDeferred<'loaded' | 'not_ready' | 'in_flight'>());
    ensureSidechainMessagesLoadedSpy.mockImplementation((_sessionId, sidechainId) => {
      const index = Number(sidechainId.replace('sidechain-', ''));
      return requests[index]!.promise;
    });

    await renderScreen(
      <Harness
        enabled
        sessionId="session-1"
        sidechainIds={['sidechain-0', 'sidechain-1', 'sidechain-2', 'sidechain-3']}
      />,
    );
    await flushHookEffects();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(2);
    expect(ensureSidechainMessagesLoadedSpy.mock.calls.map(([, sidechainId]) => sidechainId)).toEqual([
      'sidechain-0',
      'sidechain-1',
    ]);

    await act(async () => {
      requests[0]!.resolve('loaded');
      await requests[0]!.promise;
    });
    await flushHookEffects();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(3);
    expect(ensureSidechainMessagesLoadedSpy.mock.calls[2]).toEqual(['session-1', 'sidechain-2']);
  });

  it('retries the same sidechain automatically after a transient not_ready result', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '10';
    ensureSidechainMessagesLoadedSpy
      .mockResolvedValueOnce('not_ready')
      .mockResolvedValueOnce('loaded');

    await renderScreen(<Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />);

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await waitForRetryCycle();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after the configured max retry count', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '1';
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '2';
    ensureSidechainMessagesLoadedSpy.mockResolvedValue('not_ready');

    await renderScreen(<Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />);

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await waitForRetryCycle();

    await waitForRetryCycle();

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(3);
  });
});
