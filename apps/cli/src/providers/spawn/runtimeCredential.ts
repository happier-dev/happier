import {
  createProviderErrorV1,
  type ProviderCredentialTransportV1,
} from '@happier-dev/protocol';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderProbeCredential } from '../probe/client';

import {
  resolveProviderCredentialPlaintext,
  type ProviderProbeHostCredentialReference,
} from './credentials';
import { createProviderRedactionLease } from './redaction';

export function renderProviderProbeCredential(
  value: string,
  transport: ProviderCredentialTransportV1,
): ProviderProbeCredential {
  const format = transport.destination.format;
  const rendered = format === 'raw'
    ? value
    : format === 'bearer'
      ? `Bearer ${value}`
      : format.template.replace('{secret}', value);
  return { kind: transport.destination.kind, name: transport.destination.name, value: rendered };
}

export async function resolveRuntimeProviderCredential(
  input: Readonly<{
    credentialRef: ProviderProbeHostCredentialReference;
    getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  }>,
) {
  let snapshot: ReturnType<typeof input.getAccountSettingsSnapshot>;
  try {
    snapshot = input.getAccountSettingsSnapshot();
  } catch {
    return {
      ok: false as const,
      error: createProviderErrorV1('provider_secret_missing', {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }),
    };
  }
  if (!snapshot) {
    return {
      ok: false as const,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }),
    };
  }
  try {
    const resolved = resolveProviderCredentialPlaintext({
      reference: input.credentialRef.reference,
      accountSettings: snapshot.settings,
      settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
      connectionId: input.credentialRef.connectionId,
      machineId: input.credentialRef.machineId,
    });
    if (!resolved.ok) return resolved;
    if (resolved.credential.kind !== 'apiKey') {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_secret_missing', {
          connectionId: input.credentialRef.connectionId,
          machineId: input.credentialRef.machineId,
        }),
      };
    }
    const credential = renderProviderProbeCredential(resolved.credential.value, input.credentialRef.transport);
    const redaction = createProviderRedactionLease({
      values: credential.value === resolved.credential.value
        ? [resolved.credential.value]
        : [resolved.credential.value, credential.value],
    });
    return {
      ok: true as const,
      lease: Object.freeze({
        credential,
        redact: redaction.redact,
        close: redaction.close,
      }),
    };
  } catch {
    return {
      ok: false as const,
      error: createProviderErrorV1('provider_secret_missing', {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }),
    };
  }
}
