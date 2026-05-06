import { describe, expect, it } from 'vitest';

async function loadModule() {
  return await import('./probeSshTunnel').catch(() => null);
}

describe('probeSshTunnel', () => {
  it('probes the forwarded HTTP base URL rather than process-only state', async () => {
    const mod = await loadModule();
    expect(mod?.probeSshTunnelUrl).toEqual(expect.any(Function));

    const calls: string[] = [];
    const health = await mod!.probeSshTunnelUrl('http://127.0.0.1:49152', {
      fetch: async (url: string | URL | Request) => {
        calls.push(String(url));
        return { ok: true, status: 200 } as Response;
      },
      nowMs: () => 1234,
    });

    expect(calls).toEqual(['http://127.0.0.1:49152/']);
    expect(health).toEqual({
      state: 'healthy',
      checkedAt: '1970-01-01T00:00:01.234Z',
    });
  });

  it('maps unreachable local forwarded URLs to local_port_unreachable', async () => {
    const mod = await loadModule();
    expect(mod?.probeSshTunnelUrl).toEqual(expect.any(Function));

    const health = await mod!.probeSshTunnelUrl('http://127.0.0.1:49152', {
      fetch: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:49152'), { code: 'ECONNREFUSED' });
      },
      nowMs: () => 1234,
    });

    expect(health.state).toBe('local_port_unreachable');
  });
});
