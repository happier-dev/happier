import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebBridgeEnvelopeV1Schema,
  PluginHostedWebBridgeResponseEnvelopeV1Schema,
} from './hostedWebBridge.js';

describe('hosted web bridge protocol', () => {
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
});
