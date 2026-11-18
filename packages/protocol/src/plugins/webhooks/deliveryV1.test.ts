import { describe, expect, it } from 'vitest';

import {
  PLUGIN_WEBHOOK_MAX_CONTENT_JSON_BYTES_V1,
  PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1,
  PLUGIN_WEBHOOK_MAX_ENCRYPTED_BUNDLE_BYTES_V1,
  PLUGIN_WEBHOOK_MAX_STORED_ENVELOPE_BYTES_V1,
  PluginWebhookActionInputV1Schema,
  PluginWebhookActionResultV1Schema,
  PluginWebhookClaimResultV1Schema,
  PluginWebhookDeliveryContentV1Schema,
  StoredPluginWebhookDeliveryContentV1Schema,
  PluginWebhookInvocationReferenceV1Schema,
  serializePluginWebhookDeliveryContentV1,
  serializeStoredPluginWebhookDeliveryContentV1,
} from './deliveryV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';

const validContent = {
  v: 1,
  receivedAtMs: 1_700_000_000_000,
  contentType: 'application/json',
  headers: [{ name: 'x-github-event', value: 'issues' }],
  rawBodyBytes: 2,
  rawBodyBase64: 'e30=',
  verified: {
    verifier: 'github_hmac_sha256_v1',
    providerDeliveryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    eventType: 'issues',
    credentialVersionId: 'wh_cred_1',
  },
} as const;

