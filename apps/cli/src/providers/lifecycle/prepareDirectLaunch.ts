import {
  createProviderErrorV1,
  type AgentProviderBindingLaunchMaterializationV1,
  type BackendTargetRefV2Input,
  type ConnectedServiceBindingsV1,
  type ProviderErrorV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
  type SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import { prepareProviderLaunch } from './prepareLaunch';
import {
  createProviderLaunchResourceScope,
  type ProviderLaunchCleanup,
  type ProviderLaunchResource,
} from './resourceScope';
import type { ProviderSpawnAuthorizationAttempt } from '../spawn/authorize';
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
      connectedServices: ConnectedServiceBindingsV1 | null;
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
  sessionId: string;
  previousBinding: SessionProviderBindingMetadataV1 | null;
  confirmation: SessionProviderBindingSecurityChangeConfirmationV1 | null;
  confirmSecurityChange?: (
    confirmation: SessionProviderBindingSecurityChangeConfirmationV1,
  ) => Promise<boolean>;
  connectedServices: ConnectedServiceBindingsV1 | null;
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
}>): Promise<DirectProviderLaunchResult> {
  const scope = createProviderLaunchResourceScope();
  try {
    for (const resource of dependencies.initialResources ?? []) scope.register(resource);
    const prepared = await prepareProviderLaunch({
      ...input,
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
      if ('materializeManagedEndpoint' in prepared.attempt) {
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
    if (!('materializeAfterHooks' in attempt)) {
      await scope.release();
      return {
        ok: false,
        error: createProviderErrorV1('provider_managed_requires_daemon', {
          connectionId: input.selection?.ref.providerConnectionId ?? undefined,
          ...(input.machineId ? { machineId: input.machineId } : {}),
        }),
      };
    }
    const materialized = await attempt.materializeAfterHooks();
    if (!materialized.ok) {
      await scope.release();
      return materialized;
    }
    const sanitizeDiagnosticText = materialized.redactionLease.snapshotRedactor();
    scope.setSanitizer(sanitizeDiagnosticText);

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
