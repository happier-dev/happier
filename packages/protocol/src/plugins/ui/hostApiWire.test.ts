import { describe, expect, it } from 'vitest';

import {
  PLUGIN_UI_HOST_API_WIRE_VERSION_V1 as BROWSER_CLIENT_HOST_API_WIRE_VERSION_V1,
  ComposerRefV1Schema as BrowserClientComposerRefV1Schema,
  PluginUiApplyComposerRequestV1Schema as BrowserClientApplyComposerRequestV1Schema,
  PluginUiDisposeHostResourceRequestV1Schema as BrowserClientDisposeHostResourceRequestV1Schema,
  pluginUiHostApiWireIdentitiesEqual as browserClientPluginUiHostApiWireIdentitiesEqual,
} from './client.js';
import {
  PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
  PluginUiHostApiWireEnvelopeV1Schema,
  pluginUiHostApiWireIdentitiesEqual,
} from './hostApiWire.js';

const identity = {
  pluginId: 'com.acme.fixture',
  pluginVersion: '1.0.0',
  viewId: 'review',
  generation: 'generation-1',
  sessionId: 'session-1',
};

const targetedOperation = {
  point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
  contributor: {
    pluginId: 'com.acme.provider',
    contributionId: 'github-connection',
    immutableGenerationId: 'provider-generation-a',
  },
  role: 'setup',
  action: { pluginId: 'com.acme.provider', localId: 'connection/prepare-v1' },
} as const;

const selectedActionInput = {
  kind: 'submitted',
  action: targetedOperation.action,
  input: { repository: 'happier-dev/happier' },
  selection: {
    target: { pluginId: identity.pluginId, immutableGenerationId: identity.generation },
    point: targetedOperation.point,
    contributor: targetedOperation.contributor,
  },
  connectedAccount: {
    kind: 'selected',
    fieldPath: 'credentialRef',
    ref: {
      service: { pluginId: 'com.acme.provider', localId: 'github' },
      accountId: 'account-1',
    },
  },
} as const;

