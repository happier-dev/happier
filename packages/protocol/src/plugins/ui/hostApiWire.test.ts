import { describe, expect, it } from 'vitest';

import { PluginUiHostApiWireEnvelopeV1Schema } from './hostApiWire.js';

const identity = {
  pluginId: 'com.acme.fixture',
  pluginVersion: '1.0.0',
  viewId: 'review',
  generation: 'generation-1',
  sessionId: 'session-1',
};

describe('plugin UI host API wire envelope', () => {
  it('requires generation-bound identity on negotiation, requests, results, subscriptions, and disconnects', () => {
    for (const envelope of [
      { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1', requiredMethods: ['context'] },
      { wireVersion: 1, kind: 'request', identity, requestId: 'r1', method: 'context' },
      { wireVersion: 1, kind: 'cancel', identity, requestId: 'r1' },
      { wireVersion: 1, kind: 'result', identity, requestId: 'r1', method: 'context', result: null },
      { wireVersion: 1, kind: 'subscribe', identity, requestId: 'r2', subscriptionId: 's1', method: 'watchContext' },
      { wireVersion: 1, kind: 'subscription', identity, subscriptionId: 's1', event: null },
      { wireVersion: 1, kind: 'unsubscribe', identity, requestId: 'r3', subscriptionId: 's1' },
      { wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' },
    ]) {
      expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
      const withoutGeneration = structuredClone(envelope) as { identity: Record<string, unknown> };
      delete withoutGeneration.identity.generation;
      expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse(withoutGeneration).success).toBe(false);
    }
  });

  it('rejects unknown methods, executable values, and unknown fields', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'r1',
      method: 'rawDaemonAccess',
      payload: null,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'result',
      identity,
      requestId: 'r1',
      method: 'context',
      result: { callback: () => undefined },
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'disconnected',
      identity,
      reason: 'daemon_offline',
      currentGenerationPointer: 'generation-2',
    }).success).toBe(false);
  });

  it('serializes canonical PluginError data instead of a UI-local error vocabulary', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'error',
      identity,
      requestId: 'r1',
      method: 'executeAction',
      error: { name: 'PluginError', code: 'policy_denied', retryable: false, details: { policy: 'external_links' } },
    }).success).toBe(true);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'error',
      identity,
      requestId: 'r1',
      method: 'executeAction',
      error: { kind: 'permission', code: 'policy_denied', message: 'denied', retryable: false },
    }).success).toBe(false);
  });

  it('strictly validates shared PluginError remediation and diagnostic shapes', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'error',
      identity,
      requestId: 'r1',
      method: 'executeAction',
      error: {
        name: 'PluginError',
        code: 'permission_denied',
        remediation: { kind: 'openSettings', path: 'plugins.permissions' },
        diagnostics: [{ code: 'permission_denied', severity: 'warning', message: 'Permission is required.' }],
      },
    }).success).toBe(true);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'error',
      identity,
      requestId: 'r1',
      method: 'executeAction',
      error: {
        name: 'PluginError',
        code: 'permission_denied',
        remediation: { kind: 'openSettings' },
        diagnostics: [{ code: 'permission_denied', severity: 'verbose' }],
      },
    }).success).toBe(false);
  });
});
