import { describe, expect, it } from 'vitest';
import {
  SessionTeamCredentialBindingIntentV1Schema,
  SessionTeamCredentialSlotV1Schema,
  encodeSessionTeamCredentialSlotKeyV1,
  SessionTeamCredentialBindingIntentsV1Schema,
  SessionTeamCredentialBindingMetadataPatchV1Schema,
} from './sessionBindingV1.js';

const purpose = { consumer: { pluginId: 'example.plugin', localId: 'consumer' }, purpose: 'search' };

describe('Session team credential binding contract', () => {
  it('encodes each physical slot deterministically as UTF-8', () => {
    const slot = { kind: 'connected_service_purpose' as const, purpose };
    expect(Array.from(encodeSessionTeamCredentialSlotKeyV1(slot))).toEqual(
      Array.from(new TextEncoder().encode(JSON.stringify(['connected_service_purpose', 'example.plugin', 'consumer', 'search']))),
    );
    expect(SessionTeamCredentialSlotV1Schema.safeParse(slot).success).toBe(true);
  });

  it('accepts clear and resource intents but rejects duplicate slots', () => {
    const clear = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' }, resourceId: null });
    expect(clear.resourceId).toBeNull();
    const resource = { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 2, deliveryMode: 'brokered' };
    expect(SessionTeamCredentialBindingIntentV1Schema.parse(resource)).toEqual(resource);
    expect(SessionTeamCredentialBindingIntentsV1Schema.safeParse([resource, resource]).success).toBe(false);
  });

  it('does not impose a credential-specific cap on distinct Session slots', () => {
    const intents = Array.from({ length: 17 }, (_, index) => ({
      v: 1 as const,
      slot: {
        kind: 'connected_service_purpose' as const,
        purpose: {
          consumer: { pluginId: `example.plugin.${index}`, localId: 'consumer' },
          purpose: 'search',
        },
      },
      resourceId: `resource-${index}`,
      expectedResourceRevision: index,
      deliveryMode: 'brokered' as const,
    }));

    expect(SessionTeamCredentialBindingIntentsV1Schema.safeParse(intents).success).toBe(true);
  });

  it('binds an existing-Session witness only to its matching metadata operation', () => {
    const ownerTuple = {
      metadataLayoutVersion: 1,
      expectedOwnerMetadata: { t: 'plain', v: { v: 1 } },
      sharedMetadata: { ciphertext: '{}', expectedVersion: 0 },
      ownerMetadata: { t: 'plain', v: { v: 1 } },
      agentState: { ciphertext: null, expectedVersion: 0 },
    } as const;
    const binding = {
      v: 1,
      slot: { kind: 'provider_model' },
      resourceId: 'resource-1',
      expectedResourceRevision: 2,
      deliveryMode: 'direct',
    } as const;
    const connectedBinding = {
      v: 1,
      slot: { kind: 'connected_service_purpose', purpose },
      resourceId: 'resource-2',
      expectedResourceRevision: 3,
      deliveryMode: 'brokered',
    } as const;
    const patch = {
      ...ownerTuple,
      mode: 'owner_team_credential_binding',
      operation: 'session.model.set',
      teamCredentialBindings: [binding],
    } as const;
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.parse(patch)).toEqual(patch);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      operation: 'session.connected_service.switch',
    }).success).toBe(false);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      publisherPrecondition: { machineId: 'machine', committedFenceMs: 1 },
    }).success).toBe(false);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      activitySummaryV1: {
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 0,
        pendingRequestNewestCreatedAt: 100,
      },
    }).success).toBe(false);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      sessionExpectation: { kind: 'inactive_model_intent' },
    }).success).toBe(true);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.parse({
      ...patch,
      teamVisibilityGrantConsent: { teamId: 'team-1' },
    }).teamVisibilityGrantConsent).toEqual({ teamId: 'team-1' });
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      operation: 'session.connected_service.switch',
      teamCredentialBindings: [connectedBinding],
      sessionExpectation: { kind: 'inactive_model_intent' },
    }).success).toBe(false);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.parse({
      ...patch,
      operation: 'session.connected_service.switch',
      teamCredentialBindings: [
        connectedBinding,
        {
          ...connectedBinding,
          slot: {
            kind: 'connected_service_purpose',
            purpose: { ...purpose, purpose: 'write' },
          },
        },
      ],
    }).teamCredentialBindings).toHaveLength(2);
    expect(SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse({
      ...patch,
      teamCredentialBindings: [binding, connectedBinding],
    }).success).toBe(false);
  });
});