describe('PluginWebhookDeliveryContentV1Schema', () => {
  it('retains Bitbucket colon event keys only with its selected verified header', () => {
    const content = { ...validContent, headers: [{ name: 'x-event-key', value: 'pullrequest:created' }],
      verified: { ...validContent.verified, verifier: 'bitbucket_hmac_sha256_v1', eventType: 'pullrequest:created' } };
    expect(PluginWebhookDeliveryContentV1Schema.parse(content)).toEqual(content);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...content,
      headers: [{ name: 'x-hub-signature', value: 'secret' }] }).success).toBe(false);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...validContent,
      headers: [{ name: 'x-github-event', value: 'pullrequest:created' }],
      verified: { ...validContent.verified, eventType: 'pullrequest:created' } }).success).toBe(false);
  });
  it('retains GitLab event names with spaces while rejecting token retention and unrelated header relaxation', () => {
    const content = { ...validContent, headers: [{ name: 'x-gitlab-event', value: 'Push Hook' }],
      verified: { ...validContent.verified, verifier: 'gitlab_token_v1', eventType: 'Push Hook' } };
    expect(PluginWebhookDeliveryContentV1Schema.parse(content)).toEqual(content);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...content,
      headers: [{ name: 'x-gitlab-token', value: 'secret' }] }).success).toBe(false);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...validContent,
      headers: [{ name: 'x-github-event', value: 'Push Hook' }],
      verified: { ...validContent.verified, eventType: 'Push Hook' } }).success).toBe(false);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...content,
      headers: [{ name: 'x-gitlab-event', value: 'Push Hook\n' }] }).success).toBe(false);
  });
  it('carries capability-authenticated handler content without a fabricated signing credential', () => {
    const content = { ...validContent, headers: [], verified: {
      verifier: 'capabilityUrl_v1', providerDeliveryId: 'sha256:body-digest',
    } };
    expect(PluginWebhookDeliveryContentV1Schema.parse(content)).toEqual(content);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({ ...content,
      headers: validContent.headers }).success).toBe(false);
  });
  it('accepts the strict canonical GitHub content envelope', () => {
    expect(PluginWebhookDeliveryContentV1Schema.parse(validContent)).toEqual(validContent);
    expect(StoredPluginWebhookDeliveryContentV1Schema.parse({ t: 'plain', v: validContent })).toEqual({
      t: 'plain',
      v: validContent,
    });
  });

  it('serializes validated content as stable canonical UTF-8 bytes', () => {
    const reordered = {
      verified: { ...validContent.verified },
      rawBodyBase64: validContent.rawBodyBase64,
      rawBodyBytes: validContent.rawBodyBytes,
      headers: [...validContent.headers],
      contentType: validContent.contentType,
      receivedAtMs: validContent.receivedAtMs,
      v: validContent.v,
    };
    expect(serializePluginWebhookDeliveryContentV1(reordered)).toEqual(
      serializePluginWebhookDeliveryContentV1(validContent),
    );
    expect(new TextDecoder().decode(serializePluginWebhookDeliveryContentV1(validContent))).toBe(
      '{"contentType":"application/json","headers":[{"name":"x-github-event","value":"issues"}],"rawBodyBase64":"e30=","rawBodyBytes":2,"receivedAtMs":1700000000000,"v":1,"verified":{"credentialVersionId":"wh_cred_1","eventType":"issues","providerDeliveryId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","verifier":"github_hmac_sha256_v1"}}',
    );
    expect(() => serializePluginWebhookDeliveryContentV1({ ...validContent, rawBodyBytes: 3 })).toThrow();
  });

  it('serializes the explicit storage discriminator as canonical UTF-8 bytes', () => {
    const plain = { t: 'plain', v: validContent } as const;
    expect(new TextDecoder().decode(serializeStoredPluginWebhookDeliveryContentV1(plain))).toBe(
      `{"t":"plain","v":${new TextDecoder().decode(serializePluginWebhookDeliveryContentV1(validContent))}}`,
    );
    expect(new TextDecoder().decode(serializeStoredPluginWebhookDeliveryContentV1({ c: 'AA==', t: 'encrypted' }))).toBe(
      '{"c":"AA==","t":"encrypted"}',
    );
  });

  it('rejects aliases, unselected headers, and noncanonical or mismatched base64', () => {
    const invalid = [
      { ...validContent, rawBodyBase64: 'e31=', rawBodyBytes: 2 },
      { ...validContent, rawBodyBase64: 'e30', rawBodyBytes: 2 },
      { ...validContent, rawBodyBase64: 'e30=\n', rawBodyBytes: 2 },
      { ...validContent, rawBodyBytes: 3 },
      { ...validContent, headers: [{ name: 'x-hub-signature-256', value: 'secret' }] },
      { ...validContent, contentType: 'application/json; charset=utf-8' },
      { ...validContent, providerPayload: {} },
    ];
    for (const value of invalid) {
      expect(PluginWebhookDeliveryContentV1Schema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts the exact 25 MiB body and rejects maximum plus one', () => {
    const exact = `${'A'.repeat(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1 - 2)}==`;
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({
      ...validContent,
      rawBodyBytes: 26_214_400,
      rawBodyBase64: exact,
    }).success).toBe(true);

    const plusOne = `${'A'.repeat(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1 - 1)}=`;
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({
      ...validContent,
      rawBodyBytes: 26_214_401,
      rawBodyBase64: plusOne,
    }).success).toBe(false);
  });

  it('derives aggregate canonical headroom from bounded components without materializing a maximum body', () => {
    const maximumAsciiToken = 'a'.repeat(128);
    const maximumContentType = `a/${'a'.repeat(126)}`;
    const maximumPluginId = `a.${'a'.repeat(254)}`;
    const maximumLocalId = 'a'.repeat(256);
    const maximumContentWithoutRawBody = {
      v: 1,
      receivedAtMs: Number.MAX_SAFE_INTEGER,
      contentType: maximumContentType,
      headers: [{ name: 'x-github-event', value: maximumAsciiToken }],
      rawBodyBytes: 0,
      rawBodyBase64: '',
      verified: {
        verifier: 'github_hmac_sha256_v1',
        providerDeliveryId: maximumAsciiToken,
        eventType: maximumAsciiToken,
        credentialVersionId: maximumAsciiToken,
      },
    } as const;
    const maximumActionWithoutRawBody = {
      v: 1,
      endpoint: {
        webhookContribution: { pluginId: maximumPluginId, localId: maximumLocalId },
        sourceInstanceId: maximumAsciiToken,
      },
      delivery: {
        deliveryId: maximumAsciiToken,
        attempt: 12,
        replay: 10,
        receivedAtMs: Number.MAX_SAFE_INTEGER,
        providerDeliveryId: maximumAsciiToken,
      },
      request: {
        contentType: maximumContentType,
        headers: [{ name: 'x-github-event', value: maximumAsciiToken }],
        rawBodyBytes: 0,
        rawBodyBase64: '',
      },
      verified: { verifier: 'github_hmac_sha256_v1', eventType: maximumAsciiToken },
    } as const;
    const maximumEncryptedEnvelopeWithoutCiphertext = { c: '', t: 'encrypted' } as const;

    expect(PluginWebhookDeliveryContentV1Schema.parse(maximumContentWithoutRawBody)).toEqual(maximumContentWithoutRawBody);
    expect(PluginWebhookActionInputV1Schema.parse(maximumActionWithoutRawBody)).toEqual(maximumActionWithoutRawBody);
    expect(
      serializePluginWebhookDeliveryContentV1(maximumContentWithoutRawBody).byteLength
      + PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1,
    ).toBeLessThanOrEqual(PLUGIN_WEBHOOK_MAX_CONTENT_JSON_BYTES_V1);
    expect(
      new TextEncoder().encode(createCanonicalJsonSigningInput(maximumActionWithoutRawBody)).byteLength
      + PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1,
    ).toBeLessThanOrEqual(PLUGIN_WEBHOOK_MAX_CONTENT_JSON_BYTES_V1);
    expect(
      serializeStoredPluginWebhookDeliveryContentV1(maximumEncryptedEnvelopeWithoutCiphertext).byteLength
      + (4 * Math.ceil(PLUGIN_WEBHOOK_MAX_ENCRYPTED_BUNDLE_BYTES_V1 / 3)),
    ).toBeLessThanOrEqual(PLUGIN_WEBHOOK_MAX_STORED_ENVELOPE_BYTES_V1);
  });
});

