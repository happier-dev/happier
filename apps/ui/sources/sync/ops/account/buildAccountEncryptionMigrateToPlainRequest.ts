import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { deriveSettingsSecretsKey, unsealSecretsDeep } from '@/sync/encryption/secretSettings';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import {
  AUTOMATION_TEMPLATE_ENVELOPE_KIND,
  encodeAutomationTemplateForTransport,
  tryDecodeAutomationTemplateEnvelope,
} from '@/sync/domains/automations/automationTemplateTransport';

import {
  AccountEncryptionMigrateRequestSchema,
  type AccountEncryptionMigrateRequest,
} from '@/sync/api/account/apiAccountEncryptionMigrate';

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

export async function buildAccountEncryptionMigrateToPlainRequest(params: Readonly<{
  credentials: AuthCredentials;
  expectedSettingsVersion: number;
  settings: Settings;
  connectedServiceProfiles: ReadonlyArray<Readonly<{ serviceId: ConnectedServiceId; profileId: string }>>;
  automations: ReadonlyArray<Readonly<{ id: string; templateCiphertext: string }>>;
  fetchConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<Readonly<{
    sealed: Readonly<{ format: string; ciphertext: string }>;
    metadata: ConnectedServiceCredentialMetadataInput;
  }>>;
  decryptAutomationTemplateRaw: (payloadCiphertext: string) => Promise<unknown | null>;
}>): Promise<AccountEncryptionMigrateRequest> {
  const seed = (() => {
    try {
      return isLegacyAuthCredentials(params.credentials)
        ? decodeBase64(params.credentials.secret, 'base64url')
        : decodeBase64(params.credentials.encryption.machineKey, 'base64');
    } catch {
      return null;
    }
  })();
  const secretsKey = seed && seed.length === 32
    ? await deriveSettingsSecretsKey(seed).catch(() => null)
    : null;

  const settingsForServer = stripLocalOnlyAccountSettings(params.settings);
  const plainSettings = unsealSecretsDeep(settingsForServer, secretsKey);

  const connectedServices = await (async () => {
    if (params.connectedServiceProfiles.length === 0) {
      return { action: 'assert_empty' as const };
    }

    const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
    const credentials: any[] = [];
    for (const profile of params.connectedServiceProfiles) {
      const fetched = await params.fetchConnectedServiceCredentialSealed({ serviceId: profile.serviceId, profileId: profile.profileId });
      const opened = openConnectedServiceCredentialCiphertext({ material, ciphertext: fetched.sealed.ciphertext });
      const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened.value);
      if (!recordParsed.success) {
        throw new Error(`Failed to open connected service credential (${profile.serviceId}/${profile.profileId})`);
      }
      const record: ConnectedServiceCredentialRecordV1 = recordParsed.data;
      credentials.push({
        serviceId: profile.serviceId,
        profileId: profile.profileId,
        kind: 'plain',
        record,
        metadata: fetched.metadata,
      });
    }
    return { action: 'migrate' as const, credentials };
  })();

  const automations = await (async () => {
    if (params.automations.length === 0) {
      return { action: 'assert_empty' as const };
    }

    const templates: any[] = [];
    for (const automation of params.automations) {
      const envelope = tryDecodeAutomationTemplateEnvelope(automation.templateCiphertext);
      if (!envelope) throw new Error(`Invalid automation template envelope (${automation.id})`);

      const rawPayload = envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND
        ? await params.decryptAutomationTemplateRaw(envelope.payloadCiphertext)
        : envelope.payload;

      const decoded = decodeAutomationTemplate(JSON.stringify(rawPayload));
      if (!decoded) throw new Error(`Invalid decrypted automation template payload (${automation.id})`);

      const requiresSensitiveEncryption =
        typeof (decoded as any).sessionEncryptionKeyBase64 === 'string' &&
        String((decoded as any).sessionEncryptionKeyBase64).trim().length > 0;
      if (requiresSensitiveEncryption) {
        templates.push({ automationId: automation.id, templateCiphertext: automation.templateCiphertext });
        continue;
      }

      const plainTemplateCiphertext = await encodeAutomationTemplateForTransport({
        accountMode: 'plain',
        template: decoded,
      });

      templates.push({ automationId: automation.id, templateCiphertext: plainTemplateCiphertext });
    }
    return { action: 'migrate' as const, templates };
  })();

  return AccountEncryptionMigrateRequestSchema.parse({
    toMode: 'plain',
    expectedSettingsVersion: params.expectedSettingsVersion,
    settingsContent: { t: 'plain', v: plainSettings },
    connectedServices,
    automations,
  });
}
