import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RelayHostEngine } from '@happier-dev/cli-common/relayHost';

const { readStatusMock } = vi.hoisted(() => ({
  readStatusMock: vi.fn<RelayHostEngine['readStatus']>(),
}));

vi.mock('@happier-dev/cli-common/relayHost', () => ({
  createRelayHostEngine: () => ({
    readStatus: readStatusMock,
  }),
}));

import { readDoctorRelays } from './relays';

describe('readDoctorRelays', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('settles independent relay probes together while preserving inventory order and filtering', async () => {
    vi.useFakeTimers();
    readStatusMock.mockImplementation(async ({ channel = 'stable', mode = 'user' }) => {
      const id = `${channel}:${mode}`;
      const delayMsById: Readonly<Record<string, number>> = {
        'stable:user': 900,
        'stable:system': 100,
        'preview:user': 700,
        'preview:system': 200,
        'dev:user': 600,
        'dev:system': 300,
      };
      await new Promise<void>((resolve) => setTimeout(resolve, delayMsById[id] ?? 1_000));

      const included = id === 'stable:user' || id === 'preview:system' || id === 'dev:user';
      return {
        installed: id === 'stable:user',
        version: id === 'stable:user' ? '1.2.3' : null,
        service: {
          active: id === 'dev:user' ? true : null,
          enabled: id === 'preview:system' ? true : null,
        },
        baseUrl: `http://127.0.0.1/${id}`,
        healthy: included,
      };
    });

    const inventoryPromise = readDoctorRelays();
    let settled = false;
    void inventoryPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    expect(readStatusMock.mock.calls.map(([params]) => `${params.channel}:${params.mode}`)).toEqual([
      'stable:user',
      'stable:system',
      'preview:user',
      'preview:system',
      'dev:user',
      'dev:system',
    ]);
    await expect(inventoryPromise).resolves.toEqual({
      relays: [
        {
          id: 'stable:user',
          releaseChannel: 'stable',
          installed: true,
          version: '1.2.3',
          relayUrl: 'http://127.0.0.1/stable:user',
          healthy: true,
          running: null,
          serviceEnabled: null,
        },
        {
          id: 'preview:system',
          releaseChannel: 'preview',
          installed: false,
          version: null,
          relayUrl: 'http://127.0.0.1/preview:system',
          healthy: true,
          running: null,
          serviceEnabled: true,
        },
        {
          id: 'dev:user',
          releaseChannel: 'dev',
          installed: false,
          version: null,
          relayUrl: 'http://127.0.0.1/dev:user',
          healthy: true,
          running: true,
          serviceEnabled: null,
        },
      ],
    });
  });

  it('starts every probe and observes later rejections after the aggregate rejects', async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', recordUnhandledRejection);

    try {
      readStatusMock.mockImplementation(async ({ channel = 'stable', mode = 'user' }) => {
        const id = `${channel}:${mode}`;
        await new Promise<void>((resolve) => setTimeout(resolve, id === 'stable:user' ? 100 : 200));
        if (id === 'stable:user') throw new Error('first probe failed');
        if (id === 'dev:system') throw new Error('later probe failed');
        return {
          installed: false,
          version: null,
          service: { active: null, enabled: null },
          baseUrl: `http://127.0.0.1/${id}`,
          healthy: false,
        };
      });

      const inventoryPromise = readDoctorRelays();
      const rejectionExpectation = expect(inventoryPromise).rejects.toThrow('first probe failed');

      expect(readStatusMock).toHaveBeenCalledTimes(6);
      await vi.runAllTimersAsync();
      await rejectionExpectation;
      await Promise.resolve();

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandledRejection);
    }
  });
});
