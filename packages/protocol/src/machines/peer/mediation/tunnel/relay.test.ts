import { describe, expect, it } from 'vitest';

type TunnelRelayModule = typeof import('./relay');

async function loadTunnelRelayModule(): Promise<TunnelRelayModule | null> {
  const modulePath = './relay.js';
  return import(modulePath).catch(() => null) as Promise<TunnelRelayModule | null>;
}

describe('peer TCP tunnel relay protocol', () => {
  it('parses server relay envelopes without reusing transfer relay envelopes', async () => {
    const mod = await loadTunnelRelayModule();
    const parsed = mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse({
      v: 1,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      frame: {
        v: 1,
        kind: 'abort',
        tunnelId: 'tun_1',
        reasonCode: 'relay_disabled_by_server_policy',
      },
    });

    expect(parsed?.success).toBe(true);
    expect(mod?.PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT).toBe('peer:tunnel:v1');
  });
});
