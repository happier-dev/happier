import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ProviderErrorV1, ProviderSettingsV1, ProviderCredentialTransportV1 } from '@happier-dev/protocol';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderProbeCredential } from '../probe/client';
import type { ResolvedProviderConnectionRecord } from '../registry/types';
import { awaitWithinProviderOperation, ProviderOperationAbandonedError, type ProviderOperationLifetime } from '../operationLifetime';
import { refreshSavedSecretCatalogAdmissionForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { SavedSecretOperationAdmissionError, assertSavedSecretOperationReferencesReady,
  acquireSavedSecretMaterializerForOperation,
  type SavedSecretCatalogOperationAdmissionV1 } from '@/settings/secrets/savedSecretCatalogRead';
import { createLaunchSecretReferenceOverlayProviderErrorV1 } from '@/settings/secrets/secretReferenceOverlay';
import {
  resolveProviderCredentialPlaintext,
  resolveProviderCredentialPlaintextAsync,
  type ProviderProbeHostCredentialReference,
} from './credentials';
import { TeamCredentialDirectMaterialOperationError } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createProviderRedactionLease } from './redaction';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import type { SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';

/**
 * The Saved Secret owner's admission outcome as a Provider refusal, through the
 * owner's launch projection. A failure without a typed reason means the Home
 * catalog could not be read, which is the owner's `reference_unavailable`.
 */
export function providerSavedSecretAdmissionError(
  error: unknown,
  context: Readonly<{ connectionId: string; machineId: string }>,
): ProviderErrorV1 {
  const reason = error instanceof SavedSecretOperationAdmissionError ? error.reason : 'reference_unavailable';
  return createLaunchSecretReferenceOverlayProviderErrorV1(reason, context);
}

/** Refresh only the selected shared credential at a new Provider operation's admission. */
export async function admitRuntimeProviderSavedSecret(input: Readonly<{
  connection: Pick<ResolvedProviderConnectionRecord, 'connectionId' | 'machineId' | 'authorization' | 'deployment' | 'source'>;
  providerSettings: ProviderSettingsV1;
  snapshot: ActiveAccountSettingsSnapshot;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  lifetime: ProviderOperationLifetime;
  operationContext?: SavedSecretOperationContextV1 | null;
  /** Required companions of the operation's canonically selected transport only. */
  additionalCredentials?: readonly Readonly<{ slotId: string }>[];
  /** The same operation's full-catalog read, before its transport was selected. */
  admittedCatalog?: SavedSecretCatalogOperationAdmissionV1;
}>): Promise<Readonly<
  | ({ ok: true } & SavedSecretCatalogOperationAdmissionV1)
  | { ok: false; error: ProviderErrorV1 }
>> {
  const { connection, snapshot } = input;
  const context = { connectionId: connection.connectionId, machineId: connection.machineId };
  if (!connection.authorization.authorized) {
    return { ok: false, error: createProviderErrorV1(connection.authorization.errorCode, context) };
  }
  if (connection.deployment.kind === 'managedLocal') return { ok: true, snapshot, catalogRead: false };
  const definition = connection.source.kind === 'contribution' ? connection.source.definition : connection.source.template;
  const credential = definition.credential;
  if (!credential) return { ok: true, snapshot, catalogRead: false };
  let references: { ref: string }[];
  try {
    const slotIds = [credential.slotId, ...(input.additionalCredentials ?? []).map(row => row.slotId)];
    references = [...new Set(slotIds)].flatMap(slotId => {
      const ref = resolveProviderSecretBindingIdV1(input.providerSettings, connection.connectionId, connection.machineId, slotId);
      return ref !== null && parseSavedSecretRefV1(ref).kind === 'shared_resource' ? [{ ref }] : [];
    });
  } catch {
    // An unparseable binding is a configuration fault, not a Home read.
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  if (!references.length) {
    return { ok: true, snapshot, catalogRead: false };
  }
  if (!snapshot.scopeKey || input.getAccountSettingsSnapshot()?.scopeKey !== snapshot.scopeKey) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  if (input.operationContext === null) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  try {
    const admission = await awaitWithinProviderOperation(input.admittedCatalog?.catalogRead
      ? Promise.resolve(input.admittedCatalog)
      : refreshSavedSecretCatalogAdmissionForOperation({
      expectedScopeKey: snapshot.scopeKey,
      references,
      ...(input.operationContext ? { operationContext: input.operationContext } : {}),
      ...(input.lifetime.signal ? { signal: input.lifetime.signal } : {}),
    }), input.lifetime);
    const admitted = admission.snapshot;
    const current = input.getAccountSettingsSnapshot();
    // Home admits this secret acquisition. An Account switch withdraws custody;
    // edits within that Account do not re-admit an already captured operation.
    if (admitted.scopeKey !== snapshot.scopeKey || current?.scopeKey !== snapshot.scopeKey) {
      return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
    }
    if (input.admittedCatalog?.catalogRead) assertSavedSecretOperationReferencesReady(admitted, references);
    return { ok: true, snapshot: { ...snapshot, savedSecretResources: admitted.savedSecretResources,
      savedSecretCatalogState: admitted.savedSecretCatalogState,
      settingsSecretsReadKeys: admitted.settingsSecretsReadKeys }, catalogRead: admission.catalogRead };
  } catch (error) {
    if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
    return { ok: false, error: providerSavedSecretAdmissionError(error, context) };
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
    sourceKind?: 'inline';
    secretSources?: TargetSecretSourcesV1;
    resolveSavedSecretMaterializer?: (signal?: AbortSignal) => Promise<SavedSecretMaterializerV1>;
    operationContext?: SavedSecretOperationContextV1;
    signal?: AbortSignal;
    openTeamDirect?: Parameters<typeof resolveProviderCredentialPlaintextAsync>[0]['openTeamDirect'];
  }>,
) {
  let snapshot: ProviderProbeHostCredentialReference['admittedSnapshot'] | null | undefined;
  try {
    const current = input.getAccountSettingsSnapshot();
    snapshot = input.credentialRef.admittedSnapshot ?? current;
    if (input.credentialRef.admittedSnapshot && (!current || current.scopeKey !== snapshot?.scopeKey)) snapshot = null;
  } catch (error) {
    if (
      error instanceof TeamCredentialDirectMaterialOperationError
      || error instanceof ProviderOperationAbandonedError
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
    const reference = input.credentialRef.reference;
    const savedSecretMaterializer = input.resolveSavedSecretMaterializer
      ? await input.resolveSavedSecretMaterializer(input.signal)
      : reference.kind === 'apiKey' ? await acquireSavedSecretMaterializerForOperation({
        snapshot,
        references: [{ ref: reference.secretId }, ...(reference.additionalCredentials ?? []).map(row => ({ ref: row.secretId }))],
        operationContext: input.operationContext ?? input.credentialRef.admittedOperationContext,
        signal: input.signal,
        sourceKind: input.sourceKind,
        secretSources: input.secretSources,
        isCurrent: () => input.getAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey && !input.signal?.aborted,
      }) : undefined;
    const common = {
      accountSettings: snapshot.settings,
      savedSecretResources: snapshot.savedSecretResources,
      settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
      connectionId: input.credentialRef.connectionId,
      machineId: input.credentialRef.machineId,
      savedSecretMaterializer,
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
    const primary = renderProviderProbeCredential(resolved.credential.value, input.credentialRef.transport);
    const additionalCredentials = (input.credentialRef.transport.additionalCredentials ?? []).map(declaration => {
      if (resolved.credential.kind !== 'apiKey') throw new Error('Provider credential disappeared');
      const material = resolved.credential.additionalCredentials?.find(row => row.slotId === declaration.slotId);
      if (!material) throw new Error('Provider companion credential is missing');
      return renderProviderProbeCredential(material.value, { ...input.credentialRef.transport, destination: declaration.destination });
    });
    const credential = { ...primary, ...(additionalCredentials.length ? { additionalCredentials } : {}) };
    const redaction = createProviderRedactionLease({
      values: [resolved.credential.value, credential.value,
        ...(resolved.credential.additionalCredentials ?? []).map(row => row.value), ...additionalCredentials.map(row => row.value)],
    });
    return {
      ok: true as const,
      lease: Object.freeze({
        credential,
        redact: redaction.redact,
        containsSensitiveValue: redaction.containsSensitiveValue,
        createStreamingSanitizer: redaction.createStreamingSanitizer,
        ...(additionalCredentials.length ? { registerSensitiveValues: redaction.add } : {}),
        close: redaction.close,
      }),
    };
  } catch (error) {
    if (
      error instanceof TeamCredentialDirectMaterialOperationError
      || error instanceof ProviderOperationAbandonedError
      || (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    return {
      ok: false as const,
      error: error instanceof SavedSecretOperationAdmissionError ? providerSavedSecretAdmissionError(error, {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }) : createProviderErrorV1('provider_secret_missing', {
        connectionId: input.credentialRef.connectionId,
        machineId: input.credentialRef.machineId,
      }),
    };
  }
}
