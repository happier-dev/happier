import { describe, expect, it } from 'vitest';

import {
  CONNECTED_ACCOUNT_V4_PROTOCOL_VERSION,
  QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES,
  QualifiedConnectedAccountConfigurationPatchV4Schema,
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountCredentialHealthPatchV4Schema,
  QualifiedConnectedAccountRefreshLeaseV4Schema,
  QualifiedConnectedAccountCredentialDeleteV4Schema,
  QualifiedConnectedAccountCredentialReadV4Schema,
  QualifiedConnectedAccountGroupCreateV4Schema,
  QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
  QualifiedConnectedAccountGroupListResponseV4Schema,
  QualifiedConnectedAccountGroupResponseV4Schema,
  QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountQuotaResponseV4Schema,
  QualifiedProviderAccountUsageWriteV4Schema,
  QualifiedConnectedAccountRefSchema,
  QualifiedConnectedServiceUsageSourceV4Schema,
  openQualifiedConnectedAccountQuotaResponseV4,
  projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4,
} from './qualifiedConnectedAccountsV4.js';
import { ConnectedServicesCapabilitiesSchema } from '../features/payload/capabilities/connectedServicesCapabilities.js';
import {
  buildProviderAccountUsageRecordId,
  sealProviderAccountUsageSnapshotCiphertext,
  type ProviderAccountUsageSnapshotV1,
} from './accountUsage.js';

const service = {
  pluginId: 'acme.connected-accounts',
  localId: 'git/hosting',
} as const;
const credentialRevision = 'csr_abcdefghijklmnopqrstuvwxyz';

