import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/installationIdentity.js';
import {
  sealSessionOwnerMetadataEnvelopeV1,
} from '../sessions/metadata/sessionMetadataEnvelopesV1.js';
import {
  buildReviewCommentEventRequestBindingV1,
} from '../reviews/comments/content.js';
import * as migrationContract from './encryptionMigrate.js';
import {
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateAutomationDirectiveSchema,
  AccountEncryptionMigrateAutomationInventoryPageRequestSchema,
  AccountEncryptionMigrateAutomationInventoryPageSchema,
  AccountEncryptionMigrateAutomationStageBatchRequestSchema,
  AccountEncryptionMigrateCollectionDirectiveSchema,
  AccountEncryptionMigrateCollectionInventoryPageRequestSchema,
  AccountEncryptionMigrateCollectionInventoryPageSchema,
  AccountEncryptionMigrateCollectionStageBatchRequestSchema,
  AccountEncryptionMigrateTransitionActivateRequestSchema,
  AccountEncryptionMigrateTransitionAuthorizeRequestSchema,
  AccountEncryptionMigrateTransitionCancelRequestSchema,
  AccountEncryptionMigrateTransitionPrepareRequestSchema,
  AccountEncryptionMigrateTransitionPrepareResponseSchema,
  ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS,
  ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
  ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES,
  AccountEncryptionMigrateKeyProofSchema,
  AccountEncryptionMigratePredecessorRequestSchema,
  AccountEncryptionMigratePredecessorSuccessResponseSchema,
  AccountEncryptionMigrateRequestSchema,
  AccountEncryptionMigrateRequestBindingDigestV1Schema,
  AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
  AccountEncryptionMigrateSuccessResponseSchema,
  AccountEncryptionMigrateUnsignedRequestSchema,
  AccountEncryptionMigrateToModeSchema,
  attachAccountEncryptionMigrateProofSignatureV1,
  computeAccountEncryptionMigrateKeyFingerprintV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountEncryptionMigrateProofSigningInputV1,
  createAccountEncryptionMigrateRequestBindingDigestV1,
  createAccountEncryptionMigrateTransitionAuthorizationProofSigningInputV1,
} from './encryptionMigrate.js';

