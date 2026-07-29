import {
  createProviderErrorV1,
  createProviderSavedSecretRecordFingerprintV1,
  decryptSecretValueWithKeysV1,
  resolveProviderSecretBindingIdV1,
  type ProviderConnectionId,
  type ProviderCredentialTransportV1,
  type ProviderErrorV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';
import type { ProviderProbeAuthorizationRequest } from '../probe/authorization';

export type ProviderCredentialReference =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'apiKey';
      secretId: string;
      secretRecordFingerprint: string;
    }>;

export type ProviderProbeHostCredentialReference = Readonly<{
  connectionId: ProviderConnectionId;
  machineId: string;
  reference: ProviderCredentialReference;
  transport: ProviderCredentialTransportV1;
  protocol: ProviderProbeAuthorizationRequest['protocol'];
}>;

type ProviderCredentialReferenceResult =
  | Readonly<{ ok: true; reference: ProviderCredentialReference }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export function resolveProviderCredentialReference(input: Readonly<{
  providerSettings: ProviderSettingsV1;
  accountSettings: unknown;
  connectionId: ProviderConnectionId | string;
  machineId: string;
  credentialSlotId: string;
  required: boolean;
}>): ProviderCredentialReferenceResult {
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  const secretId = resolveProviderSecretBindingIdV1(
    input.providerSettings,
    input.connectionId,
    input.machineId,
    input.credentialSlotId,
  );
  if (secretId === null) {
    return input.required
      ? { ok: false, error: createProviderErrorV1('provider_secret_missing', context) }
      : { ok: true, reference: { kind: 'none' } };
  }
  const secret = indexSavedSecretsByIdFromAccountSettings(input.accountSettings).get(secretId);
  if (!secret?.encryptedValue) {
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  return {
    ok: true,
    reference: {
      kind: 'apiKey',
      secretId,
      secretRecordFingerprint: createProviderSavedSecretRecordFingerprintV1({
        secretId,
        persistedEncryptedEnvelope: secret.encryptedValue,
      }),
    },
  };
}

export type ProviderResolvedCredential =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'apiKey'; value: string }>;

export type ProviderCredentialPlaintextResultForSpawn =
  | Readonly<{ ok: true; credential: ProviderResolvedCredential }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export function resolveProviderCredentialPlaintext(input: Readonly<{
  reference: ProviderCredentialReference;
  accountSettings: unknown;
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
  connectionId: ProviderConnectionId | string;
  machineId: string;
}>): ProviderCredentialPlaintextResultForSpawn {
  if (input.reference.kind === 'none') return { ok: true, credential: { kind: 'none' } };
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  const secret = indexSavedSecretsByIdFromAccountSettings(input.accountSettings).get(input.reference.secretId);
  if (!secret?.encryptedValue) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  const currentFingerprint = createProviderSavedSecretRecordFingerprintV1({
    secretId: input.reference.secretId,
    persistedEncryptedEnvelope: secret.encryptedValue,
  });
  if (currentFingerprint !== input.reference.secretRecordFingerprint) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  const value = decryptSecretValueWithKeysV1(secret, input.settingsSecretsReadKeys);
  if (!value) return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  return { ok: true, credential: { kind: 'apiKey', value } };
}