describe('Sentry-verified webhook content and Action input', () => {
  const sentryContent = {
    ...validContent,
    headers: [{ name: 'sentry-hook-resource', value: 'issue' }],
    verified: {
      verifier: 'sentry_hmac_sha256_v1',
      providerDeliveryId: '6f1d4c4e-2a7b-4a51-9f3e-7f4a0a5b9c11',
      eventType: 'issue',
      credentialVersionId: 'wh_cred_1',
    },
  } as const;
  const sentryActionInput = {
    v: 1,
    endpoint: { webhookContribution: { pluginId: 'acme.sentry', localId: 'sentry-events' }, sourceInstanceId: 'source-1' },
    delivery: { deliveryId: 'delivery-1', attempt: 1, replay: 0, receivedAtMs: 1_700_000_000_000, providerDeliveryId: '6f1d4c4e-2a7b-4a51-9f3e-7f4a0a5b9c11' },
    request: { contentType: 'application/json', headers: [{ name: 'sentry-hook-resource', value: 'issue' }], rawBodyBytes: 2, rawBodyBase64: 'e30=' },
    verified: { verifier: 'sentry_hmac_sha256_v1', eventType: 'issue' },
  } as const;

  it('accepts the Sentry resource header as the verified event type', () => {
    expect(PluginWebhookDeliveryContentV1Schema.parse(sentryContent)).toEqual(sentryContent);
    expect(PluginWebhookActionInputV1Schema.parse(sentryActionInput)).toEqual(sentryActionInput);
  });

  it('accepts GitLab spaced Action events but refuses them under other verifiers or without the matching header', () => {
    const input = { ...sentryActionInput,
      request: { ...sentryActionInput.request, headers: [{ name: 'x-gitlab-event', value: 'Push Hook' }] },
      verified: { verifier: 'gitlab_token_v1', eventType: 'Push Hook' } };
    expect(PluginWebhookActionInputV1Schema.parse(input)).toEqual(input);
    for (const verifier of ['github_hmac_sha256_v1', 'sentry_hmac_sha256_v1']) {
      for (const headers of [[], [{ name: 'x-gitlab-event', value: 'Push Hook' }],
        [{ name: verifier === 'github_hmac_sha256_v1' ? 'x-github-event' : 'sentry-hook-resource', value: 'Push Hook' }]]) {
        expect(PluginWebhookActionInputV1Schema.safeParse({ ...input,
          request: { ...input.request, headers }, verified: { verifier, eventType: 'Push Hook' } }).success).toBe(false);
      }
    }
  });

  it('refuses a selected header that belongs to another verifier', () => {
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({
      ...sentryContent,
      headers: [{ name: 'x-github-event', value: 'issue' }],
    }).success).toBe(false);
    expect(PluginWebhookDeliveryContentV1Schema.safeParse({
      ...validContent,
      headers: [{ name: 'sentry-hook-resource', value: 'issues' }],
    }).success).toBe(false);
    expect(PluginWebhookActionInputV1Schema.safeParse({
      ...sentryActionInput,
      request: { ...sentryActionInput.request, headers: [{ name: 'x-github-event', value: 'issue' }] },
    }).success).toBe(false);
  });
});

