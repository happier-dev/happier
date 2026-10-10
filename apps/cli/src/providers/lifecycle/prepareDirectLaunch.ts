import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import type { AgentProviderBindingLaunchMaterializationV1, BackendTargetRefV2Input, ConnectedServiceBindingsV2, PluginExecutionScopeV1, ProviderErrorV1, SessionModelSelectionV1, SessionProviderBindingMetadataV1, SessionProviderBindingSecurityChangeConfirmationV1 } from '@happier-dev/protocol';

import { prepareProviderLaunch } from './prepareLaunch';
import {
  createProviderLaunchResourceScope,
  type ProviderLaunchCleanup,
  type ProviderLaunchResource,
} from './resourceScope';
import type { ProviderSpawnAuthorizationAttempt } from '../spawn/authorize';
import type { ProviderSpawnAuthorization } from '../spawn/resolve';
import { isSessionControlEnvKey } from '@/session/runtime/control/sessionControlEnvironment';

type ProviderLaunchPrerequisiteContext = Readonly<{
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
}>;

type CreateAuthorizationAttemptContext = Readonly<{
  selection: SessionModelSelectionV1;
  machineId: string;
  agentTargetKey: string;
  agentId: string;
}>;

/** Host-private acquisition for one already admitted exact consumer. The
 * source owner retains catalog/currentness and supplies only scoped access. */
export type DirectManagedProviderEndpointPreparer = (input: Readonly<{
  scope: PluginExecutionScopeV1;
  authorization: Extract<ProviderSpawnAuthorization, { deployment: { kind: 'managedLocal' } }>;
  /** Retain acquired resources before any fallible endpoint preparation. */
  registerCleanup: (cleanup: ProviderLaunchCleanup) => void;
}>) => Promise<Readonly<{
  normalizedUrl: string;
  downstreamBearer: string | null;
  revalidateBeforeCommit(): Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  cleanup: ProviderLaunchCleanup;
}>>;

export type DirectProviderLaunchResult =
  | Readonly<{
      ok: true;
      kind: 'native';
      environment: Readonly<Record<string, string>>;
      unsetEnvKeys: readonly string[];
      cleanupOnExit: ProviderLaunchCleanup | null;
    }>
  | Readonly<{
      ok: true;
      kind: 'provider';
      agentTargetKey: string;
      connectedServices: ConnectedServiceBindingsV2 | null;
      suppressedConnectedServiceIds: readonly string[];
      environment: Readonly<Record<string, string>>;
      unsetEnvKeys: readonly string[];
      launchMaterialization: AgentProviderBindingLaunchMaterializationV1;
      bindingMetadata: SessionProviderBindingMetadataV1;
      sanitizeDiagnosticText: (value: string) => string;
      revalidateBeforeCommit: () => Promise<Readonly<
        { ok: true } | { ok: false; error: ProviderErrorV1 }
      >>;
      transferLaunchMaterializationCleanupOwnership: () => void;
      cleanupOnExit: ProviderLaunchCleanup | null;
    }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

/**
 * Direct/in-process half of the canonical Provider launch corridor. The caller
 * supplies the same prerequisite and authorization owners as daemon launch;
 * this function owns late materialization, final ticket revalidation, and
 * exact-once transfer of every Provider resource into the runtime lifetime.
 */
