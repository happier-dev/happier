import { afterEach, describe, expect, it, vi } from 'vitest';

import { scrapeStressMetrics } from './scrapeStressMetrics';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scrapeStressMetrics', () => {
  it('fetches the metrics endpoint and returns the selected counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'session_alive_events_total 12\nmachine_alive_events_total 7\n',
    })));

    await expect(
      scrapeStressMetrics({
        baseUrl: 'http://127.0.0.1:43080',
        metricNames: ['session_alive_events_total', 'machine_alive_events_total'],
      }),
    ).resolves.toMatchObject({
      counters: {
        session_alive_events_total: 12,
        machine_alive_events_total: 7,
      },
    });
  });

  it('sums repeated and labeled series for the same metric name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => [
        'socket_cluster_fetch_sockets_failures_total{scope="session"} 2',
        'socket_cluster_fetch_sockets_failures_total{scope="user"} 3',
        'presence_stream_pending_entries 4',
      ].join('\n'),
    })));

    await expect(
      scrapeStressMetrics({
        baseUrl: 'http://127.0.0.1:43080',
        metricNames: ['socket_cluster_fetch_sockets_failures_total', 'presence_stream_pending_entries'],
      }),
    ).resolves.toMatchObject({
      counters: {
        socket_cluster_fetch_sockets_failures_total: 5,
        presence_stream_pending_entries: 4,
      },
    });
  });
});