describe('PluginWebhookActionResultV1Schema', () => {
  it('keeps the result union and diagnostic code closed and bounded', () => {
    expect(PluginWebhookActionResultV1Schema.parse({ kind: 'settled', disposition: 'accepted' })).toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    expect(PluginWebhookActionResultV1Schema.parse({ kind: 'retry', code: 'upstream.busy' })).toEqual({
      kind: 'retry',
      code: 'upstream.busy',
    });
    for (const value of [
      { kind: 'settled', disposition: 'unknown' },
      { kind: 'retry', code: 'Payload leaked' },
      { kind: 'deadLetter', code: 'a'.repeat(65) },
      { kind: 'accepted' },
    ]) {
      expect(PluginWebhookActionResultV1Schema.safeParse(value).success).toBe(false);
    }
  });
});

describe('PluginWebhookActionInputV1Schema', () => {
  it('carries the worker endpoint identity while refusing routing authority operands', () => {
    const input = {
      v: 1,
      endpoint: {
        webhookContribution: { pluginId: 'example.github', localId: 'events' },
        sourceInstanceId: 'channel:github:primary',
      },
      delivery: {
        deliveryId: 'delivery-1',
        attempt: 1,
        replay: 0,
        receivedAtMs: validContent.receivedAtMs,
        providerDeliveryId: validContent.verified.providerDeliveryId,
      },
      request: {
        contentType: validContent.contentType,
        headers: validContent.headers,
        rawBodyBytes: validContent.rawBodyBytes,
        rawBodyBase64: validContent.rawBodyBase64,
      },
      verified: { verifier: validContent.verified.verifier, eventType: validContent.verified.eventType },
    } as const;
    expect(PluginWebhookActionInputV1Schema.safeParse(input).success).toBe(true);
    expect(PluginWebhookActionInputV1Schema.safeParse({
      ...input,
      endpoint: { ...input.endpoint, webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' },
    }).success).toBe(true);
    expect(PluginWebhookActionInputV1Schema.safeParse({ ...input,
      endpoint: { ...input.endpoint, revision: 1, setup: { kind: 'capabilityUrl' } },
    }).success).toBe(false);
  });
});

describe('PluginWebhookInvocationReferenceV1Schema', () => {
  const reference = {
    v: 1,
    deliveryId: 'delivery-1',
    endpoint: {
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
      revision: 3,
      webhookContribution: { pluginId: 'example.github', localId: 'events' },
      handlerActionLocalId: 'receive',
      sourceInstanceId: 'channel:github:primary',
    },
    target: {
      materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'example.github' },
      machineInstallationId: 'installation-1',
    },
    lease: { leaseId: 'lease-1', revision: 2 },
  } as const;

  it('accepts only the bounded host-stamped claim facts', () => {
    expect(PluginWebhookInvocationReferenceV1Schema.parse(reference)).toEqual(reference);
    expect(PluginWebhookInvocationReferenceV1Schema.safeParse({ ...reference, generation: 4 }).success).toBe(false);
    expect(PluginWebhookInvocationReferenceV1Schema.safeParse({
      ...reference,
      endpoint: { ...reference.endpoint, revision: 0 },
    }).success).toBe(false);
  });
});

describe('PluginWebhookClaimResultV1Schema', () => {
  it('extends the lease identity with bounded claim timing facts and no client server identity', () => {
    const result = {
      kind: 'delivery',
      deliveryId: 'delivery-1',
      target: {
        materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'example.github' },
        machineInstallationId: 'installation-1',
      },
      pluginVersion: 'plugin-version-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        revision: 3,
        webhookContribution: { pluginId: 'example.github', localId: 'events' },
        handlerActionLocalId: 'receive',
        sourceInstanceId: 'channel:github:primary',
      },
      attempt: 1,
      replay: 0,
      receivedAtMs: 1,
      envelope: { t: 'plain', v: validContent },
      lease: {
        leaseId: 'lease-1',
        revision: 2,
        firstClaimAtMs: 3,
        expiresAtMs: 4,
        maxClaimUntilMs: 5,
      },
    } as const;

    expect(PluginWebhookClaimResultV1Schema.parse(result)).toEqual(result);
    expect(PluginWebhookClaimResultV1Schema.safeParse({
      ...result,
      endpoint: { ...result.endpoint, serverId: 'client-profile-server' },
    }).success).toBe(false);
  });
});