export async function prepareDirectProviderLaunch(input: Readonly<{
  selection?: SessionModelSelectionV1;
  backendTarget: BackendTargetRefV2Input;
  machineId?: string;
  agentId: string | null;
  scope: PluginExecutionScopeV1;
  previousBinding: SessionProviderBindingMetadataV1 | null;
  confirmation: SessionProviderBindingSecurityChangeConfirmationV1 | null;
  confirmSecurityChange?: (
    confirmation: SessionProviderBindingSecurityChangeConfirmationV1,
  ) => Promise<boolean>;
  connectedServices: ConnectedServiceBindingsV2 | null;
  featureEnabled: boolean;
}>, dependencies: Readonly<{
  resolvePrerequisites: (
    context: ProviderLaunchPrerequisiteContext,
  ) => Promise<Readonly<
    ({ ok: true } | { ok: false; error: ProviderErrorV1 }) & {
      cleanupOnFailure?: ProviderLaunchCleanup | null;
      cleanupOnExit?: ProviderLaunchCleanup | null;
    }
  >>;
  createAuthorizationAttempt: (
    context: CreateAuthorizationAttemptContext,
  ) => Promise<Readonly<
    | { ok: true; attempt: ProviderSpawnAuthorizationAttempt }
    | { ok: false; error: ProviderErrorV1 }
  >>;
  initialResources?: readonly ProviderLaunchResource[];
  prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
  /** The actual runtime retains this scope even if preparation rejects. */
  retainCleanup?: (cleanup: ProviderLaunchCleanup) => void;
}>): Promise<DirectProviderLaunchResult> {
  const scope = createProviderLaunchResourceScope();
  try {
    dependencies.retainCleanup?.(scope.retire);
    for (const resource of dependencies.initialResources ?? []) scope.register(resource);
    const { scope: executionScope, ...providerLaunchInput } = input;
    const prepared = await prepareProviderLaunch({
      ...providerLaunchInput,
      ...(executionScope.kind === 'session' ? { sessionId: executionScope.sessionId } : {}),
      resolvePrerequisites: async (context) => {
        const result = await dependencies.resolvePrerequisites(context);
        if (result.cleanupOnFailure || result.cleanupOnExit) {
          scope.register({
            onFailure: result.cleanupOnFailure ?? (() => {}),
            onExit: result.cleanupOnExit ?? (() => {}),
          });
        }
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      createAuthorizationAttempt: dependencies.createAuthorizationAttempt,
    });
    if (!prepared.ok) {
      await scope.release();
      return prepared;
    }
    if (prepared.kind === 'provider') {
      scope.register({ onFailure: prepared.attempt.cleanupOnFailure, onExit: () => {} });
      if ('materializeManagedEndpoint' in prepared.attempt && !dependencies.prepareManagedEndpoint) {
        await scope.release();
        return {
          ok: false,
          error: createProviderErrorV1('provider_managed_requires_daemon', {
            connectionId: input.selection?.ref.providerConnectionId ?? undefined,
            ...(input.machineId ? { machineId: input.machineId } : {}),
          }),
        };
      }
    }
    if (prepared.kind === 'native') {
      await scope.release();
      return {
        ...prepared,
        environment: Object.freeze({}),
        unsetEnvKeys: Object.freeze([]),
        cleanupOnExit: null,
      };
    }

    const attempt = prepared.attempt;
    let revalidateManagedEndpoint: Awaited<ReturnType<DirectManagedProviderEndpointPreparer>>['revalidateBeforeCommit'] | null = null;
    let materialized;
    if ('materializeManagedEndpoint' in attempt) {
      const current = await attempt.revalidateBeforeEffect();
      if (!current.ok) { await scope.release(); return current; }
      let endpointCleanupRegistered = false;
      const endpoint = await dependencies.prepareManagedEndpoint!({
        scope: input.scope, authorization: attempt.authorization,
        registerCleanup: cleanup => { scope.register(cleanup); endpointCleanupRegistered = true; },
      });
      if (!endpointCleanupRegistered) scope.register(endpoint.cleanup);
      revalidateManagedEndpoint = endpoint.revalidateBeforeCommit;
      materialized = await attempt.materializeManagedEndpoint(endpoint);
    } else {
      materialized = await attempt.materializeAfterHooks();
    }
    if (!materialized.ok) {
      await scope.release();
      return materialized;
    }
    const sanitizeDiagnosticText = materialized.redactionLease.snapshotRedactor();
    scope.setSanitizer(sanitizeDiagnosticText);

    if (revalidateManagedEndpoint) {
      const current = await revalidateManagedEndpoint();
      if (!current.ok) { await scope.release(); return current; }
    }
    const commitAuthorization = await attempt.revalidateBeforeCommit();
    if (!commitAuthorization.ok) {
      await scope.release();
      return commitAuthorization;
    }
    scope.register(attempt.takeCleanupOnExit());

    const environment: Record<string, string> = Object.create(null);
    const unsetEnvKeysByIdentity = new Map<string, string>();
    for (const entry of materialized.materialization.providerEnvironmentOverlay) {
      if (isSessionControlEnvKey(entry.name)) continue;
      const identity = entry.name.toLowerCase();
      for (const existingName of Object.keys(environment)) {
        if (existingName.toLowerCase() === identity) delete environment[existingName];
      }
      if (entry.value === null) unsetEnvKeysByIdentity.set(identity, entry.name);
      else {
        unsetEnvKeysByIdentity.delete(identity);
        environment[entry.name] = entry.value;
      }
    }

    const cleanupOnExit = scope.transfer();
    let launchMaterializationCleanupTransferred = false;
    const transferLaunchMaterializationCleanupOwnership = () => {
      if (launchMaterializationCleanupTransferred) return;
      launchMaterializationCleanupTransferred = true;
      attempt.transferLaunchMaterializationCleanupOwnership();
    };
    const revalidateBeforeCommit = async (): Promise<Readonly<
      { ok: true } | { ok: false; error: ProviderErrorV1 }
    >> => {
      try {
        if (revalidateManagedEndpoint) {
          const current = await revalidateManagedEndpoint();
          if (!current.ok) { await cleanupOnExit?.(); return current; }
        }
        const authorization = await attempt.revalidateBeforeCommit();
        if (!authorization.ok) await cleanupOnExit?.();
        return authorization;
      } catch {
        await cleanupOnExit?.();
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: attempt.authorization.ticket.connectionId,
            machineId: attempt.authorization.ticket.machineId,
          }),
        };
      }
    };

    return {
      ok: true,
      kind: 'provider',
      agentTargetKey: prepared.agentTargetKey,
      connectedServices: prepared.connectedServices,
      suppressedConnectedServiceIds: prepared.suppressedConnectedServiceIds,
      environment: Object.freeze(environment),
      unsetEnvKeys: Object.freeze([...unsetEnvKeysByIdentity.values()]),
      launchMaterialization: materialized.materialization.launchMaterialization,
      bindingMetadata: attempt.authorization.sessionBindingMetadata,
      sanitizeDiagnosticText,
      revalidateBeforeCommit,
      transferLaunchMaterializationCleanupOwnership,
      cleanupOnExit,
    };
  } catch (error) {
    await scope.release();
    const providerError = ProviderErrorV1Schema.safeParse(error);
    if (providerError.success) return { ok: false, error: providerError.data };
    const connectionId = input.selection?.ref.providerConnectionId ?? undefined;
    return {
      ok: false,
      error: createProviderErrorV1('provider_agent_runtime_unsupported', {
        ...(connectionId ? { connectionId } : {}),
        ...(input.machineId ? { machineId: input.machineId } : {}),
      }),
    };
  }
}
