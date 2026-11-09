import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import * as Protocol from '../../index.js';
import {
  formatPluginWebhookEndpointIdV1,
  PluginWebhookEndpointIdV1JsonSchema,
  PluginWebhookDeliveryMovePendingInputV1Schema,
  PluginWebhookEndpointCheckCorrespondenceInputV1Schema,
  PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
  PluginWebhookEndpointEnsureInputV1Schema,
  PluginWebhookEndpointEnsureResultV1Schema,
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookHeartbeatReadInputV1Schema,
  PluginWebhookHeartbeatReceiptHintV1Schema,
  PluginWebhookEndpointReadResultV1Schema,
  PluginWebhookEndpointRetargetInputV1Schema,
  PluginWebhookEndpointRevokeInputV1Schema,
  PluginWebhookPublicUrlV1Schema,
} from './endpointV1.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../actions/jsonSchemaValidation.js';

describe('PluginWebhookEndpointIdV1Schema', () => {
  const canonical = `wh_ep_${encodeBase64(new Uint8Array(16), 'base64url')}`;

  it('projects the same exact canonical endpoint identity as a reusable JSON Schema fragment', () => {
    const validates = compilePluginJsonSchema(PluginWebhookEndpointIdV1JsonSchema);

    expect(PluginWebhookEndpointIdV1JsonSchema).toEqual({
      type: 'string',
      minLength: 28,
      maxLength: 28,
      pattern: '^wh_ep_[A-Za-z0-9_-]{21}[AQgw]$(?![\\s\\S])',
    });
    expect(isValidPluginJsonSchemaValue(validates, canonical)).toBe(true);
    // A 22-character base64url suffix only has two payload bits in its final
    // character. The other low-bit variants would normalize to a different ID.
    expect(isValidPluginJsonSchemaValue(validates, `${canonical.slice(0, -1)}B`)).toBe(false);
  });

  it('exports the reusable endpoint identity fragment from the public protocol entrypoint', () => {
    expect(Protocol.PluginWebhookEndpointIdV1JsonSchema).toBe(PluginWebhookEndpointIdV1JsonSchema);
  });

  it('accepts only the canonical 128-bit endpoint identity', () => {
    expect(PluginWebhookEndpointIdV1Schema.parse(canonical)).toBe(canonical);
    expect(canonical).toHaveLength(28);
    expect(decodeBase64(canonical.slice(6), 'base64url')).toHaveLength(16);

    const invalid = [
      '',
      canonical.slice(0, -1),
      `${canonical}A`,
      canonical.replace('wh_ep_', 'WH_EP_'),
      `${canonical}=`,
      `${canonical}\n`,
      canonical.replace(/A$/u, '+'),
      `${canonical.slice(0, -1)}B`,
      'wh_ep_AAAAAAAAAAAAAAAAAAAA',
      'wh_ep_AAAAAAAAAAAAAAAAAAAAAAAA',
    ];
    for (const value of invalid) {
      expect(PluginWebhookEndpointIdV1Schema.safeParse(value).success, value).toBe(false);
    }
  });

  it('round-trips canonical generated suffixes without normalization', () => {
    for (let seed = 0; seed < 256; seed += 1) {
      const bytes = Uint8Array.from({ length: 16 }, (_, index) => (seed + index * 17) & 0xff);
      const value = `wh_ep_${encodeBase64(bytes, 'base64url')}`;
      const parsed = PluginWebhookEndpointIdV1Schema.parse(value);
      expect(`wh_ep_${encodeBase64(decodeBase64(parsed.slice(6), 'base64url'), 'base64url')}`).toBe(value);
    }
  });

  it('formats exactly 16 random bytes through the one canonical schema', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    expect(formatPluginWebhookEndpointIdV1(bytes)).toBe('wh_ep_AAECAwQFBgcICQoLDA0ODw');
    expect(() => formatPluginWebhookEndpointIdV1(bytes.subarray(1))).toThrow(/16 random bytes/u);
    expect(() => formatPluginWebhookEndpointIdV1(new Uint8Array(17))).toThrow(/16 random bytes/u);
  });
});

const endpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
const webhookContribution = { pluginId: 'example.github', localId: 'events' } as const;
const targetMaterialization = {
  machineId: 'machine-1',
  materializationId: 'materialization-1',
  pluginId: 'example.github',
} as const;

