import { readSessionModelSelectionProviderConnectionId, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import type { AgentProviderBindingLaunchMaterializationV1, BackendTargetRefV2Input, ConnectedServiceBindingsV2, PluginExecutionScopeV1, ProviderErrorV1, SessionProviderBindingMetadataV1, SessionProviderBindingSecurityChangeConfirmationV1 } from '@happier-dev/protocol';

import { prepareProviderLaunch, type PrepareProviderLaunchInput } from './prepareLaunch';
import {
  createProviderLaunchResourceScope,
  type ProviderLaunchCleanup,
  type ProviderLaunchResource,
} from './resourceScope';
import type { ProviderSpawnAuthorizationAttempt } from '../spawn/authorize';
import type { ProviderSpawnAuthorization } from '../spawn/resolve';
import { isSessionControlEnvKey } from '@/session/runtime/control/sessionControlEnvironment';
import { logProviderUnexpectedFailure, traceRunPreparationPhase } from '@/providers/diagnostics';
import { ProviderOperationAbandonedError } from '../operationLifetime';
import { createProviderRedactionLease } from '../spawn/redaction';
import type { ManagedPurposeLaunchContext } from './managedPurposeLaunch';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ProviderBoundModelRef, SessionEnvOverlayV1 } from '@happier-dev/protocol';

type ProviderLaunchPrerequisiteContext = Readonly<{
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
}>;

type CreateAuthorizationAttemptContext = Readonly<{
  selection: SessionModelSelection;
  machineId: string;
  agentTargetKey: string;
  agentId: string;
}>;

async function cleanupAfterRefusal(cleanup: ProviderLaunchCleanup | null): Promise<void> {
  try {
    await cleanup?.();
  } catch (error) {
    logProviderUnexpectedFailure('launch', error);
  }
}

/** Host-private acquisition for one already admitted exact consumer. The
 * source owner retains catalog/currentness and supplies only scoped access. */
export type DirectManagedProviderEndpointPreparer = (input: Readonly<{
  signal?: AbortSignal;
  scope: PluginExecutionScopeV1;
  authorization: Extract<ProviderSpawnAuthorization, { deployment: { kind: 'managedLocal' } }>;
  /** Retain acquired resources before any fallible endpoint preparation. */
  registerCleanup: (cleanup: ProviderLaunchCleanup) => void;
}>) => Promise<Readonly<{
  normalizedUrl: string;
  downstreamBearer: string | null;
  revalidateBeforeCommit(signal?: AbortSignal): Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  cleanup: ProviderLaunchCleanup;
}>>;

function projectLaunchEnvironment(overlay: SessionEnvOverlayV1) {
    const environment: Record<string, string> = Object.create(null);
    const unsetEnvKeysByIdentity = new Map<string, string>();
    for (const entry of overlay) {
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

    return { environment: Object.freeze(environment), unsetEnvKeys: Object.freeze([...unsetEnvKeysByIdentity.values()]) };
}

export type DirectProviderLaunchResult<PrerequisiteFailure extends Readonly<{ ok: false }> = never> =
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
      additionalRedactionValues: readonly string[];
      revalidateBeforeCommit: (signal?: AbortSignal) => Promise<Readonly<
        { ok: true } | { ok: false; error: ProviderErrorV1 }
      >>;
      transferLaunchMaterializationCleanupOwnership: () => void;
      cleanupOnExit: ProviderLaunchCleanup | null;
    }>
  | Readonly<{
      ok: true;
      kind: 'managedPurpose';
      agentTargetKey: string;
      selection: ProviderBoundModelRef;
      connectedServices: ConnectedServiceBindingsV2;
      environment: Readonly<Record<string, string>>;
      unsetEnvKeys: readonly string[];
      providerBinding: AgentSessionProviderBinding;
      launchMaterialization: AgentProviderBindingLaunchMaterializationV1;
      sanitizeDiagnosticText: (value: string) => string;
      additionalRedactionValues: readonly string[];
      revalidateBeforeCommit(signal?: AbortSignal): Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
      cleanupOnExit: ProviderLaunchCleanup | null;
    }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>
  | PrerequisiteFailure;

