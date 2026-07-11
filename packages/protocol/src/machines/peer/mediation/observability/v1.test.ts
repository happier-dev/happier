import { describe, expect, it } from 'vitest';

describe('peer mediation observability protocol contracts', () => {
  function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      eventId: 'obs_1',
      sequence: 1,
      emittedAtMs: 1_900_000,
      scope: {
        kind: 'machine',
        accountId: 'account_1',
        machineId: 'machine_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId: 'tunnel_1',
      },
      kind: 'http.request.finished',
      data: {},
      redaction: {
        level: 'metadataOnly',
        queryRedacted: true,
        headersRedacted: true,
        truncated: false,
      },
      ...overrides,
    };
  }

  it('parses redacted flow events with reader scope and stable flow ids', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.PeerMediationObservabilityEventV1Schema.parse({
      v: 1,
      eventId: 'obs_1',
      sequence: 1,
      emittedAtMs: 1_900_000,
      scope: {
        kind: 'machine',
        accountId: 'account_1',
        machineId: 'machine_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId: 'tunnel_1',
        productRef: {
          kind: 'preview',
          id: 'preview_1',
          redacted: false,
        },
      },
      kind: 'http.request.finished',
      data: {
        method: 'GET',
        status: 200,
        pathClass: '/api/*',
        durationMs: 41,
        requestBytes: 120,
        responseBytes: 4096,
      },
      redaction: {
        level: 'metadataOnly',
        queryRedacted: true,
        headersRedacted: true,
        truncated: false,
      },
    });

    expect(parsed.flow.flowId).toBe('tunnel_1');
    expect(parsed.data.pathClass).toBe('/api/*');
  });

  it('parses WebSocket aborted and errored terminal events with reason metadata', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    for (const kind of ['websocket.aborted', 'websocket.errored'] as const) {
      const parsed = mod.PeerMediationObservabilityEventV1Schema.parse(baseEvent({
        kind,
        data: {
          socketId: 'socket_1',
          reasonCode: kind === 'websocket.aborted'
            ? 'upstream_response_invalid'
            : 'preview_websocket_adapter_error',
        },
      }));

      expect(parsed.kind).toBe(kind);
      expect(parsed.data.reasonCode).toBeTypeOf('string');
    }
  });

  it('rejects events that contain raw body, token, cookie, or websocket payload fields', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.PeerMediationObservabilityEventV1Schema.safeParse({
      v: 1,
      eventId: 'obs_unsafe',
      sequence: 1,
      emittedAtMs: 1,
      scope: {
        kind: 'machine',
        accountId: 'account_1',
        machineId: 'machine_1',
      },
      flow: {
        flowId: 'stream_1',
        flowKind: 'live_stream',
        streamId: 'stream_1',
      },
      kind: 'stream.frame',
      data: {
        payloadBase64: 'abcd',
        cookie: 'secret',
        previewToken: 'secret',
      },
      redaction: {
        level: 'metadataOnly',
        queryRedacted: true,
        headersRedacted: true,
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects events that contain mixed-case authorization or API key fields', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.PeerMediationObservabilityEventV1Schema.safeParse({
      v: 1,
      eventId: 'obs_unsafe_header',
      sequence: 1,
      emittedAtMs: 1,
      scope: {
        kind: 'machine',
        accountId: 'account_1',
        machineId: 'machine_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        tunnelId: 'tunnel_1',
      },
      kind: 'http.request.headers',
      data: {
        headers: {
          Authorization: 'Bearer secret',
          'X-API-Key': 'secret',
        },
      },
      redaction: {
        level: 'metadataOnly',
        queryRedacted: true,
        headersRedacted: true,
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects public and plugin scoped events that expose internal grant or product references', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const publicWithGrant = mod.PeerMediationObservabilityEventV1Schema.safeParse(baseEvent({
      scope: {
        kind: 'publicPreview',
        publicExposureId: 'public_exposure_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        tunnelId: 'tunnel_1',
        routeGrantId: 'grant_1',
        productRef: {
          kind: 'publicExposure',
          id: 'public_exposure_1',
        },
      },
    }));
    const publicWithPrivatePreviewRef = mod.PeerMediationObservabilityEventV1Schema.safeParse(baseEvent({
      scope: {
        kind: 'publicPreview',
        publicExposureId: 'public_exposure_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        tunnelId: 'tunnel_1',
        productRef: {
          kind: 'preview',
          id: 'preview_1',
        },
      },
    }));
    const pluginWithGrant = mod.PeerMediationObservabilityEventV1Schema.safeParse(baseEvent({
      scope: {
        kind: 'pluginSurface',
        accountId: 'account_1',
        pluginId: 'plugin_1',
        surfaceId: 'surface_1',
      },
      flow: {
        flowId: 'tunnel_1',
        flowKind: 'tcp_tunnel',
        tunnelId: 'tunnel_1',
        routeGrantId: 'grant_1',
        productRef: {
          kind: 'pluginSurface',
          id: 'surface_1',
        },
      },
    }));

    expect(publicWithGrant.success).toBe(false);
    expect(publicWithPrivatePreviewRef.success).toBe(false);
    expect(pluginWithGrant.success).toBe(false);
  });

  it('rejects observability deltas whose events do not match the envelope scope', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.PeerMediationObservabilityDeltaV1Schema.safeParse({
      v: 1,
      scope: {
        kind: 'publicPreview',
        publicExposureId: 'public_exposure_1',
      },
      sequence: 2,
      events: [
        baseEvent({
          scope: {
            kind: 'machine',
            accountId: 'account_1',
            machineId: 'machine_1',
          },
        }),
      ],
    });

    expect(result.success).toBe(false);
  });

  it('parses snapshot and delta socket envelopes with monotonic sequence numbers', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT).toBe('peer:observability:snapshot:v1');
    expect(mod.PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT).toBe('peer:observability:delta:v1');

    const snapshot = mod.PeerMediationObservabilitySnapshotV1Schema.parse({
      v: 1,
      scope: {
        kind: 'machine',
        accountId: 'account_1',
        machineId: 'machine_1',
      },
      sequence: 5,
      capturedAtMs: 1_900_000,
      flows: [
        {
          flow: {
            flowId: 'tunnel_1',
            flowKind: 'tcp_tunnel',
            tunnelId: 'tunnel_1',
          },
          lifecycleState: 'ready',
          startedAtMs: 1,
          lastActivityAtMs: 2,
          bytesIn: 128,
          bytesOut: 256,
          activeSubstreams: 1,
          capUsagePercent: 25,
        },
      ],
    });

    expect(snapshot.sequence).toBe(5);
    expect(snapshot.flows[0]?.bytesOut).toBe(256);
  });

  it('parses strict subscribe and unsubscribe socket request envelopes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const scope = {
      kind: 'machine',
      accountId: 'account_1',
      machineId: 'machine_1',
    };

    expect(mod.PeerMediationObservabilitySubscribeRequestV1Schema.parse({
      scope,
    })).toEqual({ scope });
    expect(mod.PeerMediationObservabilityUnsubscribeRequestV1Schema.parse({})).toEqual({});
    expect(mod.PeerMediationObservabilityUnsubscribeRequestV1Schema.parse({
      scope,
    })).toEqual({ scope });

    expect(mod.PeerMediationObservabilitySubscribeRequestV1Schema.safeParse({
      v: 1,
      source: 'server',
      scope,
    }).success).toBe(false);
    expect(mod.PeerMediationObservabilityUnsubscribeRequestV1Schema.safeParse({
      v: 1,
      source: 'daemon',
      scope,
    }).success).toBe(false);
  });
});
