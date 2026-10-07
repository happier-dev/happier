import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { deriveSettingsSecretsKeySet, unsealSecretsDeepWithKeysForPlainStorage } from '@/sync/encryption/secretSettings';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { ConnectedServiceCredentialRecordV1Schema, type ConnectedServiceCredentialRecordV1, type ConnectedServiceCredentialRevisionBoundaryV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';
import { openConnectedServiceCredentialCiphertext } from '@happier-dev/protocol/connect/connectedServiceCipher';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountConfigurationSnapshotV4, QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { convertAccountEncryptionMigrationTemplate } from './buildAccountEncryptionMigrationAutomations';

import {
  AccountEncryptionMigrateRequestSchema,
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

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

export async function buildAccountEncryptionMigrateToPlainRequest(params: Readonly<{
  credentials: AuthCredentials;
  expectedAccountVersion: number;
  expectedSigningKeyFingerprint: string | null;
  expectedContentKeyFingerprint: string | null;
  expectedSettingsVersion: number;
  settings: Settings;
  connectedServiceProfiles: ReadonlyArray<Readonly<{ serviceId: ConnectedServiceId; profileId: string }>>;
  qualifiedConnectedAccounts?: readonly QualifiedConnectedAccountProfileV4[];
  automations: ReadonlyArray<Readonly<{ id: string; templateVersion: number; templateCiphertext: string }>>;
  sessionDrafts?: readonly AccountEncryptionSessionDraftMigrationCandidate[];
  authoringMemory?: readonly AccountEncryptionAuthoringMemoryMigrationCandidate[];
  storageDirectives: AccountEncryptionMigrationStorageDirectives;
  fetchConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<Readonly<{
    sealed: Readonly<{ format: string; ciphertext: string }>;
    metadata: ConnectedServiceCredentialMetadataInput;
  }> & ConnectedServiceCredentialRevisionBoundaryV1>;
  fetchQualifiedConnectedAccountCredential?: (
    ref: QualifiedConnectedAccountRef,
  ) => Promise<QualifiedConnectedAccountCredentialSnapshotV4>;
  fetchQualifiedConnectedAccountConfiguration?: (
    ref: QualifiedConnectedAccountRef,
  ) => Promise<QualifiedConnectedAccountConfigurationSnapshotV4>;
  decryptAutomationTemplateRaw: (payloadCiphertext: string) => Promise<unknown | null>;
  resolveSession?: Parameters<typeof convertAccountEncryptionMigrationTemplate>[0]['resolveSession'];
}>): Promise<AccountEncryptionMigrateRequest> {
  const settingsSecretsReadKeys = (() => {
    try {
      return deriveSettingsSecretsKeySet(resolveAccountScopedCryptoMaterialFromCredentials(params.credentials)).readKeys;
    } catch {
      return [];
    }
  })();

  const settingsForServer = normalizeVoiceSettingsServerDelta(
    stripLocalOnlyAccountSettings(params.settings),
  );
  const plainSettings = unsealSecretsDeepWithKeysForPlainStorage(settingsForServer, settingsSecretsReadKeys);

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

    const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
    const credentials: any[] = [];
    for (const profile of params.connectedServiceProfiles) {
      if (
        qualifiedLegacyKeys.has(
          JSON.stringify([profile.serviceId, profile.profileId]),
        )
      ) {
        continue;
      }
      const fetched = await params.fetchConnectedServiceCredentialSealed({ serviceId: profile.serviceId, profileId: profile.profileId });
      if (
        fetched.revisionSemantics !== 'revisioned'
        || !fetched.credentialRevision
      ) {
        throw new Error(
          `Connected service credential revision is unavailable (${profile.serviceId}/${profile.profileId})`,
        );
      }
      const opened = openConnectedServiceCredentialCiphertext({ material, ciphertext: fetched.sealed.ciphertext });
      if (!opened) {
        throw new Error(`Failed to open connected service credential (${profile.serviceId}/${profile.profileId})`);
      }
      const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened.value);
      if (!recordParsed.success) {
        throw new Error(`Failed to open connected service credential (${profile.serviceId}/${profile.profileId})`);
      }
      const record: ConnectedServiceCredentialRecordV1 = assertConnectedServiceCredentialRecordBinding({
        binding: profile,
        record: recordParsed.data,
      });
      credentials.push({
        serviceId: profile.serviceId,
        profileId: profile.profileId,
        kind: 'plain',
        record,
        metadata: fetched.metadata,
        expectedCredentialRevision: fetched.credentialRevision,
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
          toMode: 'plain',
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
          id: automation.id, templateCiphertext: automation.templateCiphertext, toMode: 'plain',
          decryptRaw: params.decryptAutomationTemplateRaw,
          resolveSession: params.resolveSession,
        }),
      });
    }
    return { action: 'migrate' as const, templates, runs: [] };
  })();
  const sessionDrafts = buildAccountEncryptionSessionDraftsDirective({
    candidates: params.sessionDrafts ?? [],
    target: { mode: 'plain' },
  });
  const authoringMemory = buildAccountEncryptionAuthoringMemoryDirective({
    candidates: params.authoringMemory ?? [], target: { mode: 'plain' },
  });
  return AccountEncryptionMigrateRequestSchema.parse({
    toMode: 'plain',
    expectedAccountVersion: params.expectedAccountVersion,
    expectedSigningKeyFingerprint:
      params.expectedSigningKeyFingerprint,
    expectedContentKeyFingerprint:
      params.expectedContentKeyFingerprint,
    expectedSettingsVersion: params.expectedSettingsVersion,
    settingsContent: { t: 'plain', v: plainSettings },
    connectedServices,
    automations,
    ...params.storageDirectives,
    ...(sessionDrafts ? { sessionDrafts } : {}),
    ...(authoringMemory ? { authoringMemory } : {}),
  });
}
