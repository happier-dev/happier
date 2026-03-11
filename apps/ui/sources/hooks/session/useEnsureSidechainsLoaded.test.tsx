import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEnsureSidechainsLoaded } from './useEnsureSidechainsLoaded';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string, sidechainId: string) => Promise<'loaded' | 'not_ready' | 'in_flight'>>(
    async (_sessionId: string, _sidechainId: string) => 'loaded',
  ),
);

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSidechainMessagesLoaded: (sessionId: string, sidechainId: string) =>
      ensureSidechainMessagesLoadedSpy(sessionId, sidechainId),
  },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    void promise;
  },
}));

function Harness(props: Parameters<typeof useEnsureSidechainsLoaded>[0]) {
  useEnsureSidechainsLoaded(props);
  return null;
}

describe('useEnsureSidechainsLoaded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ensureSidechainMessagesLoadedSpy.mockReset();
    delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS;
    delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-request the same sidechain when callers pass a new array instance', async () => {
    let tree: renderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = renderer.create(
        <Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />,
      );
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.update(
        <Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />,
      );
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);
  });

  it('retries the same sidechain automatically after a transient not_ready result', async () => {
    ensureSidechainMessagesLoadedSpy
      .mockResolvedValueOnce('not_ready')
      .mockResolvedValueOnce('loaded');

    await act(async () => {
      renderer.create(
        <Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after the configured max retry count', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS = '1';
    process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '2';
    ensureSidechainMessagesLoadedSpy.mockResolvedValue('not_ready');

    await act(async () => {
      renderer.create(
        <Harness enabled sessionId="session-1" sidechainIds={['sidechain-1']} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    });

    expect(ensureSidechainMessagesLoadedSpy).toHaveBeenCalledTimes(3);
  });
});
