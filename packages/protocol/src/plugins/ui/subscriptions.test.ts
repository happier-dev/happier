import { describe, expect, it } from 'vitest';
import { DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema } from '../../daemon/contributionRegistryProjection.js';

import {
  PluginUiResourceSubscriptionEventV1Schema,
  PluginUiResourceSubscriptionRequestV1Schema,
} from './subscriptions.js';

describe('plugin UI resource subscriptions', () => {
  it('admits an exact consumer and purpose authority watch without accepting credential or routing inputs', () => {
    const resource = { readAuthority: { consumer: { pluginId: 'acme.external', localId: 'read-ci' }, purpose: 'github', input: {} } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.parse({ resource, subscriptionId: 'authority' }).resource).toEqual(resource);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({ machineId: 'machine-1', callerPluginId: 'acme.external',
      expectedCallerOccurrenceId: 'occurrence-7', subscriptionId: 'authority', resource }).resource).toEqual(resource);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.parse({ ok: true, subscriptionId: 'authority' }))
      .toEqual({ ok: true, subscriptionId: 'authority' });
    for (const extra of [{ accountId: 'selected' }, { tokenHash: 'private' }, { machineId: 'foreign' }]) {
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: {
        readAuthority: { ...resource.readAuthority, ...extra },
      }, subscriptionId: 'authority' }).success).toBe(false);
    }
  });
  it('admits closed host read references through the incumbent subscription target', () => {
    for (const hostRead of ['usage.query', 'connectedServices.quota.get', 'connectedServices.pools.selection.get']) {
      const resource = { hostRead, input: { queries: [] } };
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource, subscriptionId: 'host' }).success).toBe(true);
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { ...resource, accountId: 'foreign' }, subscriptionId: 'host' }).success).toBe(false);
    }
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { hostRead: 'settings.set', input: {} }, subscriptionId: 'host' }).success).toBe(false);
  });
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
