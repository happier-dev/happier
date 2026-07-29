import { describe, expect, it } from 'vitest';

import {
  CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
  CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
  CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
  EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
  EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
  PENDING_INPUT_PROTOCOL_VERSION_V1,
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  ClientCompatibilityCapabilitiesV1Schema,
  ClientCompatibilityDeclarationV1Schema,
  ExternalSessionImportServerContractV1Schema,
  PendingInputServerContractV1Schema,
  SessionSyncPendingInputCompatibilityPingAckV1Schema,
  SessionSyncServerRequirementsV1Schema,
  buildClientCompatibilityHttpHeadersV1,
} from './index.js';

describe('client compatibility protocol contracts', () => {
  it('owns independent Runtime Activity, Pending-input, and external-session import thresholds', () => {
    expect(SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY).toBe(2);
    expect(CURRENT_SESSION_SYNC_PROTOCOL_VERSION).toBe(2);
    expect(PENDING_INPUT_PROTOCOL_VERSION_V1).toBe(1);
    expect(CURRENT_PENDING_INPUT_PROTOCOL_VERSION).toBe(1);
    expect(EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1).toBe(1);
    expect(EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3).toBe(3);
    expect(CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION).toBe(3);
    const requirements = SessionSyncServerRequirementsV1Schema.parse({
      v: 1,
      enforcement: 'observe',
      minimumSessionSyncProtocolVersion: 1,
      currentSessionSyncProtocolVersion: 2,
      declarationTransport: 'headers-v1',
      minimumVersionsByClientKind: {
        daemon: '0.2.10',
        'session-runner': '0.2.10-preview.1',
      },
      upgradeUrlsByClientKind: {
        daemon: 'https://app.happier.dev/update?client=daemon',
        'session-runner': 'https://app.happier.dev/update?client=session-runner',
      },
    });
    const pendingInput = PendingInputServerContractV1Schema.parse({
      currentPendingInputProtocolVersion: 1,
    });
    const externalSessionImport = ExternalSessionImportServerContractV1Schema.parse({
      currentPublicationFenceVersion: 1,
    });
    expect(ClientCompatibilityCapabilitiesV1Schema.parse({
      v: 1,
      sessionSync: requirements,
      pendingInput,
      externalSessionImport,
    })).toBeTruthy();
    expect(SessionSyncPendingInputCompatibilityPingAckV1Schema.parse({
      v: 1,
      compatibility: { v: 1, sessionSync: requirements, pendingInput, externalSessionImport },
    })).toBeTruthy();
  });

  it('keeps older envelopes readable but rejects malformed Pending-input members', () => {
    const sessionSync = SessionSyncServerRequirementsV1Schema.parse({
      v: 1,
      enforcement: 'observe',
      minimumSessionSyncProtocolVersion: 1,
      currentSessionSyncProtocolVersion: 2,
      declarationTransport: 'headers-v1',
    });
    expect(ClientCompatibilityCapabilitiesV1Schema.safeParse({ v: 1, sessionSync }).success).toBe(true);
    expect(ClientCompatibilityCapabilitiesV1Schema.safeParse({
      v: 1,
      sessionSync,
      pendingInput: {},
    }).success).toBe(false);
    expect(ClientCompatibilityCapabilitiesV1Schema.safeParse({
      v: 1,
      sessionSync,
      externalSessionImport: {},
    }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({
      ...sessionSync,
      minimumVersionsByClientKind: { browser: '0.2.10' },
    }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({
      ...sessionSync,
      upgradeUrlsByClientKind: { daemon: 'http://app.happier.dev/update' },
    }).success).toBe(false);
  });

  it('accepts one strict current client declaration', () => {
    const declaration = ClientCompatibilityDeclarationV1Schema.parse({
      v: 1,
      clientKind: 'session-runner',
      appVersion: '0.2.10',
      sessionSyncProtocolVersion: 2,
    });
    expect(declaration).toMatchObject({ clientKind: 'session-runner', sessionSyncProtocolVersion: 2 });
    expect(buildClientCompatibilityHttpHeadersV1(declaration)).toMatchObject({
      'x-happier-client-kind': 'session-runner',
      'x-happier-session-sync-protocol': '2',
    });
  });
});
