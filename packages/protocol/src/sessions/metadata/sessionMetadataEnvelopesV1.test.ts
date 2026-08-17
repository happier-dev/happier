import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import { decodeBase64 } from '../../crypto/base64.js';
import {
  projectExternalSessionOperationSharedPresentationV1,
  projectExternalSessionOperationProgressV1,
  resolveExternalSessionOperationTimelineV1,
} from '../external/operationV1.js';
import {
  buildLinkedExternalSessionMetadataV1,
  resolveLinkedExternalSessionMetadataV1,
} from '../external/linkedSessionMetadata.js';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SESSION_OWNER_METADATA_VERSION_V1,
  SESSION_SHARED_METADATA_VERSION_V1,
  SessionMetadataActiveConflictV1Schema,
  SessionMetadataEnvelopeTupleV1Schema,
  SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
  SessionMetadataInactiveModelIntentPatchV1Schema,
  SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
  SessionMetadataInactiveModelIntentExpectationV1Schema,
  SessionMetadataInactiveModelIntentVersionConflictV1Schema,
  SessionMetadataRecipientProjectionV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  SessionMetadataTuplePatchV1Schema,
  SessionMetadataVersionConflictV1Schema,
  SessionOwnerMetadataCiphertextV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionOwnerMetadataV1Schema,
  SessionSharedMetadataV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  encodeSessionOwnerMetadataEnvelopeV1,
  openSessionOwnerMetadataEnvelopeV1,
  isSessionOwnerMetadataCiphertextV1,
  openSessionOwnerMetadataV1,
  parseSessionOwnerMetadataEnvelopeV1,
  projectSessionMetadataAgentVocabularyWriteCompatibilityV1,
  projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1,
  rewrapSessionOwnerMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataV1,
  validateSessionOwnerMetadataEnvelopeForAccountModeV1,
} from './sessionMetadataEnvelopesV1.js';

function deterministicRandomBytes(seed: number): (length: number) => Uint8Array {
  let next = seed;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}

function material(byte: number): AccountScopedCryptoMaterial {
  return {
    type: 'dataKey',
    machineKey: Uint8Array.from({ length: 32 }, () => byte),
  };
}

function operationProgress() {
  const request = {
    v: 1 as const,
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'native-session-1',
      qualifiedIdentity: {
        v: 1 as const,
        agent: {
          pluginId: 'com.example.agent',
          localId: 'example',
        },
        source: {
          kind: 'jsonl',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      sourceGeneration: 'source-generation-1',
      contributionGeneration: 'contribution-generation-1',
    },
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  };
  return projectExternalSessionOperationProgressV1({
    v: 1,
    operationId: 'operation-1',
    revision: 1,
    request,
    status: 'running',
    phase: 'validating',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 10,
    updatedAtMs: 10,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'machine_only',
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
      },
    },
    bindings: { operationClaimId: 'private-claim-id' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 3 },
    fence: { kind: 'none' },
  });
}

function genericPluginRuntimeDescriptor() {
  return {
    v: 1,
    agentId: 'claude',
    agent: {
      backendMode: 'native',
      providerSessionId: 'claude-session-private',
      agentExtra: {
        owner: 'happier',
        schemaId: 'happier.pluginRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: {
          backendId: 'claude',
          agentId: 'claude',
          provenance: 'first_party',
          source: { kind: 'bundled' },
        },
      },
    },
  } as const;
}

function genericHostSessionRuntimeDescriptor(params: Readonly<{
  agentId?: string;
  backendId?: string;
  provenance?: 'first_party' | 'external' | 'configured';
}> = {}) {
  const agentId = params.agentId ?? 'claude';
  const backendId = params.backendId ?? agentId;
  return {
    v: 1,
    agentId,
    agent: {
      backendMode: 'native',
      providerSessionId: 'claude-session-private',
      agentExtra: {
        owner: 'happier',
        schemaId: 'happier.hostSessionRuntimeIdentity',
        v: 1,
        runtimeHandle: {
          backendId,
          agentId,
          provenance: params.provenance ?? 'first_party',
        },
      },
    },
  } as const;
}

