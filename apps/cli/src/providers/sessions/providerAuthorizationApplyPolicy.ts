import {
  compareProviderCanonicalStringsV1,
  type ModelSelectionApplyPolicy,
  type ProviderBoundModelRef,
  type ProviderManagedDeploymentSecurityFactsV1,
  type ProviderRuntimeBindingBasisV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
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

function canonicalManagedPurposeBindingList(
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1,
): QualifiedConnectedAccountPurposeBindingsV1['bindings'] {
  return [...purposeBindings.bindings].sort((left, right) =>
    compareProviderCanonicalStringsV1(JSON.stringify(left), JSON.stringify(right)),
  );
}

function canonicalManagedPurposeBindings(
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 | undefined,
): string | null {
  return purposeBindings
    ? JSON.stringify(canonicalManagedPurposeBindingList(purposeBindings))
    : null;
}

function canonicalManagedConnectedAccounts(
  connectedAccounts: ProviderManagedDeploymentSecurityFactsV1['connectedAccounts'],
): ProviderManagedDeploymentSecurityFactsV1['connectedAccounts'] {
  // Purpose ids are unique within one consumer by schema, so purpose is the
  // complete canonical order key while the full declaration remains identity.
  return connectedAccounts.map((declaration) => ({
    ...declaration,
    ...(declaration.materializationKinds !== undefined
      ? {
          materializationKinds: [...declaration.materializationKinds].sort(
            compareProviderCanonicalStringsV1,
          ),
        }
      : {}),
  })).sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
}

function canonicalManagedRequestAuthUses(
  requestAuthUses: ProviderManagedDeploymentSecurityFactsV1['requestAuthUses'],
): ProviderManagedDeploymentSecurityFactsV1['requestAuthUses'] {
  return [...requestAuthUses].sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
}

function canonicalRuntimeBindingBasis(
  basis: ProviderRuntimeBindingBasisV1,
): unknown {
  return canonicalize(
    basis.deployment.kind === 'managedLocal'
      ? {
          ...basis,
          deployment: {
            ...basis.deployment,
            securityFacts: {
              ...basis.deployment.securityFacts,
              connectedAccounts: canonicalManagedConnectedAccounts(
                basis.deployment.securityFacts.connectedAccounts,
              ),
              requestAuthUses: canonicalManagedRequestAuthUses(
                basis.deployment.securityFacts.requestAuthUses,
              ),
            },
            purposeBindings: {
              ...basis.deployment.purposeBindings,
              bindings: canonicalManagedPurposeBindingList(
                basis.deployment.purposeBindings,
              ),
            },
          },
        }
      : basis,
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
  const activeBasis =
    input.activeSessionBindingMetadata.runtimeBindingBasis;
  if (!activeBasis) return false;
  return input.activeSelection.agentTargetKey === activeBasis.agentTargetKey
    && input.activeSelection.providerConnectionId
      === activeBasis.connectionId
    && input.activeSessionBindingMetadata.connectionId
      === activeBasis.connectionId
    && input.activeSessionBindingMetadata.contributionKey
      === activeBasis.contributionKey
    && input.activeSessionBindingMetadata.protocol
      === activeBasis.endpoint.protocol
    && input.activeSessionBindingMetadata.materialization
      === activeBasis.prepared.materialization
    && (input.activeSessionBindingMetadata.adapterBindingKey ?? null)
      === (activeBasis.prepared.adapterBindingKey ?? null)
    && canonicalManagedPurposeBindings(
      input.activeSessionBindingMetadata.managedPurposeBindings,
    )
      === (
        activeBasis.deployment.kind === 'managedLocal'
          ? canonicalManagedPurposeBindings(
              activeBasis.deployment.purposeBindings,
            )
          : null
      );
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
