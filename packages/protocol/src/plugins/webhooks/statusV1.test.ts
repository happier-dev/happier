import { describe, expect, it } from 'vitest';

import {
  PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1,
  PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1,
  PluginWebhookAccountStatusResultV1Schema,
  PluginWebhookAutomationAdmissionUnresolvedV1Schema,
  PluginWebhookDeliveryReplayInputV1Schema,
} from './statusV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(createCanonicalJsonSigningInput(value)).byteLength;
}

function createExactAutomationAdmissionSummary(byteLength: number) {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    automationId: `automation-${String(index).padStart(3, '0')}-`,
    status: { kind: 'blocked' as const, reason: 'capacity' as const },
  }));
  const summary = {
    v: 1 as const,
    kind: 'automationAdmissionUnresolved' as const,
    totalCount: 100,
    entries,
    omittedCount: 0,
  };
  let remaining = byteLength - canonicalJsonByteLength(summary);
  for (const entry of entries) {
    if (remaining <= 0) break;
    const available = 256 - entry.automationId.length;
    const added = Math.min(available, remaining);
    entry.automationId += 'x'.repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error('test fixture cannot reach the requested canonical JSON size');
  return summary;
}

describe('plugin webhook Account status contracts', () => {
  it('keeps the retained diagnostic status arms exactly aligned with canonical Automation admission', () => {
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse({
      v: 1,
      kind: 'automationAdmissionUnresolved',
      totalCount: 1,
      entries: [{
        automationId: 'automation-no-assignment',
        status: { kind: 'blocked', reason: 'noEnabledAssignment' },
      }],
      omittedCount: 0,
    }).success).toBe(true);
  });

  it('keeps status metadata bounded and rejects raw/provider payload fields', () => {
    const status = {
      endpoints: [], nextEndpointCursor: null,
      deadLetters: [{
        deliveryId: 'delivery-1', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
        deliveryIdentityDigestPrefix: '012345abcdef', errorCode: 'provider_busy', attemptCount: 2,
        replayCount: 0, receivedAtMs: 1, deadLetteredAtMs: 2,
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        automationAdmissionUnresolved: null,
      }],
    };
    expect(PluginWebhookAccountStatusResultV1Schema.parse(status)).toEqual(status);
    expect(PluginWebhookAccountStatusResultV1Schema.safeParse({
      ...status,
      deadLetters: [{ ...status.deadLetters[0], rawBodyBase64: 'secret' }],
    }).success).toBe(false);
  });

  it('projects only the bounded unresolved Automation admission diagnostics on a dead letter', () => {
    const status = {
      endpoints: [],
      nextEndpointCursor: null,
      deadLetters: [{
        deliveryId: 'delivery-1', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
        deliveryIdentityDigestPrefix: '012345abcdef', errorCode: 'provider_busy', attemptCount: 12,
        replayCount: 0, receivedAtMs: 1, deadLetteredAtMs: 2,
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        automationAdmissionUnresolved: {
          v: 1,
          kind: 'automationAdmissionUnresolved',
          totalCount: 2,
          entries: [
            {
              automationId: 'automation-a',
              status: { kind: 'blocked', reason: 'capacity' },
            },
            {
              automationId: 'automation-b',
              status: { kind: 'refreshDefinition', reason: 'definitionStale' },
            },
          ],
          omittedCount: 0,
        },
      }],
    };

    expect(PluginWebhookAccountStatusResultV1Schema.parse(status)).toEqual(status);
    expect(PluginWebhookAccountStatusResultV1Schema.safeParse({
      ...status,
      deadLetters: [{
        ...status.deadLetters[0],
        automationAdmissionUnresolved: {
          ...status.deadLetters[0].automationAdmissionUnresolved,
          entries: [
            ...status.deadLetters[0].automationAdmissionUnresolved.entries,
            {
              automationId: 'automation-a',
              status: { kind: 'blocked', reason: 'capacity' },
            },
          ],
          totalCount: 3,
          omittedCount: 0,
        },
      }],
    }).success).toBe(false);
    expect(PluginWebhookAccountStatusResultV1Schema.safeParse({
      ...status,
      deadLetters: [{
        ...status.deadLetters[0],
        automationAdmissionUnresolved: {
          ...status.deadLetters[0].automationAdmissionUnresolved,
          entries: [{
            automationId: 'automation-a',
            status: null,
          }],
          totalCount: 1,
          omittedCount: 0,
        },
      }],
    }).success).toBe(false);
  });

  it('enforces the exact 100-entry and 16 KiB canonical-summary ceilings and declares the 4 MiB Account-status ceiling', () => {
    const exact = createExactAutomationAdmissionSummary(
      PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1,
    );
    expect(canonicalJsonByteLength(exact)).toBe(
      PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1,
    );
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse(exact).success).toBe(true);

    const tooLarge = structuredClone(exact);
    const expandableEntry = tooLarge.entries.find((entry) => entry.automationId.length < 256);
    if (!expandableEntry) throw new Error('exact summary fixture has no expandable Automation ID');
    expandableEntry.automationId += 'x';
    expect(canonicalJsonByteLength(tooLarge)).toBe(
      PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1 + 1,
    );
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse(tooLarge).success).toBe(false);
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse({
      ...exact,
      totalCount: 101,
      entries: [...exact.entries, {
        automationId: 'z-extra',
        status: { kind: 'blocked', reason: 'capacity' },
      }],
      omittedCount: 0,
    }).success).toBe(false);
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse({
      v: 1,
      kind: 'automationAdmissionUnresolved',
      totalCount: 10_000,
      entries: [{
        automationId: 'automation-1',
        status: { kind: 'blocked', reason: 'capacity' },
      }],
      omittedCount: 9_999,
    }).success).toBe(true);
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse({
      v: 1,
      kind: 'automationAdmissionUnresolved',
      totalCount: 10_001,
      entries: [{
        automationId: 'automation-1',
        status: { kind: 'blocked', reason: 'capacity' },
      }],
      omittedCount: 10_000,
    }).success).toBe(false);
    expect(PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1).toBe(4 * 1024 * 1024);
  });

  it('requires revision CAS for replay', () => {
    expect(PluginWebhookDeliveryReplayInputV1Schema.safeParse({ deliveryId: 'delivery-1' }).success).toBe(false);
  });

  it('projects only bounded transfer recovery facts for retained prior-target deliveries', () => {
    const status = {
      endpoints: [{
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 2,
        contribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-2', materializationId: 'materialization-2', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1', routing: 'accountEndpoint', readiness: 'ready', targetStatus: 'current',
        publicUrl: 'https://server.example/v1/plugins/webhooks/opaque', createdAt: 1,
        queue: { queued: 2, retrying: 0, claimed: 0, deadLetter: 1, oldestPendingAtMs: 1 },
        pendingTargetTransfer: {
          previousTargetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
          eligibleDeliveryCount: 3,
        },
        credentialRotation: {
          previousCredentialVersionId: 'credential-v1',
          previousAcceptUntilMs: 2,
        },
      }],
      nextEndpointCursor: null,
      deadLetters: [],
    };
    expect(PluginWebhookAccountStatusResultV1Schema.parse(status)).toEqual(status);
    expect(PluginWebhookAccountStatusResultV1Schema.safeParse({
      ...status,
      endpoints: [{ ...status.endpoints[0], pendingTargetTransfer: { ...status.endpoints[0].pendingTargetTransfer, cursor: 'secret' } }],
    }).success).toBe(false);
  });
});