describe('qualified connected-account V4 wire contract', () => {
  it('keeps qualified identity structured and strict even when ids contain path separators', () => {
    expect(QualifiedConnectedAccountRefSchema.parse({
      service,
      accountId: 'team/primary',
    })).toEqual({
      service,
      accountId: 'team/primary',
    });

    expect(QualifiedConnectedAccountRefSchema.safeParse({
      service,
      accountId: 'team/primary',
      serviceId: 'github',
    }).success).toBe(false);
  });

  it('addresses a group member with one group service identity and one local account id', () => {
    const parsed = QualifiedConnectedAccountGroupMemberMutationV4Schema.parse({
      group: { service, groupId: 'fallback-pool' },
      connectedAccountId: 'team/primary',
      expectedRuntimeStateRevision: 1,
      priority: 4,
      enabled: true,
    });

    expect(parsed.group.service).toEqual(service);
    expect(QualifiedConnectedAccountGroupMemberMutationV4Schema.safeParse({
      ...parsed,
      ref: { service, accountId: parsed.connectedAccountId },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountGroupMemberMutationV4Schema.safeParse({
      group: { service, groupId: 'fallback-pool' },
      connectedAccountId: 'team/primary',
      expectedRuntimeStateRevision: '1',
    }).success).toBe(false);
  });

  it('preserves omission of optional runtime state across structural and member-only group mutations', () => {
    expect(QualifiedConnectedAccountGroupPatchV4Schema.parse({
      service,
      groupId: 'fallback-pool',
      displayName: 'Fallback pool',
    })).not.toHaveProperty('state');

    expect(QualifiedConnectedAccountGroupMemberMutationV4Schema.parse({
      group: { service, groupId: 'fallback-pool' },
      connectedAccountId: 'team/primary',
      priority: 4,
    })).not.toHaveProperty('state');

    expect(QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse({
      service,
      groupId: 'fallback-pool',
      expectedRuntimeStateRevision: 1,
      runtimeState: {
        memberStates: [{
          connectedAccountId: 'team/primary',
          state: { cooldownUntilMs: 1_000 },
        }],
      },
    }).runtimeState).not.toHaveProperty('state');
  });

  it('accepts the structural generation CAS for active-account mutation', () => {
    expect(QualifiedConnectedAccountGroupActiveAccountV4Schema.parse({
      group: { service, groupId: 'fallback-pool' },
      connectedAccountId: 'team/primary',
      expectedGeneration: 2,
      expectedRuntimeStateRevision: 1,
      expectedSource: {
        connectedAccountId: 'team/current',
        credentialRevision,
        configurationRevision: null,
      },
    })).toMatchObject({
      expectedGeneration: 2,
      expectedRuntimeStateRevision: 1,
      expectedSource: {
        connectedAccountId: 'team/current',
        credentialRevision,
        configurationRevision: null,
      },
    });
    expect(QualifiedConnectedAccountGroupPatchV4Schema.safeParse({
      service,
      groupId: 'fallback-pool',
      activeConnectedAccountId: 'team/primary',
    }).success).toBe(false);
  });

  it('requires both owner revisions for account configuration mutation and rejects credential plaintext', () => {
    const target = {
      kind: 'account',
      ref: { service, accountId: 'team/primary' },
    } as const;
    const parsed = QualifiedConnectedAccountConfigurationPatchV4Schema.parse({
      target,
      expectedConfigurationRevision: 'config-revision-3',
      expectedCredentialRevision: credentialRevision,
      replacementContentEnvelope: {
        t: 'encrypted',
        c: 'opaque-account-configuration',
      },
    });

    expect(parsed.target).toEqual(target);
    expect(QualifiedConnectedAccountConfigurationPatchV4Schema.safeParse({
      ...parsed,
      content: { t: 'plain', v: { token: 'must-not-be-resent' } },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountConfigurationPatchV4Schema.safeParse({
      target,
      expectedConfigurationRevision: 'config-revision-3',
      replacementContentEnvelope: parsed.replacementContentEnvelope,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountConfigurationPatchV4Schema.safeParse({
      target,
      expectedConfigurationRevision: null,
      expectedCredentialRevision: null,
      replacementContentEnvelope: parsed.replacementContentEnvelope,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountConfigurationPatchV4Schema.parse({
      target,
      expectedConfigurationRevision: null,
      expectedCredentialRevision: credentialRevision,
      replacementContentEnvelope: parsed.replacementContentEnvelope,
    }).expectedConfigurationRevision).toBeNull();
    expect(QualifiedConnectedAccountConfigurationPatchV4Schema.safeParse({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedConfigurationRevision: 'config-revision-3',
      expectedAccountSettingsRevision: 'settings-revision-2',
      configurationContent: parsed.configurationContent,
    }).success).toBe(false);
  });

  it('returns the credential revision needed to prepare an account configuration CAS', () => {
    expect(QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
      target: {
        kind: 'account',
        ref: { service, accountId: 'team/primary' },
      },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationRevision: 'config-revision-3',
      configurationContent: {
        t: 'encrypted',
        c: 'opaque-account-configuration',
      },
    })).toMatchObject({
      credentialRevision,
      configurationRevision: 'config-revision-3',
    });
  });

  it('keeps nullable public read modes separate from non-null credential mutations', () => {
    const ref = { service, accountId: 'team/legacy' };
    const publicRead = {
      authenticationModeId: null,
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationRevision: 'config-revision-3',
    } as const;

    expect(QualifiedConnectedAccountProfileV4Schema.parse({
      ref,
      status: 'needs_reauth',
      ...publicRead,
      configurationReady: true,
      scopes: [],
    }).authenticationModeId).toBeNull();
    expect(QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref,
      ...publicRead,
      content: { t: 'encrypted', c: 'opaque-legacy-credential' },
      metadata: { scopes: [] },
    }).authenticationModeId).toBeNull();
    expect(QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
      target: { kind: 'account', ref },
      ...publicRead,
      configurationContent: {
        t: 'encrypted',
        c: 'opaque-legacy-configuration',
      },
    }).authenticationModeId).toBeNull();

    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ref,
      authenticationModeId: null,
      expectedCredentialRevision: null,
      content: { t: 'encrypted', c: 'must-not-write' },
      metadata: { scopes: [] },
    }).success).toBe(false);
  });

  it('requires explicit null-or-exact credential CAS for every credential write', () => {
    const mutation = {
      ref: { service, accountId: 'team/primary' },
      authenticationModeId: 'oauth',
      content: { t: 'plain', v: { token: 'opaque-at-this-boundary' } },
      metadata: {
        providerIdentity: {
          accountId: 'provider-account-1',
          email: 'operator@example.com',
        },
        displayName: 'Primary account',
        scopes: ['account.read'],
      },
    } as const;

    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse(mutation).success)
      .toBe(false);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.parse({
      ...mutation,
      expectedCredentialRevision: null,
    }).expectedCredentialRevision).toBeNull();
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...mutation,
      expectedCredentialRevision: credentialRevision,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.parse({
      ...mutation,
      expectedCredentialRevision: credentialRevision,
      expectedConfigurationRevision: null,
    }).expectedCredentialRevision).toBe(credentialRevision);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...mutation,
      expectedCredentialRevision: 'credential-revision-8',
      expectedConfigurationRevision: null,
    }).success).toBe(false);

    expect(QualifiedConnectedAccountCredentialMutationV4Schema.parse({
      ...mutation,
      expectedCredentialRevision: credentialRevision,
      expectedConfigurationRevision: 'config-revision-3',
    })).not.toHaveProperty('initialConfiguration');
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...mutation,
      expectedCredentialRevision: credentialRevision,
      initialConfiguration: {
        replacementContentEnvelope: {
          t: 'encrypted',
          c: 'replacement-without-null-cas',
        },
      },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...mutation,
      expectedCredentialRevision: null,
      expectedConfigurationRevision: null,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.parse({
      ...mutation,
      expectedCredentialRevision: null,
      initialConfiguration: {
        expectedConfigurationRevision: null,
        replacementContentEnvelope: {
          t: 'encrypted',
          c: 'initial-account-configuration',
        },
      },
    }).initialConfiguration).toMatchObject({
      expectedConfigurationRevision: null,
    });
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...mutation,
      expectedCredentialRevision: credentialRevision,
      initialConfiguration: {
        expectedConfigurationRevision: null,
        replacementContentEnvelope: {
          t: 'encrypted',
          c: 'must-not-split-or-overwrite-established-config',
        },
      },
    }).success).toBe(false);
  });

  it('requires exact credential and nullable configuration CAS for health settlement', () => {
    const patch = {
      ref: { service, accountId: 'team/primary' },
      expectedCredentialRevision: credentialRevision,
      expectedConfigurationRevision: null,
      health: {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
      },
    } as const;

    expect(QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(patch))
      .toEqual(patch);
    expect(QualifiedConnectedAccountCredentialHealthPatchV4Schema.safeParse({
      ...patch,
      expectedConfigurationRevision: 'config-revision-3',
    }).success).toBe(true);
    expect(QualifiedConnectedAccountCredentialHealthPatchV4Schema.safeParse({
      ...patch,
      expectedCredentialRevision: undefined,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialHealthPatchV4Schema.safeParse({
      ...patch,
      expectedConfigurationRevision: undefined,
    }).success).toBe(false);
  });

  it('requires an exact credential revision for refresh lease acquisition', () => {
    const lease = {
      ref: { service, accountId: 'team/primary' },
      expectedCredentialRevision: credentialRevision,
      ownerId: 'machine:daemon',
      ttlMs: 30_000,
    } as const;

    expect(QualifiedConnectedAccountRefreshLeaseV4Schema.parse(lease))
      .toEqual(lease);
    expect(QualifiedConnectedAccountRefreshLeaseV4Schema.safeParse({
      ...lease,
      expectedCredentialRevision: undefined,
    }).success).toBe(false);
  });

  it('accepts only bounded non-secret provider metadata outside the credential envelope', () => {
    const mutation = {
      ref: { service, accountId: 'team/primary' },
      expectedCredentialRevision: null,
      authenticationModeId: 'oauth',
      content: { t: 'encrypted', c: 'opaque-e2ee-credential' },
      metadata: {
        providerIdentity: {
          accountId: 'provider-account-1',
          email: 'operator@example.com',
        },
        displayName: 'Primary account',
        scopes: ['account.read', 'account.write'],
      },
    } as const;

    expect(QualifiedConnectedAccountCredentialMutationV4Schema.parse(mutation).metadata)
      .toEqual(mutation.metadata);
    for (const unsafeMetadata of [
      { ...mutation.metadata, accessToken: 'plaintext-secret' },
      { ...mutation.metadata, password: 'plaintext-secret' },
      { ...mutation.metadata, apiKey: 'plaintext-secret' },
      { ...mutation.metadata, arbitrary: 'unknown-clear-field' },
      {
        ...mutation.metadata,
        providerIdentity: {
          ...mutation.metadata.providerIdentity,
          refreshToken: 'plaintext-secret',
        },
      },
    ]) {
      expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
        ...mutation,
        metadata: unsafeMetadata,
      }).success).toBe(false);
    }
  });

  it('keeps credential GET read-only and requires an exact revision for DELETE', () => {
    const ref = { service, accountId: 'team/primary' };
    expect(QualifiedConnectedAccountCredentialReadV4Schema.parse({ ref }))
      .toEqual({ ref });
    expect(QualifiedConnectedAccountCredentialReadV4Schema.safeParse({
      ref,
      expectedCredentialRevision: credentialRevision,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialReadV4Schema.safeParse({
      ref,
      cleanupGroupReferences: true,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialDeleteV4Schema.safeParse({
      ref,
      cleanupGroupReferences: true,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialDeleteV4Schema.safeParse({
      ref,
      expectedCredentialRevision: credentialRevision,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialDeleteV4Schema.parse({
      ref,
      expectedCredentialRevision: credentialRevision,
      cleanupGroupReferences: true,
    })).toEqual({
      ref,
      expectedCredentialRevision: credentialRevision,
      cleanupGroupReferences: true,
    });
  });

  it('uses the canonical numeric group CAS and strict policy schema on writes', () => {
    expect(QualifiedConnectedAccountGroupCreateV4Schema.parse({
      service,
      group: {
        groupId: 'fallback-pool',
        policy: {
          strategy: 'priority',
        },
      },
    }).group.policy).toMatchObject({ strategy: 'priority' });
    expect(QualifiedConnectedAccountGroupPatchV4Schema.parse({
      service,
      groupId: 'fallback-pool',
      expectedRuntimeStateRevision: 3,
      policy: {
        strategy: 'priority',
      },
    }).expectedRuntimeStateRevision).toBe(3);
    expect(QualifiedConnectedAccountGroupPatchV4Schema.safeParse({
      service,
      groupId: 'fallback-pool',
      expectedRuntimeStateRevision: '3',
    }).success).toBe(false);
    expect(QualifiedConnectedAccountGroupCreateV4Schema.safeParse({
      service,
      group: {
        groupId: 'fallback-pool',
        policy: { strategy: 'not-a-policy' },
      },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountGroupPatchV4Schema.safeParse({
      service,
      groupId: 'fallback-pool',
      policy: { arbitraryPolicyKey: true },
    }).success).toBe(false);
  });

  it('derives a group-member usage source service from the account ref instead of accepting a second service', () => {
    const parsed = QualifiedConnectedServiceUsageSourceV4Schema.parse({
      ref: { service, accountId: 'team/primary' },
      bindingKind: 'group_member',
      groupId: 'fallback-pool',
      groupGeneration: 7,
    });

    expect(parsed.ref.service).toEqual(service);
    expect(QualifiedConnectedServiceUsageSourceV4Schema.safeParse({
      ...parsed,
      groupService: service,
    }).success).toBe(false);
  });

  it('reuses the canonical provider-usage payload and record-id write contract', () => {
    const recordKey = {
      providerId: 'acme-provider',
      accountSubjectId: 'subject-1',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const base = {
      source: {
        ref: { service, accountId: 'team/primary' },
        bindingKind: 'account',
      },
      expectedCredentialRevision: credentialRevision,
      expectedConfigurationRevision: null,
      recordId,
      recordKey,
      payloadMode: 'sealed_account_scoped_v1',
      status: 'refresh_requested',
    } as const;

    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse(base).success)
      .toBe(true);
    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse({
      ...base,
      expectedCredentialRevision: undefined,
    }).success).toBe(false);
    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse({
      ...base,
      expectedConfigurationRevision: undefined,
    }).success).toBe(false);
    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse({
      ...base,
      recordId: 'paug_v1_abcdefgh',
    }).success).toBe(false);
    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse({
      ...base,
      sealedPayload: {
        format: 'account_scoped_v1',
        ciphertext: 'must-not-accompany-refresh-request',
      },
    }).success).toBe(false);
    expect(QualifiedProviderAccountUsageWriteV4Schema.safeParse({
      ...base,
      payloadMode: 'plain_json_v1',
      status: 'ok',
    }).success).toBe(false);
  });

  it('projects and opens plain or encrypted PAU quota content through one qualified owner', () => {
    const ref = {
      service,
      accountId: 'team/primary',
    } as const;
    const recordKey = {
      providerId: 'acme-provider',
      accountSubjectId: 'provider-subject-1',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: recordKey.providerId,
      accountSubject: {
        kind: 'providerSubject',
        id: recordKey.accountSubjectId,
      },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      staleAfterMs: 60_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'Pro',
      accountLabel: 'Work',
      meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: 25,
        limit: 100,
        unit: 'credits',
        utilizationPct: 25,
        resetsAt: 61_000,
        status: 'ok',
        details: {},
      }],
    };
    const projected =
      projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
        snapshot,
        ref,
      });
    expect(projected).toMatchObject({
      ref,
      providerId: 'acme-provider',
      activeAccountId: 'provider-subject-1',
      source: 'provider_api',
      confidence: 'exact',
      meters: snapshot.meters,
    });
    const metadata = {
      fetchedAt: 1_000,
      staleAfterMs: 60_000,
      status: 'ok' as const,
    };
    const sourceResolution = {
      source: {
        ref,
        bindingKind: 'account' as const,
      },
      recordId: snapshot.recordId,
      providerAccountId: snapshot.recordKey.accountSubjectId,
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
    };
    const material = {
      type: 'legacy' as const,
      secret: new Uint8Array(32).fill(7),
    };
    const plain = QualifiedConnectedAccountQuotaResponseV4Schema.parse({
      ref,
      sourceResolution,
      content: { t: 'plain', v: projected },
      metadata,
    });
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: plain,
      expectedRef: ref,
      material,
    })).toEqual(projected);
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: plain,
      expectedRef: ref,
    })).toEqual(projected);

    const encrypted = QualifiedConnectedAccountQuotaResponseV4Schema.parse({
      ref,
      sourceResolution,
      content: {
        t: 'encrypted',
        c: sealProviderAccountUsageSnapshotCiphertext({
          material,
          payload: snapshot,
          randomBytes: (length) => new Uint8Array(length).fill(3),
        }),
      },
      metadata,
    });
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: encrypted,
      expectedRef: ref,
      material,
    })).toEqual(projected);
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: encrypted,
      expectedRef: ref,
    })).toBeNull();
  });

  it('fails qualified quota opening closed on outer, inner, or ciphertext identity loss', () => {
    const ref = {
      service,
      accountId: 'team/primary',
    } as const;
    const otherRef = {
      service,
      accountId: 'team/other',
    } as const;
    const material = {
      type: 'legacy' as const,
      secret: new Uint8Array(32).fill(7),
    };
    const base = {
      ref,
      sourceResolution: {
        source: {
          ref,
          bindingKind: 'account' as const,
        },
        recordId:
          'paug_v1_12345678',
        providerAccountId: 'provider-subject-1',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
      },
      content: {
        t: 'plain' as const,
        v: {
          v: 1 as const,
          ref,
          fetchedAt: 1_000,
          staleAfterMs: 60_000,
          planLabel: null,
          accountLabel: null,
          providerId: 'acme-provider',
          activeAccountId: 'provider-subject-1',
          fetchedAtMs: 1_000,
          staleAtMs: 61_000,
          source: 'provider_api' as const,
          confidence: 'exact' as const,
          meters: [],
        },
      },
      metadata: {
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        status: 'ok' as const,
      },
    };
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: base,
      expectedRef: otherRef,
      material,
    })).toBeNull();
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: {
        ...base,
        content: {
          ...base.content,
          v: { ...base.content.v, ref: otherRef },
        },
      },
      expectedRef: ref,
      material,
    })).toBeNull();
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: {
        ...base,
        content: {
          t: 'encrypted',
          c: 'invalid-ciphertext',
        },
      },
      expectedRef: ref,
      material,
    })).toBeNull();
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: {
        ...base,
        sourceResolution: {
          ...base.sourceResolution,
          source: {
            ...base.sourceResolution.source,
            ref: otherRef,
          },
        },
      },
      expectedRef: ref,
      material,
    })).toBeNull();
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: {
        ...base,
        metadata: {
          ...base.metadata,
          fetchedAt: base.metadata.fetchedAt + 1,
        },
      },
      expectedRef: ref,
      material,
    })).toBeNull();

    const substitutedRecordKey = {
      providerId: 'acme-provider',
      accountSubjectId: 'provider-subject-2',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const substitutedSnapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId:
        buildProviderAccountUsageRecordId(substitutedRecordKey),
      recordKey: substitutedRecordKey,
      providerId: substitutedRecordKey.providerId,
      accountSubject: {
        kind: 'providerSubject',
        id: substitutedRecordKey.accountSubjectId,
      },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      staleAfterMs: 60_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: null,
      accountLabel: null,
      meters: [],
    };
    expect(openQualifiedConnectedAccountQuotaResponseV4({
      response: {
        ...base,
        content: {
          t: 'encrypted',
          c: sealProviderAccountUsageSnapshotCiphertext({
            material,
            payload: substitutedSnapshot,
            randomBytes: (length) =>
              new Uint8Array(length).fill(3),
          }),
        },
      },
      expectedRef: ref,
      material,
    })).toBeNull();
  });

  it('keeps account and group responses strict, qualified, and free of legacy identity', () => {
    const ref = { service, accountId: 'team/primary' };
    const account = {
      ref,
      status: 'connected',
      authenticationModeId: 'api-key',
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationReady: true,
      configurationRevision: 'cscr_revision',
      kind: 'token',
      providerIdentity: {
        email: null,
        accountId: null,
      },
      displayName: 'Primary account',
      scopes: ['account.read'],
      expiresAt: null,
      lastUsedAt: null,
    } as const;
    expect(QualifiedConnectedAccountListResponseV4Schema.parse({
      service,
      accounts: [account],
    })).toEqual({ service, accounts: [account] });
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: [{ ...account, serviceId: 'openai' }],
    }).success).toBe(false);
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: [{
        ...account,
        providerIdentity: {
          accountId: 'x'.repeat(257),
        },
      }],
    }).success).toBe(false);
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: [{
        ...account,
        scopes: Array.from({ length: 129 }, (_, index) => `scope.${index}`),
      }],
    }).success).toBe(false);
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: [{
        ...account,
        scopes: ['account.read', 'account.read'],
      }],
    }).success).toBe(false);
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: [{
        ...account,
        scopes: ['x'.repeat(257)],
      }],
    }).success).toBe(false);
    expect(QualifiedConnectedAccountListResponseV4Schema.safeParse({
      service,
      accounts: Array.from({ length: 501 }, () => account),
    }).success).toBe(false);

    const group = {
      v: 1,
      ref: { service, groupId: 'fallback-pool' },
      incarnation: 'qualified-group-row-fallback-pool',
      displayName: 'Fallback',
      policy: {},
      activeConnectedAccountId: ref.accountId,
      generation: 1,
      runtimeStateRevision: 2,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [{
        v: 1,
        connectedAccountId: ref.accountId,
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 2,
      }],
    } as const;
    expect(QualifiedConnectedAccountGroupResponseV4Schema.parse({ group }))
      .toMatchObject({
        group: {
          ref: group.ref,
          activeConnectedAccountId: ref.accountId,
          members: group.members,
        },
      });
    expect(QualifiedConnectedAccountGroupResponseV4Schema.safeParse({
      group: { ...group, serviceId: 'openai' },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountGroupListResponseV4Schema.safeParse({
      groups: Array.from({ length: 501 }, () => group),
    }).success).toBe(false);
  });

  it('freezes the atomic route family and advertises only protocol version 4', () => {
    expect(CONNECTED_ACCOUNT_V4_PROTOCOL_VERSION).toBe(4);
    expect(QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES).toEqual([
      ['GET', '/v4/connect/qualified/accounts'],
      ['POST', '/v4/connect/qualified/credential'],
      ['GET', '/v4/connect/qualified/credential'],
      ['DELETE', '/v4/connect/qualified/credential'],
      ['GET', '/v4/connect/qualified/configuration'],
      ['PATCH', '/v4/connect/qualified/configuration'],
      ['PATCH', '/v4/connect/qualified/credential/health'],
      ['POST', '/v4/connect/qualified/credential/refresh-lease'],
      ['GET', '/v4/connect/qualified/quotas'],
      ['DELETE', '/v4/connect/qualified/quotas'],
      ['POST', '/v4/connect/qualified/quotas/refresh'],
      ['GET', '/v4/connect/qualified/groups'],
      ['POST', '/v4/connect/qualified/groups'],
      ['GET', '/v4/connect/qualified/group'],
      ['PATCH', '/v4/connect/qualified/group'],
      ['DELETE', '/v4/connect/qualified/group'],
      ['PATCH', '/v4/connect/qualified/group/runtime-state'],
      ['POST', '/v4/connect/qualified/group/members'],
      ['PATCH', '/v4/connect/qualified/group/member'],
      ['DELETE', '/v4/connect/qualified/group/member'],
      ['POST', '/v4/connect/qualified/group/active-account'],
      ['GET', '/v4/connect/qualified/provider-account-usage/sources/resolve'],
      ['POST', '/v4/connect/qualified/provider-account-usage'],
      ['GET', '/v4/connect/qualified/provider-account-usage/record'],
      ['DELETE', '/v4/connect/qualified/provider-account-usage/record'],
      ['POST', '/v4/connect/qualified/provider-account-usage/record/refresh'],
    ]);

    expect(ConnectedServicesCapabilitiesSchema.parse({}).qualifiedAccounts).toBeUndefined();
    expect(ConnectedServicesCapabilitiesSchema.parse({
      qualifiedAccounts: { protocolVersion: 4 },
    }).qualifiedAccounts).toEqual({ protocolVersion: 4 });
    expect(ConnectedServicesCapabilitiesSchema.safeParse({
      qualifiedAccounts: { protocolVersion: 3 },
    }).success).toBe(false);
  });

  it('uses the descriptor-owned local-id codec for persisted authentication modes', () => {
    const base = {
      ref: { service, accountId: 'team/primary' },
      expectedCredentialRevision: null,
      authenticationModeId: 'oauth-device',
      content: { t: 'encrypted', c: 'opaque-e2ee-credential' },
      metadata: {
        displayName: 'Primary account',
        scopes: [],
      },
    } as const;
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse(base).success)
      .toBe(true);
    expect(QualifiedConnectedAccountCredentialMutationV4Schema.safeParse({
      ...base,
      authenticationModeId: 'OAuth Device',
    }).success).toBe(false);
  });
});