// Prospective predecessor reader pinned from:
//   ../remote-dev HEAD fae505bdc6916b3c9fa7a67eac3c4c88df759e9b
//   apps/ui/sources/sync/domains/state/storageTypes.ts:29-306
// The real reader is a single top-level safeParse: any missing nested legacy
// identity or non-positive model window rejects the whole metadata object.
const RemoteDevScalarValueAtFae505Schema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const RemoteDevCatalogValueOptionAtFae505Schema = z.object({
  value: RemoteDevScalarValueAtFae505Schema,
  name: z.string(),
  description: z.string().optional(),
});
const RemoteDevModelOptionAtFae505Schema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.string(),
  currentValue: RemoteDevScalarValueAtFae505Schema,
  options: z.array(RemoteDevCatalogValueOptionAtFae505Schema).optional(),
});
const RemoteDevModelAtFae505Schema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  modelOptions: z.array(RemoteDevModelOptionAtFae505Schema).optional(),
});
const RemoteDevModeCatalogAtFae505Schema = z.object({
  v: z.literal(1),
  provider: z.string(),
  updatedAt: z.number(),
  currentModeId: z.string(),
  availableModes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
  })),
});
const RemoteDevModelCatalogAtFae505Schema = z.object({
  v: z.literal(1),
  provider: z.string(),
  updatedAt: z.number(),
  currentModelId: z.string(),
  availableModels: z.array(RemoteDevModelAtFae505Schema),
});
const RemoteDevConfigCatalogAtFae505Schema = z.object({
  v: z.literal(1),
  provider: z.string(),
  updatedAt: z.number(),
  configOptions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    type: z.string(),
    currentValue: RemoteDevScalarValueAtFae505Schema,
    options: z.array(RemoteDevCatalogValueOptionAtFae505Schema).optional(),
  })),
});
const RemoteDevRuntimeDescriptorAtFae505Schema = z.object({
  v: z.literal(1),
  providerId: z.string(),
  provider: z.object({
    backendMode: z.string().optional(),
    vendorSessionId: z.string().optional(),
    serverBaseUrl: z.string().optional(),
    serverBaseUrlExplicit: z.boolean().optional(),
    resumeStrategy: z.string().optional(),
    sessionFile: z.string().optional(),
    providerExtra: z.object({
      owner: z.string(),
      schemaId: z.string(),
      v: z.number().int().positive(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const RemoteDevMetadataReaderAtFae505Schema = z.object({
  path: z.string().nullish().transform((value) =>
    typeof value === 'string' ? value : ''),
  host: z.string().nullish().transform((value) =>
    typeof value === 'string' ? value : ''),
  agentRuntimeDescriptorV1:
    RemoteDevRuntimeDescriptorAtFae505Schema.optional(),
  handoffV1: z.object({
    v: z.literal(1),
    sourceMachineId: z.string(),
    targetMachineId: z.string(),
    providerId: z.string(),
    sessionStorageBefore: z.enum(['direct', 'persisted']),
    sessionStorageAfter: z.enum(['direct', 'persisted']),
    transportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
    completedAtMs: z.number(),
    sourceWorkspaceRootPath: z.string().optional(),
    targetWorkspaceRootPath: z.string().optional(),
  }).optional(),
  acpHistoryImportV1: z.object({
    v: z.literal(1),
    provider: z.string(),
    remoteSessionId: z.string(),
    importedAt: z.number(),
    lastImportedFingerprint: z.string().optional(),
  }).optional(),
  acpSessionModesV1: RemoteDevModeCatalogAtFae505Schema.optional(),
  sessionModesV1: RemoteDevModeCatalogAtFae505Schema.optional(),
  acpSessionModelsV1: RemoteDevModelCatalogAtFae505Schema.optional(),
  sessionModelsV1: RemoteDevModelCatalogAtFae505Schema.optional(),
  acpConfigOptionsV1: RemoteDevConfigCatalogAtFae505Schema.optional(),
  sessionConfigOptionsV1: RemoteDevConfigCatalogAtFae505Schema.optional(),
  forkV1: z.object({
    v: z.literal(1),
    parentSessionId: z.string(),
    parentCutoffSeqInclusive: z.number(),
    createdAtMs: z.number(),
    strategy: z.string(),
    providerHint: z.object({
      providerId: z.string().optional(),
      backendMode: z.string().optional(),
      vendorSessionId: z.string().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

describe('session metadata privacy envelopes v1', () => {
  it('normalizes deployed Antigravity runtime identity through the host owner projection', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'antigravity',
          provider: {
            runtimeMode: 'cliPrint',
            providerSessionId: 'stale-cli-conversation',
            providerExtra: {
              owner: 'antigravity',
              schemaId: 'antigravity.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                runtimeMode: 'sdk',
                providerSessionId: 'localharness-session-1',
                localharnessSessionId: 'localharness-session-1',
              },
            },
          },
        },
      },
    });

    expect(created).toMatchObject({
      ok: true,
      ownerMetadata: {
        nativeSession: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'antigravity',
            runtimeMode: 'sdk',
            providerSessionId: 'localharness-session-1',
            localharnessSessionId: 'localharness-session-1',
          },
        },
      },
    });
    if (!created.ok) return;
    expect(projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: created.ownerMetadata,
    })).toMatchObject({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'antigravity',
        agent: {
          runtimeMode: 'sdk',
          providerSessionId: 'localharness-session-1',
          localharnessSessionId: 'localharness-session-1',
        },
      },
    });
  });

  it('admits only the exact canonical padded Base64 spelling of kind-10 ciphertext', () => {
    const canonicalCiphertext =
      'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==';
    const caseOnlyDistinctCiphertext =
      'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGdb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==';
    const lenientAliases = [
      `${canonicalCiphertext}\n`,
      `${canonicalCiphertext.slice(0, 12)}!${canonicalCiphertext.slice(12)}`,
      canonicalCiphertext.slice(0, -2),
      `${canonicalCiphertext.slice(0, -3)}B==`,
    ];

    expect(isSessionOwnerMetadataCiphertextV1(canonicalCiphertext)).toBe(true);
    expect(SessionOwnerMetadataCiphertextV1Schema.safeParse(canonicalCiphertext).success)
      .toBe(true);
    expect(isSessionOwnerMetadataCiphertextV1(caseOnlyDistinctCiphertext))
      .toBe(true);
    expect(SessionOwnerMetadataCiphertextV1Schema.safeParse(
      caseOnlyDistinctCiphertext,
    ).success).toBe(true);
    expect(caseOnlyDistinctCiphertext).not.toBe(canonicalCiphertext);
    expect(caseOnlyDistinctCiphertext.toLowerCase())
      .toBe(canonicalCiphertext.toLowerCase());

    for (const alias of lenientAliases) {
      expect(decodeBase64(alias, 'base64'))
        .toEqual(decodeBase64(canonicalCiphertext, 'base64'));
      expect(isSessionOwnerMetadataCiphertextV1(alias)).toBe(false);
      expect(SessionOwnerMetadataCiphertextV1Schema.safeParse(alias).success)
        .toBe(false);
    }
  });

  it('opens only the explicit Session owner-envelope branch', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/workspace',
        machineId: 'machine-1',
      },
    });
    const plain = createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const encrypted = sealSessionOwnerMetadataEnvelopeV1({
      material: material(6),
      ownerMetadata,
      randomBytes: deterministicRandomBytes(1),
    });

    expect(SessionOwnerMetadataEnvelopeV1Schema.parse(plain)).toEqual(plain);
    expect(SessionOwnerMetadataEnvelopeV1Schema.parse(encrypted))
      .toEqual(encrypted);
    expect(parseSessionOwnerMetadataEnvelopeV1(
      encodeSessionOwnerMetadataEnvelopeV1(plain),
    )).toEqual(plain);
    expect(parseSessionOwnerMetadataEnvelopeV1(
      encodeSessionOwnerMetadataEnvelopeV1(encrypted),
    )).toEqual(encrypted);
    expect(parseSessionOwnerMetadataEnvelopeV1(encrypted.c)).toBeNull();
    expect(parseSessionOwnerMetadataEnvelopeV1(
      JSON.stringify(encrypted.c),
    )).toBeNull();
    expect(parseSessionOwnerMetadataEnvelopeV1(
      JSON.stringify({ ...plain, privateBag: {} }),
    )).toBeNull();
    expect(parseSessionOwnerMetadataEnvelopeV1(JSON.stringify({
      ciphertext: encrypted.c,
    }))).toBeNull();
    expect(parseSessionOwnerMetadataEnvelopeV1('not-json')).toBeNull();
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse(encrypted.c).success)
      .toBe(false);
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: plain,
    })).toEqual({ ok: true, ownerMetadata });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
    })).toEqual({ ok: false, reason: 'material_unavailable' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
      material: material(6),
    })).toEqual({ ok: true, ownerMetadata });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
      material: material(7),
    })).toEqual({ ok: false, reason: 'invalid_ciphertext' });
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse({
      ...plain,
      c: encrypted.c,
    }).success).toBe(false);
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse({
      ...encrypted,
      v: ownerMetadata,
    }).success).toBe(false);
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'not-owner-metadata-ciphertext',
    }).success).toBe(false);
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse({
      t: 'plain',
      v: {
        ...ownerMetadata,
        privateBag: {},
      },
    }).success).toBe(false);
    expect(SessionOwnerMetadataEnvelopeV1Schema.safeParse({
      ciphertext: encrypted.c,
    }).success).toBe(false);
  });

  it('uses Account mode, independently of Session mode, as owner-envelope authority', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/workspace',
        machineId: 'machine-1',
      },
    });
    const plain = createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const encrypted = sealSessionOwnerMetadataEnvelopeV1({
      material: material(6),
      ownerMetadata,
      randomBytes: deterministicRandomBytes(1),
    });

    // Account plain + Session E2EE: owner metadata remains Account-scoped plain.
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: plain,
    })).toEqual({ ok: true, ownerMetadata });

    // Account E2EE + Session plain: owner metadata remains Account-scoped encrypted.
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
      material: material(6),
    })).toEqual({ ok: true, ownerMetadata });

    expect(validateSessionOwnerMetadataEnvelopeForAccountModeV1({
      accountMode: 'plain',
      envelope: encrypted,
    })).toEqual({ ok: false, reason: 'account_mode_mismatch' });
    expect(validateSessionOwnerMetadataEnvelopeForAccountModeV1({
      accountMode: 'e2ee',
      envelope: plain,
    })).toEqual({ ok: false, reason: 'account_mode_mismatch' });
    expect(validateSessionOwnerMetadataEnvelopeForAccountModeV1({
      accountMode: 'plain',
      envelope: { t: 'plain', v: { ...ownerMetadata, privateBag: {} } },
    })).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: { t: 'plain', v: { ...ownerMetadata, privateBag: {} } },
    })).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: encrypted,
      material: material(6),
    })).toEqual({ ok: false, reason: 'account_mode_mismatch' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: plain,
    })).toEqual({ ok: false, reason: 'account_mode_mismatch' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
    })).toEqual({ ok: false, reason: 'material_unavailable' });
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: encrypted,
      material: material(7),
    })).toEqual({ ok: false, reason: 'invalid_ciphertext' });
  });

  it('persists only the canonical applied startup-instructions marker', () => {
    const canonicalOwnerMetadata = {
      v: 1,
      system: {
        voiceAgentStartupInstructionsV1: {
          v: 1,
          id: 'happier.global_voice_agent',
          revision: 1,
        },
      },
    } as const;

    expect(SessionOwnerMetadataV1Schema.parse(canonicalOwnerMetadata))
      .toEqual(canonicalOwnerMetadata);
    expect(SessionOwnerMetadataV1Schema.safeParse({
      ...canonicalOwnerMetadata,
      system: {
        voiceAgentStartupInstructionsV1: {
          ...canonicalOwnerMetadata.system.voiceAgentStartupInstructionsV1,
          revision: 0,
        },
      },
    }).success).toBe(false);
    expect(SessionOwnerMetadataV1Schema.safeParse({
      ...canonicalOwnerMetadata,
      system: {
        voiceAgentStartupInstructionsV1: {
          ...canonicalOwnerMetadata.system.voiceAgentStartupInstructionsV1,
          id: 'Happier Voice',
        },
      },
    }).success).toBe(false);
  });

  it('strictly owns the layout-v1 persisted tuple and PATCH transport shapes', () => {
    const ownerCiphertext = sealSessionOwnerMetadataV1({
      material: material(6),
      ownerMetadata: { v: 1 },
      randomBytes: deterministicRandomBytes(1),
    });
    const tuple = {
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: 'shared-ciphertext',
        version: 3,
      },
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
      agentState: {
        ciphertext: null,
        version: 5,
      },
    } as const;
    expect(SessionMetadataEnvelopeTupleV1Schema.parse(tuple)).toEqual(tuple);
    expect(SessionMetadataEnvelopeTupleV1Schema.parse({
      ...tuple,
      ownerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
    })).toEqual({
      ...tuple,
      ownerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
    });
    expect(SessionMetadataEnvelopeTupleV1Schema.safeParse({
      ...tuple,
      metadataLayoutVersion: 2,
    }).success).toBe(false);
    expect(SessionMetadataEnvelopeTupleV1Schema.safeParse({
      ...tuple,
      ownerMetadata: {
        ...tuple.ownerMetadata,
        version: 3,
      },
    }).success).toBe(false);
    expect(SessionMetadataEnvelopeTupleV1Schema.safeParse({
      ...tuple,
      ownerMetadata: {
        ciphertext: ownerCiphertext,
      },
    }).success).toBe(false);

    const ownerPatch = {
      mode: 'owner',
      metadataLayoutVersion: 1,
      publisherPrecondition: {
        machineId: 'machine-1',
        committedFenceMs: 1_000,
      },
      expectedOwnerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
      sharedMetadata: {
        ciphertext: 'next-shared-ciphertext',
        expectedVersion: 3,
      },
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
      agentState: {
        ciphertext: 'next-agent-state-ciphertext',
        expectedVersion: 5,
      },
    } as const;
    const sharedEditorPatch = {
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: 'editor-shared-ciphertext',
        expectedVersion: 3,
      },
    } as const;
    expect(SessionMetadataTuplePatchV1Schema.parse(ownerPatch))
      .toEqual(ownerPatch);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...ownerPatch,
      publisherPrecondition: {
        ...ownerPatch.publisherPrecondition,
        reusablePermit: true,
      },
    }).success).toBe(false);
    const {
      expectedOwnerMetadata: _missingExpectedOwnerMetadata,
      ...ownerPatchWithoutExpectedOwnerMetadata
    } = ownerPatch;
    expect(SessionMetadataTuplePatchV1Schema.safeParse(
      ownerPatchWithoutExpectedOwnerMetadata,
    ).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...ownerPatch,
      expectedOwnerMetadataCiphertext: ownerCiphertext,
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.parse(sharedEditorPatch))
      .toEqual(sharedEditorPatch);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...sharedEditorPatch,
      ownerMetadata: { ciphertext: 'must-not-be-observable' },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...sharedEditorPatch,
      agentState: { ciphertext: null, expectedVersion: 5 },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...sharedEditorPatch,
      publisherPrecondition: ownerPatch.publisherPrecondition,
    }).success).toBe(false);
  });

  it('admits the inactive-model-intent expectation only on owner metadata patches', () => {
    const ownerCiphertext = sealSessionOwnerMetadataV1({
      material: material(6),
      ownerMetadata: { v: 1 },
      randomBytes: deterministicRandomBytes(1),
    });
    const sessionExpectation = {
      kind: 'inactive_model_intent',
    } as const;
    const ownerPatch = {
      mode: 'owner_inactive_model_intent',
      metadataLayoutVersion: 1,
      sessionExpectation,
      expectedOwnerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
      sharedMetadata: {
        ciphertext: 'next-shared-ciphertext',
        expectedVersion: 3,
      },
      ownerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
      agentState: {
        ciphertext: null,
        expectedVersion: 5,
      },
    } as const;

    expect(
      SessionMetadataInactiveModelIntentExpectationV1Schema.parse(
        sessionExpectation,
      ),
    ).toEqual(sessionExpectation);
    expect(
      SessionMetadataInactiveModelIntentOwnerPatchV1Schema.parse(ownerPatch),
    ).toEqual(ownerPatch);
    expect(
      SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse({
        ...ownerPatch,
        publisherPrecondition: {
          machineId: 'machine-1',
          committedFenceMs: 1_000,
        },
      }).success,
    ).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse(ownerPatch).success)
      .toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...ownerPatch,
      mode: 'owner',
    }).success).toBe(false);
    expect(
      SessionMetadataInactiveModelIntentExpectationV1Schema.safeParse({
        ...sessionExpectation,
        active: false,
      }).success,
    ).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      sessionExpectation,
      sharedMetadata: {
        ciphertext: 'editor-shared-ciphertext',
        expectedVersion: 3,
      },
    }).success).toBe(false);

    const conditionedLegacyPatch = {
      inactiveModelIntent: {
        metadata: {
          ciphertext: 'legacy-model-intent-ciphertext',
          expectedVersion: 3,
        },
        sessionExpectation,
      },
    } as const;
    expect(
      SessionMetadataInactiveModelIntentPatchV1Schema.parse(
        conditionedLegacyPatch,
      ),
    ).toEqual(conditionedLegacyPatch);
    expect(SessionMetadataInactiveModelIntentPatchV1Schema.safeParse({
      ...conditionedLegacyPatch,
      metadata: conditionedLegacyPatch.inactiveModelIntent.metadata,
    }).success).toBe(false);

    const releasedLegacyPatchSchema = z.object({
      metadata: z.object({
        ciphertext: z.string(),
        expectedVersion: z.number(),
      }).optional(),
      agentState: z.object({
        ciphertext: z.string().nullable(),
        expectedVersion: z.number(),
      }).optional(),
    });
    expect(releasedLegacyPatchSchema.parse(conditionedLegacyPatch))
      .toEqual({});
  });

  it('admits only the exact complete layout-zero owner migration tuple', () => {
    const ownerCiphertext = sealSessionOwnerMetadataV1({
      material: material(6),
      ownerMetadata: { v: 1 },
      randomBytes: deterministicRandomBytes(1),
    });
    const migrationPatch = {
      mode: 'owner_migration',
      expectedAccountEncryptionMode: 'e2ee',
      expectedAccountContentPublicKeyFingerprint:
        'content-public-key-sha256:b6e2f1b418486b2714dd42bc21bffd2a9099e988572c4885713e19923cc774a6',
      source: {
        metadataLayoutVersion: 0,
        metadata: {
          version: 3,
          ciphertext: 'legacy-metadata-ciphertext',
        },
        ownerMetadata: null,
        agentState: {
          version: 5,
          ciphertext: null,
        },
      },
      target: {
        metadataLayoutVersion: 1,
        sharedMetadata: {
          ciphertext: 'shared-metadata-ciphertext',
        },
        ownerMetadata: {
          t: 'encrypted',
          c: ownerCiphertext,
        },
        agentState: {
          ciphertext: 'next-agent-state-ciphertext',
        },
      },
    } as const;

    expect(SessionMetadataTuplePatchV1Schema.parse(migrationPatch))
      .toEqual(migrationPatch);
    expect(SessionMetadataTuplePatchV1Schema.parse({
      ...migrationPatch,
      expectedAccountEncryptionMode: 'plain',
      expectedAccountContentPublicKeyFingerprint: null,
      target: {
        ...migrationPatch.target,
        ownerMetadata: {
          t: 'plain',
          v: { v: 1 },
        },
      },
    })).toEqual({
      ...migrationPatch,
      expectedAccountEncryptionMode: 'plain',
      expectedAccountContentPublicKeyFingerprint: null,
      target: {
        ...migrationPatch.target,
        ownerMetadata: {
          t: 'plain',
          v: { v: 1 },
        },
      },
    });
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      expectedAccountEncryptionMode: 'plain',
    }).success).toBe(false);
    const {
      expectedAccountEncryptionMode: _missingAccountMode,
      ...migrationWithoutAccountMode
    } = migrationPatch;
    expect(SessionMetadataTuplePatchV1Schema.safeParse(
      migrationWithoutAccountMode,
    ).success).toBe(false);
    const {
      expectedAccountContentPublicKeyFingerprint: _missingAccountFingerprint,
      ...migrationWithoutAccountFingerprint
    } = migrationPatch;
    expect(SessionMetadataTuplePatchV1Schema.safeParse(
      migrationWithoutAccountFingerprint,
    ).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      expectedAccountContentPublicKeyFingerprint:
        'content-public-key-sha256:not-canonical',
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      target: {
        ...migrationPatch.target,
        agentState: { ciphertext: null },
      },
    }).success).toBe(true);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      mode: 'owner',
    }).success).toBe(false);
    const {
      ownerMetadata: _missingSourceOwnerMetadata,
      ...sourceWithoutOwnerMetadata
    } = migrationPatch.source;
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      source: sourceWithoutOwnerMetadata,
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      source: {
        ...migrationPatch.source,
        ownerMetadata: ownerCiphertext,
      },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      source: {
        ...migrationPatch.source,
        metadataVersion: 3,
      },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      source: {
        ...migrationPatch.source,
        metadata: {
          ...migrationPatch.source.metadata,
          version: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    }).success).toBe(false);
    const {
      agentState: _missingTargetAgentState,
      ...targetWithoutAgentState
    } = migrationPatch.target;
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      target: targetWithoutAgentState,
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      target: {
        ...migrationPatch.target,
        sharedMetadata: {
          ...migrationPatch.target.sharedMetadata,
          version: 4,
        },
      },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      target: {
        ...migrationPatch.target,
        metadata: { ciphertext: 'former-target-name' },
      },
    }).success).toBe(false);
    expect(SessionMetadataTuplePatchV1Schema.safeParse({
      ...migrationPatch,
      target: {
        ...migrationPatch.target,
        ownerMetadata: {
          t: 'encrypted',
          c: 'not-owner-metadata-ciphertext',
        },
      },
    }).success).toBe(false);
  });

  it('admits exactly owner-full or participant/public null-state recipient projections', () => {
    const ownerCiphertext = sealSessionOwnerMetadataV1({
      material: material(6),
      ownerMetadata: { v: 1 },
      randomBytes: deterministicRandomBytes(1),
    });
    const sharedProjection = {
      metadata: 'shared-ciphertext',
      metadataVersion: 3,
      metadataLayoutVersion: 1,
      agentState: null,
      agentStateVersion: 5,
    } as const;
    const ownerProjection = {
      ...sharedProjection,
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
      agentState: null,
      agentStateVersion: 5,
    } as const;

    expect(SessionMetadataRecipientProjectionV1Schema.parse(ownerProjection))
      .toEqual(ownerProjection);
    expect(SessionMetadataRecipientProjectionV1Schema.parse({
      ...ownerProjection,
      ownerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
    })).toEqual({
      ...ownerProjection,
      ownerMetadata: {
        t: 'encrypted',
        c: ownerCiphertext,
      },
    });
    expect(SessionMetadataRecipientProjectionV1Schema.parse(sharedProjection))
      .toEqual(sharedProjection);
    expect(sharedProjection).not.toHaveProperty('ownerMetadata');
    expect(SessionMetadataRecipientProjectionV1Schema.safeParse({
      metadata: sharedProjection.metadata,
      metadataVersion: sharedProjection.metadataVersion,
      metadataLayoutVersion: sharedProjection.metadataLayoutVersion,
    }).success).toBe(false);
    expect(SessionMetadataRecipientProjectionV1Schema.safeParse({
      ...sharedProjection,
      agentState: 'must-not-reach-a-shared-recipient',
    }).success).toBe(false);
    expect(SessionMetadataRecipientProjectionV1Schema.safeParse({
      ...sharedProjection,
      privateMetadata: 'must-not-be-observable',
    }).success).toBe(false);
  });

  it('freezes the flat recipient-safe tuple version-conflict response', () => {
    const success = {
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 },
      agentState: { version: 6 },
    } as const;
    expect(SessionMetadataTuplePatchSuccessV1Schema.parse(success))
      .toEqual(success);
    expect(SessionMetadataTuplePatchSuccessV1Schema.safeParse({
      ...success,
      ownerMetadata: { version: 4 },
    }).success).toBe(false);

    const conflict = {
      code: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 3 },
      agentState: { version: 5 },
    } as const;
    expect(SessionMetadataVersionConflictV1Schema.parse(conflict))
      .toEqual(conflict);
    expect(SessionMetadataVersionConflictV1Schema.parse({
      code: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 3 },
    })).toEqual({
      code: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 3 },
    });
    expect(SessionMetadataVersionConflictV1Schema.safeParse({
      ...conflict,
      ownerMetadata: { version: 3 },
    }).success).toBe(false);
    expect(SessionMetadataVersionConflictV1Schema.safeParse({
      code: 'session_metadata_version_conflict',
      current: {
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 3 },
      },
    }).success).toBe(false);

    const activeConflict = {
      code: 'session_active',
    } as const;
    expect(SessionMetadataActiveConflictV1Schema.parse(activeConflict))
      .toEqual(activeConflict);
    expect(SessionMetadataActiveConflictV1Schema.safeParse({
      ...activeConflict,
      active: true,
    }).success).toBe(false);
  });

  it('strictly owns conditioned layout-zero success and conflict responses', () => {
    const success = {
      success: true,
      metadata: { version: 4 },
    } as const;
    expect(
      SessionMetadataInactiveModelIntentPatchSuccessV1Schema.parse(success),
    ).toEqual(success);
    expect(
      SessionMetadataInactiveModelIntentPatchSuccessV1Schema.safeParse({
        ...success,
        metadata: {
          ...success.metadata,
          value: 'must-not-appear-on-success',
        },
      }).success,
    ).toBe(false);

    const conflict = {
      success: false,
      error: 'version-mismatch',
      metadata: {
        version: 4,
        value: 'current-owner-ciphertext',
      },
    } as const;
    expect(
      SessionMetadataInactiveModelIntentVersionConflictV1Schema.parse(
        conflict,
      ),
    ).toEqual(conflict);
    expect(
      SessionMetadataInactiveModelIntentVersionConflictV1Schema.safeParse({
        ...conflict,
        agentState: {
          version: 7,
          value: 'must-not-appear',
        },
      }).success,
    ).toBe(false);
    expect(
      SessionMetadataInactiveModelIntentVersionConflictV1Schema.safeParse({
        ...conflict,
        metadata: {
          ...conflict.metadata,
          ownerMetadata: 'must-not-appear',
        },
      }).success,
    ).toBe(false);
  });

  it('strictly projects shared and owner envelopes into a local-only owner compatibility view', () => {
    const completeProgress = operationProgress();
    const sharedPresentation =
      projectExternalSessionOperationSharedPresentationV1(completeProgress);
    const sharedMetadata = {
      v: 1,
      summary: { text: 'Safe title', updatedAt: 10 },
      agentPresentation: { agentId: 'codex' },
      externalSessionOperationPresentationV1: sharedPresentation,
      publicAgentState: {
        completedRequests: {
          request_1: {
            tool: 'permission',
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
          },
        },
      },
    } as const;
    const ownerMetadata = {
      v: 1,
      workspace: {
        path: '/private/workspace',
        machineId: 'private-machine',
      },
      nativeSession: {
        codexSessionId: 'private-native-session',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          backendMode: 'appServer',
          providerSessionId: 'private-native-session',
        },
      },
      runtime: {
        permissionMode: 'default',
        externalSessionOperationV1: {
          v: 1,
          progress: completeProgress,
        },
      },
    } as const;
    const sharedBefore = structuredClone(sharedMetadata);
    const ownerBefore = structuredClone(ownerMetadata);

    expect(projectSessionOwnerCompatibilityViewV1({
      sharedMetadata,
      ownerMetadata,
    })).toEqual({
      path: '/private/workspace',
      host: '',
      homeDir: '',
      happyHomeDir: '',
      happyLibDir: '',
      happyToolsDir: '',
      summary: { text: 'Safe title', updatedAt: 10 },
      agentPresentation: { agentId: 'codex' },
      externalSessionOperationPresentationV1: sharedPresentation,
      externalSessionOperationV1: {
        v: 1,
        progress: completeProgress,
      },
      machineId: 'private-machine',
      codexSessionId: 'private-native-session',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'private-native-session',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'private-native-session',
        },
      },
      permissionMode: 'default',
    });
    expect(sharedMetadata).toEqual(sharedBefore);
    expect(ownerMetadata).toEqual(ownerBefore);
    expect(() => projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: {
        ...sharedMetadata,
        path: '/injected-private-path',
      },
      ownerMetadata,
    })).toThrow();
    expect(() => projectSessionOwnerCompatibilityViewV1({
      sharedMetadata,
      ownerMetadata: {
        ...ownerMetadata,
        futurePrivateAuthority: 'must-not-drop',
      },
    })).toThrow();
  });

  it('strictly rejects unknown or private-looking fields at both envelope boundaries', () => {
    expect(SessionSharedMetadataV1Schema.safeParse({
      v: 1,
      summary: { text: 'Safe title', updatedAt: 1 },
      path: '/private/workspace',
    }).success).toBe(false);
    expect(SessionSharedMetadataV1Schema.safeParse({
      v: 1,
      agentState: { requests: {} },
    }).success).toBe(false);
    expect(SessionOwnerMetadataV1Schema.safeParse({
      v: 1,
      workspace: { path: '/private/workspace' },
      futurePrivateAuthority: 'must-not-pass-through',
    }).success).toBe(false);
  });

  it('rejects a shared public Agent-state projection with more than 2,048 completion facts', () => {
    const completedRequests = Object.fromEntries(
      Array.from({ length: 2_049 }, (_, index) => [
        `request-${index}`,
        {
          tool: 'Read',
          createdAt: index,
          completedAt: index + 1,
          status: 'approved' as const,
        },
      ]),
    );

    expect(SessionSharedMetadataV1Schema.safeParse({
      v: 1,
      publicAgentState: { completedRequests },
    }).success).toBe(false);
  });

  it('allowlists only recipient-safe title, Agent presentation, operation presentation, and transcript completion facts', () => {
    const progress = operationProgress();
    const presentation =
      projectExternalSessionOperationSharedPresentationV1(progress);
    const projected = projectSessionSharedMetadataV1({
      metadata: {
        path: '/Users/alice/secret-project',
        host: 'alice-private-host',
        machineId: 'machine-private',
        claudeSessionId: 'native-private',
        externalSessionV1: {
          v: 1,
          remoteSessionId: 'native-private',
          linkData: { sourcePath: '/private/transcript.jsonl' },
        },
        directSessionV1: {
          v: 1,
          remoteSessionId: 'prospective-private',
          machineId: 'machine-private',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'claude',
          agent: {
            providerSessionId: 'private-native-id',
            agentExtra: {
              owner: 'private-owner',
              schemaId: 'private-schema',
              v: 1,
              sourcePath: '/private/runtime.json',
            },
          },
        },
        summary: { text: 'Canonical title', updatedAt: 20 },
        externalSessionOperationV1: { v: 1, progress },
        externalSessionOperationPresentationV1: {
          ...presentation,
          ownerEvidence: 'must-not-cross',
        },
        futurePrivateAuthority: { token: 'never-forward' },
      },
      agentState: {
        controlledByUser: true,
        capabilities: { inFlightSteerSupported: true },
        requests: {
          pending: {
            tool: 'Bash',
            arguments: { command: 'cat ~/.ssh/id_ed25519' },
            createdAt: 21,
          },
        },
        completedRequests: {
          done: {
            tool: 'Write',
            kind: 'permission',
            arguments: { path: '/private/secret.txt', content: 'secret' },
            createdAt: 22,
            completedAt: 23,
            status: 'approved',
            responseTarget: { kind: 'private-router', id: 'private-target' },
          },
          malformed: {
            tool: 'Read',
            completedAt: 'not-a-number',
            status: 'approved',
          },
        },
        futurePrivateAgentState: { value: 'never-forward' },
      },
    });

    expect(projected).toEqual({
      v: 1,
      summary: { text: 'Canonical title', updatedAt: 20 },
      agentPresentation: { agentId: 'claude' },
      externalSessionOperationPresentationV1: presentation,
      publicAgentState: {
        completedRequests: {
          done: {
            tool: 'Write',
            kind: 'permission',
            createdAt: 22,
            completedAt: 23,
            status: 'approved',
          },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /secret-project|private-host|machine-private|native-private|prospective-private|private-native-id|private-claim-id|operationClaimId|canonicalOwnerEvidence|linkedSessionRevision|ownerEvidence|id_ed25519|secret\.txt|private-router|never-forward/,
    );
    expect(SESSION_METADATA_LAYOUT_VERSION_V1).toBe(1);
    expect(SESSION_SHARED_METADATA_VERSION_V1).toBe(1);
    expect(SESSION_OWNER_METADATA_VERSION_V1).toBe(1);
  });

  it('never derives a public title from path or arbitrary legacy name fields', () => {
    expect(projectSessionSharedMetadataV1({
      metadata: {
        path: '/private/workspace/derived-title',
        name: 'non-canonical-native-name',
      },
    })).toEqual({ v: 1 });
  });

  it('derives only a bounded Agent id across current and predecessor link metadata precedence', () => {
    expect(projectSessionSharedMetadataV1({
      metadata: {
        externalSessionV1: {
          agentId: 'codex',
          remoteSessionId: 'private-native-id',
          linkData: { sourcePath: '/private/source.jsonl' },
        },
      },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'codex' },
    });

    expect(projectSessionSharedMetadataV1({
      metadata: {
        directSessionV1: {
          providerId: 'claude',
          remoteSessionId: 'private-native-id',
          machineId: 'private-machine',
        },
      },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'claude' },
    });

    expect(projectSessionSharedMetadataV1({
      metadata: {
        agentRuntimeDescriptorV1: {
          providerId: 'opencode',
          provider: { providerSessionId: 'private-native-id' },
        },
      },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'opencode' },
    });

    expect(projectSessionSharedMetadataV1({
      metadata: {
        runtimeDescriptorV1: { agentId: 'pi' },
        externalSessionV1: { agentId: 'codex' },
        directSessionV1: { providerId: 'claude' },
        flavor: 'gpt',
      },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'pi' },
    });

    expect(projectSessionSharedMetadataV1({
      metadata: { flavor: ' GPT ' },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'codex' },
    });
    expect(projectSessionSharedMetadataV1({
      metadata: { flavor: 'customAcp' },
    })).toEqual({ v: 1 });
    expect(projectSessionSharedMetadataV1({
      metadata: { claudeSessionId: 'native-claude-private' },
    })).toEqual({
      v: 1,
      agentPresentation: { agentId: 'claude' },
    });
  });

  it('projects modeled private facts into strict owner categories without a raw carrier', () => {
    const metadata = {
      path: '/private/workspace',
      host: 'private-host',
      machineId: 'machine-1',
      workspaceId: 'workspace-private',
      codexSessionId: 'native-1',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'native-1',
        },
      },
    };
    const created = createSessionOwnerMetadataV1({ metadata });
    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        workspace: {
          path: '/private/workspace',
          host: 'private-host',
          machineId: 'machine-1',
          workspaceId: 'workspace-private',
        },
        nativeSession: {
          codexSessionId: 'native-1',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            backendMode: 'appServer',
            providerSessionId: 'native-1',
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain('metadataJson');
  });

  it('uses generated strict descriptor readers for every current and predecessor carrier', () => {
    const descriptors = [
      {
        expectedAgentId: 'codex',
        value: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'codex-current-private',
            agentExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'appServer',
                providerSessionId: 'codex-current-private',
              },
            },
          },
        },
      },
      {
        expectedAgentId: 'codex',
        value: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'mcp',
            vendorSessionId: 'codex-predecessor-private',
            providerExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeAffinity: {
                backendMode: 'mcp',
                vendorSessionId: 'codex-predecessor-private',
              },
            },
          },
        },
      },
      {
        expectedAgentId: 'opencode',
        value: {
          v: 1,
          agentId: 'opencode',
          agent: {
            backendMode: 'server',
            providerSessionId: 'opencode-current-private',
            agentExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                providerSessionId: 'opencode-current-private',
              },
            },
          },
        },
      },
      {
        expectedAgentId: 'opencode',
        value: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'acp',
            vendorSessionId: 'opencode-predecessor-private',
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'acp',
                vendorSessionId: 'opencode-predecessor-private',
              },
            },
          },
        },
      },
      {
        expectedAgentId: 'pi',
        value: {
          v: 1,
          agentId: 'pi',
          agent: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            providerSessionId: 'pi-current-private',
            sessionFile: '/private/pi-current.jsonl',
          },
        },
      },
      {
        expectedAgentId: 'pi',
        value: {
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileBySessionId',
            vendorSessionId: 'pi-predecessor-private',
            sessionFile: '/private/pi-predecessor.jsonl',
          },
        },
      },
    ] as const;

    for (const descriptor of descriptors) {
      const created = createSessionOwnerMetadataV1({
        metadata: { runtimeDescriptorV1: descriptor.value },
      });
      expect(created).toMatchObject({
        ok: true,
        ownerMetadata: {
          nativeSession: {
            runtimeDescriptorV1: {
              agentId: descriptor.expectedAgentId,
            },
          },
        },
      });
    }

    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            futurePrivateAuthority: 'must-not-drop',
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('projects the canonical generic plugin runtime descriptor without carrying its source envelope', () => {
    const descriptor = genericPluginRuntimeDescriptor();

    expect(createSessionOwnerMetadataV1({
      metadata: { runtimeDescriptorV1: descriptor },
    })).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        nativeSession: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            backendMode: 'native',
            providerSessionId: 'claude-session-private',
            backendId: 'claude',
            provenance: 'first_party',
          },
        },
      },
    });
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          agent: {
            ...descriptor.agent,
            agentExtra: {
              ...descriptor.agent.agentExtra,
              runtimeHandle: {
                ...descriptor.agent.agentExtra.runtimeHandle,
                futurePrivateAuthority: 'must-not-drop',
              },
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          agent: {
            ...descriptor.agent,
            agentExtra: {
              ...descriptor.agent.agentExtra,
              runtimeHandle: {
                ...descriptor.agent.agentExtra.runtimeHandle,
                source: {
                  ...descriptor.agent.agentExtra.runtimeHandle.source,
                  futurePrivateAuthority: 'must-not-drop',
                },
              },
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('projects the exact host-session runtime identity envelope and rejects widened host authority', () => {
    const descriptor = genericHostSessionRuntimeDescriptor();

    const created = createSessionOwnerMetadataV1({
      metadata: { runtimeDescriptorV1: descriptor },
    });
    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        nativeSession: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            backendMode: 'native',
            providerSessionId: 'claude-session-private',
            backendId: 'claude',
            provenance: 'first_party',
          },
        },
      },
    });
    if (!created.ok) throw new Error('expected canonical host-session owner metadata');
    const compatibilityView = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: created.ownerMetadata,
    });
    const reparsed = createSessionOwnerMetadataV1({
      metadata: compatibilityView,
    });
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('expected reparsed host-session owner metadata');
    expect(reparsed.ownerMetadata.nativeSession?.runtimeDescriptorV1)
      .toEqual(created.ownerMetadata.nativeSession?.runtimeDescriptorV1);
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          agent: {
            ...descriptor.agent,
            agentExtra: {
              ...descriptor.agent.agentExtra,
              runtimeHandle: {
                ...descriptor.agent.agentExtra.runtimeHandle,
                futurePrivateAuthority: 'must-not-drop',
              },
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          agentId: 'codex',
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('projects host-session runtime identity before generated Agent-native descriptor dispatch', () => {
    for (const agentId of ['codex', 'opencode', 'pi'] as const) {
      const descriptor = genericHostSessionRuntimeDescriptor({ agentId });

      expect(createSessionOwnerMetadataV1({
        metadata: { runtimeDescriptorV1: descriptor },
      })).toEqual({
        ok: true,
        ownerMetadata: {
          v: 1,
          nativeSession: {
            runtimeDescriptorV1: {
              v: 1,
              agentId,
              backendMode: 'native',
              providerSessionId: 'claude-session-private',
              backendId: agentId,
              provenance: 'first_party',
            },
          },
        },
      });
    }
  });

  it('reparses the projected Codex host-session runtime identity idempotently', () => {
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'custom' },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });

    const genericHostDescriptor = genericHostSessionRuntimeDescriptor({
      agentId: 'codex',
    });
    const descriptor = {
      ...genericHostDescriptor,
      agent: {
        ...genericHostDescriptor.agent,
        backendMode: 'custom',
      },
    } as const;

    const created = createSessionOwnerMetadataV1({
      metadata: { runtimeDescriptorV1: descriptor },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error('expected canonical Codex host-session owner metadata');
    }

    const compatibilityView = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: created.ownerMetadata,
    });
    const reparsed = createSessionOwnerMetadataV1({
      metadata: compatibilityView,
    });

    if (!reparsed.ok) {
      throw new Error(
        `expected reparsed Codex host-session owner metadata; received ${
          reparsed.error
        }: ${reparsed.unsupportedFields.join(', ')}`,
      );
    }
    expect(reparsed).toMatchObject({ ok: true });
    expect(reparsed.ownerMetadata.nativeSession?.runtimeDescriptorV1)
      .toEqual(created.ownerMetadata.nativeSession?.runtimeDescriptorV1);
  });

  it('projects the reachable account-configured ACP host-session provenance', () => {
    const descriptor = genericHostSessionRuntimeDescriptor({
      agentId: 'acp:account-configured-acp',
      backendId: 'account-configured-acp',
      provenance: 'configured',
    });

    const created = createSessionOwnerMetadataV1({
      metadata: { runtimeDescriptorV1: descriptor },
    });
    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        nativeSession: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acp:account-configured-acp',
            backendMode: 'native',
            providerSessionId: 'claude-session-private',
            backendId: 'account-configured-acp',
            provenance: 'configured',
          },
        },
      },
    });
    if (!created.ok) throw new Error('expected configured host-session owner metadata');
    const compatibilityView = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: created.ownerMetadata,
    });
    const reparsed = createSessionOwnerMetadataV1({
      metadata: compatibilityView,
    });
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('expected configured host-session compatibility reparse');
    expect(reparsed.ownerMetadata.nativeSession?.runtimeDescriptorV1)
      .toEqual(created.ownerMetadata.nativeSession?.runtimeDescriptorV1);

    const pluginDescriptor = genericPluginRuntimeDescriptor();
    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...pluginDescriptor,
          agent: {
            ...pluginDescriptor.agent,
            agentExtra: {
              ...pluginDescriptor.agent.agentExtra,
              runtimeHandle: {
                ...pluginDescriptor.agent.agentExtra.runtimeHandle,
                provenance: 'configured',
              },
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('rejects contradictory canonical and legacy Agent identity aliases', () => {
    const descriptor = genericHostSessionRuntimeDescriptor();

    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          providerId: 'other-agent',
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('reparses its generic runtime descriptor compatibility projection idempotently', () => {
    const first = createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: genericPluginRuntimeDescriptor(),
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected canonical owner metadata');

    const compatibilityView = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: first.ownerMetadata,
    });

    const reparsed = createSessionOwnerMetadataV1({
      metadata: compatibilityView,
    });
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('expected reparsed owner metadata');
    expect(reparsed.ownerMetadata.nativeSession?.runtimeDescriptorV1)
      .toEqual(first.ownerMetadata.nativeSession?.runtimeDescriptorV1);
  });

  it('rejects independently mismatched generic runtime descriptor owners and schemas', () => {
    const descriptor = genericPluginRuntimeDescriptor();

    for (const agentExtra of [
      {
        ...descriptor.agent.agentExtra,
        owner: 'foreign-owner',
      },
      {
        ...descriptor.agent.agentExtra,
        schemaId: 'foreign.runtimeDescriptorExtra',
      },
    ]) {
      expect(createSessionOwnerMetadataV1({
        metadata: {
          runtimeDescriptorV1: {
            ...descriptor,
            agent: {
              ...descriptor.agent,
              agentExtra,
            },
          },
        },
      })).toEqual({
        ok: false,
        error: 'unsupported_owner_metadata',
        unsupportedFields: ['runtimeDescriptorV1'],
      });
    }
  });

  it('rejects mixed generic runtime descriptor envelope and projected fields', () => {
    const descriptor = genericPluginRuntimeDescriptor();

    expect(createSessionOwnerMetadataV1({
      metadata: {
        runtimeDescriptorV1: {
          ...descriptor,
          agent: {
            ...descriptor.agent,
            backendId: 'claude',
            provenance: 'first_party',
          },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });
  });

  it('rejects incomplete or unknown-source generic runtime descriptor envelopes', () => {
    const descriptor = genericPluginRuntimeDescriptor();
    const {
      source: _missingSource,
      ...runtimeHandleWithoutSource
    } = descriptor.agent.agentExtra.runtimeHandle;

    for (const runtimeHandle of [
      runtimeHandleWithoutSource,
      {
        ...descriptor.agent.agentExtra.runtimeHandle,
        source: { kind: 'future-source-kind' },
      },
    ]) {
      expect(createSessionOwnerMetadataV1({
        metadata: {
          runtimeDescriptorV1: {
            ...descriptor,
            agent: {
              ...descriptor.agent,
              agentExtra: {
                ...descriptor.agent.agentExtra,
                runtimeHandle,
              },
            },
          },
        },
      })).toEqual({
        ok: false,
        error: 'unsupported_owner_metadata',
        unsupportedFields: ['runtimeDescriptorV1'],
      });
    }
  });

  it('fails closed with a typed error for unknown or unmodeled owner authority', () => {
    expect(createSessionOwnerMetadataV1({
      metadata: {
        path: '/private/workspace',
        futurePrivateAuthority: { token: 'must-not-carry' },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['futurePrivateAuthority'],
    });

    expect(createSessionOwnerMetadataV1({
      metadata: {
        path: '/private/workspace',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'future-agent',
          agent: { providerSessionId: 'cannot-drop-this-authority' },
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['runtimeDescriptorV1'],
    });

    expect(createSessionOwnerMetadataV1({
      metadata: {
        terminal: {
          mode: 'plain',
          requested: 'future-unowned-launch-mode',
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: '../invalid-private-identity',
          createdAt: 1,
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: [
        'connectedServices.connectedServiceMaterializationIdentityV1.id',
        'runtime.terminal.requested',
      ],
    });
  });

  it.each([
    ['released identity with canonical-only link data', {
      v: 1,
      providerId: 'codex',
      remoteSessionId: 'native-private',
      importedAtMs: 11,
      source: { kind: 'codexHome', home: 'user' },
      linkData: { projectId: 'project-private' },
    }],
    ['equal released and canonical identities', {
      v: 1,
      providerId: 'codex',
      agentId: 'codex',
      remoteSessionId: 'native-private',
      importedAtMs: 11,
      source: { kind: 'codexHome', home: 'user' },
    }],
  ])('rejects a historical-import tombstone with %s', (_label, tombstone) => {
    const created = createSessionOwnerMetadataV1({
      metadata: { externalHistoryImportV1: tombstone },
    });
    expect(created).toMatchObject({
      ok: false,
      error: 'unsupported_owner_metadata',
    });
    if (created.ok) return;
    expect(created.unsupportedFields).toContain('externalHistoryImportV1');
  });

  it('normalizes predecessor provider vocabulary and direct attention without retaining aliases', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        directSessionAttentionV1: {
          v: 1,
          observedProgressToken: 'cursor-private',
          observedAtMs: 10,
        },
        externalHistoryImportV1: {
          v: 1,
          providerId: 'codex',
          remoteSessionId: 'native-private',
          importedAtMs: 11,
          source: { kind: 'codexHome', home: 'user' },
        },
        acpHistoryImportV1: {
          v: 1,
          provider: 'opencode',
          remoteSessionId: 'native-private-2',
          importedAt: 12,
        },
        handoffV1: {
          v: 1,
          providerId: 'claude',
          sourceMachineId: 'machine-a',
          targetMachineId: 'machine-b',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'persisted',
          transportStrategy: 'server_routed_stream',
          completedAtMs: 13,
        },
        acpTransportV1: {
          v: 1,
          provider: 'gemini',
        },
      },
    });

    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        history: {
          externalHistoryImportV1: {
            v: 1,
            agentId: 'codex',
            remoteSessionId: 'native-private',
            importedAtMs: 11,
            source: { kind: 'codexHome', home: 'user' },
          },
          acpHistoryImportV1: {
            v: 1,
            agentId: 'opencode',
            remoteSessionId: 'native-private-2',
            importedAt: 12,
          },
        },
        handoff: {
          handoffV1: {
            v: 1,
            agentId: 'claude',
            sourceMachineId: 'machine-a',
            targetMachineId: 'machine-b',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'persisted',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 13,
          },
          acpTransportV1: {
            v: 1,
            agentId: 'gemini',
          },
        },
        cursors: {
          externalSessionAttentionV1: {
            v: 1,
            observedProgressToken: 'cursor-private',
            observedAtMs: 10,
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toMatch(
      /providerId|directSessionAttentionV1/,
    );
  });

  it('projects every reachable Agent-vocabulary record for the exact prospective predecessor reader', () => {
    const modeCatalog = {
      v: 1 as const,
      agentId: 'codex',
      updatedAt: 10,
      currentModeId: 'build',
      availableModes: [{ id: 'build', name: 'Build' }],
    };
    const modelCatalog = {
      v: 1 as const,
      agentId: 'codex',
      updatedAt: 11,
      currentModelId: 'codex-1',
      availableModels: [{
        id: 'codex-1',
        name: 'Codex 1',
        contextWindowTokens: 200_000,
      }],
    };
    const configCatalog = {
      v: 1 as const,
      agentId: 'codex',
      updatedAt: 12,
      configOptions: [{
        id: 'sandbox',
        name: 'Sandbox',
        type: 'boolean',
        currentValue: true,
      }],
    };
    const canonical = {
      path: '/private/workspace',
      host: 'private-host',
      acpHistoryImportV1: {
        v: 1 as const,
        agentId: 'codex',
        remoteSessionId: 'remote-private',
        importedAt: 9,
      },
      acpSessionModesV1: modeCatalog,
      sessionModesV1: modeCatalog,
      acpSessionModelsV1: modelCatalog,
      sessionModelsV1: modelCatalog,
      acpConfigOptionsV1: configCatalog,
      sessionConfigOptionsV1: configCatalog,
      handoffV1: {
        v: 1 as const,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
        agentId: 'codex',
        sessionStorageBefore: 'direct' as const,
        sessionStorageAfter: 'persisted' as const,
        transportStrategy: 'server_routed_stream' as const,
        completedAtMs: 13,
      },
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'opencode-private',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      forkV1: {
        v: 1 as const,
        parentSessionId: 'parent-session',
        parentCutoffSeqInclusive: 42,
        createdAtMs: 14,
        strategy: 'provider_native',
        agentHint: {
          agentId: 'opencode',
          backendMode: 'server',
          agentSessionId: 'opencode-private',
        },
      },
    };

    expect(RemoteDevMetadataReaderAtFae505Schema.safeParse(canonical).success)
      .toBe(false);

    const compatible =
      projectSessionMetadataAgentVocabularyWriteCompatibilityV1(canonical);
    expect(
      projectSessionMetadataAgentVocabularyWriteCompatibilityV1(compatible),
    ).toEqual(compatible);
    const predecessor =
      RemoteDevMetadataReaderAtFae505Schema.safeParse(compatible);
    expect(predecessor.success).toBe(true);
    if (!predecessor.success) return;
    expect(predecessor.data).toMatchObject({
      acpHistoryImportV1: { provider: 'codex' },
      acpSessionModesV1: { provider: 'codex' },
      sessionModesV1: { provider: 'codex' },
      acpSessionModelsV1: { provider: 'codex' },
      sessionModelsV1: { provider: 'codex' },
      acpConfigOptionsV1: { provider: 'codex' },
      sessionConfigOptionsV1: { provider: 'codex' },
      handoffV1: { providerId: 'codex' },
      agentRuntimeDescriptorV1: {
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'opencode-private',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      forkV1: {
        providerHint: {
          providerId: 'opencode',
          backendMode: 'server',
          vendorSessionId: 'opencode-private',
        },
      },
    });

    const canonicalOwner = createSessionOwnerMetadataV1({
      metadata: compatible,
    });
    expect(
      canonicalOwner.ok,
      canonicalOwner.ok ? '' : canonicalOwner.unsupportedFields.join(', '),
    ).toBe(true);
    if (!canonicalOwner.ok) return;
    expect(canonicalOwner.ownerMetadata.runtime?.sessionModelsV1)
      .toMatchObject({ agentId: 'codex' });
    expect(canonicalOwner.ownerMetadata.handoff?.handoffV1)
      .toMatchObject({ agentId: 'codex' });
    expect(JSON.stringify(canonicalOwner.ownerMetadata))
      .not.toMatch(/"provider"|"providerId"/);
    expect(canonical.acpSessionModelsV1).not.toHaveProperty('provider');
    expect(canonical.handoffV1).not.toHaveProperty('providerId');
    expect(canonical).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(canonical.forkV1).not.toHaveProperty('providerHint');
  });

  it('narrows model catalog windows at the owner and omits invalid optional hints at the predecessor write projection', () => {
    const zeroWindowMetadata = {
      path: '/private/workspace',
      host: 'private-host',
      sessionModelsV1: {
        v: 1 as const,
        agentId: 'codex',
        updatedAt: 11,
        currentModelId: 'codex-1',
        availableModels: [{
          id: 'codex-1',
          name: 'Codex 1',
          contextWindowTokens: 0,
        }],
      },
    };

    expect(createSessionOwnerMetadataV1({
      metadata: zeroWindowMetadata,
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: [
        'runtime.sessionModelsV1.availableModels.0.contextWindowTokens',
      ],
    });

    const compatible =
      projectSessionMetadataAgentVocabularyWriteCompatibilityV1(
        zeroWindowMetadata,
      );
    expect(compatible.sessionModelsV1.availableModels[0])
      .not.toHaveProperty('contextWindowTokens');
    expect(RemoteDevMetadataReaderAtFae505Schema.safeParse(compatible).success)
      .toBe(true);
  });

  it('normalizes legacy voice resume authority before sealing owner metadata', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        voiceAgentRunV1: {
          v: 1,
          runId: 'voice-run-private',
          backendId: 'codex',
          resumeHandle: {
            kind: 'vendor_session.v1',
            backendId: 'codex',
            vendorSessionId: 'native-private',
          },
          updatedAtMs: 14,
          streamId: 'obsolete-private-stream',
        },
      },
    });

    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        system: {
          voiceAgentRunV1: {
            v: 1,
            runId: 'voice-run-private',
            backendId: 'codex',
            resumeHandle: {
              kind: 'provider_session.v1',
              backendTarget: {
                kind: 'backend',
                backendId: 'codex',
                sourceKind: 'built_in',
              },
              providerSessionId: 'native-private',
            },
            updatedAtMs: 14,
            transcriptContractVersion: 2,
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toMatch(/vendor_session|streamId/);
  });

  it('migrates the remote-dev dual Voice resume handle without dropping resume authority', () => {
    // Prospective predecessor provenance:
    // ../remote-dev@f8c0ecb7919eac4ba8cb060917b97bb6fca89fae
    // packages/protocol/src/executionRunStartRequest.ts and
    // apps/ui/sources/voice/agent/VoiceAgentSessionController.persistence.spec.ts
    const created = createSessionOwnerMetadataV1({
      metadata: {
        voiceAgentRunV1: {
          v: 1,
          runId: 'voice-run-predecessor',
          backendId: 'claude',
          resumeHandle: {
            kind: 'voice_agent_sessions.v1',
            backendId: 'claude',
            chatVendorSessionId: 'chat-predecessor',
            commitVendorSessionId: 'commit-predecessor',
          },
          updatedAtMs: 14,
        },
      },
    });

    expect(created).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        system: {
          voiceAgentRunV1: {
            v: 1,
            runId: 'voice-run-predecessor',
            backendId: 'claude',
            resumeHandle: {
              kind: 'voice_agent_sessions.v1',
              backendTarget: {
                kind: 'backend',
                backendId: 'claude',
                sourceKind: 'built_in',
              },
              chatProviderSessionId: 'chat-predecessor',
              commitProviderSessionId: 'commit-predecessor',
            },
            updatedAtMs: 14,
            transcriptContractVersion: 2,
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toMatch(/VendorSessionId/);
  });

  it('preserves the representative current and predecessor owner inventory without alias authority', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        version: '1.2.3',
        name: 'private-name',
        os: 'linux',
        machineId: 'machine-private',
        profileId: 'profile-private',
        homeDir: '/private/home',
        happyHomeDir: '/private/happier',
        happyLibDir: '/private/happier/lib',
        happyToolsDir: '/private/happier/tools',
        flavor: 'pi',
        projectId: 'project-private',
        workspaceId: 'workspace-private',
        workspaceLocationId: 'location-private',
        workspaceCheckoutId: 'checkout-private',
        piSessionId: 'pi-native-private',
        piSessionFile: '/private/pi-session.jsonl',
        providerSessionInfoV1: {
          v: 1,
          provider: 'pi',
          sessionId: 'provider-native-private',
          observedAt: 1,
          title: 'private provider title',
          updatedAt: '2026-07-27T12:00:00+00:00',
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileBySessionId',
            vendorSessionId: 'pi-native-private',
            sessionFile: '/private/pi-session.jsonl',
          },
        },
        terminal: {
          mode: 'plain',
          requested: 'hidden',
          fallbackReason: 'private fallback',
          controlServiceabilityV1: {
            v: 1,
            attachmentId: 'attachment-private',
            state: 'recoverable_unservable',
            observedAt: 2,
            reason: 'private reason',
          },
        },
        tools: ['Read'],
        slashCommands: ['/review'],
        slashCommandDetails: [{
          command: '/review',
          description: 'private command',
        }],
        permissionMode: 'default',
        permissionModeUpdatedAt: 3,
        hostPid: 123,
        startedFromDaemon: true,
        startedBy: 'daemon',
        sessionLogPath: '/private/session.log',
        lifecycleState: 'running',
        lifecycleStateSince: 4,
        archivedBy: 'private-user',
        archiveReason: 'private reason',
        sessionModesV1: {
          v: 1,
          provider: 'pi',
          updatedAt: 5,
          currentModeId: 'build',
          availableModes: [{
            id: 'build',
            name: 'Build',
            description: 'private mode',
          }],
        },
        sessionModelsV1: {
          v: 1,
          provider: 'pi',
          updatedAt: 6,
          currentModelId: 'model-private',
          activeSelectionV1: {
            v: 1,
            selection: {
              agentTargetKey: 'backend:pi',
              providerConnectionId: null,
              modelId: 'model-private',
            },
            source: 'runtime_apply',
            runner: {
              pid: 123,
              processStartTimeMs: 1_000,
            },
          },
          availableModels: [{
            id: 'model-private',
            name: 'Private model',
            description: 'private model detail',
            contextWindowTokens: 1234,
            modelOptions: [{
              id: 'reasoning',
              name: 'Reasoning',
              description: 'private option',
              category: 'advanced',
              type: 'select',
              currentValue: 'high',
              options: [{
                value: 'high',
                name: 'High',
                description: 'private choice',
              }],
            }],
          }],
        },
        sessionConfigOptionsV1: {
          v: 1,
          provider: 'pi',
          updatedAt: 7,
          configOptions: [{
            id: 'sandbox',
            name: 'Sandbox',
            description: 'private config',
            category: 'security',
            type: 'boolean',
            currentValue: true,
            groups: [{
              id: 'security',
              name: 'Security',
              options: [{ value: true, name: 'Enabled' }],
            }],
          }],
        },
        modelOverrideV1: { v: 1, updatedAt: 8, modelId: 'model-private' },
        sessionModeOverrideV1: { v: 1, updatedAt: 9, modeId: 'build' },
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 10,
          overrides: {
            sandbox: { updatedAt: 10, value: true },
          },
        },
        acpConfiguredBackendV1: {
          v: 1,
          updatedAt: 11,
          backendId: 'backend-private',
          title: 'Private backend',
        },
        agentRuntimeCapabilitiesV1: {
          executionRun: {
            supported: true,
            structuredOutputRecovery: {
              plan: 'loose-sections',
              delegate: 'loose-deliverables',
            },
          },
          backend: {
            executionRun: { supported: true },
            session: {
              media: {
                acceptsImageInput: { supported: true },
                emitsSessionMedia: {
                  supported: true,
                  mediaKinds: ['image'],
                  sources: ['provider-generated'],
                  storage: 'session-media-file',
                },
                nativeImageGeneration: {
                  supported: true,
                  mediaKinds: ['image'],
                  streamingPartials: true,
                },
              },
              contextCompaction: {
                events: {
                  supported: true,
                  phases: ['started', 'completed'],
                  tokenCounts: true,
                  progress: true,
                },
                manualTrigger: {
                  supported: true,
                  transport: 'native-runtime-hook',
                  acceptsInstructions: true,
                },
                transcriptInference: { supported: false },
              },
            },
          },
        },
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
        mcpSelectionV1: {
          v: 1,
          managedServersEnabled: true,
          forceIncludeServerIds: ['mcp-private'],
          forceExcludeServerIds: [],
        },
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 12,
        runtimeActivityRevision: 1,
        connectedServicesUpdatedAt: 13,
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'materialization.private-1',
          createdAtMs: 14,
          source: 'test',
        },
        connectedServicePendingAuthGroupGenerationsV1: {
          v: 1,
          entries: [{
            kind: 'provider_adopted_generation',
            providerAdoptedTarget: {
              serviceId: 'openai',
              groupId: 'group-private',
              profileId: 'profile-private',
              generation: 2,
              credentialRevision: null,
              proof: {
                status: 'verified',
                source: 'provider-private',
                providerAccountId: 'account-private',
              },
            },
            proofStrength: 'exact',
            updatedAtMs: 15,
          }],
        },
        claudeSubscriptionAccessTokenRefreshV1: {
          v: 1,
          mode: 'daemon_callback',
        },
        connectedServiceAccessTokenRefreshV1: {
          v: 1,
          mode: 'daemon_callback',
          serviceIds: ['openai'],
        },
        sessionRollbackRangesV1: {
          v: 1,
          updatedAt: 16,
          ranges: [{
            target: {
              type: 'before_user_message',
              userMessageSeq: 1,
            },
            startSeqInclusive: 1,
            endSeqInclusive: 2,
            rolledBackAt: 16,
          }],
        },
        forkV1: {
          v: 1,
          parentSessionId: 'parent-private',
          parentCutoffSeqInclusive: 2,
          createdAtMs: 17,
          strategy: 'copy',
          agentHint: {
            agentId: 'pi',
            backendMode: 'local',
            agentSessionId: 'pi-native-private',
          },
        },
        replaySeedV1: {
          v: 1,
          seedText: 'private seed',
          sourceSessionId: 'parent-private',
          sourceCutoffSeqInclusive: 2,
          createdAtMs: 18,
          appliedToLocalId: 'local-private',
          appliedAtMs: 19,
        },
        forkInitialPromptV1: {
          v: 1,
          text: 'private fork prompt',
          createdAtMs: 20,
          sourceMessageId: 'message-private',
          appliedAtMs: 21,
        },
        sessionInitialPromptV1: {
          v: 1,
          text: 'private initial prompt',
          mode: 'append',
          createdAtMs: 22,
          sourceMessageIds: ['message-private'],
          sourceSessionId: 'parent-private',
        },
        sessionMediaContinuityV1: {
          v: 1,
          sourceSessionId: 'parent-private',
          sourceCutoffSeqInclusive: 2,
          referencedWorkspacePaths: ['/private/image.png'],
        },
        sessionGoalV1: {
          objective: 'Private legacy goal',
          status: 'active',
          updatedAt: 23,
          createdAt: 20,
          startedAt: 21,
          completedAt: 22,
          tokenBudget: 1_000,
          tokensUsed: 100,
          timeUsedSeconds: 10,
        },
        systemSessionV1: {
          v: 1,
          key: 'system-private',
          hidden: true,
        },
        hiddenSystemSession: false,
        voiceAgentRunV1: {
          v: 1,
          runId: 'voice-private',
          backendId: 'pi',
          resumeHandle: { kind: 'malformed-best-effort-hint' },
          updatedAtMs: 24,
        },
        voiceConversationScopeV1: {
          v: 1,
          kind: 'session_root',
          sessionRootId: 'root-private',
        },
        voiceConversationBindingV1: {
          v: 1,
          adapterId: 'adapter-private',
          controlSessionId: 'control-private',
          transcriptMode: 'native_session',
          targetSessionId: 'target-private',
          updatedAt: 25,
        },
        voiceAgentStartupInstructionsV1: {
          v: 1,
          id: 'instructions-private',
          revision: 1,
        },
        readStateV1: {
          v: 1,
          sessionSeq: 3,
          pendingActivityAt: 26,
          updatedAt: 27,
        },
        discardedCommittedMessageLocalIds: ['discard-private'],
        locallyConsumedUserMessageSeqsV1: [4],
      },
    });

    expect(
      created.ok,
      created.ok ? '' : created.unsupportedFields.join(', '),
    ).toBe(true);
    if (!created.ok) return;
    expect(SessionOwnerMetadataV1Schema.parse(created.ownerMetadata)).toEqual(
      created.ownerMetadata,
    );
    expect(created.ownerMetadata.nativeSession?.runtimeDescriptorV1).toMatchObject({
      agentId: 'pi',
      providerSessionId: 'pi-native-private',
      sessionFile: '/private/pi-session.jsonl',
    });
    expect(created.ownerMetadata.runtime?.sessionModelsV1).toMatchObject({
      agentId: 'pi',
      activeSelectionV1: {
        selection: {
          modelId: 'model-private',
        },
        runner: {
          pid: 123,
          processStartTimeMs: 1_000,
        },
      },
      availableModels: [{
        modelOptions: [{ category: 'advanced' }],
      }],
    });
    expect(created.ownerMetadata.runtime?.sessionConfigOptionsV1).toMatchObject({
      agentId: 'pi',
      configOptions: [{ category: 'security' }],
    });
    expect(created.ownerMetadata.work?.sessionWorkStateV1?.items[0]).toMatchObject({
      createdAt: 20,
      startedAt: 21,
      completedAt: 22,
    });
    expect(created.ownerMetadata.system?.voiceAgentRunV1?.resumeHandle).toBeNull();
    expect(created.ownerMetadata.system?.systemSessionV1).toEqual({
      v: 1,
      key: 'system-private',
      hidden: true,
    });
    expect(created.ownerMetadata.nativeSession?.runtimeDescriptorV1).not.toHaveProperty(
      'providerId',
    );
    expect(created.ownerMetadata.nativeSession?.runtimeDescriptorV1).not.toHaveProperty(
      'vendorSessionId',
    );
    expect(created.ownerMetadata.runtime?.sessionModesV1).not.toHaveProperty(
      'provider',
    );
    expect(created.ownerMetadata.runtime?.sessionModelsV1).not.toHaveProperty(
      'provider',
    );
    expect(created.ownerMetadata.runtime?.sessionConfigOptionsV1).not.toHaveProperty(
      'provider',
    );
    expect(created.ownerMetadata.system).not.toHaveProperty(
      'hiddenSystemSession',
    );
    expect(
      created.ownerMetadata.connectedServices
        ?.connectedServiceMaterializationIdentityV1,
    ).not.toHaveProperty('createdAtMs');
  });

  it('uses the canonical bounded plugin source envelope as the sole dynamic strict-schema exception', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'example-agent',
          machineId: 'machine-private',
          remoteSessionId: 'native-private',
          source: {
            kind: 'plugin-owned-source',
            contractVersion: 1,
            pluginCursor: { opaque: 'private-declaration-validated-value' },
          },
        },
      },
    });

    expect(created).toMatchObject({
      ok: true,
      ownerMetadata: {
        nativeSession: {
          externalSessionV1: {
            source: {
              kind: 'plugin-owned-source',
              pluginCursor: { opaque: 'private-declaration-validated-value' },
            },
          },
        },
      },
    });
  });

  it('preserves canonical follow lifecycle metadata when projecting a linked session into owner metadata', () => {
    const metadata = buildLinkedExternalSessionMetadataV1({}, {
      v: 1,
      agentId: 'opencode',
      machineId: 'machine-private',
      remoteSessionId: 'native-private',
      source: {
        kind: 'opencodeServer',
        contractVersion: 1,
        baseUrl: 'http://127.0.0.1:4096',
      },
      followPolicyV1: {
        v: 1,
        policy: 'background_follow',
        updatedAtMs: 100,
      },
      followStatusV1: {
        v: 1,
        status: 'error',
        reason: 'source_unavailable',
        updatedAtMs: 101,
      },
      lastFollowIssueV1: {
        v: 1,
        code: 'source_unavailable',
        message: 'Reconnect the source.',
        retryable: true,
        observedAtMs: 101,
      },
    });

    const created = createSessionOwnerMetadataV1({ metadata });

    expect(created).toMatchObject({
      ok: true,
      ownerMetadata: {
        nativeSession: {
          externalSessionV1: {
            followPolicyV1: {
              policy: 'background_follow',
            },
            followStatusV1: {
              status: 'error',
              reason: 'source_unavailable',
            },
            lastFollowIssueV1: {
              code: 'source_unavailable',
              retryable: true,
            },
          },
        },
      },
    });
  });

  it('rejects conflicting canonical and predecessor linked-session metadata before owner projection', () => {
    const metadata = buildLinkedExternalSessionMetadataV1({}, {
      v: 1,
      agentId: 'opencode',
      machineId: 'machine-private',
      remoteSessionId: 'native-private',
      source: {
        kind: 'opencodeServer',
        contractVersion: 1,
        baseUrl: 'http://127.0.0.1:4096',
      },
    });
    const released = {
      v: 1,
      providerId: 'opencode',
      machineId: 'machine-private',
      remoteSessionId: 'native-private',
      source: {
        kind: 'opencodeServer',
        contractVersion: 1,
        baseUrl: 'http://127.0.0.1:4096',
      },
    };

    expect(createSessionOwnerMetadataV1({
      metadata: {
        ...metadata,
        directSessionV1: {
          ...released,
          remoteSessionId: 'conflicting-native-session',
        },
      },
    })).toMatchObject({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: expect.arrayContaining([
        'externalSessionV1',
        'directSessionV1',
      ]),
    });
    expect(SessionOwnerMetadataV1Schema.safeParse({
      v: 1,
      nativeSession: {
        externalSessionV1: metadata.externalSessionV1,
        directSessionV1: {
          ...released,
          remoteSessionId: 'conflicting-native-session',
        },
      },
    }).success).toBe(false);
  });

  it('reparses linked-session runtime descriptors after owner projection', () => {
    const metadata = buildLinkedExternalSessionMetadataV1({}, {
      v: 1,
      agentId: 'codex',
      machineId: 'machine-private',
      remoteSessionId: 'native-private',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'native-private',
        },
      },
    });

    const created = createSessionOwnerMetadataV1({ metadata });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(SessionOwnerMetadataV1Schema.safeParse(created.ownerMetadata).success)
      .toBe(true);

    const reopened = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: createPlainSessionOwnerMetadataEnvelopeV1(
        created.ownerMetadata,
      ),
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const compatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: reopened.ownerMetadata,
    });
    expect(resolveLinkedExternalSessionMetadataV1(compatibility)).toMatchObject({
      ok: true,
      linkedSession: {
        agentId: 'codex',
        remoteSessionId: 'native-private',
        runtimeDescriptorV1: {
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'native-private',
          },
        },
      },
    });

    const releasedOnly = createSessionOwnerMetadataV1({
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-private',
          remoteSessionId: 'native-private',
          source: {
            kind: 'codexHome',
            home: 'user',
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'native-private',
            },
          },
        },
      },
    });
    expect(releasedOnly.ok).toBe(true);
    if (!releasedOnly.ok) return;
    expect(releasedOnly.ownerMetadata.nativeSession).toMatchObject({
      externalSessionV1: {
        agentId: 'codex',
        remoteSessionId: 'native-private',
      },
    });
    expect(releasedOnly.ownerMetadata.nativeSession).not.toHaveProperty('directSessionV1');
    const releasedCompatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: releasedOnly.ownerMetadata,
    });
    expect(resolveLinkedExternalSessionMetadataV1(releasedCompatibility))
      .toMatchObject({
        ok: true,
        linkedSession: {
          agentId: 'codex',
          remoteSessionId: 'native-private',
          runtimeDescriptorV1: {
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'native-private',
            },
          },
        },
      });
  });

  it('reads a released provider-only direct owner row and emits canonical compatibility metadata', () => {
    const ownerMetadata = {
      v: 1,
      nativeSession: {
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-released',
          remoteSessionId: 'remote-released',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
    };

    expect(SessionOwnerMetadataV1Schema.safeParse(ownerMetadata).success).toBe(true);
    const compatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata,
    });
    expect(compatibility).toMatchObject({
      externalSessionV1: {
        agentId: 'codex',
        remoteSessionId: 'remote-released',
      },
    });
    expect(compatibility).not.toHaveProperty('directSessionV1');
    expect(resolveLinkedExternalSessionMetadataV1(compatibility)).toMatchObject({
      ok: true,
      source: 'canonical',
      linkedSession: {
        agentId: 'codex',
        remoteSessionId: 'remote-released',
      },
    });
  });

  it('domain-seals owner metadata, rejects wrong keys/kinds, and rewraps for account-key rotation', () => {
    const oldMaterial = material(7);
    const newMaterial = material(8);
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/workspace',
        machineId: 'machine-1',
      },
      nativeSession: {
        codexSessionId: 'native-1',
      },
    });
    const ciphertext = sealSessionOwnerMetadataV1({
      material: oldMaterial,
      ownerMetadata,
      randomBytes: deterministicRandomBytes(1),
    });

    expect(openSessionOwnerMetadataV1({
      material: oldMaterial,
      ciphertext,
    })).toEqual(ownerMetadata);
    expect(openSessionOwnerMetadataV1({
      material: newMaterial,
      ciphertext,
    })).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_first_intent',
      material: oldMaterial,
      ciphertext,
    })).toBeNull();

    const wrongDomainCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'session_first_intent',
      material: oldMaterial,
      payload: ownerMetadata,
      randomBytes: deterministicRandomBytes(40),
    });
    expect(openSessionOwnerMetadataV1({
      material: oldMaterial,
      ciphertext: wrongDomainCiphertext,
    })).toBeNull();

    const rotated = rewrapSessionOwnerMetadataV1({
      sourceMaterial: oldMaterial,
      targetMaterial: newMaterial,
      ciphertext,
      randomBytes: deterministicRandomBytes(80),
    });
    expect(rotated).not.toBeNull();
    expect(openSessionOwnerMetadataV1({
      material: oldMaterial,
      ciphertext: rotated!,
    })).toBeNull();
    expect(openSessionOwnerMetadataV1({
      material: newMaterial,
      ciphertext: rotated!,
    })).toEqual(ownerMetadata);
  });
});