/**
 * Direct/in-process half of the canonical Provider launch corridor. The caller
 * supplies the same prerequisite and authorization owners as daemon launch;
 * this function owns late materialization, final ticket revalidation, and
 * exact-once transfer of every Provider resource into the runtime lifetime.
 */
export async function prepareDirectProviderLaunch<PrerequisiteFailure extends Readonly<{ ok: false }> = never>(input: Readonly<{
  signal?: AbortSignal;
  selection?: SessionModelSelection;
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
  featureEnabled: PrepareProviderLaunchInput['featureEnabled'];
  managedPurposeContext?: ManagedPurposeLaunchContext;
}>, dependencies: Readonly<{
  resolvePrerequisites: (
    context: ProviderLaunchPrerequisiteContext,
  ) => Promise<Readonly<
    ({ ok: true } | { ok: false; error: ProviderErrorV1 } | PrerequisiteFailure) & {
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
}>): Promise<DirectProviderLaunchResult<PrerequisiteFailure>> {
  const scope = createProviderLaunchResourceScope();
  const trace = <T>(phase: Parameters<typeof traceRunPreparationPhase>[1], work: () => Promise<T>) =>
    traceRunPreparationPhase(input.scope.kind === 'execution_run' ? input.scope.executionRunId : undefined,
      phase, input.signal, work);
  try {
    dependencies.retainCleanup?.(scope.retire);
    for (const resource of dependencies.initialResources ?? []) scope.register(resource);
    const { scope: executionScope, ...providerLaunchInput } = input;
    const prepared = await trace('provider_authorization', () => prepareProviderLaunch<PrerequisiteFailure>({
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
        return result.ok ? { ok: true } : result;
      },
      createAuthorizationAttempt: dependencies.createAuthorizationAttempt,
    }));
    if (!prepared.ok) {
      await cleanupAfterRefusal(() => scope.release());
      return prepared;
    }
    if (prepared.kind === 'provider') {
      scope.register({ onFailure: prepared.attempt.cleanupOnFailure, onExit: () => {} });
      if ('materializeManagedEndpoint' in prepared.attempt && !dependencies.prepareManagedEndpoint) {
        await cleanupAfterRefusal(() => scope.release());
        return {
          ok: false,
          error: createProviderErrorV1('provider_managed_requires_daemon', {
            connectionId: (input.selection ? readSessionModelSelectionProviderConnectionId(input.selection) : null) ?? undefined,
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

    if (prepared.kind === 'managedPurpose') {
      if (executionScope.kind !== 'session' && executionScope.kind !== 'execution_run') {
        await cleanupAfterRefusal(() => scope.release());
        return { ok: false, error: createProviderErrorV1('provider_agent_runtime_unsupported') };
      }
      const materialized = await prepared.materialize(executionScope);
      if (!materialized.ok) { await cleanupAfterRefusal(() => scope.release()); return materialized; }
      scope.register(materialized.cleanup);
      const redaction = createProviderRedactionLease({ values: materialized.additionalRedactionValues });
      scope.register(redaction.close);
      scope.setSanitizer(redaction.redact);
      return { ok: true, kind: 'managedPurpose', agentTargetKey: prepared.agentTargetKey,
        selection: prepared.selection, connectedServices: materialized.connectedServices,
        ...projectLaunchEnvironment(materialized.environmentOverlay), providerBinding: materialized.providerBinding,
        launchMaterialization: materialized.providerBinding.materialization,
        sanitizeDiagnosticText: redaction.redact, additionalRedactionValues: redaction.values(),
        revalidateBeforeCommit: materialized.revalidateBeforeCommit, cleanupOnExit: scope.transfer() };
    }
    const attempt = prepared.attempt;
    let revalidateManagedEndpoint: Awaited<ReturnType<DirectManagedProviderEndpointPreparer>>['revalidateBeforeCommit'] | null = null;
    let materialized;
    if ('materializeManagedEndpoint' in attempt) {
      const current = await trace('provider_before_effect', () => attempt.revalidateBeforeEffect());
      if (!current.ok) { await cleanupAfterRefusal(() => scope.release()); return current; }
      let endpointCleanupRegistered = false;
      const endpoint = await trace('managed_endpoint', () => dependencies.prepareManagedEndpoint!({
        signal: input.signal,
        scope: input.scope, authorization: attempt.authorization,
        registerCleanup: cleanup => { scope.register(cleanup); endpointCleanupRegistered = true; },
      }));
      if (!endpointCleanupRegistered) scope.register(endpoint.cleanup);
      revalidateManagedEndpoint = endpoint.revalidateBeforeCommit;
      materialized = await trace('provider_materialization', () => attempt.materializeManagedEndpoint(endpoint));
    } else {
      materialized = await trace('provider_materialization', () => attempt.materializeAfterHooks());
    }
    if (!materialized.ok) {
      await cleanupAfterRefusal(() => scope.release());
      return materialized;
    }
    const sanitizeDiagnosticText = materialized.redactionLease.snapshotRedactor();
    scope.setSanitizer(sanitizeDiagnosticText);

    if (revalidateManagedEndpoint) {
      const current = await trace('endpoint_currentness', () => revalidateManagedEndpoint!(input.signal));
      if (!current.ok) { await cleanupAfterRefusal(() => scope.release()); return current; }
    }
    const commitAuthorization = await trace('provider_commit', () => attempt.revalidateBeforeCommit());
    if (!commitAuthorization.ok) {
      await cleanupAfterRefusal(() => scope.release());
      return commitAuthorization;
    }
    scope.register(attempt.takeCleanupOnExit());

    const { environment, unsetEnvKeys } = projectLaunchEnvironment(materialized.materialization.providerEnvironmentOverlay);

    const cleanupOnExit = scope.transfer();
    let launchMaterializationCleanupTransferred = false;
    const transferLaunchMaterializationCleanupOwnership = () => {
      if (launchMaterializationCleanupTransferred) return;
      launchMaterializationCleanupTransferred = true;
      attempt.transferLaunchMaterializationCleanupOwnership();
    };
    const revalidateBeforeCommit = async (signal?: AbortSignal): Promise<Readonly<
      { ok: true } | { ok: false; error: ProviderErrorV1 }
    >> => {
      try {
        if (revalidateManagedEndpoint) {
          const current = await revalidateManagedEndpoint(signal ?? input.signal);
          if (!current.ok) { await cleanupAfterRefusal(cleanupOnExit); return current; }
        }
        const authorization = await attempt.revalidateBeforeCommit(signal);
        if (!authorization.ok) await cleanupAfterRefusal(cleanupOnExit);
        return authorization;
      } catch (error) {
        await cleanupAfterRefusal(cleanupOnExit);
        if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: attempt.authorization.ticket.connectionId,
            machineId: attempt.authorization.ticket.machineId,
          }, error),
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
      unsetEnvKeys,
      launchMaterialization: materialized.materialization.launchMaterialization,
      bindingMetadata: attempt.authorization.sessionBindingMetadata,
      sanitizeDiagnosticText,
      additionalRedactionValues: materialized.redactionLease.values(),
      revalidateBeforeCommit,
      transferLaunchMaterializationCleanupOwnership,
      cleanupOnExit,
    };
  } catch (error) {
    await cleanupAfterRefusal(() => scope.release());
    if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
    const providerError = ProviderErrorV1Schema.safeParse(error);
    if (!providerError.success) logProviderUnexpectedFailure('launch', error);
    if (providerError.success) return { ok: false, error: providerError.data };
    const connectionId = (input.selection ? readSessionModelSelectionProviderConnectionId(input.selection) : null) ?? undefined;
    return {
      ok: false,
      error: createProviderErrorV1('agent_error', {
        ...(connectionId ? { connectionId } : {}),
        ...(input.machineId ? { machineId: input.machineId } : {}),
      }, error),
    };
  }
}
