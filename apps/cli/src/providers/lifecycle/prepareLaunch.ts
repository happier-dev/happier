import {
  BackendTargetKeyV2InputSchema,
  ConnectedServiceBindingsV1Schema,
  SessionModelSelectionV1Schema,
  SessionProviderBindingSecurityChangeConfirmationV1Schema,
  buildBackendTargetKeyV2,
  createProviderErrorV1,
  readBackendTargetRefV2,
  type BackendTargetRefV2Input,
  type ConnectedServiceBindingsV1,
  type ProviderErrorV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
  type SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import {
  filterSuppressedConnectedServiceBindings,
  type ProviderSpawnAuthorizationAttempt,
} from '../spawn/authorize';
import { resolveSpawnBindingContinuity } from '../sessions/resolveSpawnBindingContinuity';

type ProviderLaunchPrerequisiteContext = Readonly<{
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
}>;

type CreateAuthorizationAttemptInput = Readonly<{
  selection: SessionModelSelectionV1;
  machineId: string;
  agentTargetKey: string;
  agentId: string;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>;

export type PreparedProviderLaunch = Readonly<{
  ok: true;
  kind: 'provider';
  agentTargetKey: string;
  attempt: ProviderSpawnAuthorizationAttempt;
  connectedServices: ConnectedServiceBindingsV1 | null;
  suppressedConnectedServiceIds: readonly string[];
}>;

export type PrepareProviderLaunchResult =
  | Readonly<{ ok: true; kind: 'native' }>
  | PreparedProviderLaunch
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

/**
 * Canonical Provider lifecycle preparation semantics shared by daemon and
 * direct terminal launch adapters. Resource ownership and late materialization
 * remain with the caller so the launch resource scope can own them exactly once.
 */
export async function prepareProviderLaunch(input: Readonly<{
  selection?: SessionModelSelectionV1;
  backendTarget: BackendTargetRefV2Input;
  machineId?: string;
  agentId: string | null;
  sessionId?: string;
  previousBinding: SessionProviderBindingMetadataV1 | null;
  confirmation: SessionProviderBindingSecurityChangeConfirmationV1 | null;
  confirmSecurityChange?: (
    confirmation: SessionProviderBindingSecurityChangeConfirmationV1,
  ) => Promise<boolean>;
  connectedServices: ConnectedServiceBindingsV1 | null;
  featureEnabled: boolean;
  resolvePrerequisites: (
    context: ProviderLaunchPrerequisiteContext,
  ) => Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  createAuthorizationAttempt: (
    context: CreateAuthorizationAttemptInput,
  ) => Promise<Readonly<
    | { ok: true; attempt: ProviderSpawnAuthorizationAttempt }
    | { ok: false; error: ProviderErrorV1 }
  >>;
}>): Promise<PrepareProviderLaunchResult> {
  const selection = input.selection ? SessionModelSelectionV1Schema.parse(input.selection) : undefined;
  if (!selection) {
    if (input.previousBinding) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_binding_changed', {
          connectionId: input.previousBinding.connectionId,
          ...(input.machineId ? { machineId: input.machineId } : {}),
        }),
      };
    }
    return { ok: true, kind: 'native' };
  }
  if (selection.ref.providerConnectionId === null) return { ok: true, kind: 'native' };
  const connectionId = selection.ref.providerConnectionId;

  const errorContext = {
    connectionId,
    ...(input.machineId ? { machineId: input.machineId } : {}),
  };
  if (!input.featureEnabled) {
    return { ok: false, error: createProviderErrorV1('provider_feature_disabled', errorContext) };
  }
  if (!input.machineId || !input.agentId) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  }

  const agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget));
  const normalizedSelectionTargetKey = BackendTargetKeyV2InputSchema.safeParse(
    selection.ref.agentTargetKey,
  );
  if (
    !normalizedSelectionTargetKey.success
    || normalizedSelectionTargetKey.data !== agentTargetKey
  ) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  }
  const canonicalSelection =
    normalizedSelectionTargetKey.data === selection.ref.agentTargetKey
      ? selection
      : {
          ...selection,
          ref: {
            ...selection.ref,
            agentTargetKey: normalizedSelectionTargetKey.data,
          },
        };

  const connectedServices = input.connectedServices === null
    ? null
    : ConnectedServiceBindingsV1Schema.safeParse(input.connectedServices);
  if (connectedServices !== null && !connectedServices.success) {
    return { ok: false, error: createProviderErrorV1('provider_settings_invalid', errorContext) };
  }

  const authorization = await input.createAuthorizationAttempt({
    selection: canonicalSelection,
    machineId: input.machineId,
    agentTargetKey,
    agentId: input.agentId,
    ...(input.previousBinding?.managedPurposeBindings
      ? {
          managedPurposeBindingSnapshot:
            input.previousBinding.managedPurposeBindings,
        }
      : {}),
  });
  if (!authorization.ok) return authorization;

  const sessionId = input.sessionId?.trim() ?? '';
  if (input.previousBinding && !sessionId) {
    authorization.attempt.cleanupOnFailure();
    return {
      ok: false,
      error: createProviderErrorV1('provider_binding_changed', errorContext),
    };
  }
  let continuity = resolveSpawnBindingContinuity({
    previous: input.previousBinding,
    next: authorization.attempt.authorization.sessionBindingMetadata,
    sessionId,
    confirmation: input.confirmation,
  });
  if (
    !continuity.ok
    && input.confirmation === null
    && input.confirmSecurityChange
    && input.previousBinding
    && input.previousBinding.connectionId
      === authorization.attempt.authorization.sessionBindingMetadata.connectionId
  ) {
    const exactConfirmation = SessionProviderBindingSecurityChangeConfirmationV1Schema.parse({
      v: 1,
      sessionId,
      connectionId: input.previousBinding.connectionId,
      previousBindingSecurityFingerprint: input.previousBinding.bindingSecurityFingerprint,
      nextBindingSecurityFingerprint:
        authorization.attempt.authorization.sessionBindingMetadata.bindingSecurityFingerprint,
    });
    let confirmed = false;
    try {
      confirmed = await input.confirmSecurityChange(exactConfirmation);
    } catch {
      confirmed = false;
    }
    if (confirmed) {
      continuity = resolveSpawnBindingContinuity({
        previous: input.previousBinding,
        next: authorization.attempt.authorization.sessionBindingMetadata,
        sessionId,
        confirmation: exactConfirmation,
      });
    }
  }
  if (!continuity.ok) {
    authorization.attempt.cleanupOnFailure();
    return continuity;
  }

  const isolated = connectedServices === null
    ? null
    : filterSuppressedConnectedServiceBindings({
        bindings: connectedServices.data,
        suppressConnectedServiceIds:
          authorization.attempt.authorization.support.authIsolation.suppressConnectedServiceIds,
      });
  if (authorization.attempt.deployment.kind === 'external') {
    const prerequisites = await input.resolvePrerequisites({
      agentTargetKey,
      connectionId,
      modelId: canonicalSelection.ref.modelId,
    });
    if (!prerequisites.ok) {
      authorization.attempt.cleanupOnFailure();
      return prerequisites;
    }
  }
  return {
    ok: true,
    kind: 'provider',
    agentTargetKey,
    attempt: authorization.attempt,
    connectedServices: isolated?.bindings ?? null,
    suppressedConnectedServiceIds: isolated?.suppressedServiceIds ?? [],
  };
}
