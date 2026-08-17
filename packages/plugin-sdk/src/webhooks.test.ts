import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol/plugins/manifest';
import {
  PluginWebhookActionInputV1Schema,
  PluginWebhookActionResultV1Schema,
} from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import {
  PluginWebhookEndpointIdV1Schema as canonicalPluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointIdV1JsonSchema as canonicalPluginWebhookEndpointIdV1JsonSchema,
  PluginWebhookEndpointSetupV1Schema as canonicalPluginWebhookEndpointSetupV1Schema,
  type PluginWebhookEndpointIdV1 as CanonicalPluginWebhookEndpointIdV1,
  type PluginWebhookEndpointSetupV1 as CanonicalPluginWebhookEndpointSetupV1,
} from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import type { PluginApi } from './activation.js';
import {
  decodePluginWebhookActionRawBody,
  definePluginWebhookTestFixture,
  PluginWebhookActionInputSchema,
  PluginWebhookActionResultSchema,
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointIdV1JsonSchema,
  PluginWebhookEndpointSetupV1Schema,
  type PluginWebhookContribution,
  type PluginWebhookEndpointIdV1,
  type PluginWebhookEndpointSetupV1,
  type PluginWebhookTestFixture,
} from './webhooks.js';
import {
  PluginWebhookEndpointSetupV1Schema as publicPluginWebhookEndpointSetupV1Schema,
  type PluginWebhookEndpointSetupV1 as PublicPluginWebhookEndpointSetupV1,
} from './webhooks/index.js';

const fixture = {
  webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
  input: {
    v: 1,
    endpoint: {
      webhookContribution: { pluginId: 'example.github', localId: 'events' },
      sourceInstanceId: 'channel:github:primary',
    },
    delivery: {
      deliveryId: 'delivery-1',
      attempt: 1,
      replay: 0,
      receivedAtMs: 1,
      providerDeliveryId: 'provider-delivery-1',
    },
    request: {
      contentType: 'application/json',
      headers: [{ name: 'x-github-event', value: 'issues' }],
      rawBodyBytes: 2,
      rawBodyBase64: 'e30=',
    },
    verified: {
      verifier: 'github_hmac_sha256_v1',
      eventType: 'issues',
    },
  },
  result: { kind: 'settled', disposition: 'accepted' },
} as const satisfies PluginWebhookTestFixture;

describe('webhook authoring surface', () => {
  it('declares the realm-neutral public /webhooks entrypoint for browser-safe schema consumers', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

    expect(packageJson.exports['./webhooks']).toEqual({
      types: './dist/webhooks/index.d.ts',
      default: './dist/webhooks/index.js',
    });
    expect((await readFile(new URL('./webhooks.ts', import.meta.url), 'utf8'))
      .startsWith('/** @moduleRealm any */')).toBe(true);
  });

  it('projects the closed descriptor and validates fixtures through Protocol owners', () => {
    expect(definePluginWebhookTestFixture(fixture)).toEqual(fixture);
    expect(() => definePluginWebhookTestFixture({
      ...fixture,
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAB',
    })).toThrow();

    expectTypeOf<PluginWebhookContribution>().toMatchTypeOf<Readonly<{
      id: string;
      verifier: Readonly<{
        kind: 'github_hmac_sha256_v1';
        routing: 'accountEndpoint' | 'providerInstallation';
      }>;
      handlerAction: Readonly<{ localId: string }>;
    }>>();
  });

  it('projects the webhook action boundary schemas and raw-body decoder without exposing a general codec', () => {
    expect(PluginWebhookActionInputSchema).toBe(PluginWebhookActionInputV1Schema);
    expect(PluginWebhookActionResultSchema).toBe(PluginWebhookActionResultV1Schema);
    expect(new TextDecoder().decode(decodePluginWebhookActionRawBody(fixture.input))).toBe('{}');
    expect(PluginWebhookEndpointIdV1JsonSchema)
      .toBe(canonicalPluginWebhookEndpointIdV1JsonSchema);
    expect(PluginWebhookEndpointSetupV1Schema)
      .toBe(canonicalPluginWebhookEndpointSetupV1Schema);
    expectTypeOf<PluginWebhookEndpointSetupV1>()
      .toEqualTypeOf<CanonicalPluginWebhookEndpointSetupV1>();
    expect(publicPluginWebhookEndpointSetupV1Schema)
      .toBe(canonicalPluginWebhookEndpointSetupV1Schema);
    expectTypeOf<PublicPluginWebhookEndpointSetupV1>()
      .toEqualTypeOf<CanonicalPluginWebhookEndpointSetupV1>();
  });

  it('re-exports the exact endpoint parser and JSON projection from the canonical /webhooks source', () => {
    const malformedEndpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAB';
    const jsonEndpointValidator = compilePluginJsonSchema(PluginWebhookEndpointIdV1JsonSchema);

    expect(PluginWebhookEndpointIdV1Schema).toBe(canonicalPluginWebhookEndpointIdV1Schema);
    expect(PluginWebhookEndpointIdV1JsonSchema)
      .toBe(canonicalPluginWebhookEndpointIdV1JsonSchema);
    expect(PluginWebhookEndpointIdV1Schema.parse(fixture.webhookEndpointId))
      .toBe(fixture.webhookEndpointId);
    expect(PluginWebhookEndpointIdV1Schema.safeParse(malformedEndpointId).success).toBe(false);
    expect(isValidPluginJsonSchemaValue(jsonEndpointValidator, fixture.webhookEndpointId)).toBe(true);
    expect(isValidPluginJsonSchemaValue(jsonEndpointValidator, malformedEndpointId)).toBe(false);
    expectTypeOf<PluginWebhookEndpointIdV1>()
      .toEqualTypeOf<CanonicalPluginWebhookEndpointIdV1>();
  });

  it('adds no runtime webhook service or registration authority', () => {
    expectTypeOf<PluginApi>().not.toHaveProperty('services');
    expectTypeOf<PluginApi>().not.toHaveProperty('webhooks');
  });
});
