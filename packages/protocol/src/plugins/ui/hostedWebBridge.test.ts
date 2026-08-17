import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebBridgeBootstrapEnvelopeV1Schema,
  PluginHostedWebBridgeEnvelopeV1Schema,
  PluginHostedWebBridgeHostMessageEnvelopeV1Schema,
  PluginHostedWebBridgeResponseEnvelopeV1Schema,
  resolvePluginHostedWebNativeArtifactFrameOriginV1,
} from './hostedWebBridge.js';

describe('hosted web bridge protocol', () => {
  it('carries the canonical UI host wire through the existing hosted-web bridge', () => {
    const parsed = PluginHostedWebBridgeEnvelopeV1Schema.parse({
      version: 1,
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'preview-surface',
      nonce: 'nonce-1',
      sequence: 2,
      kind: 'hostApi',
      payload: {
        wireVersion: 1,
        kind: 'negotiate',
        identity: {
          pluginId: 'acme.preview',
          pluginVersion: '1.0.0',
          viewId: 'preview',
          generation: '7',
        },
        apiRange: '^1.0.0',
      },
    });

    expect(parsed.kind).toBe('hostApi');
  });

  it('accepts nonce-bound hosted web bridge messages with JSON payloads', () => {
    const parsed = PluginHostedWebBridgeEnvelopeV1Schema.parse({
      version: 1,
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'sessionSurface:acme.preview:preview-pane',
      sessionId: 'session-1',
      nonce: 'nonce-1',
      sequence: 1,
      kind: 'ready',
      payload: { height: 480 },
    });

    expect(parsed.kind).toBe('ready');
    expect(parsed.payload).toEqual({ height: 480 });
  });

  it('rejects executable-looking bridge payloads and empty nonces', () => {
    const result = PluginHostedWebBridgeEnvelopeV1Schema.safeParse({
      version: 1,
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'sessionSurface:acme.preview:preview-pane',
      nonce: '',
      sequence: 1,
      kind: 'requestHostAction',
      payload: { callback: () => undefined },
    });

    expect(result.success).toBe(false);
  });

  it('models host responses without exposing arbitrary RPC payloads', () => {
    const parsed = PluginHostedWebBridgeResponseEnvelopeV1Schema.parse({
      version: 1,
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'sessionSurface:acme.preview:preview-pane',
      nonce: 'nonce-1',
      sequence: 2,
      requestSequence: 1,
      kind: 'result',
      payload: { ok: true },
    });

    expect(parsed.requestSequence).toBe(1);
  });

  const hostPush = {
    version: 1,
    direction: 'hostToFrame',
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    nonce: 'nonce-1',
    sequence: 3,
    kind: 'hostApi',
    payload: {
      wireVersion: 1,
      kind: 'subscription',
      identity: {
        pluginId: 'acme.preview',
        pluginVersion: '1.0.0',
        viewId: 'preview',
        generation: '7',
        sessionId: 'session-1',
      },
      subscriptionId: 'subscription-1',
      event: { placement: 'session.details' },
    },
  } as const;

  it('carries an unsolicited host->frame message whose payload is a canonical wire envelope', () => {
    const parsed = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.parse(hostPush);

    expect(parsed.direction).toBe('hostToFrame');
    expect(parsed.payload.kind).toBe('subscription');
  });

  it('rejects a host push whose payload is not a canonical wire envelope', () => {
    // The push channel derives from the ONE host-API wire vocabulary. A free
    // JSON bag here would be a second host->frame language.
    const result = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse({
      ...hostPush,
      payload: { kind: 'contextChanged', surface: { placement: 'session.details' } },
    });

    expect(result.success).toBe(false);
  });

  it('keeps the guest->host and host->frame envelopes mutually unparseable', () => {
    // A frame that reflects a host push back at the host must not be read as a
    // guest request, and a guest request must not be mistaken for a push.
    expect(PluginHostedWebBridgeEnvelopeV1Schema.safeParse(hostPush).success).toBe(false);
    expect(PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse({
      version: 1,
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'sessionSurface:acme.preview:preview-pane',
      nonce: 'nonce-1',
      sequence: 1,
      kind: 'ready',
      payload: null,
    }).success).toBe(false);
  });

  it('rejects a host push that names a non-push envelope kind', () => {
    const result = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse({
      ...hostPush,
      kind: 'ready',
    });

    expect(result.success).toBe(false);
  });

  it('bootstraps a hosted Composer frame with its exact host-stamped mount ref outside launch input', () => {
    const bootstrap = PluginHostedWebBridgeBootstrapEnvelopeV1Schema.parse({
      version: 1,
      direction: 'hostToFrame',
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'surface:acme.preview:preview',
      nonce: 'nonce-1',
      sequence: 0,
      origin: 'https://assets.happier.test',
      kind: 'bootstrap',
      payload: {
        apiVersion: '1.0.0',
        wireVersion: 1,
        identity: {
          pluginId: 'acme.preview',
          pluginVersion: '1.0.0',
          viewId: 'preview',
          generation: '7',
        },
        subPath: '/review/42/',
        launchInput: { reviewId: '42' },
        composerRef: { kind: 'session', sessionId: 'session-1' },
      },
    });

    expect(bootstrap.payload.subPath).toBe('review/42');
    expect(bootstrap.payload.composerRef).toEqual({ kind: 'session', sessionId: 'session-1' });
    expect(PluginHostedWebBridgeBootstrapEnvelopeV1Schema.safeParse({
      ...bootstrap,
      payload: { ...bootstrap.payload, target: { kind: 'session', sessionId: 'session-1' } },
    }).success).toBe(false);
  });

  it('accepts only the exact token-scoped iOS frame address as a non-HTTP bridge origin', () => {
    const bootstrap = {
      version: 1,
      direction: 'hostToFrame',
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      surfaceId: 'surface:acme.preview:preview',
      nonce: 'nonce-1',
      sequence: 0,
      kind: 'bootstrap',
      payload: {
        apiVersion: '1.0.0',
        wireVersion: 1,
        identity: {
          pluginId: 'acme.preview',
          pluginVersion: '1.0.0',
          viewId: 'preview',
          generation: '7',
        },
      },
    } as const;
    const origin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    expect(PluginHostedWebBridgeBootstrapEnvelopeV1Schema.safeParse({
      ...bootstrap,
      origin,
    }).success).toBe(true);
    expect(PluginHostedWebBridgeBootstrapEnvelopeV1Schema.safeParse({
      ...bootstrap,
      origin: `${origin}/`,
    }).success).toBe(false);
    expect(PluginHostedWebBridgeBootstrapEnvelopeV1Schema.safeParse({
      ...bootstrap,
      origin: 'happier-hosted-artifact://not-a-token',
    }).success).toBe(false);
  });

  it('derives the exact native frame origin for each renderer without giving Android the custom scheme', () => {
    const storagePartitionId = `hpa_${'a'.repeat(64)}`;

    expect(resolvePluginHostedWebNativeArtifactFrameOriginV1({
      platform: 'ios',
      storagePartitionId,
    })).toBe(`happier-hosted-artifact://${storagePartitionId}`);
    // Desktop's factual macOS direct-Wry adapter uses the same custom-protocol
    // origin grammar as iOS. Windows/Linux remain typed unavailable rather
    // than inheriting this assertion as a support claim.
    expect(resolvePluginHostedWebNativeArtifactFrameOriginV1({
      platform: 'desktop',
      storagePartitionId,
    })).toBe(`happier-hosted-artifact://${storagePartitionId}`);
    expect(resolvePluginHostedWebNativeArtifactFrameOriginV1({
      platform: 'android',
      storagePartitionId,
    })).toBe(`https://${storagePartitionId}.plugins.happier.dev`);
    expect(resolvePluginHostedWebNativeArtifactFrameOriginV1({
      platform: 'android',
      storagePartitionId: 'not-a-partition',
    })).toBeNull();
  });
});
