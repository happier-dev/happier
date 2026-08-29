import { describe, expect, it } from 'vitest';

import {
  PluginWebhookClaimRequestV1Schema,
  PluginWebhookClaimResultV1Schema,
  PluginWebhookActionResultV1Schema,
  PluginWebhookCompleteRequestV1Schema,
  PluginWebhookFailRequestV1Schema,
  PluginWebhookRenewRequestV1Schema,
} from './deliveryV1.js';

const target = {
  materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
  machineInstallationId: 'installation-1',
} as const;
const machine = { machineId: 'machine-1', machineInstallationId: 'installation-1' } as const;
const lease = { leaseId: 'lease-1', revision: 2 } as const;

describe('plugin webhook daemon claim wire V1', () => {
  it('claims per authenticated machine installation and never names a materialization target', () => {
    expect(PluginWebhookClaimRequestV1Schema.parse({ v: 1, policyVersion: 1, machine })).toEqual({
      v: 1,
      policyVersion: 1,
      machine,
    });
    // The server selects the exact eligible materialization; a daemon-selected
    // target or a client serverId would move that authority into mutable input.
    expect(PluginWebhookClaimRequestV1Schema.safeParse({
      v: 1,
      policyVersion: 1,
      machine: { ...machine, materializationId: 'materialization-1' },
    }).success).toBe(false);
    expect(PluginWebhookClaimRequestV1Schema.safeParse({
      v: 1,
      policyVersion: 1,
      machine: { ...machine, serverId: 'spoofed' },
    }).success).toBe(false);
    expect(PluginWebhookClaimRequestV1Schema.safeParse({
      v: 1,
      policyVersion: 1,
      target,
    }).success).toBe(false);
  });

  it('returns at most one strict Account envelope under one bounded lease', () => {
    const delivery = {
      kind: 'delivery',
      deliveryId: 'delivery-1',
      target,
      pluginVersion: '1.0.0',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: { pluginId: 'acme.github', localId: 'github-events' },
        handlerActionLocalId: 'handle-webhook',
        sourceInstanceId: 'source-1',
      },
      attempt: 1,
      replay: 0,
      receivedAtMs: 1,
      envelope: { t: 'plain', v: {
        v: 1,
        receivedAtMs: 1,
        contentType: 'application/json',
        headers: [{ name: 'x-github-event', value: 'issues' }],
        rawBodyBytes: 2,
        rawBodyBase64: 'e30=',
        verified: {
          verifier: 'github_hmac_sha256_v1',
          providerDeliveryId: 'delivery-1',
          eventType: 'issues',
          credentialVersionId: 'credential-1',
        },
      } },
      lease: { ...lease, firstClaimAtMs: 1, expiresAtMs: 121_000, maxClaimUntilMs: 601_000 },
    } as const;
    expect(PluginWebhookClaimResultV1Schema.parse(delivery)).toEqual(delivery);
    expect(PluginWebhookClaimResultV1Schema.safeParse({ ...delivery, body: '{}' }).success).toBe(false);
  });

  it('keeps renew, completion, and failure transitions closed', () => {
    expect(PluginWebhookRenewRequestV1Schema.safeParse({
      v: 1, target, lease, transition: 'executionStarted',
    }).success).toBe(true);
    expect(PluginWebhookCompleteRequestV1Schema.safeParse({
      v: 1, target, lease, result: { kind: 'settled', disposition: 'accepted' },
    }).success).toBe(true);
    expect(PluginWebhookFailRequestV1Schema.safeParse({
      v: 1, target, lease, result: { kind: 'retry', code: 'temporary' },
    }).success).toBe(true);
    const automationAdmissionUnresolved = {
      v: 1,
      kind: 'automationAdmissionUnresolved',
      totalCount: 1,
      entries: [{
        automationId: 'automation-1',
        status: { kind: 'blocked', reason: 'capacity' },
      }],
      omittedCount: 0,
    } as const;
    expect(PluginWebhookFailRequestV1Schema.safeParse({
      v: 1, target, lease, result: { kind: 'retry', code: 'temporary' }, automationAdmissionUnresolved,
    }).success).toBe(true);
    expect(PluginWebhookFailRequestV1Schema.safeParse({
      v: 1, target, lease, result: { kind: 'deadLetter', code: 'temporary' }, automationAdmissionUnresolved,
    }).success).toBe(false);
    expect(PluginWebhookFailRequestV1Schema.safeParse({
      v: 1, target, lease, result: { kind: 'retry', code: 'secret leaked' },
    }).success).toBe(false);
    expect(PluginWebhookActionResultV1Schema.safeParse({
      kind: 'retry',
      code: 'temporary',
      automationAdmissionUnresolved,
    }).success).toBe(false);
  });
});