describe('plugin webhook endpoint lifecycle wire contracts', () => {
  it('preserves the saved health check identity through enrollment, receipt reads and hints', () => {
    const checkId = `心拍:${'x'.repeat(1500)}`;
    const setup = { kind: 'capabilityUrlV1', checkId };
    expect(PluginWebhookEndpointEnsureInputV1Schema.parse({ webhookContribution, targetMaterialization,
      sourceInstanceId: 'health:subject', setup, idempotencyKey: 'health-enrollment-0001' }).setup).toEqual(setup);
    const selector = { webhookEndpointId: endpointId, sourceInstanceId: 'health:subject', checkId };
    expect(PluginWebhookHeartbeatReadInputV1Schema.parse(selector)).toEqual(selector);
    expect(PluginWebhookHeartbeatReceiptHintV1Schema.parse({ ...selector, lastAcceptedAt: 123 }).checkId).toBe(checkId);
  });

  it('admits HTTPS public endpoints and only the explicit HTTP loopback development exception', () => {
    expect(Protocol.PluginWebhookPublicUrlV1Schema).toBe(PluginWebhookPublicUrlV1Schema);
    for (const value of [
      'https://example.test/v1/plugins/webhooks/opaque-route',
      'http://localhost:3000/v1/plugins/webhooks/opaque-route',
      'http://127.0.0.1:3000/v1/plugins/webhooks/opaque-route',
      'http://127.0.0.2:3000/v1/plugins/webhooks/opaque-route',
      'http://hooks.localhost:3000/v1/plugins/webhooks/opaque-route',
      'http://[::1]:3000/v1/plugins/webhooks/opaque-route',
    ]) {
      expect(PluginWebhookPublicUrlV1Schema.safeParse(value).success, value).toBe(true);
    }
    for (const value of [
      'http://example.test/v1/plugins/webhooks/opaque-route',
      'http://192.168.1.10/v1/plugins/webhooks/opaque-route',
      'ftp://localhost/v1/plugins/webhooks/opaque-route',
    ]) {
      expect(PluginWebhookPublicUrlV1Schema.safeParse(value).success, value).toBe(false);
    }
  });

  it('accepts one exact present-user ensure contract without Account or server identity', () => {
    const input = {
      webhookContribution,
      targetMaterialization,
      sourceInstanceId: 'channel:github:primary',
      setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
      idempotencyKey: 'ensure-github-primary-0001',
    } as const;

    expect(PluginWebhookEndpointEnsureInputV1Schema.parse(input)).toEqual(input);
    for (const forbidden of [
      { ...input, accountId: 'account-1' },
      { ...input, serverId: 'server-1' },
      { ...input, credential: 'caller-secret' },
      { ...input, targetMaterialization: { ...targetMaterialization, serverId: 'server-1' } },
    ]) {
      expect(PluginWebhookEndpointEnsureInputV1Schema.safeParse(forbidden).success).toBe(false);
    }
  });

  it('enforces setup, source, idempotency, and page bounds at the wire owner', () => {
    const base = {
      webhookContribution,
      targetMaterialization,
      sourceInstanceId: 'a',
      setup: {
        kind: 'githubSharedInstallationV1',
        installationId: '1',
        installationAuthorizationRef: 'authorization-ref',
      },
      idempotencyKey: '1234567890abcdef',
    } as const;
    expect(PluginWebhookEndpointEnsureInputV1Schema.safeParse(base).success).toBe(true);

    for (const value of [
      { ...base, sourceInstanceId: '' },
      { ...base, sourceInstanceId: 'a'.repeat(129) },
      { ...base, sourceInstanceId: 'contains space' },
      { ...base, idempotencyKey: 'short' },
      { ...base, idempotencyKey: 'a'.repeat(129) },
      { ...base, setup: { ...base.setup, installationId: '0' } },
      { ...base, setup: { ...base.setup, installationId: '01' } },
      { ...base, setup: { ...base.setup, installationId: '1'.repeat(21) } },
    ]) {
      expect(PluginWebhookEndpointEnsureInputV1Schema.safeParse(value).success).toBe(false);
    }

    const move = {
      webhookEndpointId: endpointId,
      endpointRevision: 2,
      targetMaterialization: { ...targetMaterialization, materializationId: 'materialization-2' },
      pageSize: 500,
    } as const;
    expect(PluginWebhookDeliveryMovePendingInputV1Schema.safeParse(move).success).toBe(true);
    expect(PluginWebhookDeliveryMovePendingInputV1Schema.safeParse({ ...move, pageSize: 501 }).success).toBe(false);
    // Movement is scoped by difference from the current target, so naming a
    // predecessor is not an accepted input the wire owner may silently ignore.
    expect(PluginWebhookDeliveryMovePendingInputV1Schema.safeParse({
      ...move,
      previousTargetMaterialization: targetMaterialization,
    }).success).toBe(false);
  });

  it('keeps secret material out of read and bounded lifecycle operations exact', () => {
    const ensureResult = {
      webhookEndpointId: endpointId,
      revision: 1,
      publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
      readiness: 'ready',
      oneTimeGeneratedSecret: 'only-on-create',
    } as const;
    expect(PluginWebhookEndpointEnsureResultV1Schema.parse(ensureResult)).toEqual(ensureResult);

    const read = {
      webhookEndpointId: endpointId,
      revision: 1,
      contribution: webhookContribution,
      targetMaterialization,
      sourceInstanceId: 'channel:github:primary',
      routing: 'accountEndpoint',
      readiness: 'ready',
      publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
      createdAt: 1,
    } as const;
    expect(PluginWebhookEndpointReadResultV1Schema.parse(read)).toEqual(read);
    expect(PluginWebhookEndpointReadResultV1Schema.safeParse({ ...read, credential: 'secret' }).success).toBe(false);

    expect(PluginWebhookEndpointRevokeInputV1Schema.safeParse({
      webhookEndpointId: endpointId,
      expectedRevision: 1,
      idempotencyKey: '1234567890abcdef',
    }).success).toBe(true);
    expect(PluginWebhookEndpointRetargetInputV1Schema.safeParse({
      webhookEndpointId: endpointId,
      expectedRevision: 1,
      targetMaterialization,
      idempotencyKey: '1234567890abcdef',
    }).success).toBe(true);
  });

  it('accepts optional verified readiness without turning attachment into provider confirmation', () => {
    const attached = { kind: 'ready', webhookEndpointId: endpointId, revision: 1 } as const;
    expect(PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse(attached)).toEqual(attached);
    for (const readiness of ['ready', 'providerConfirmationRequired'] as const) {
      expect(PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse({ ...attached, readiness }))
        .toEqual({ ...attached, readiness });
    }
    // Nonsecret binding observations let the monitor keep its exact identity
    // checks while using the plugin-safe correspondence principal.
    const binding = { contribution: webhookContribution, targetMaterialization,
      sourceInstanceId: 'channel:github:primary', readiness: 'ready' } as const;
    expect(PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse({ ...attached, ...binding }))
      .toEqual({ ...attached, ...binding });
    expect(PluginWebhookEndpointCheckCorrespondenceResultV1Schema.safeParse({ ...attached, readiness: 'guessed' }).success).toBe(false);
    expect(PluginWebhookEndpointCheckCorrespondenceResultV1Schema.safeParse({ ...attached, oneTimeGeneratedSecret: 'secret' }).success).toBe(false);
  });

  it('keeps correspondence input exact and authority-free', () => {
    const input = {
      webhookEndpointId: endpointId,
      webhookContribution,
      targetMaterialization,
      sourceInstanceId: 'channel:github:primary',
      setup: {
        kind: 'githubSharedInstallationV1',
        installationId: '123',
        installationAuthorizationRef: 'authorization-ref',
      },
    } as const;
    expect(PluginWebhookEndpointCheckCorrespondenceInputV1Schema.parse(input)).toEqual(input);
    expect(PluginWebhookEndpointCheckCorrespondenceInputV1Schema.safeParse({
      webhookEndpointId: input.webhookEndpointId,
      webhookContribution: input.webhookContribution,
      targetMaterialization: input.targetMaterialization,
      sourceInstanceId: input.sourceInstanceId,
    }).success).toBe(false);
    expect(PluginWebhookEndpointCheckCorrespondenceInputV1Schema.safeParse({
      ...input,
      accountId: 'account-1',
    }).success).toBe(false);
  });
});
