import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import {
  ConnectedServiceCredentialRecordV1Schema,
  AccountEncryptionMigrateUnsignedRequestSchema,
  attachAccountEncryptionMigrateProofSignatureV1,
  createAccountEncryptionMigrateProofSigningInputV1,
  assertConnectedServiceCredentialRecordBinding,
  sealAccountScopedBlobCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import {
  AUTOMATION_TEMPLATE_ENVELOPE_KIND,
  encodeAutomationTemplateForTransport,
  tryDecodeAutomationTemplateEnvelope,
} from '@/sync/domains/automations/automationTemplateTransport';

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
  connectedServiceProfiles: ReadonlyArray<Readonly<{ serviceId: ConnectedServiceId; profileId: string }>>;
  qualifiedConnectedAccounts?: readonly QualifiedConnectedAccountProfileV4[];
  automations: ReadonlyArray<Readonly<{ id: string; templateVersion: number; templateCiphertext: string }>>;
  sessionDrafts?: readonly AccountEncryptionSessionDraftMigrationCandidate[];
  storageDirectives: AccountEncryptionMigrationStorageDirectives;
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
}>): Promise<AccountEncryptionMigrateRequest> {
  if (!isLegacyAuthCredentials(params.credentials)) {
    throw new Error('Legacy credentials are required to migrate to e2ee');
  }

  const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  if (material.type !== 'legacy') {
    throw new Error('Legacy crypto material is required to migrate to e2ee');
  }

  const settingsForServer = normalizeVoiceSettingsServerDelta(
    stripLocalOnlyAccountSettings(params.settings),
  );
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

  const automations = await (async () => {
    if (params.automations.length === 0) {
      return { action: 'assert_empty' as const };
    }

    const templates: any[] = [];
    for (const automation of params.automations) {
      const envelope = tryDecodeAutomationTemplateEnvelope(automation.templateCiphertext);
      if (!envelope) throw new Error(`Invalid automation template envelope (${automation.id})`);

      if (envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND) {
        templates.push({
          automationId: automation.id,
          expectedTemplateVersion: automation.templateVersion,
          templateCiphertext: automation.templateCiphertext,
        });
        continue;
      }

      const decoded = decodeAutomationTemplate(JSON.stringify(envelope.payload));
      if (!decoded) throw new Error(`Invalid automation template payload (${automation.id})`);

      const encryptedTemplateCiphertext = await encodeAutomationTemplateForTransport({
        accountMode: 'e2ee',
        template: decoded,
        encryptRaw: async (value) =>
          sealAccountScopedBlobCiphertext({
            kind: 'automation_template_payload',
            material,
            payload: value,
            randomBytes: getRandomBytes,
          }),
      });

      templates.push({
        automationId: automation.id,
        expectedTemplateVersion: automation.templateVersion,
        templateCiphertext: encryptedTemplateCiphertext,
      });
    }
    return { action: 'migrate' as const, templates };
  })();
  const sessionDrafts = buildAccountEncryptionSessionDraftsDirective({
    candidates: params.sessionDrafts ?? [],
    target: { mode: 'e2ee', material, randomBytes: getRandomBytes },
  });
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
      ...(sessionDrafts ? { sessionDrafts } : {}),
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