describe('account/encryptionMigrate', () => {
  it('converts the canonical content-key digest to the Account-currentness fingerprint without rehashing', () => {
    const publicKey = new Uint8Array(32).fill(0x5a);

    expect(
      convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        computeContentPublicKeyFingerprint(publicKey),
      ),
    ).toBe(computeAccountEncryptionMigrateKeyFingerprintV1(publicKey));
    expect(() =>
      convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        'content-public-key-sha256:not-a-canonical-digest',
      )).toThrow();
  });

  const emptyRemainingAccountDomainDirectives = {
    reviewComments: { action: 'assert_empty' as const },
    sessionOrganization: { action: 'assert_empty' as const },
    pets: { action: 'assert_empty' as const },
  };

  const encryptedSessionOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
    material: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(7),
    },
    ownerMetadata: { v: 1 },
    randomBytes: (length) => new Uint8Array(length).fill(9),
  });

  const createUnsignedE2eeRequest = () =>
    AccountEncryptionMigrateUnsignedRequestSchema.parse({
      toMode: 'e2ee',
      expectedAccountVersion: 11,
      expectedSigningKeyFingerprint: 'aemk1_current-signing',
      expectedContentKeyFingerprint: 'aemk1_current-content',
      expectedSettingsVersion: 7,
      settingsContent: { t: 'encrypted', c: 'settings-ciphertext' },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
      keyProof: {
        v: 1,
        publicKey: encodeBase64(new Uint8Array(32).fill(1)),
        contentPublicKey: encodeBase64(new Uint8Array(32).fill(3)),
        contentPublicKeySig: encodeBase64(new Uint8Array(64).fill(4)),
      },
    });

  const createPlainRequest = () =>
    AccountEncryptionMigrateRequestSchema.parse({
      toMode: 'plain',
      expectedAccountVersion: 13,
      expectedSigningKeyFingerprint: 'aemk1_preserved-signing',
      expectedContentKeyFingerprint: 'aemk1_preserved-content',
      expectedSettingsVersion: 9,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
    });

  it('requires the remaining Account-domain transition directives on the strict current wire', () => {
    const complete = {
      toMode: 'plain',
      expectedAccountVersion: 13,
      expectedSigningKeyFingerprint: 'aemk1_preserved-signing',
      expectedContentKeyFingerprint: 'aemk1_preserved-content',
      expectedSettingsVersion: 9,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      reviewComments: { action: 'assert_empty' },
      sessionOrganization: { action: 'assert_empty' },
      pets: { action: 'assert_empty' },
    } as const;

    expect(AccountEncryptionMigrateRequestSchema.safeParse(complete).success)
      .toBe(true);
    const {
      reviewComments: _reviewComments,
      ...missingReviewComments
    } = complete;
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(missingReviewComments)
        .success,
    ).toBe(false);
    const {
      sessionOrganization: _sessionOrganization,
      ...missingSessionOrganization
    } = complete;
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(
        missingSessionOrganization,
      ).success,
    ).toBe(false);
    const { pets: _pets, ...missingPets } = complete;
    expect(AccountEncryptionMigrateRequestSchema.safeParse(missingPets).success)
      .toBe(false);
  });

  it('strictly parses the existing external-auth pending proof artifact', () => {
    const request = {
      ...createUnsignedE2eeRequest(),
      externalAuthProof: {
        provider: 'github',
        pending: 'oauth_pending_stepup123',
        proof: 'fresh-browser-proof',
      },
    };

    expect(
      AccountEncryptionMigrateUnsignedRequestSchema.parse(request)
        .externalAuthProof,
    ).toEqual(request.externalAuthProof);
    expect(
      AccountEncryptionMigrateUnsignedRequestSchema.safeParse({
        ...request,
        externalAuthProof: {
          ...request.externalAuthProof,
          extra: true,
        },
      }).success,
    ).toBe(false);
    expect(
      AccountEncryptionMigrateUnsignedRequestSchema.safeParse({
        ...request,
        externalAuthProof: {
          provider: '',
          pending: '',
          proof: '',
        },
      }).success,
    ).toBe(false);
  });

  it('requires bounded Machine, Todo, Artifact, and Session inventory directives', () => {
    const complete = {
      toMode: 'plain',
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: {
        action: 'migrate',
        items: [{
          machineId: 'machine-1',
          expectedMetadataVersion: 2,
          expectedDaemonStateVersion: 3,
          metadata: 'plain-metadata',
          daemonState: null,
          dataEncryptionKey: 'plain-marker',
          contentPublicKeyFingerprint: null,
        }],
      },
      todos: {
        action: 'migrate',
        items: [{
          key: 'todo.index',
          expectedVersion: 4,
          value: 'plain-index',
        }],
      },
      artifacts: {
        action: 'migrate',
        items: [{
          artifactId: '00000000-0000-4000-8000-000000000001',
          expectedHeaderVersion: 5,
          expectedBodyVersion: 6,
          header: 'plain-header',
          body: 'plain-body',
          dataEncryptionKey: 'plain-marker',
        }],
      },
      sessions: {
        action: 'migrate',
        items: [{
          sessionId: 'session-1',
          expectedMetadataLayoutVersion: 1,
          expectedMetadataVersion: 7,
          expectedAgentStateVersion: 8,
          expectedOwnerMetadata: encryptedSessionOwnerMetadata,
          ownerMetadata: {
            t: 'plain',
            v: { v: 1 },
          },
        }],
      },
      ...emptyRemainingAccountDomainDirectives,
    } as const;

    expect(AccountEncryptionMigrateRequestSchema.parse(complete))
      .toMatchObject(complete);
    const { machines: _machines, ...missingMachines } = complete;
    expect(AccountEncryptionMigrateRequestSchema.safeParse(missingMachines).success)
      .toBe(false);
    const { sessions: _sessions, ...missingSessions } = complete;
    expect(AccountEncryptionMigrateRequestSchema.safeParse(missingSessions).success)
      .toBe(false);
    expect(ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS).toBe(500);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...complete,
      sessions: {
        action: 'migrate',
        items: Array.from(
          { length: ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS + 1 },
          () => complete.sessions.items[0],
        ),
      },
    }).success).toBe(false);
  });

  it('parses the one-shot target mode request with an explicit empty Session inventory', () => {
    expect(AccountEncryptionMigrateToModeSchema.parse('plain')).toBe('plain');
    expect(AccountEncryptionMigrateToModeSchema.parse('e2ee')).toBe('e2ee');

    const parsed = AccountEncryptionMigrateRequestSchema.parse({
      toMode: 'plain',
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
    });
    expect(parsed.toMode).toBe('plain');
    expect(parsed.sessions).toEqual({ action: 'assert_empty' });
  });

  it('requires exact source and target Account-mode Session owner envelopes', () => {
    const base = {
      toMode: 'plain',
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: {
        action: 'migrate',
        items: [{
          sessionId: 'session-1',
          expectedMetadataLayoutVersion: 1,
          expectedMetadataVersion: 0,
          expectedAgentStateVersion: 0,
          expectedOwnerMetadata: encryptedSessionOwnerMetadata,
          ownerMetadata: { t: 'plain', v: { v: 1 } },
        }],
      },
      ...emptyRemainingAccountDomainDirectives,
    } as const;
    expect(AccountEncryptionMigrateRequestSchema.safeParse(base).success)
      .toBe(true);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...base,
      sessions: {
        action: 'migrate',
        items: [{
          ...base.sessions.items[0],
          expectedOwnerMetadata: { t: 'plain', v: { v: 1 } },
        }],
      },
    }).success).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...base,
      sessions: {
        action: 'migrate',
        items: [{
          ...base.sessions.items[0],
          ownerMetadata: encryptedSessionOwnerMetadata,
        }],
      },
    }).success).toBe(false);
  });

  it('admits only the provenance-exact legacy Review Comment source variant across modes', () => {
    const request = createPlainRequest();
    const legacySplitSource = {
      v: 1,
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      anchor: { kind: 'file', filePath: 'src/example.ts' },
      snapshotEnvelope: { t: 'encrypted', c: 'snapshot' },
      bodyEnvelope: { t: 'encrypted', c: 'body' },
      edits: [],
      transitions: [],
    } as const;

    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      reviewComments: {
        action: 'migrate',
        items: [{
          commentId: 'comment-legacy',
          expectedServerRevision: 1,
          expectedBodyVersion: 1,
          expectedSensitiveSource: legacySplitSource,
          targetSensitiveEnvelope: {
            t: 'plain',
            v: { canonical: true },
          },
          events: [],
        }],
      },
    }).success).toBe(true);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      reviewComments: {
        action: 'migrate',
        items: [{
          commentId: 'comment-unscoped',
          expectedServerRevision: 1,
          expectedBodyVersion: 1,
          expectedSensitiveSource: { layout: 'unrelated' },
          targetSensitiveEnvelope: {
            t: 'plain',
            v: { canonical: true },
          },
          events: [],
        }],
      },
    }).success).toBe(false);
  });

  it('carries complete qualified credential and configuration replacements', () => {
    const qualified = {
      ref: {
        service: {
          pluginId: 'example.connected-accounts',
          localId: 'service/path',
        },
        accountId: 'provider/account',
      },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      expectedConfigurationRevision: 'cscr_current',
      authenticationModeId: 'api-key',
      replacementCredentialContentEnvelope: {
        t: 'encrypted',
        c: 'opaque-credential',
      },
      replacementConfigurationContentEnvelope: {
        t: 'encrypted',
        c: 'opaque-configuration',
      },
      metadata: {},
    } as const;
    const baseRequest = {
      toMode: 'e2ee' as const,
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: null,
      connectedServices: {
        action: 'migrate' as const,
        qualifiedCredentials: [qualified],
      },
      automations: { action: 'assert_empty' as const },
      machines: { action: 'assert_empty' as const },
      todos: { action: 'assert_empty' as const },
      artifacts: { action: 'assert_empty' as const },
      sessions: { action: 'assert_empty' as const },
      ...emptyRemainingAccountDomainDirectives,
      keyProof: {
        v: 1 as const,
        publicKey: 'public',
        signature: 'signature',
        contentPublicKey: 'content-public',
        contentPublicKeySig: 'content-signature',
      },
    };
    expect(AccountEncryptionMigrateRequestSchema.parse(baseRequest)
      .connectedServices).toMatchObject({
      action: 'migrate',
      qualifiedCredentials: [qualified],
    });
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...baseRequest,
      connectedServices: {
        action: 'migrate',
        qualifiedCredentials: [{
          ...qualified,
          replacementConfigurationContentEnvelope: undefined,
        }],
      },
    }).success).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...baseRequest,
      connectedServices: {
        action: 'migrate',
        qualifiedCredentials: [{
          ...qualified,
          replacementCredentialContentEnvelope: {
            t: 'plain',
            v: {},
          },
        }],
      },
    }).success).toBe(false);
  });

  it('requires exact legacy credential and Automation revisions in current migration requests', () => {
    const credential = {
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      kind: 'plain',
      record: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'token',
        createdAt: 1,
        updatedAt: 2,
        expiresAt: null,
        oauth: null,
        token: {
          token: 'token',
          providerAccountId: null,
          providerEmail: null,
          raw: null,
        },
      },
    } as const;
    const template = {
      automationId: 'automation-1',
      expectedTemplateVersion: 7,
      templateCiphertext: JSON.stringify({
        kind: 'happier_automation_template_plain_v1',
        payload: {},
      }),
    } as const;
    const request = {
      toMode: 'plain',
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: {} },
      connectedServices: {
        action: 'migrate',
        credentials: [credential],
      },
      automations: {
        action: 'migrate',
        templates: [template],
      },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
    } as const;

    expect(AccountEncryptionMigrateRequestSchema.safeParse(request).success)
      .toBe(true);
    const {
      expectedCredentialRevision: _credentialRevision,
      ...credentialWithoutRevision
    } = credential;
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      connectedServices: {
        action: 'migrate',
        credentials: [credentialWithoutRevision],
      },
    }).success).toBe(false);
    const {
      expectedTemplateVersion: _templateVersion,
      ...templateWithoutVersion
    } = template;
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      automations: {
        action: 'migrate',
        templates: [templateWithoutVersion],
      },
    }).success).toBe(false);
  });

  it('carries every retained private Automation Run envelope through the current migration wire', () => {
    const eventRun = {
      runId: 'run-automation-migration-1',
      expectedRunRevision: 3,
      triggerEvidenceEnvelope: JSON.stringify({
        t: 'encrypted',
        c: 'trigger-evidence-ciphertext',
      }),
      occurrenceEvidenceEqualityTag:
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      executionInputEnvelope: JSON.stringify({
        kind: 'happier_automation_run_execution_input_v1',
        targetType: 'new_session',
        templateVersion: 1,
        templateCiphertext: JSON.stringify({
          kind: 'happier_automation_template_encrypted_v1',
          payloadCiphertext: 'execution-input-ciphertext',
        }),
        origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
      }),
      resultEnvelope: JSON.stringify({
        t: 'encrypted',
        c: 'result-ciphertext',
      }),
      replyContextEnvelope: JSON.stringify({
        t: 'encrypted',
        c: 'reply-context-ciphertext',
      }),
      replyHandoffReceiptEnvelope: JSON.stringify({
        t: 'encrypted',
        c: 'reply-receipt-ciphertext',
      }),
    } as const;
    const scheduledRun = {
      ...eventRun,
      runId: 'run-automation-migration-scheduled-1',
      triggerEvidenceEnvelope: null,
      occurrenceEvidenceEqualityTag: null,
    } as const;
    const directive = {
      action: 'migrate' as const,
      templates: [],
      runs: [eventRun, scheduledRun],
    };

    expect(
      migrationContract.AccountEncryptionMigrateAutomationsDirectiveSchema
        .parse(directive),
    ).toEqual(directive);
    expect(
      migrationContract.AccountEncryptionMigrateAutomationsDirectiveSchema
        .safeParse({
          ...directive,
          runs: [{ ...scheduledRun, legacySummaryCiphertext: 'predecessor-only' }],
        }).success,
    ).toBe(false);
  });

  it('keeps the exact predecessor revisionless wire separate from current requests', () => {
    const predecessorRequest = {
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: {} },
      connectedServices: {
        action: 'migrate',
        credentials: [{
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'plain',
          record: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            kind: 'token',
            createdAt: 1,
            updatedAt: 2,
            expiresAt: null,
            oauth: null,
            token: {
              token: 'token',
              providerAccountId: null,
              providerEmail: null,
              raw: null,
            },
          },
        }],
      },
      automations: {
        action: 'migrate',
        templates: [{
          automationId: 'automation-1',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {},
          }),
        }],
      },
    } as const;

    expect(
      AccountEncryptionMigratePredecessorRequestSchema.safeParse(
        predecessorRequest,
      ).success,
    ).toBe(true);
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(predecessorRequest)
        .success,
    ).toBe(false);
  });

  it('accepts a bound trigger-definition target only on the current Automation transition item', () => {
    const base = {
      action: 'migrate' as const,
      templates: [{
        automationId: 'automation-definition-1',
        expectedTemplateVersion: 3,
        templateCiphertext: JSON.stringify({
          kind: 'happier_automation_template_encrypted_v1',
          payloadCiphertext: 'replacement-template-ciphertext',
        }),
      }],
    };
    const triggerDefinitionEnvelope = JSON.stringify({
      t: 'encrypted',
      c: 'replacement-trigger-definition-ciphertext',
    });

    expect(
      migrationContract.AccountEncryptionMigrateAutomationsDirectiveSchema.parse(base),
    ).toEqual(base);
    expect(
      migrationContract.AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        ...base,
        templates: [{
          ...base.templates[0],
          triggerDefinitionEnvelope,
        }],
      }),
    ).toEqual({
      ...base,
      templates: [{
        ...base.templates[0],
        triggerDefinitionEnvelope,
      }],
    });
  });

  it('admits the exact fae505 e2ee wire and preserves its strict error reader', () => {
    // Provenance-pinned prospective predecessor:
    // ../remote-dev@fae505bdc6916b3c9fa7a67eac3c4c88df759e9b
    const predecessorRequest = {
      toMode: 'e2ee',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'encrypted', c: 'opaque-settings' },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
    } as const;
    const predecessorErrorReader = z.discriminatedUnion('error', [
      z
        .object({
          error: z.literal('invalid-params'),
          reason: z
            .enum(['restore_required', 'key_proof_required'])
            .optional(),
        })
        .strict(),
      z.object({ error: z.literal('connected_services_not_empty') }).strict(),
      z.object({ error: z.literal('automations_not_empty') }).strict(),
    ]);

    expect(
      AccountEncryptionMigratePredecessorRequestSchema.safeParse(
        predecessorRequest,
      ).success,
    ).toBe(true);
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(predecessorRequest)
        .success,
    ).toBe(false);
    expect(predecessorErrorReader.parse({
      error: 'invalid-params',
      reason: 'key_proof_required',
    })).toEqual({
      error: 'invalid-params',
      reason: 'key_proof_required',
    });
    expect(predecessorErrorReader.parse({
      error: 'invalid-params',
    })).toEqual({
      error: 'invalid-params',
    });
  });

  it('parses stable invalid-params reasons and rejects oversized key proofs', () => {
    expect(AccountEncryptionMigrateBadRequestResponseSchema.parse({
      error: 'invalid-params',
      reason: 'restore_required',
    })).toEqual({
      error: 'invalid-params',
      reason: 'restore_required',
    });
    expect(AccountEncryptionMigrateBadRequestResponseSchema.parse({
      error: 'invalid-params',
      reason: 'key_proof_required',
    })).toEqual({
      error: 'invalid-params',
      reason: 'key_proof_required',
    });
    expect(AccountEncryptionMigrateKeyProofSchema.safeParse({
      v: 1,
      publicKey: 'p'.repeat(4097),
      signature: 'signature',
    }).success).toBe(false);
  });

  it('keeps predecessor and current success responses wire-distinct', () => {
    const predecessorSuccess = {
      success: true,
      mode: 'plain',
      settingsVersion: 2,
    } as const;
    const currentSuccess = {
      ...predecessorSuccess,
      accountVersion: 9,
    } as const;

    expect(
      AccountEncryptionMigratePredecessorSuccessResponseSchema
        .safeParse(predecessorSuccess).success,
    ).toBe(true);
    expect(
      AccountEncryptionMigratePredecessorSuccessResponseSchema
        .safeParse(currentSuccess).success,
    ).toBe(false);
    expect(
      AccountEncryptionMigrateSuccessResponseSchema
        .safeParse(predecessorSuccess).success,
    ).toBe(false);
    expect(
      AccountEncryptionMigrateSuccessResponseSchema
        .safeParse(currentSuccess).success,
    ).toBe(true);
  });

  it('admits missing proof for a typed route refusal but rejects an incomplete present proof', () => {
    const request = {
      toMode: 'e2ee',
      expectedAccountVersion: 0,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 0,
      settingsContent: { t: 'encrypted', c: 'ciphertext' },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
      keyProof: {
        v: 1,
        publicKey: 'public',
        signature: 'signature',
      },
    };

    const { keyProof: _omittedKeyProof, ...requestWithoutKeyProof } = request;
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(requestWithoutKeyProof)
        .success,
    ).toBe(true);
    expect(
      AccountEncryptionMigrateUnsignedRequestSchema.safeParse(
        requestWithoutKeyProof,
      ).success,
    ).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse(request).success).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      keyProof: {
        ...request.keyProof,
        contentPublicKey: 'content-public',
        contentPublicKeySig: 'content-signature',
      },
    }).success).toBe(true);
  });

  it('builds a request-bound proof from the unsigned strict request and attaches only its signature', () => {
    const unsignedRequest = AccountEncryptionMigrateUnsignedRequestSchema.parse({
      toMode: 'e2ee',
      expectedAccountVersion: 11,
      expectedSigningKeyFingerprint: 'aemk1_current-signing',
      expectedContentKeyFingerprint: 'aemk1_current-content',
      expectedSettingsVersion: 7,
      settingsContent: { t: 'encrypted', c: 'settings-ciphertext' },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      ...emptyRemainingAccountDomainDirectives,
      keyProof: {
        v: 1,
        publicKey: encodeBase64(new Uint8Array(32).fill(1)),
        contentPublicKey: encodeBase64(new Uint8Array(32).fill(3)),
        contentPublicKeySig: encodeBase64(new Uint8Array(64).fill(4)),
      },
    });
    const binding = {
      accountId: 'account-1',
      sourceMode: 'plain' as const,
    };
    const baseline = createAccountEncryptionMigrateProofSigningInputV1({
      request: unsignedRequest,
      ...binding,
    });
    const signature = encodeBase64(new Uint8Array(64).fill(2));
    const signedRequest = attachAccountEncryptionMigrateProofSignatureV1({
      request: unsignedRequest,
      signature,
    });

    expect(signedRequest.keyProof?.signature).toBe(signature);
    expect(signedRequest.keyProof).not.toHaveProperty('challenge');
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: signedRequest,
      ...binding,
    })).toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: {
        ...unsignedRequest,
        settingsContent: {
          t: 'encrypted',
          c: 'substituted-settings',
        },
      },
      ...binding,
    })).not.toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: {
        ...unsignedRequest,
        sessions: {
          action: 'migrate',
          items: [{
            sessionId: 'session-1',
            expectedMetadataLayoutVersion: 1,
            expectedMetadataVersion: 2,
            expectedAgentStateVersion: 3,
            expectedOwnerMetadata: { t: 'plain', v: { v: 1 } },
            ownerMetadata: encryptedSessionOwnerMetadata,
          }],
        },
      },
      ...binding,
    })).not.toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: unsignedRequest,
      ...binding,
      accountId: 'account-2',
    })).not.toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: {
        ...unsignedRequest,
        expectedAccountVersion: 12,
      },
      ...binding,
    })).not.toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: {
        ...unsignedRequest,
        expectedSigningKeyFingerprint: 'aemk1_stale',
      },
      ...binding,
    })).not.toEqual(baseline);
    expect(createAccountEncryptionMigrateProofSigningInputV1({
      request: {
        ...unsignedRequest,
        machines: {
          action: 'migrate',
          items: [{
            machineId: 'machine-1',
            expectedMetadataVersion: 2,
            expectedDaemonStateVersion: 3,
            metadata: 'encrypted-machine',
            daemonState: null,
            dataEncryptionKey: 'encrypted-key',
            contentPublicKeyFingerprint: 'aemk1_machine-content',
          }],
        },
      },
      ...binding,
    })).not.toEqual(baseline);
    expect(() => createAccountEncryptionMigrateProofSigningInputV1({
      request: unsignedRequest,
      accountId: '',
      sourceMode: 'plain',
    })).toThrow();
    expect(() => createAccountEncryptionMigrateProofSigningInputV1({
      request: unsignedRequest,
      accountId: 'account-1',
      sourceMode: 'e2ee',
    })).toThrow();
    expect(AccountEncryptionMigrateKeyProofSchema.safeParse({
      ...signedRequest.keyProof,
      challenge: 'client-chosen',
    }).success).toBe(false);
  });

  it('creates one strict request-binding digest for signed and unsigned e2ee requests', () => {
    const unsignedRequest = createUnsignedE2eeRequest();
    const signedRequest = attachAccountEncryptionMigrateProofSignatureV1({
      request: unsignedRequest,
      signature: encodeBase64(new Uint8Array(64).fill(2)),
    });
    const replacementSignatureRequest = {
      ...signedRequest,
      keyProof: {
        ...signedRequest.keyProof!,
        signature: encodeBase64(new Uint8Array(64).fill(8)),
      },
    };
    const externalAuthRequest = {
      ...signedRequest,
      externalAuthProof: {
        provider: 'github',
        pending: 'pending-1',
        proof: 'proof-1',
      },
    };
    const replacementExternalAuthRequest = {
      ...externalAuthRequest,
      externalAuthProof: {
        provider: 'oidc-work',
        pending: 'pending-2',
        proof: 'proof-2',
      },
    };
    const binding = {
      accountId: 'account-1',
      sourceMode: 'plain' as const,
    };

    const digest = createAccountEncryptionMigrateRequestBindingDigestV1({
      request: unsignedRequest,
      ...binding,
    });
    expect(digest).toMatch(/^aemrb1_[A-Za-z0-9_-]{43}$/);
    expect(
      AccountEncryptionMigrateRequestBindingDigestV1Schema.safeParse(
        digest,
      ).success,
    ).toBe(true);
    const nonCanonicalFinalPaddingBits = `${digest.slice(0, -1)}B`;
    expect(nonCanonicalFinalPaddingBits)
      .toMatch(/^aemrb1_[A-Za-z0-9_-]{43}$/);
    expect(
      AccountEncryptionMigrateRequestBindingDigestV1Schema.safeParse(
        nonCanonicalFinalPaddingBits,
      ).success,
    ).toBe(false);
    expect(
      AccountEncryptionMigrateRequestBindingDigestV1Schema.safeParse(
        `${digest}\n`,
      ).success,
    ).toBe(false);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: signedRequest,
      ...binding,
    })).toBe(digest);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: replacementSignatureRequest,
      ...binding,
    })).toBe(digest);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: externalAuthRequest,
      ...binding,
    })).toBe(digest);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: replacementExternalAuthRequest,
      ...binding,
    })).toBe(digest);
  });

  it('supports plain targets with preserved current fingerprints and canonical ordering', () => {
    const request = createPlainRequest();
    const reorderedRequest = AccountEncryptionMigrateRequestSchema.parse({
      pets: request.pets,
      sessionOrganization: request.sessionOrganization,
      reviewComments: request.reviewComments,
      sessions: request.sessions,
      artifacts: request.artifacts,
      todos: request.todos,
      machines: request.machines,
      automations: request.automations,
      connectedServices: request.connectedServices,
      settingsContent: request.settingsContent,
      expectedSettingsVersion: request.expectedSettingsVersion,
      expectedContentKeyFingerprint:
        request.expectedContentKeyFingerprint,
      expectedSigningKeyFingerprint:
        request.expectedSigningKeyFingerprint,
      expectedAccountVersion: request.expectedAccountVersion,
      toMode: request.toMode,
    });
    const binding = {
      accountId: 'account-1',
      sourceMode: 'e2ee' as const,
    };

    const digest = createAccountEncryptionMigrateRequestBindingDigestV1({
      request,
      ...binding,
    });
    expect(digest).toMatch(/^aemrb1_[A-Za-z0-9_-]{43}$/);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: reorderedRequest,
      ...binding,
    })).toBe(digest);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: {
        ...request,
        expectedSigningKeyFingerprint: 'aemk1_replaced-signing',
      },
      ...binding,
    })).not.toBe(digest);
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: {
        ...request,
        expectedContentKeyFingerprint: 'aemk1_replaced-content',
      },
      ...binding,
    })).not.toBe(digest);
  });

  it('binds Account identity, modes, currentness, keys, domain replacements, and Sessions', () => {
    const request = createUnsignedE2eeRequest();
    const reviewCommentEventRequestBinding =
      buildReviewCommentEventRequestBindingV1({
        accountId: 'account-1',
        projectId: 'project-1',
        actor: { kind: 'user', userId: 'user-1' },
        actionId: 'reviews.comments.create',
        input: {
          projectId: 'project-1',
          clientMutationId: 'mutation-1',
        },
      });
    const binding = {
      accountId: 'account-1',
      sourceMode: 'plain' as const,
    };
    const baseline =
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request,
        ...binding,
      });
    const assertChanged = (
      candidate: Parameters<
        typeof createAccountEncryptionMigrateRequestBindingDigestV1
      >[0],
    ) => {
      expect(
        createAccountEncryptionMigrateRequestBindingDigestV1(candidate),
      ).not.toBe(baseline);
    };

    assertChanged({ request, ...binding, accountId: 'account-2' });
    assertChanged({
      request: createPlainRequest(),
      accountId: binding.accountId,
      sourceMode: 'e2ee',
    });
    assertChanged({
      request: { ...request, expectedAccountVersion: 12 },
      ...binding,
    });
    assertChanged({
      request: { ...request, expectedSettingsVersion: 8 },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        keyProof: {
          ...request.keyProof!,
          publicKey: encodeBase64(new Uint8Array(32).fill(5)),
        },
      },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        keyProof: {
          ...request.keyProof!,
          contentPublicKeySig:
            encodeBase64(new Uint8Array(64).fill(6)),
        },
      },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        todos: {
          action: 'migrate',
          items: [{
            key: 'todo.index',
            expectedVersion: 4,
            value: 'encrypted-index',
          }],
        },
      },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        sessions: {
          action: 'migrate',
          items: [{
            sessionId: 'session-1',
            expectedMetadataLayoutVersion: 1,
            expectedMetadataVersion: 2,
            expectedAgentStateVersion: 3,
            expectedOwnerMetadata: { t: 'plain', v: { v: 1 } },
            ownerMetadata: encryptedSessionOwnerMetadata,
          }],
        },
      },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        reviewComments: {
          action: 'migrate',
          items: [{
            commentId: 'comment-1',
            expectedServerRevision: 1,
            expectedBodyVersion: 1,
            expectedSensitiveSource: {
              v: 1,
              layout: 'canonical_v1',
              envelope: {
                t: 'plain',
                v: { body: 'source' },
              },
            },
            targetSensitiveEnvelope: {
              t: 'encrypted',
              c: 'sealed-comment',
            },
            events: [{
              eventId: 'event-1',
              expectedSensitiveEnvelope: {
                v: 1,
                binding: {
                  v: 1,
                  eventId: 'event-1',
                  commentId: 'comment-1',
                  accountId: 'account-1',
                  projectId: 'project-1',
                  eventKind: 'created',
                  actor: { kind: 'user', userId: 'user-1' },
                  createdAt: 1,
                  serverRevision: 1,
                  requestBinding: reviewCommentEventRequestBinding,
                },
                sensitive: {
                  t: 'plain',
                  v: { body: 'source-event' },
                },
              },
              targetSensitiveEnvelope: {
                v: 1,
                binding: {
                  v: 1,
                  eventId: 'event-1',
                  commentId: 'comment-1',
                  accountId: 'account-1',
                  projectId: 'project-1',
                  eventKind: 'created',
                  actor: { kind: 'user', userId: 'user-1' },
                  createdAt: 1,
                  serverRevision: 1,
                  requestBinding: reviewCommentEventRequestBinding,
                },
                sensitive: {
                  t: 'encrypted',
                  c: 'sealed-event',
                },
              },
            }],
          }],
        },
      },
      ...binding,
    });
    assertChanged({
      request: {
        ...request,
        sessionOrganization: {
          action: 'migrate',
          expectedVersion: 3,
          folders: [{
            folderId: 'folder-1',
            expectedDisplay: { t: 'plain', v: { name: 'Work' } },
            display: { t: 'encrypted', c: 'sealed-folder' },
          }],
          tags: [],
          labels: [],
        },
      },
      ...binding,
    });
  });

  it('rejects malformed bindings and same-mode request bindings', () => {
    const e2eeRequest = createUnsignedE2eeRequest();
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request: e2eeRequest,
        accountId: '',
        sourceMode: 'plain',
      })
    ).toThrow();
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request: {
          ...e2eeRequest,
          sessions: undefined,
        } as never,
        accountId: 'account-1',
        sourceMode: 'plain',
      })
    ).toThrow();
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request: {
          ...e2eeRequest,
          unrelatedOuterField: 'must-remain-strict',
        } as never,
        accountId: 'account-1',
        sourceMode: 'plain',
      })
    ).toThrow();
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request: e2eeRequest,
        accountId: 'account-1',
        sourceMode: 'e2ee',
      })
    ).toThrow();
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        request: createPlainRequest(),
        accountId: 'account-1',
        sourceMode: 'plain',
      })
    ).toThrow();
  });

  it('keeps proof signing on the established wrapper over the shared digest bytes', () => {
    const request = createUnsignedE2eeRequest();
    const binding = {
      accountId: 'account-1',
      sourceMode: 'plain' as const,
    };
    const digest = createAccountEncryptionMigrateRequestBindingDigestV1({
      request,
      ...binding,
    });
    const signingInput = new TextDecoder().decode(
      createAccountEncryptionMigrateProofSigningInputV1({
        request,
        ...binding,
      }),
    );

    expect(signingInput).toBe(
      `happier.account-encryption-migrate-proof.v1\u0000${
        digest.slice('aemrb1_'.length)
      }`,
    );
    expect(signingInput).toBe(
      'happier.account-encryption-migrate-proof.v1\u0000'
        + 'eQ2wl9TtgH_Z2JhRm1yXZ6_t_xo7uoOfzzViR8UGquo',
    );
  });

  it('owns a closed authorized Collection staging transition with exact row evidence', () => {
    const transitionId = '00000000-0000-4000-8000-000000000001';
    const prepare = {
      toMode: 'e2ee' as const,
      expectedAccountVersion: 12,
      expectedSigningKeyFingerprint: null,
      expectedContentKeyFingerprint: null,
    };
    expect(AccountEncryptionMigrateTransitionPrepareRequestSchema.parse(prepare))
      .toEqual(prepare);
    const prepared = {
      transitionId,
      fromMode: 'plain' as const,
      ...prepare,
    };
    expect(AccountEncryptionMigrateTransitionPrepareResponseSchema.parse(prepared))
      .toEqual(prepared);

    const authorization = {
      transitionId,
      authorization: {
        kind: 'first_key' as const,
        keyProof: {
          v: 1 as const,
          publicKey: encodeBase64(new Uint8Array(32).fill(1)),
          contentPublicKey: encodeBase64(new Uint8Array(32).fill(3)),
          contentPublicKeySig: encodeBase64(new Uint8Array(64).fill(4)),
          signature: encodeBase64(new Uint8Array(64).fill(2)),
        },
        externalAuthProof: {
          provider: 'github',
          pending: 'oauth_pending_stepup123',
          proof: 'fresh-browser-proof',
        },
      },
    };
    expect(AccountEncryptionMigrateTransitionAuthorizeRequestSchema.parse(
      authorization,
    )).toEqual(authorization);
    expect(
      new TextDecoder().decode(
        createAccountEncryptionMigrateTransitionAuthorizationProofSigningInputV1({
          accountId: 'account-1',
          prepared,
          request: authorization,
        }),
      ),
    ).toMatch(
      /^happier\.account-encryption-migrate-transition-authorization-proof\.v1\u0000/,
    );
    expect(AccountEncryptionMigrateTransitionAuthorizeRequestSchema.parse({
      transitionId,
      authorization: { kind: 'present_user_confirmation' },
    })).toEqual({
      transitionId,
      authorization: { kind: 'present_user_confirmation' },
    });

    const item = {
      pluginId: 'example.collection',
      collectionId: 'documents',
      rowId: 'row-1',
      expectedRevision: 7,
      sourceEnvelope: { t: 'plain' as const, v: { title: 'source' } },
      targetEnvelope: { t: 'encrypted' as const, c: 'target-ciphertext' },
      schemaVersion: 1,
      contractDigest: 'A'.repeat(43),
    };
    expect(AccountEncryptionMigrateCollectionInventoryPageRequestSchema.parse({
      transitionId,
    })).toEqual({ transitionId });
    expect(AccountEncryptionMigrateCollectionInventoryPageSchema.parse({
      items: [{
        pluginId: item.pluginId,
        collectionId: item.collectionId,
        rowId: item.rowId,
        revision: item.expectedRevision,
        sourceEnvelope: item.sourceEnvelope,
        schemaVersion: item.schemaVersion,
        contractDigest: item.contractDigest,
      }],
    })).toBeTruthy();
    expect(AccountEncryptionMigrateCollectionStageBatchRequestSchema.parse({
      transitionId,
      items: [item],
    })).toMatchObject({ items: [item] });
    expect(AccountEncryptionMigrateCollectionStageBatchRequestSchema.safeParse({
      transitionId,
      items: [item, { ...item }],
    }).success).toBe(false);
    expect(AccountEncryptionMigrateCollectionStageBatchRequestSchema.safeParse({
      transitionId,
      items: Array.from(
        { length: ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS + 1 },
        (_, index) => ({ ...item, rowId: `row-${index}` }),
      ),
    }).success).toBe(false);
    expect(AccountEncryptionMigrateCollectionInventoryPageSchema.safeParse({
      items: Array.from(
        { length: ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS + 1 },
        (_, index) => ({
          pluginId: item.pluginId,
          collectionId: item.collectionId,
          rowId: `row-${index}`,
          revision: item.expectedRevision,
          sourceEnvelope: item.sourceEnvelope,
          schemaVersion: item.schemaVersion,
          contractDigest: item.contractDigest,
        }),
      ),
    }).success).toBe(false);
    expect(
      ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES,
    ).toBe(8 * 1024 * 1024);
    expect(AccountEncryptionMigrateCollectionStageBatchRequestSchema.safeParse({
      transitionId,
      items: Array.from({ length: 33 }, (_, index) => ({
        ...item,
        rowId: `large-row-${index}`,
        targetEnvelope: { t: 'encrypted' as const, c: 'x'.repeat(255 * 1024) },
      })),
    }).success).toBe(false);
    expect(AccountEncryptionMigrateTransitionCancelRequestSchema.parse({
      transitionId,
    })).toEqual({ transitionId });
    const automationItem = {
      kind: 'definition' as const,
      automationId: 'automation-transition-1',
      expectedRevision: 0,
      source: {
        templateCiphertext: JSON.stringify({
          kind: 'happier_automation_template_plain_v1',
          payload: {},
        }),
        triggerDefinitionEnvelope: null,
      },
      target: {
        templateCiphertext: JSON.stringify({
          kind: 'happier_automation_template_encrypted_v1',
          payloadCiphertext: 'replacement-template-ciphertext',
        }),
        triggerDefinitionEnvelope: JSON.stringify({
          t: 'encrypted',
          c: 'replacement-trigger-definition-ciphertext',
        }),
      },
    };
    expect(AccountEncryptionMigrateAutomationInventoryPageRequestSchema.parse({
      transitionId,
    })).toEqual({ transitionId });
    expect(AccountEncryptionMigrateAutomationInventoryPageSchema.parse({
      items: [{
        kind: automationItem.kind,
        automationId: automationItem.automationId,
        revision: automationItem.expectedRevision,
        source: automationItem.source,
      }],
    })).toBeTruthy();
    expect(AccountEncryptionMigrateAutomationStageBatchRequestSchema.parse({
      transitionId,
      items: [automationItem],
    })).toMatchObject({ items: [automationItem] });
    expect(AccountEncryptionMigrateAutomationStageBatchRequestSchema.safeParse({
      transitionId,
      items: [automationItem, { ...automationItem }],
    }).success).toBe(false);
    const collections = { action: 'staged' as const, transitionId };
    expect(AccountEncryptionMigrateCollectionDirectiveSchema.parse(collections))
      .toEqual(collections);
    const automations = { action: 'staged' as const, transitionId };
    expect(AccountEncryptionMigrateAutomationDirectiveSchema.parse(automations))
      .toEqual(automations);
    expect(AccountEncryptionMigrateTransitionActivateRequestSchema.parse({
      transitionId,
      collections,
      automations,
    })).toEqual({ transitionId, collections, automations });
    expect(AccountEncryptionMigrateTransitionActivateRequestSchema.safeParse({
      transitionId,
      collections,
    }).success).toBe(false);
    expect(AccountEncryptionMigrateTransitionActivateRequestSchema.safeParse({
      transitionId,
      collections: { action: 'staged', transitionId: '00000000-0000-4000-8000-000000000002' },
      automations,
    }).success).toBe(false);
    expect(AccountEncryptionMigrateTransitionActivateRequestSchema.safeParse({
      transitionId,
      collections,
      automations: { action: 'staged', transitionId: '00000000-0000-4000-8000-000000000002' },
    }).success).toBe(false);
    expect(
      migrationContract.AccountEncryptionMigrateTransitionAuthorizeResponseSchema
        .parse({ success: true }),
    ).toEqual({ success: true });
    expect(
      migrationContract.AccountEncryptionMigrateCollectionStageBatchResponseSchema
        .parse({
          success: true,
          stagedParticipantCount: 1,
          stagedSourceBytes: 42,
          stagedTargetBytes: 43,
        }),
    ).toEqual({
      success: true,
      stagedParticipantCount: 1,
      stagedSourceBytes: 42,
      stagedTargetBytes: 43,
    });
    expect(
      migrationContract.AccountEncryptionMigrateTransitionActivateResponseSchema
        .parse({
          success: true,
          mode: 'plain',
          accountVersion: 13,
          updatedAt: 1_700_000_000_000,
        }),
    ).toEqual({
      success: true,
      mode: 'plain',
      accountVersion: 13,
      updatedAt: 1_700_000_000_000,
    });
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...createPlainRequest(),
      collections,
    }).success).toBe(false);
  });

  it('accepts only the legacy or transition-bound first-key external-auth digest', () => {
    expect(AccountEncryptionMigrateExternalAuthBindingDigestV1Schema.parse(
      `aemrb1_${'A'.repeat(43)}`,
    )).toBe(`aemrb1_${'A'.repeat(43)}`);
    expect(AccountEncryptionMigrateExternalAuthBindingDigestV1Schema.parse(
      `aemtb1_${'A'.repeat(43)}`,
    )).toBe(`aemtb1_${'A'.repeat(43)}`);
    expect(
      AccountEncryptionMigrateExternalAuthBindingDigestV1Schema.safeParse(
        `aemrb1_${'A'.repeat(42)}B`,
      ).success,
    ).toBe(false);
    expect(
      AccountEncryptionMigrateExternalAuthBindingDigestV1Schema.safeParse(
        `unknown_${'A'.repeat(43)}`,
      ).success,
    ).toBe(false);
  });

  it('does not expose the rejected multi-phase rotation topology', () => {
    for (const retired of [
      'AccountEncryptionMigratePrepareBatchRequestSchema',
      'AccountEncryptionMigrateFinalizeRequestSchema',
      'AccountEncryptionMigrateRotationStateV1Schema',
      'AccountEncryptionMigrateServerIngressRequestSchema',
      'createAccountEncryptionMigrateRotationProofChallengeV1',
    ]) {
      expect(migrationContract).not.toHaveProperty(retired);
    }
  });
});
