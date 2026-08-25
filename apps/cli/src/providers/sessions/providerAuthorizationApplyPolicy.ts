import {
  createProviderManagedRuntimeBindingEqualityKeyV1,
  sessionProviderBindingMetadataMatchesRuntimeBasisV1,
  type ModelSelectionApplyPolicy,
  type ProviderBoundModelRef,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';

import type { ProviderSpawnAuthorization } from '../spawn/resolve';
import { projectProviderRuntimeBindingBasis } from '../spawn/runtimeBindingBasis';

export type ProviderAuthorizationApplyPolicyInput = Readonly<{
  current: ProviderSpawnAuthorization;
  next: ProviderSpawnAuthorization;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function canonicalRuntimeBindingBasis(
  basis: ProviderRuntimeBindingBasisV1,
): unknown {
  if (basis.deployment.kind !== 'managedLocal') {
    return canonicalize(basis);
  }
  const {
    implementationIdentity,
    managedRuntime,
    purposeBindings,
    ...deployment
  } = basis.deployment;
  return canonicalize(
    {
      ...basis,
      deployment: {
        ...deployment,
        managedRuntimeBindingEqualityKey:
          createProviderManagedRuntimeBindingEqualityKeyV1({
            implementationIdentity,
            managedRuntime,
            purposeBindings,
          }),
      },
    },
  );
}

export function sameProviderAuthorizationRuntimeBindingDimensions(
  left: ProviderSpawnAuthorization,
  right: ProviderSpawnAuthorization,
): boolean {
  return sameProviderRuntimeBindingBasis(
    projectProviderRuntimeBindingBasis(left),
    projectProviderRuntimeBindingBasis(right),
  );
}

export function sameProviderRuntimeBindingBasis(
  left: ProviderRuntimeBindingBasisV1,
  right: ProviderRuntimeBindingBasisV1,
): boolean {
  return JSON.stringify(canonicalRuntimeBindingBasis(left))
    === JSON.stringify(canonicalRuntimeBindingBasis(right));
}

export function activeProviderBindingMetadataMatchesRuntimeBasis(
  input: Readonly<{
    activeSelection: ProviderBoundModelRef;
    activeSessionBindingMetadata: SessionProviderBindingMetadataV1;
  }>,
): boolean {
  return sessionProviderBindingMetadataMatchesRuntimeBasisV1({
    selection: input.activeSelection,
    binding: input.activeSessionBindingMetadata,
  });
}

export function resolveProviderAuthorizationApplyPolicy(
  input: ProviderAuthorizationApplyPolicyInput,
): ModelSelectionApplyPolicy {
  const agentPolicy = input.next.support.applyPolicy;
  if (agentPolicy === 'unsupported') return 'unsupported';
  if (input.current.binding.agentTargetKey !== input.next.binding.agentTargetKey) {
    return 'unsupported';
  }
  if (
    input.current.binding.selection.connectionId
      !== input.next.binding.selection.connectionId
  ) {
    return 'restart_session';
  }
  if (agentPolicy !== 'live') return agentPolicy;
  return sameProviderAuthorizationRuntimeBindingDimensions(
    input.current,
    input.next,
  )
    ? 'live'
    : 'restart_session';
}

export function resolveProviderAuthorizationApplyPolicyForActiveBinding(
  input: Readonly<{
    activeSelection: ProviderBoundModelRef;
    activeSessionBindingMetadata: SessionProviderBindingMetadataV1;
    next: ProviderSpawnAuthorization;
  }>,
): ModelSelectionApplyPolicy {
  const nextBinding = input.next.binding;
  const agentPolicy = input.next.support.applyPolicy;
  if (agentPolicy === 'unsupported') return 'unsupported';
  if (input.activeSelection.agentTargetKey !== nextBinding.agentTargetKey) {
    return 'unsupported';
  }
  if (
    input.activeSelection.providerConnectionId
      !== nextBinding.selection.connectionId
  ) {
    return 'restart_session';
  }
  if (agentPolicy !== 'live') return agentPolicy;

  const activeBasis =
    input.activeSessionBindingMetadata.runtimeBindingBasis;
  if (
    !activeBasis
    || !activeProviderBindingMetadataMatchesRuntimeBasis(input)
  ) {
    return 'restart_session';
  }
  return sameProviderRuntimeBindingBasis(
    activeBasis,
    projectProviderRuntimeBindingBasis(input.next),
  )
    ? 'live'
    : 'restart_session';
}
