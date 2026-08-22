import { join } from 'node:path';

import type {
  ModelSelectionApplyPolicy,
  ProviderBoundModelRef,
  ProviderModelDescriptorV1,
  ProviderRuntimeBindingBasisV1,
  QualifiedConnectedAccountPurposeBindingsV1,
  SessionModelSelectionV1,
  SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';

import {
  activeProviderBindingMetadataMatchesRuntimeBasis,
  resolveProviderAuthorizationApplyPolicyForActiveBinding,
  sameProviderRuntimeBindingBasis,
} from './providerAuthorizationApplyPolicy';
import { projectProviderRuntimeBindingBasis } from '../spawn/runtimeBindingBasis';
import type { AuthorizedSessionModelTransitionTarget } from './sessionModelTransitionCoordinator';

function modelSelection(ref: ProviderBoundModelRef): SessionModelSelectionV1 {
  return { v: 1, updatedAt: Date.now(), ref };
}

export type SessionModelTransitionAuthorizationRoute =
  | Readonly<{ kind: 'restart' }>
  | Readonly<{
      kind: 'authorize_same_binding';
      managedPurposeBindingSnapshot?:
        NonNullable<
          AuthorizedSessionModelTransitionTarget['sessionBindingMetadata']
        >['managedPurposeBindings'];
    }>;

export type SessionModelTransitionAuthorizer = ((
  selection: ProviderBoundModelRef,
) => Promise<AuthorizedSessionModelTransitionTarget>) & Readonly<{
  bindCurrentAuthorizationProof: (
    target: AuthorizedSessionModelTransitionTarget,
  ) => AuthorizedSessionModelTransitionTarget;
}>;

export type SessionModelTransitionProviderTargetAuthorization = Readonly<{
  selection: ProviderBoundModelRef & Readonly<{ providerConnectionId: string }>;
  policy: ModelSelectionApplyPolicy;
  model: ProviderModelDescriptorV1;
  sessionBindingMetadata: SessionProviderBindingMetadataV1;
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
}>;

export type SessionModelTransitionProviderTargetAuthorizer = (
  input: Readonly<{
    selection: ProviderBoundModelRef & Readonly<{ providerConnectionId: string }>;
    activeSelection: ProviderBoundModelRef;
    activeSessionBindingMetadata: SessionProviderBindingMetadataV1;
    managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
  }>,
) => Promise<SessionModelTransitionProviderTargetAuthorization>;

export function resolveDaemonSessionModelTransitionAuthority(params: Readonly<{
  trackedAgentId: string | null;
  authorizedAgentId?: string | null;
  trackedSelection: ProviderBoundModelRef | null;
  trackedSessionBindingMetadata:
    SessionProviderBindingMetadataV1 | null;
  requestAgentId: string;
  requestedSelection:
    Parameters<SessionModelTransitionProviderTargetAuthorizer>[0]['selection'];
}>): Readonly<{
  agentId: string;
  agentTargetKey: string;
  input: Parameters<SessionModelTransitionProviderTargetAuthorizer>[0];
}> {
  const trackedAgentId = params.trackedAgentId
    ?? params.authorizedAgentId
    ?? null;
  const trackedSelection = params.trackedSelection;
  const trackedMetadata = params.trackedSessionBindingMetadata;
  if (
    trackedAgentId === null
    || trackedAgentId !== params.requestAgentId
    || trackedSelection === null
    || trackedSelection.providerConnectionId === null
    || params.requestedSelection.agentTargetKey
      !== trackedSelection.agentTargetKey
    || params.requestedSelection.providerConnectionId
      !== trackedSelection.providerConnectionId
    || trackedMetadata === null
    || !activeProviderBindingMetadataMatchesRuntimeBasis({
      activeSelection: trackedSelection,
      activeSessionBindingMetadata: trackedMetadata,
    })
  ) {
    throw new Error(
      'session_model_transition_daemon_authority_mismatch',
    );
  }
  return {
    agentId: trackedAgentId,
    agentTargetKey: trackedSelection.agentTargetKey,
    input: {
      selection: {
        ...trackedSelection,
        modelId: params.requestedSelection.modelId,
      },
      activeSelection: trackedSelection,
      activeSessionBindingMetadata: trackedMetadata,
      ...(trackedMetadata.managedPurposeBindings
        ? {
            managedPurposeBindingSnapshot:
              trackedMetadata.managedPurposeBindings,
          }
        : {}),
    },
  };
}

export async function authorizeDaemonSessionModelTransitionProviderTarget(
  params: Parameters<typeof resolveDaemonSessionModelTransitionAuthority>[0]
    & Readonly<{
      authorizeProviderTarget(
        authority: ReturnType<
          typeof resolveDaemonSessionModelTransitionAuthority
        >,
      ): Promise<SessionModelTransitionProviderTargetAuthorization>;
    }>,
): Promise<SessionModelTransitionProviderTargetAuthorization> {
  const authority = resolveDaemonSessionModelTransitionAuthority(params);
  return await params.authorizeProviderTarget(authority);
}

export async function authorizeSessionModelTransitionProviderTargetWithLease(
  params: Readonly<{
    sessionId: string;
    machineId: string;
    agentId: string;
    agentTargetKey: string;
    lease: PluginRuntimeRegistryLease;
    input: Parameters<SessionModelTransitionProviderTargetAuthorizer>[0];
  }>,
): Promise<SessionModelTransitionProviderTargetAuthorization> {
  const runtimeStateStore = createProviderRuntimeStateStore({
    happyHomeDir: configuration.happyHomeDir,
    machineId: params.machineId,
  });
  const result = await createRuntimeProviderSpawnAuthorizationAttempt({
    selection: modelSelection(params.input.selection),
    machineId: params.machineId,
    agentTargetKey: params.agentTargetKey,
    agentId: params.agentId,
    lease: params.lease,
    getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
    subscribeAccountSettingsSnapshot: (listener) =>
      subscribeActiveAccountSettingsSnapshot(() => listener()),
    runtimeStateStore,
    materializationBaseDir: join(
      configuration.happyHomeDir,
      'providers',
      'materialized',
    ),
    sessionId: params.sessionId,
    ...(params.input.managedPurposeBindingSnapshot
      ? {
          managedPurposeBindingSnapshot:
            params.input.managedPurposeBindingSnapshot,
        }
      : {}),
  });
  if (!result.ok) {
    throw new Error(result.error.code);
  }
  try {
    const authorization = result.attempt.authorization;
    return {
      selection: {
        agentTargetKey: authorization.binding.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse(
          authorization.binding.selection.connectionId,
        ),
        modelId: authorization.binding.selection.model.id,
      },
      policy: resolveProviderAuthorizationApplyPolicyForActiveBinding({
        activeSelection: params.input.activeSelection,
        activeSessionBindingMetadata:
          params.input.activeSessionBindingMetadata,
        next: authorization,
      }),
      model: authorization.binding.selection.model,
      sessionBindingMetadata: authorization.sessionBindingMetadata,
      runtimeBindingBasis:
        projectProviderRuntimeBindingBasis(authorization),
    };
  } finally {
    result.attempt.cleanupOnFailure();
  }
}

export function resolveSessionModelTransitionAuthorizationRoute(
  active: AuthorizedSessionModelTransitionTarget,
  selection: ProviderBoundModelRef,
): SessionModelTransitionAuthorizationRoute {
  if (
    selection.providerConnectionId === null
    || active.selection.providerConnectionId === null
    || active.selection.providerConnectionId
      !== selection.providerConnectionId
  ) {
    return { kind: 'restart' };
  }
  const metadata = active.sessionBindingMetadata;
  const basis = metadata?.runtimeBindingBasis;
  if (
    !metadata
    || !basis
    || active.runtimeBindingBasis === null
    || !sameProviderRuntimeBindingBasis(
      active.runtimeBindingBasis,
      basis,
    )
    || basis.agentTargetKey !== active.selection.agentTargetKey
    || basis.connectionId !== active.selection.providerConnectionId
  ) {
    return { kind: 'restart' };
  }
  if (basis.deployment.kind === 'external') {
    return { kind: 'authorize_same_binding' };
  }
  const snapshot = metadata.managedPurposeBindings;
  if (!snapshot) return { kind: 'restart' };
  return {
    kind: 'authorize_same_binding',
    managedPurposeBindingSnapshot: snapshot,
  };
}

export function createSessionModelTransitionAuthorizer(params: Readonly<{
  sessionId: string;
  machineId: string;
  agentId: string;
  agentTargetKey: string;
  nativeModelApplyPolicy: Extract<
    AuthorizedSessionModelTransitionTarget['policy'],
    'live' | 'restart_session' | 'unsupported'
  >;
  readActiveTarget: () => AuthorizedSessionModelTransitionTarget;
  authorizeProviderTarget?: SessionModelTransitionProviderTargetAuthorizer;
}>): SessionModelTransitionAuthorizer {
  const authorizeProviderTargetLocally:
    SessionModelTransitionProviderTargetAuthorizer = async (input) => {
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir,
      });
      try {
        return await authorizeSessionModelTransitionProviderTargetWithLease({
          sessionId: params.sessionId,
          machineId: params.machineId,
          agentId: params.agentId,
          agentTargetKey: params.agentTargetKey,
          lease,
          input,
        });
      } finally {
        await lease.release();
      }
    };
  const authorizeProviderTarget =
    params.authorizeProviderTarget ?? authorizeProviderTargetLocally;

  const bindCurrentAuthorizationProof = (
    target: AuthorizedSessionModelTransitionTarget,
  ): AuthorizedSessionModelTransitionTarget => {
    if (target.selection.providerConnectionId === null) {
      return {
        ...target,
        revalidateBeforeEffect: async () => true,
      };
    }
    const metadata = target.sessionBindingMetadata;
    const managedPurposeBindingSnapshot =
      metadata?.managedPurposeBindings;
    return {
      ...target,
      revalidateBeforeEffect: async () => {
        if (
          target.policy !== 'live'
          || target.providerBinding === null
          || metadata === null
          || target.runtimeBindingBasis === null
        ) {
          return false;
        }
        const refreshed = await authorizeProviderTarget({
          selection: target.selection as ProviderBoundModelRef & Readonly<{
            providerConnectionId: string;
          }>,
          activeSelection: target.selection,
          activeSessionBindingMetadata: metadata,
          ...(managedPurposeBindingSnapshot
            ? { managedPurposeBindingSnapshot }
            : {}),
        });
        return refreshed.policy === 'live'
          && refreshed.selection.agentTargetKey
            === target.selection.agentTargetKey
          && refreshed.selection.providerConnectionId
            === target.selection.providerConnectionId
          && refreshed.selection.modelId === target.selection.modelId
          && metadata.bindingSecurityFingerprint
            === refreshed.sessionBindingMetadata.bindingSecurityFingerprint;
      },
    };
  };

  const authorizeSelection = async (selection: ProviderBoundModelRef) => {
    const active = params.readActiveTarget();
    const restartTarget = (): AuthorizedSessionModelTransitionTarget => ({
      selection,
      policy: 'restart_session',
      providerBinding: null,
      sessionBindingMetadata: null,
      runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => false,
    });
    if (selection.providerConnectionId === null) {
      return bindCurrentAuthorizationProof({
        selection,
        policy: active.selection.providerConnectionId === null
          ? params.nativeModelApplyPolicy
          : 'restart_session',
        providerBinding: null,
        sessionBindingMetadata: null,
        runtimeBindingBasis: null,
        revalidateBeforeEffect: async () => true,
      });
    }

    const route = resolveSessionModelTransitionAuthorizationRoute(
      active,
      selection,
    );
    if (route.kind === 'restart') return restartTarget();
    const activeBindingMetadata = active.sessionBindingMetadata!;
    const managedPurposeBindingSnapshot =
      route.managedPurposeBindingSnapshot;

    let nextAuthorization:
      SessionModelTransitionProviderTargetAuthorization;
    try {
      nextAuthorization = await authorizeProviderTarget({
        selection: selection as ProviderBoundModelRef & Readonly<{
          providerConnectionId: string;
        }>,
        activeSelection: active.selection,
        activeSessionBindingMetadata: activeBindingMetadata,
        ...(managedPurposeBindingSnapshot
          ? { managedPurposeBindingSnapshot }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'provider_connection_invalid'
      ) {
        return restartTarget();
      }
      throw error;
    }

    if (
      nextAuthorization.selection.agentTargetKey
        !== selection.agentTargetKey
      || nextAuthorization.selection.providerConnectionId
        !== selection.providerConnectionId
      || nextAuthorization.selection.modelId !== selection.modelId
    ) {
      throw new Error(
        'session_model_transition_authorized_selection_mismatch',
      );
    }
    const policy = nextAuthorization.policy;
    const nextBasis = nextAuthorization.runtimeBindingBasis;
    const activeProviderBinding = active.providerBinding;
    const activeMetadataRuntimeBindingBasis =
      activeBindingMetadata.runtimeBindingBasis;
    const exactActiveSelection =
      active.selection.agentTargetKey === selection.agentTargetKey
      && active.selection.providerConnectionId
        === selection.providerConnectionId
      && active.selection.modelId === selection.modelId;
    const retainExactActivePublishedBindingFacts =
      (policy === 'live' || policy === 'restart_session')
      && exactActiveSelection
      && activeProviderBinding !== null
      && activeProviderBinding.connectionId
        === selection.providerConnectionId
      && activeProviderBinding.model.id === selection.modelId
      && active.runtimeBindingBasis !== null
      && activeMetadataRuntimeBindingBasis !== undefined
      && sameProviderRuntimeBindingBasis(
        active.runtimeBindingBasis,
        nextBasis,
      );
    const activeMaterialization =
      activeProviderBinding?.materialization ?? null;
    let sessionBindingMetadata =
      nextAuthorization.sessionBindingMetadata;
    if (retainExactActivePublishedBindingFacts) {
      const retainedMetadata = {
        ...nextAuthorization.sessionBindingMetadata,
        runtimeBindingBasis: activeMetadataRuntimeBindingBasis,
      };
      if (activeBindingMetadata.managedPurposeBindings) {
        retainedMetadata.managedPurposeBindings =
          activeBindingMetadata.managedPurposeBindings;
      } else {
        delete retainedMetadata.managedPurposeBindings;
      }
      sessionBindingMetadata = retainedMetadata;
    }
    return bindCurrentAuthorizationProof({
      selection,
      policy,
      providerBinding: (
        policy === 'live'
        || retainExactActivePublishedBindingFacts
      ) && activeMaterialization
        ? {
            connectionId: ProviderConnectionIdSchema.parse(
              nextAuthorization.selection.providerConnectionId,
            ),
            model: nextAuthorization.model,
            materialization: activeMaterialization,
          }
        : null,
      sessionBindingMetadata,
      runtimeBindingBasis: retainExactActivePublishedBindingFacts
        ? active.runtimeBindingBasis
        : nextBasis,
      revalidateBeforeEffect: async () => false,
    });
  };

  return Object.assign(authorizeSelection, {
    bindCurrentAuthorizationProof,
  });
}