describe('plugin UI host API wire envelope', () => {
  it('addresses a mount by every wire-identity member, including an absent sessionId', () => {
    // Positive twin: the same address stays equal. Without it the per-member
    // cases below would also pass against a comparison that is always false.
    expect(pluginUiHostApiWireIdentitiesEqual(identity, { ...identity })).toBe(true);

    // Every member is load-bearing. Two mounts of one plugin share the daemon
    // projection `generation` and can differ only by `viewId`, so dropping any
    // single member would let one mount accept another mount's envelope.
    const differingByOneMember = {
      pluginId: { ...identity, pluginId: 'com.acme.other' },
      pluginVersion: { ...identity, pluginVersion: '2.0.0' },
      viewId: { ...identity, viewId: 'settings' },
      generation: { ...identity, generation: 'generation-2' },
      sessionId: { ...identity, sessionId: 'session-2' },
    };
    for (const [member, other] of Object.entries(differingByOneMember)) {
      // The fixture must actually differ, or the case could not discriminate.
      expect(other).not.toEqual(identity);
      expect(pluginUiHostApiWireIdentitiesEqual(identity, other), member).toBe(false);
    }

    // An Account-scoped mount and a Session-scoped mount of the same
    // plugin/view/generation are different addressees, not one address with a
    // missing field.
    const accountScoped = {
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      viewId: identity.viewId,
      generation: identity.generation,
    };
    expect(pluginUiHostApiWireIdentitiesEqual(identity, accountScoped)).toBe(false);
    expect(pluginUiHostApiWireIdentitiesEqual(accountScoped, identity)).toBe(false);
    expect(pluginUiHostApiWireIdentitiesEqual(accountScoped, { ...accountScoped })).toBe(true);
  });

  it('exposes the one wire-identity equality operation through the browser-safe client seam', () => {
    expect(browserClientPluginUiHostApiWireIdentitiesEqual).toBe(pluginUiHostApiWireIdentitiesEqual);
  });

  it('exposes the canonical wire version through the browser-safe client seam', () => {
    expect(BROWSER_CLIENT_HOST_API_WIRE_VERSION_V1).toBe(PLUGIN_UI_HOST_API_WIRE_VERSION_V1);
  });

  it('exposes the negotiated Composer values and one generic disposer through the browser-safe client seam', () => {
    const ref = { kind: 'session', sessionId: 'session-1' } as const;
    expect(BrowserClientComposerRefV1Schema.parse(ref)).toEqual(ref);
    expect(BrowserClientApplyComposerRequestV1Schema.parse({
      ref,
      transaction: { expectedRevision: 0, operations: [{ kind: 'text.clear' }] },
    })).toMatchObject({ ref });
    expect(BrowserClientDisposeHostResourceRequestV1Schema.parse({
      subscriptionId: 'composer-watch-1',
    })).toEqual({ subscriptionId: 'composer-watch-1' });
  });

  it('carries input selection in the sole initial semantic contract', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'select-1',
      method: 'selectActionInput',
      payload: {
        operation: targetedOperation,
      },
    }).success).toBe(true);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'open-replayable-prepared-workspace',
      method: 'openNewSession',
      payload: { checkoutIntent: 'preparedReviewWorkspace' },
      targetedOperation,
      selectedActionInput,
    }).success).toBe(false);
  });

  it('carries one exact selected-operation settlement only on terminal operation consumers', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'execute-1',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      targetedOperation,
      selectedActionInput,
      // This is a host-private terminal-dispatch fact. Absence retains the
      // selected settlement for a nonterminal relay; true consumes it before
      // the mounted host dispatches the outer Action.
      consumeSelectedActionInput: true,
    }).success).toBe(true);

    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'open-prepared-workspace',
      method: 'openNewSession',
      payload: { checkoutIntent: 'preparedReviewWorkspace' },
      targetedOperation,
      selectedActionInput,
      consumeSelectedActionInput: true,
    }).success).toBe(true);

    // A selection carrier is one atomic operation/result pair. Neither half
    // is meaningful or admissible by itself.
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'execute-without-settlement',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      targetedOperation,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'execute-without-operation',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      selectedActionInput,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'consume-without-settlement',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      consumeSelectedActionInput: true,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'execute-with-tampered-operation',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      targetedOperation: {
        ...targetedOperation,
        action: { pluginId: 'com.acme.provider', localId: 'connection/test-v1' },
      },
      selectedActionInput,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'select-2',
      method: 'selectActionInput',
      payload: { operation: targetedOperation },
      targetedOperation,
      selectedActionInput,
      consumeSelectedActionInput: true,
    }).success).toBe(false);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'request',
      identity,
      requestId: 'execute-with-false-consumption',
      method: 'executeAction',
      payload: {
        action: targetedOperation.action,
        input: { repository: 'happier-dev/happier' },
      },
      targetedOperation,
      selectedActionInput,
      consumeSelectedActionInput: false,
    }).success).toBe(false);
  });

  it('requires generation-bound identity on negotiation, requests, results, subscriptions, and disconnects', () => {
    for (const envelope of [
      { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1' },
      { wireVersion: 1, kind: 'request', identity, requestId: 'r1', method: 'context' },
      { wireVersion: 1, kind: 'cancel', identity, requestId: 'r1' },
      { wireVersion: 1, kind: 'result', identity, requestId: 'r1', method: 'context', result: null },
      { wireVersion: 1, kind: 'subscribe', identity, requestId: 'r2', subscriptionId: 's1', method: 'watchContext' },
      { wireVersion: 1, kind: 'subscription', identity, subscriptionId: 's1', event: null },
      { wireVersion: 1, kind: 'disposeHostResource', identity, requestId: 'r3', subscriptionId: 's1' },
      { wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' },
    ]) {
      expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
      const withoutGeneration = structuredClone(envelope) as { identity: Record<string, unknown> };
      delete withoutGeneration.identity.generation;
      expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse(withoutGeneration).success).toBe(false);
    }
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'negotiate',
      identity,
      apiRange: '^1',
      requiredMethods: ['context'],
    }).success).toBe(false);
  });

  it('uses one generic disposer frame instead of a subscription-specific wire alias', () => {
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'disposeHostResource',
      identity,
      requestId: 'dispose-1',
      subscriptionId: 'resource-or-composer-lease-1',
    }).success).toBe(true);
    expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse({
      wireVersion: 1,
      kind: 'unsubscribe',
      identity,
      requestId: 'dispose-1',
      subscriptionId: 'resource-or-composer-lease-1',
    }).success).toBe(false);
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
