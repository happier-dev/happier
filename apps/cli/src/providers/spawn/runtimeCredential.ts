import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ProviderErrorV1, ProviderSettingsV1, ProviderCredentialTransportV1 } from '@happier-dev/protocol';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderProbeCredential } from '../probe/client';
import type { ResolvedProviderConnectionRecord } from '../registry/types';
import { awaitWithinProviderOperation, ProviderOperationAbandonedError, type ProviderOperationLifetime } from '../operationLifetime';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import {
  resolveProviderCredentialPlaintext,
  resolveProviderCredentialPlaintextAsync,
  type ProviderProbeHostCredentialReference,
} from './credentials';
import { TeamCredentialDirectMaterialOperationError } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createProviderRedactionLease } from './redaction';

/** Refresh only the selected shared credential at a new Provider operation's admission. */
export async function admitRuntimeProviderSavedSecret(input: Readonly<{
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  snapshot: ActiveAccountSettingsSnapshot;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  lifetime: ProviderOperationLifetime;
}>): Promise<Readonly<
  | { ok: true; snapshot: ActiveAccountSettingsSnapshot }
  | { ok: false; error: ProviderErrorV1 }
>> {
  const { connection, snapshot } = input;
  const context = { connectionId: connection.connectionId, machineId: connection.machineId };
  if (!connection.authorization.authorized) {
    return { ok: false, error: createProviderErrorV1(connection.authorization.errorCode, context) };
  }
  if (connection.deployment.kind === 'managedLocal') return { ok: true, snapshot };
  const credential = connection.source.kind === 'contribution'
    ? connection.source.definition.credential
    : connection.source.template.credential;
  if (!credential) return { ok: true, snapshot };
  try {
    const ref = resolveProviderSecretBindingIdV1(
      input.providerSettings, connection.connectionId, connection.machineId, credential.slotId,
    );
    if (ref === null || parseSavedSecretRefV1(ref).kind !== 'shared_resource') {
      return { ok: true, snapshot };
    }
    if (!snapshot.scopeKey) {
      return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
    }
    const admitted = await awaitWithinProviderOperation(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: snapshot.scopeKey,
      references: [{ ref }],
      ...(input.lifetime.signal ? { signal: input.lifetime.signal } : {}),
    }), input.lifetime);
    const current = input.getAccountSettingsSnapshot();
    if (!current || current.scopeKey !== snapshot.scopeKey
      || current.settingsVersion !== snapshot.settingsVersion
      || admitted.settingsVersion !== snapshot.settingsVersion
      || admitted.settings !== snapshot.settings || current.settings !== snapshot.settings) {
      return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
    }
    return { ok: true, snapshot: admitted };
  } catch (error) {
    return { ok: false, error: createProviderErrorV1(
      error instanceof ProviderOperationAbandonedError ? 'provider_endpoint_unavailable' : 'provider_secret_missing',
      context,
    ) };
  }
}

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
    openTeamDirect?: Parameters<typeof resolveProviderCredentialPlaintextAsync>[0]['openTeamDirect'];
  }>,
) {
  let snapshot: ReturnType<typeof input.getAccountSettingsSnapshot>;
  try {
    snapshot = input.getAccountSettingsSnapshot();
  } catch (error) {
    if (
      error instanceof TeamCredentialDirectMaterialOperationError
      || (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
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
    const common = {
      accountSettings: snapshot.settings,
      savedSecretResources: snapshot.savedSecretResources,
      settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
      connectionId: input.credentialRef.connectionId,
      machineId: input.credentialRef.machineId,
    };
    const resolved = input.credentialRef.reference.kind === 'team_direct'
      ? await resolveProviderCredentialPlaintextAsync({
          ...common,
          reference: input.credentialRef.reference,
          openTeamDirect: input.openTeamDirect,
        })
      : resolveProviderCredentialPlaintext({
          ...common,
          reference: input.credentialRef.reference,
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
        containsSensitiveValue: redaction.containsSensitiveValue,
        createStreamingSanitizer: redaction.createStreamingSanitizer,
        close: redaction.close,
      }),
    };
  } catch (error) {
    if (
      error instanceof TeamCredentialDirectMaterialOperationError
      || (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    return {
      ok: false as const,
      error: createProviderErrorV1('provider_secret_missing', {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }),
    };
  }
}
