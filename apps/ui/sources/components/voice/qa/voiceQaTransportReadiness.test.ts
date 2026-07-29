import { describe, expect, it } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { resolveVoiceQaTransportReadiness } from './voiceQaTransportReadiness';

function createFeatures(allowedPorts: readonly number[]) {
  const base = createRootLayoutFeaturesResponse();
  return createRootLayoutFeaturesResponse({
    features: {
      machines: {
        enabled: true,
        tunnel: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: true },
        },
      },
    },
    capabilities: {
      machines: {
        ...base.capabilities.machines,
        tunnel: {
          ...base.capabilities.machines.tunnel,
          directPeer: {
            ...base.capabilities.machines.tunnel.directPeer,
            allowedPorts: [...allowedPorts],
          },
        },
      },
    },
  });
}

const directEndpoint = {
  v: 1,
  routeKind: 'loopback_direct',
  url: 'http://127.0.0.1:43123/peer-mediation/v1/probe',
  endpointFingerprint: 'qa-endpoint-fingerprint',
  expiresAt: Date.now() + 60_000,
};

describe('resolveVoiceQaTransportReadiness', () => {
  it('reports ready only when the canonical machine, direct endpoint, profile, and socket inputs are ready', () => {
    expect(resolveVoiceQaTransportReadiness({
      serverFeatures: createFeatures([43123]),
      serverId: 'server-1',
      machineId: 'machine-1',
      daemonHttpPort: 43123,
      directEndpoint,
      accountProfileId: 'account-1',
      socketStatus: 'connected',
      activeSocketId: 'socket-1',
    })).toEqual({
      machineControlPortAuthorized: true,
      directLoopbackEndpointReady: true,
      accountProfileReady: true,
      activeServerSocketReady: true,
    });
  });

  it('fails closed for a non-authorized port, absent endpoint, profile, or active socket', () => {
    expect(resolveVoiceQaTransportReadiness({
      serverFeatures: createFeatures([43124]),
      serverId: 'server-1',
      machineId: 'machine-1',
      daemonHttpPort: 43123,
      directEndpoint: null,
      accountProfileId: '',
      socketStatus: 'connected',
      activeSocketId: '',
    })).toEqual({
      machineControlPortAuthorized: false,
      directLoopbackEndpointReady: false,
      accountProfileReady: false,
      activeServerSocketReady: false,
    });
  });
});
