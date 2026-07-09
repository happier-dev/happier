import { describe, expect, it } from 'vitest';

import {
  PluginUiResourceSubscriptionEventV1Schema,
  PluginUiResourceSubscriptionRequestV1Schema,
} from './subscriptions.js';

describe('plugin UI resource subscriptions', () => {
  it('uses subscription ids for events instead of request sequence correlation', () => {
    const request = PluginUiResourceSubscriptionRequestV1Schema.parse({
      resource: { kind: 'localService', idPath: '/services/0/id' },
      subscriptionId: 'sub-1',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: request.subscriptionId,
      kind: 'snapshot',
      snapshot: {
        resource: request.resource,
        state: 'available',
        capturedAtMs: 1,
        payload: { status: 'ready' },
      },
    })).toMatchObject({
      subscriptionId: 'sub-1',
      kind: 'snapshot',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      requestSequence: 1,
      kind: 'snapshot',
      snapshot: {
        resource: request.resource,
        state: 'available',
        capturedAtMs: 1,
      },
    }).success).toBe(false);
  });

  it('owns the unsubscribe payload shape used by every host API tier', async () => {
    const subscriptions = await import('./subscriptions.js');
    expect('PluginUiResourceUnsubscribeRequestV1Schema' in subscriptions).toBe(true);

    const schema = (subscriptions as unknown as {
      PluginUiResourceUnsubscribeRequestV1Schema: {
        parse(value: unknown): unknown;
        safeParse(value: unknown): { success: boolean };
      };
    }).PluginUiResourceUnsubscribeRequestV1Schema;
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
