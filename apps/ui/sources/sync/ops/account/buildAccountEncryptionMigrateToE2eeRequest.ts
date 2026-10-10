import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { ConnectedServiceCredentialRecordV1Schema, type ConnectedServiceCredentialRevisionBoundaryV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { AccountEncryptionMigrateUnsignedRequestSchema, attachAccountEncryptionMigrateProofSignatureV1, createAccountEncryptionMigrateProofSigningInputV1, type AccountEncryptionMigrateTransitionPasswordCredential } from '@happier-dev/protocol/account/encryptionMigrate';
import { assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealConnectedServiceCredentialCiphertext } from '@happier-dev/protocol/connect/connectedServiceCipher';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountConfigurationSnapshotV4, QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { convertAccountEncryptionMigrationTemplate } from './buildAccountEncryptionMigrationAutomations';

import {
  type AccountEncryptionMigrateRequest,
} from '@/sync/api/account/apiAccountEncryptionMigrate';
import {
  qualifiedConnectedAccountLegacyProjectionKeys,
  resealQualifiedConnectedAccountMigrationCredentials,
} from './resealQualifiedConnectedAccountMigrationCredentials';
import type {
  AccountEncryptionMigrationStorageDirectives,
} from './buildAccountEncryptionMigrationStorageDirectives';
import {
  buildAccountEncryptionSessionDraftsDirective,
  type AccountEncryptionSessionDraftMigrationCandidate,
} from './buildAccountEncryptionSessionDraftsDirective';
import { buildAccountEncryptionAuthoringMemoryDirective, type AccountEncryptionAuthoringMemoryMigrationCandidate } from './buildAccountEncryptionAuthoringMemoryDirective';
import { buildAccountEncryptionProjectRowsDirective, type AccountEncryptionProjectRowMigrationCandidate } from './buildAccountEncryptionProjectRowsDirective';
import { buildAccountEncryptionWorkspaceExecutionConfigDirective, type AccountEncryptionWorkspaceExecutionConfigMigrationCandidate } from './buildAccountEncryptionWorkspaceExecutionConfigDirective';
import { buildAccountEncryptionProjectTrustDirective, type AccountEncryptionProjectTrustMigrationCandidate } from './buildAccountEncryptionProjectTrustDirective';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { buildAccountEncryptionProfileRowsDirective } from './buildAccountEncryptionProfileRowsDirective';
import { buildAccountEncryptionPromptLibraryDirective, restoreAccountEncryptionPromptLibrarySettingsSources, type AccountEncryptionPromptLibraryMigrationCandidate } from './buildAccountEncryptionPromptLibraryDirective';
import { buildAccountEncryptionAcpCatalogDirective, restoreAccountEncryptionAcpCatalogSettingsSource, type AccountEncryptionAcpCatalogMigrationCandidate } from './buildAccountEncryptionAcpCatalogDirective';
import { buildAccountEncryptionProviderConnectionsDirective, type AccountEncryptionProviderConnectionsMigrationCandidate } from './buildAccountEncryptionProviderConnectionsDirective';
import { buildAccountEncryptionMcpServerCatalogDirective, restoreAccountEncryptionMcpServerCatalogSettingsSource,
  type AccountEncryptionMcpServerCatalogMigrationCandidate } from './buildAccountEncryptionMcpServerCatalogDirective';
import { buildAccountEncryptionEntityCatalogDirectives, type AccountEncryptionEntityCatalogMigrationCandidates } from './buildAccountEncryptionEntityCatalogDirectives';
import { buildAccountEncryptionConnectedAccountCatalogDirectives,
  type AccountEncryptionConnectedAccountCatalogMigrationCandidates } from './buildAccountEncryptionConnectedAccountCatalogDirectives';

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

export async function buildAccountEncryptionMigrateToE2eeRequest(params: Readonly<{
  credentials: AuthCredentials;
  accountId: string;
  expectedAccountVersion: number;
  expectedSigningKeyFingerprint: string | null;
  expectedContentKeyFingerprint: string | null;
  keyProof: Readonly<{
    v: 1;
    publicKey: string;
    contentPublicKey: string;
    contentPublicKeySig: string;
    sign: (input: Uint8Array) => string;
  }>;
  expectedSettingsVersion: number;
  settings: Settings;
  rawSettings: Readonly<Record<string, unknown>>;
  connectedServiceProfiles: ReadonlyArray<Readonly<{ serviceId: ConnectedServiceId; profileId: string }>>;
  qualifiedConnectedAccounts?: readonly QualifiedConnectedAccountProfileV4[];
  automations: ReadonlyArray<Readonly<{ id: string; templateVersion: number; templateCiphertext: string }>>;
  sessionDrafts?: readonly AccountEncryptionSessionDraftMigrationCandidate[];
  authoringMemory?: readonly AccountEncryptionAuthoringMemoryMigrationCandidate[];
  projectRows?: readonly AccountEncryptionProjectRowMigrationCandidate[];
  workspaceExecutionConfig?: readonly AccountEncryptionWorkspaceExecutionConfigMigrationCandidate[];
  projectTrust?: readonly AccountEncryptionProjectTrustMigrationCandidate[];
  profileRows?: ProfileCatalogSnapshotV1;
  promptLibrary?: readonly AccountEncryptionPromptLibraryMigrationCandidate[];
  acpCatalog?: AccountEncryptionAcpCatalogMigrationCandidate;
  providerConnections?: AccountEncryptionProviderConnectionsMigrationCandidate;
  mcpServerCatalog?: AccountEncryptionMcpServerCatalogMigrationCandidate;
  storageDirectives: AccountEncryptionMigrationStorageDirectives;
  passwordCredential?: AccountEncryptionMigrateTransitionPasswordCredential;
  fetchConnectedServiceCredentialPlain: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<Readonly<{
    content: Readonly<{ t: 'plain'; v: unknown }>;
    metadata?: ConnectedServiceCredentialMetadataInput;
  }> & ConnectedServiceCredentialRevisionBoundaryV1>;
  fetchQualifiedConnectedAccountCredential?: (
    ref: QualifiedConnectedAccountRef,
  ) => Promise<QualifiedConnectedAccountCredentialSnapshotV4>;
  fetchQualifiedConnectedAccountConfiguration?: (
    ref: QualifiedConnectedAccountRef,
  ) => Promise<QualifiedConnectedAccountConfigurationSnapshotV4>;
}> & AccountEncryptionEntityCatalogMigrationCandidates & AccountEncryptionConnectedAccountCatalogMigrationCandidates): Promise<AccountEncryptionMigrateRequest> {
  if (!isLegacyAuthCredentials(params.credentials)) {
    throw new Error('Legacy credentials are required to migrate to e2ee');
  }

  const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  if (material.type !== 'legacy') {
    throw new Error('Legacy crypto material is required to migrate to e2ee');
  }

  const settingsForServer = restoreAccountEncryptionAcpCatalogSettingsSource({ settings: restoreAccountEncryptionMcpServerCatalogSettingsSource({ settings: restoreAccountEncryptionPromptLibrarySettingsSources({
    settings: normalizeVoiceSettingsServerDelta(stripLocalOnlyAccountSettings(params.settings), params.rawSettings),
    rawSettings: params.rawSettings,
  }), rawSettings: params.rawSettings }), rawSettings: params.rawSettings });
  const settingsCiphertext = sealAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material,
    payload: settingsForServer,
    randomBytes: getRandomBytes,
  });

  const connectedServices = await (async () => {
    const qualifiedAccounts = params.qualifiedConnectedAccounts ?? [];
    const qualifiedLegacyKeys =
      qualifiedConnectedAccountLegacyProjectionKeys(qualifiedAccounts);
    if (
      params.connectedServiceProfiles.length === 0
      && qualifiedAccounts.length === 0
    ) {
      return { action: 'assert_empty' as const };
    }

    const credentials: any[] = [];
    for (const profile of params.connectedServiceProfiles) {
      if (
        qualifiedLegacyKeys.has(
          JSON.stringify([profile.serviceId, profile.profileId]),
        )
      ) {
        continue;
      }
      const fetched = await params.fetchConnectedServiceCredentialPlain({
        serviceId: profile.serviceId,
        profileId: profile.profileId,
      });
      if (
        fetched.revisionSemantics !== 'revisioned'
        || !fetched.credentialRevision
      ) {
        throw new Error(
          `Connected service credential revision is unavailable (${profile.serviceId}/${profile.profileId})`,
        );
      }
      if (!fetched?.content || fetched.content.t !== 'plain') {
        throw new Error(`Unexpected connected service credential envelope (${profile.serviceId}/${profile.profileId})`);
      }
      const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(fetched.content.v);
      if (!recordParsed.success) {
        throw new Error(`Failed to parse connected service credential record (${profile.serviceId}/${profile.profileId})`);
      }
      const record = assertConnectedServiceCredentialRecordBinding({
        binding: profile,
        record: recordParsed.data,
      });
      const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
        material,
        payload: record,
        randomBytes: getRandomBytes,
      });
      const providerEmail =
        record.kind === 'oauth' ? record.oauth?.providerEmail ?? null : record.token?.providerEmail ?? null;
      const providerAccountId =
        record.kind === 'oauth' ? record.oauth?.providerAccountId ?? null : record.token?.providerAccountId ?? null;
      credentials.push({
        serviceId: profile.serviceId,
        profileId: profile.profileId,
        kind: 'sealed',
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        expectedCredentialRevision: fetched.credentialRevision,
        metadata: {
          kind: record.kind,
          providerEmail,
          providerAccountId,
          expiresAt: record.expiresAt ?? null,
        },
      });
    }
    let qualifiedCredentials: Awaited<
      ReturnType<
        typeof resealQualifiedConnectedAccountMigrationCredentials
      >
    > = [];
    if (qualifiedAccounts.length > 0) {
      if (
        !params.fetchQualifiedConnectedAccountCredential
        || !params.fetchQualifiedConnectedAccountConfiguration
      ) {
        throw new Error(
          'Qualified connected-account migration readers are unavailable',
        );
      }
      qualifiedCredentials =
        await resealQualifiedConnectedAccountMigrationCredentials({
          toMode: 'e2ee',
          material,
          accounts: qualifiedAccounts,
          fetchCredential:
            params.fetchQualifiedConnectedAccountCredential,
          fetchConfiguration:
            params.fetchQualifiedConnectedAccountConfiguration,
          randomBytes: getRandomBytes,
        });
    }
    return {
      action: 'migrate' as const,
      credentials,
      qualifiedCredentials,
    };
  })();

  const automations = params.storageDirectives.automations ?? await (async () => {
    if (params.automations.length === 0) {
      return { action: 'assert_empty' as const };
    }

    const templates = [];
    for (const automation of params.automations) {
      templates.push({
        automationId: automation.id,
        expectedTemplateVersion: automation.templateVersion,
        triggerDefinitionEnvelopes: [],
        templateCiphertext: await convertAccountEncryptionMigrationTemplate({
          id: automation.id, templateCiphertext: automation.templateCiphertext, toMode: 'e2ee', targetMaterial: material,
        }),
      });
    }
    return { action: 'migrate' as const, templates, runs: [] };
  })();
  const sessionDrafts = buildAccountEncryptionSessionDraftsDirective({
    candidates: params.sessionDrafts ?? [],
    target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
  const authoringMemory = buildAccountEncryptionAuthoringMemoryDirective({
    candidates: params.authoringMemory ?? [], target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
  const projectRows = buildAccountEncryptionProjectRowsDirective({
    candidates: params.projectRows ?? [], target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
  const workspaceExecutionConfig = buildAccountEncryptionWorkspaceExecutionConfigDirective({
    candidates: params.workspaceExecutionConfig ?? [], target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
  const projectTrust = buildAccountEncryptionProjectTrustDirective({ candidates: params.projectTrust ?? [], target: { mode: 'e2ee', material, randomBytes: getRandomBytes } });
  const profileRows = buildAccountEncryptionProfileRowsDirective({
    snapshot: params.profileRows, target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
  const promptLibrary = buildAccountEncryptionPromptLibraryDirective({ candidates: params.promptLibrary ?? [], target: { mode: 'e2ee', material, randomBytes: getRandomBytes } });
  const acpCatalog = buildAccountEncryptionAcpCatalogDirective({ candidate: params.acpCatalog, target: { mode: 'e2ee', material, randomBytes: getRandomBytes } });
  const providerConnections = buildAccountEncryptionProviderConnectionsDirective({ candidate: params.providerConnections, target: { mode: 'e2ee', material, randomBytes: getRandomBytes } });
  const mcpServerCatalog = buildAccountEncryptionMcpServerCatalogDirective({ candidate: params.mcpServerCatalog,
    target: { mode: 'e2ee', material, randomBytes: getRandomBytes } });
  const entityCatalogs = buildAccountEncryptionEntityCatalogDirectives(params, { mode: 'e2ee', material, randomBytes: getRandomBytes });
  const connectedCatalogs = buildAccountEncryptionConnectedAccountCatalogDirectives(params, { mode: 'e2ee', material, randomBytes: getRandomBytes });
  const unsignedRequest =
    AccountEncryptionMigrateUnsignedRequestSchema.parse({
      toMode: 'e2ee',
      expectedAccountVersion: params.expectedAccountVersion,
      expectedSigningKeyFingerprint:
        params.expectedSigningKeyFingerprint,
      expectedContentKeyFingerprint:
        params.expectedContentKeyFingerprint,
      expectedSettingsVersion: params.expectedSettingsVersion,
      settingsContent: { t: 'encrypted', c: settingsCiphertext },
      connectedServices,
      automations,
      keyProof: {
        v: 1,
        publicKey: params.keyProof.publicKey,
        contentPublicKey: params.keyProof.contentPublicKey,
        contentPublicKeySig: params.keyProof.contentPublicKeySig,
      },
      ...params.storageDirectives,
    ...entityCatalogs,
    ...connectedCatalogs,
      ...(params.passwordCredential ? { passwordCredential: params.passwordCredential } : {}),
      ...(sessionDrafts ? { sessionDrafts } : {}),
      ...(authoringMemory ? { authoringMemory } : {}),
      ...(projectRows ? { projectRows } : {}),
      ...(workspaceExecutionConfig ? { workspaceExecutionConfig } : {}),
      ...(projectTrust ? { projectTrust } : {}),
      ...(profileRows ? { profileRows } : {}),
    ...(promptLibrary ? { promptLibrary } : {}),
    ...(acpCatalog ? { acpCatalog } : {}),
      ...(providerConnections ? { providerConnections } : {}),
      ...(mcpServerCatalog ? { mcpServerCatalog } : {}),
    });
  const signature = params.keyProof.sign(
    createAccountEncryptionMigrateProofSigningInputV1({
      request: unsignedRequest,
      accountId: params.accountId,
      sourceMode: 'plain',
    }),
  );
  return attachAccountEncryptionMigrateProofSignatureV1({
    request: unsignedRequest,
    signature,
  });
}
