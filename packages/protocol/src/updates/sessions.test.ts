import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';
import { classifySessionEventDelivery } from '../sessions/sessionEventDelivery.js';
import { SessionConsumptionReplaceV1Schema, SessionConsumptionReplaceAckV1Schema } from '../sessions/sessionConsumptionV1.js';
import { buildSessionMessageObservationFactsV1, SessionMessageObservationFactsV1Schema } from '../sessions/messages/sessionMessageObservationFactsV1.js';

it('classifies durable-only, live and unconsumed events with one policy', () => {
  for (const event of ['new-message', 'message-updated', 'checkpoint', 'delta', 'update-session'] as const) {
    expect(classifySessionEventDelivery({ event, consumption: { durableBodies: false, liveSegments: true } }))
      .toEqual({ delivery: 'full', materialization: 'full' });
    for (const durableBodies of [true, false]) {
      expect(classifySessionEventDelivery({ event, consumption: { durableBodies, liveSegments: false } })).toEqual(
        event === 'checkpoint' || event === 'delta' ? { delivery: 'skip', materialization: 'none' }
          : { delivery: durableBodies ? 'full' : 'hint', materialization: event === 'new-message' ? 'projection' : 'stale' });
    }
  }
});

it('omits only metadata documents while retaining full Agent state in a Session metadata hint', () => {
  const hint = { t: 'update-session', id: 's', metadataDocument: 'omitted', metadataLayoutVersion: 1,
    metadataVersion: 9, agentState: { version: 3, value: 'unchanged-agent-state' }, pendingPermissionRequestCount: 1 };
  expect(UpdateBodySchema.parse(hint)).toEqual(hint);
  for (const metadata of [
    { metadata: { version: 9, value: 'private-shared-metadata' } },
    { ownerMetadata: { value: { t: 'plain', v: { v: 1 } } } },
    { metadataVersion: undefined }, { metadataLayoutVersion: undefined },
  ]) expect(UpdateBodySchema.safeParse({ ...hint, ...metadata }).success).toBe(false);
});

it('keeps consumption declaration and refusal envelopes closed', () => {
  const request = { v: 1, liveSessionIds: ['live'], durableSessionIds: ['scm'] };
  expect(SessionConsumptionReplaceV1Schema.parse(request)).toEqual(request);
  expect(SessionConsumptionReplaceV1Schema.safeParse({ ...request, accountId: 'claimed' }).success).toBe(false);
  expect(SessionConsumptionReplaceV1Schema.safeParse({ ...request, liveSessionIds: [''] }).success).toBe(false);
  expect(SessionConsumptionReplaceAckV1Schema.parse({ ok: true, ...request })).toEqual({ ok: true, ...request });
  expect(SessionConsumptionReplaceAckV1Schema.parse({ ok: false, error: 'not_allowed' })).toEqual({ ok: false, error: 'not_allowed' });
});

it('whitelists a serialized hint without content, actor or acceptance detail', () => {
  const hint = buildSessionMessageObservationFactsV1({ id: 'm', seq: 4, localId: null,
    content: { t: 'encrypted', c: 'secret' }, accountActor: null,
    deliveryResolution: { v: 1, kind: 'manual_handled' }, createdAt: 100, updatedAt: 101,
    sourceCreatedAt: 10, transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
    toolOutputAvailability: { status: 'expired', days: 30 } });
  expect(SessionMessageObservationFactsV1Schema.parse(hint)).toEqual(hint);
  expect(hint.toolOutputAvailability).toEqual({ status: 'expired', days: 30 });
  expect(hint).not.toHaveProperty('content');
  expect(hint).not.toHaveProperty('accountActor');
  expect(hint).not.toHaveProperty('deliveryResolution');
  expect(hint.attentionImpact).toEqual({ affectsUnread: true, affectsMeaningfulActivity: true });
  for (const t of ['new-message', 'message-updated']) {
    const parsed = UpdateBodySchema.parse({ t, sid: 's', delivery: 'hint', message: hint });
    if ((parsed.t !== 'new-message' && parsed.t !== 'message-updated') || parsed.delivery !== 'hint') throw new Error('Expected durable message hint');
    expect(parsed.message).toEqual(hint);
  }
});

function buildNewSessionUpdateBody(overrides: Record<string, unknown> = {}) {
  return {
    t: 'new-session',
    id: 's1',
    seq: 1,
    metadata: 'metadata',
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    dataEncryptionKey: null,
    active: true,
    activeAt: 1,
    createdAt: 1,
    updatedAt: 1,
    encryptionMode: 'plain',
    ...overrides,
  };
}

describe('session update payloads', () => {
  it('carries closed pending activation causes and explicit clearing without private failure prose', () => {
    const update = { t: 'pending-changed', sid: 's1', pendingVersion: 2, pendingCount: 1,
      pendingActivationAuthorization: { requestId: 'input', requestedAt: 1, status: 'failed', failureCode: 'runtime_start_failed' },
      pendingActivationFailureDetails: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED', runtimeReason: 'no_eligible_member' } };
    expect(UpdateBodySchema.parse(update)).toEqual(update);
    expect(UpdateBodySchema.parse({ ...update, pendingActivationAuthorization: null, pendingActivationFailureDetails: null }))
      .toMatchObject({ pendingActivationAuthorization: null, pendingActivationFailureDetails: null });
    expect(UpdateBodySchema.safeParse({ ...update, pendingActivationFailureDetails: {
      ...update.pendingActivationFailureDetails, message: 'private provider prose',
    } }).success).toBe(false);
  });
  it('accepts legacy new-session updates without a storage encryption mode', () => {
    const parsed = UpdateBodySchema.parse(buildNewSessionUpdateBody({ encryptionMode: undefined }));

    expect(parsed.t).toBe('new-session');
    expect(parsed.encryptionMode).toBeUndefined();
  });

  it('accepts explicit plaintext new-session updates', () => {
    const parsed = UpdateBodySchema.parse(buildNewSessionUpdateBody({ encryptionMode: 'plain' }));

    expect(parsed.encryptionMode).toBe('plain');
  });

  it('types the split metadata layout and owner envelope on new-session updates', () => {
    const parsed = UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
    }));

    expect(parsed.success).toBe(true);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'encrypted',
        c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
      },
    })).success).toBe(true);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: '1',
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
    })).success).toBe(false);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: 42,
    })).success).toBe(false);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata:
        'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
    })).success).toBe(false);
  });
});
