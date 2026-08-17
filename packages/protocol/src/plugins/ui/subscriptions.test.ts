import { describe, expect, it } from 'vitest';

import {
  PluginUiResourceSubscriptionEventV1Schema,
  PluginUiResourceSubscriptionRequestV1Schema,
} from './subscriptions.js';

describe('plugin UI resource subscriptions', () => {
  it('uses subscription ids for events instead of request sequence correlation', () => {
    const request = PluginUiResourceSubscriptionRequestV1Schema.parse({
      resource: { pluginId: 'acme.preview', localId: 'live-status' },
      subscriptionId: 'sub-1',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: request.subscriptionId,
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
    })).toMatchObject({
      subscriptionId: 'sub-1',
      kind: 'invalidated',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      requestSequence: 1,
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
    }).success).toBe(false);
  });

  it('is a bounded invalidation signal, never a payload channel', () => {
    // §3.6: `readResource` stays the single snapshot authority, so the event
    // carries no resource payload and no second data path exists. The retired
    // `snapshot` arm carried a full `PluginUiResourceSnapshotV1` payload bound
    // to the declarative session-resource-target vocabulary.
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'snapshot',
      snapshot: {
        resource: { kind: 'localService', idPath: '/services/0/id' },
        state: 'available',
        capturedAtMs: 1,
        payload: { status: 'ready' },
      },
    }).success).toBe(false);
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
      payload: { status: 'ready' },
    }).success).toBe(false);
    // The digest is the canonical plugin UI digest, not any opaque string.
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'invalidated',
      digest: 'not-a-digest',
    }).success).toBe(false);
  });

  it('keeps acknowledged-async retirement and rejection on the same event union', () => {
    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'complete',
    })).toMatchObject({ kind: 'complete', diagnostics: [] });
    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'error',
      code: 'stale_surface',
    })).toMatchObject({ kind: 'error', code: 'stale_surface' });
  });

  it('owns the generic host-resource disposal payload used by every host API tier', async () => {
    const subscriptions = await import('./subscriptions.js');
    expect('PluginUiDisposeHostResourceRequestV1Schema' in subscriptions).toBe(true);
    expect('PluginUiResourceUnsubscribeRequestV1Schema' in subscriptions).toBe(false);

    const schema = (subscriptions as unknown as {
      PluginUiDisposeHostResourceRequestV1Schema: {
        parse(value: unknown): unknown;
        safeParse(value: unknown): { success: boolean };
      };
    }).PluginUiDisposeHostResourceRequestV1Schema;
    expect(schema.parse({
      subscriptionId: 'sub-1',
    })).toEqual({
      subscriptionId: 'sub-1',
    });
    expect(schema.safeParse({
      subscriptionId: 'sub-1',
      requestSequence: 1,
    }).success).toBe(false);
  });
});