describe('producer-declared option override rules survive owner metadata projection', () => {
  const REASONING_OPTION = {
    id: 'reasoning_effort',
    name: 'Thinking',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'XHigh' },
    ],
  } as const;
  const ULTRACODE_OPTION = {
    id: 'ultracode',
    name: 'Ultracode',
    type: 'boolean',
    currentValue: 'false',
    overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
  } as const;

  it('accepts and preserves overridesWhenOn on model-catalog options', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        sessionModelsV1: {
          v: 1,
          agentId: 'claude',
          updatedAt: 1,
          currentModelId: 'claude-opus-5',
          availableModels: [{
            id: 'claude-opus-5',
            name: 'Opus 5',
            modelOptions: [REASONING_OPTION, ULTRACODE_OPTION],
          }],
        },
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      created.ownerMetadata.runtime?.sessionModelsV1
        ?.availableModels[0]?.modelOptions?.[1]?.overridesWhenOn,
    ).toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
  });

  it('accepts and preserves overridesWhenOn on config-catalog options', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        sessionConfigOptionsV1: {
          v: 1,
          agentId: 'claude',
          updatedAt: 1,
          configOptions: [REASONING_OPTION, ULTRACODE_OPTION],
        },
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.ownerMetadata.runtime?.sessionConfigOptionsV1?.configOptions[1]?.overridesWhenOn)
      .toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
  });

  it('still rejects a structurally invalid override rule rather than silently dropping it', () => {
    expect(createSessionOwnerMetadataV1({
      metadata: {
        sessionConfigOptionsV1: {
          v: 1,
          agentId: 'claude',
          updatedAt: 1,
          configOptions: [{ ...ULTRACODE_OPTION, overridesWhenOn: { optionIds: [] } }],
        },
      },
    })).toEqual({
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: [
        'runtime.sessionConfigOptionsV1.configOptions.0.overridesWhenOn.optionIds',
      ],
    });
  });
});

describe('extended-context model ids survive owner metadata projection', () => {
  it('accepts absence from an older producer and preserves the optional descriptor fact when present', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        sessionModelsV1: {
          v: 1,
          agentId: 'claude',
          updatedAt: 1,
          currentModelId: 'claude-sonnet-4-6',
          availableModels: [
            { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
              extendedContextModelId: 'claude-sonnet-4-6[1m]',
            },
          ],
        },
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.ownerMetadata.runtime?.sessionModelsV1?.availableModels).toEqual([
      { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
      {
        id: 'claude-sonnet-4-6',
        name: 'Sonnet 4.6',
        extendedContextModelId: 'claude-sonnet-4-6[1m]',
      },
    ]);
    expect(projectSessionMetadataAgentVocabularyWriteCompatibilityV1({
      sessionModelsV1: created.ownerMetadata.runtime?.sessionModelsV1,
    })).toMatchObject({
      sessionModelsV1: {
        provider: 'claude',
        availableModels: [
          { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
          { extendedContextModelId: 'claude-sonnet-4-6[1m]' },
        ],
      },
    });
  });
});
