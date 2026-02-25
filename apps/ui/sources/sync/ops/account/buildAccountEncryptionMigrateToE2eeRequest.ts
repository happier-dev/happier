import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import {
  ConnectedServiceCredentialRecordV1Schema,
  sealAccountScopedBlobCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceId,
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
  AccountEncryptionMigrateRequestSchema,
  type AccountEncryptionMigrateRequest,
} from '@/sync/api/account/apiAccountEncryptionMigrate';

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

export async function buildAccountEncryptionMigrateToE2eeRequest(params: Readonly<{
  credentials: AuthCredentials;
  expectedSettingsVersion: number;
  settings: Settings;
  connectedServiceProfiles: ReadonlyArray<Readonly<{ serviceId: ConnectedServiceId; profileId: string }>>;
  automations: ReadonlyArray<Readonly<{ id: string; templateCiphertext: string }>>;
  fetchConnectedServiceCredentialPlain: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<Readonly<{
    content: Readonly<{ t: 'plain'; v: unknown }>;
    metadata?: ConnectedServiceCredentialMetadataInput;
  }>>;
}>): Promise<AccountEncryptionMigrateRequest> {
  if (!isLegacyAuthCredentials(params.credentials)) {
    throw new Error('Legacy credentials are required to migrate to e2ee');
  }

  const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  if (material.type !== 'legacy') {
    throw new Error('Legacy crypto material is required to migrate to e2ee');
  }

  const settingsForServer = stripLocalOnlyAccountSettings(params.settings);
  const settingsCiphertext = sealAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material,
    payload: settingsForServer,
    randomBytes: getRandomBytes,
  });

  const connectedServices = await (async () => {
    if (params.connectedServiceProfiles.length === 0) {
      return { action: 'assert_empty' as const };
    }

    const credentials: any[] = [];
    for (const profile of params.connectedServiceProfiles) {
      const fetched = await params.fetchConnectedServiceCredentialPlain({
        serviceId: profile.serviceId,
        profileId: profile.profileId,
      });
      if (!fetched?.content || fetched.content.t !== 'plain') {
        throw new Error(`Unexpected connected service credential envelope (${profile.serviceId}/${profile.profileId})`);
      }
      const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(fetched.content.v);
      if (!recordParsed.success) {
        throw new Error(`Failed to parse connected service credential record (${profile.serviceId}/${profile.profileId})`);
      }
      const record = recordParsed.data;
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
        metadata: {
          kind: record.kind,
          providerEmail,
          providerAccountId,
          expiresAt: record.expiresAt ?? null,
        },
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

      if (envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND) {
        templates.push({ automationId: automation.id, templateCiphertext: automation.templateCiphertext });
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

      templates.push({ automationId: automation.id, templateCiphertext: encryptedTemplateCiphertext });
    }
    return { action: 'migrate' as const, templates };
  })();

  return AccountEncryptionMigrateRequestSchema.parse({
    toMode: 'e2ee',
    expectedSettingsVersion: params.expectedSettingsVersion,
    settingsContent: { t: 'encrypted', c: settingsCiphertext },
    connectedServices,
    automations,
  });
}
