import type { InstallableDependencyDescriptor } from './descriptor.js';
import type {
  InstallableContributionOwner,
  InstallableRegistryDiagnostic,
} from './diagnostic.js';

export type InstallableRegistryContribution = Readonly<{
  owner: InstallableContributionOwner;
  descriptor: InstallableDependencyDescriptor;
}>;

export type InstallablesRegistry = Readonly<{
  descriptors: readonly InstallableRegistryContribution[];
  descriptorsByKey: Readonly<Record<string, InstallableRegistryContribution>>;
  descriptorsByCapabilityId: Readonly<Record<string, InstallableRegistryContribution>>;
  diagnostics: readonly InstallableRegistryDiagnostic[];
}>;

export type ResolveInstallablesRegistryInput = Readonly<{
  builtIns?: readonly InstallableRegistryContribution[];
  bundledFirstPartyPlugins?: readonly InstallableRegistryContribution[];
  externalPlugins?: readonly InstallableRegistryContribution[];
}>;

function ownerSortValue(owner: InstallableContributionOwner): number {
  switch (owner.provenance) {
    case 'built_in':
      return 0;
    case 'bundled_first_party_plugin':
      return 1;
    case 'external_plugin':
      return 2;
  }
}

export function isCuratedFirstPartyInstallableOwner(owner: InstallableContributionOwner): boolean {
  return owner.provenance === 'built_in' || owner.provenance === 'bundled_first_party_plugin';
}

function compareContribution(
  left: InstallableRegistryContribution,
  right: InstallableRegistryContribution,
): number {
  return ownerSortValue(left.owner) - ownerSortValue(right.owner)
    || left.descriptor.key.localeCompare(right.descriptor.key)
    || left.descriptor.capabilityId.localeCompare(right.descriptor.capabilityId)
    || left.owner.ownerId.localeCompare(right.owner.ownerId)
    || (left.owner.manifestPath ?? '').localeCompare(right.owner.manifestPath ?? '');
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

function stableDescriptorJson(descriptor: InstallableDependencyDescriptor): string {
  return stableJson(descriptor);
}

function isIntentionalIdenticalDuplicate(
  existing: InstallableRegistryContribution,
  candidate: InstallableRegistryContribution,
): boolean {
  return Boolean(existing.owner.sharedGroupId)
    && existing.owner.sharedGroupId === candidate.owner.sharedGroupId
    && stableDescriptorJson(existing.descriptor) === stableDescriptorJson(candidate.descriptor);
}

function createDiagnostic(params: Readonly<{
  code: 'installable_duplicate_key' | 'installable_duplicate_capability';
  field: 'key' | 'capabilityId';
  existing: InstallableRegistryContribution;
  candidate: InstallableRegistryContribution;
}>): InstallableRegistryDiagnostic {
  return Object.freeze({
    code: params.code,
    message: `Installable ${params.field} '${params.candidate.descriptor[params.field]}' from '${params.candidate.owner.ownerId}' conflicts with '${params.existing.owner.ownerId}'`,
    conflictedField: params.field,
    disabledDescriptorKey: params.candidate.descriptor.key,
    disabledCapabilityId: params.candidate.descriptor.capabilityId,
    disabledOwnerId: params.candidate.owner.ownerId,
    disabledProvenance: params.candidate.owner.provenance,
    ...(params.candidate.owner.pluginId ? { disabledPluginId: params.candidate.owner.pluginId } : {}),
    existingDescriptorKey: params.existing.descriptor.key,
    existingCapabilityId: params.existing.descriptor.capabilityId,
    existingOwnerId: params.existing.owner.ownerId,
    existingProvenance: params.existing.owner.provenance,
    ...(params.existing.owner.pluginId ? { existingPluginId: params.existing.owner.pluginId } : {}),
  });
}

function createDisallowedSourceProvenanceDiagnostic(
  candidate: InstallableRegistryContribution,
): InstallableRegistryDiagnostic {
  return Object.freeze({
    code: 'installable_disallowed_source_provenance',
    message: `Installable source '${candidate.descriptor.source.kind}' from '${candidate.owner.ownerId}' is restricted to curated first-party contributions`,
    conflictedField: 'source',
    disabledDescriptorKey: candidate.descriptor.key,
    disabledCapabilityId: candidate.descriptor.capabilityId,
    disabledOwnerId: candidate.owner.ownerId,
    disabledProvenance: candidate.owner.provenance,
    ...(candidate.owner.pluginId ? { disabledPluginId: candidate.owner.pluginId } : {}),
  });
}

export function resolveInstallablesRegistry(
  input: ResolveInstallablesRegistryInput,
): InstallablesRegistry {
  const descriptorsByKey: Record<string, InstallableRegistryContribution> = {};
  const descriptorsByCapabilityId: Record<string, InstallableRegistryContribution> = {};
  const descriptors: InstallableRegistryContribution[] = [];
  const diagnostics: InstallableRegistryDiagnostic[] = [];

  const candidates = [
    ...(input.builtIns ?? []),
    ...(input.bundledFirstPartyPlugins ?? []),
    ...(input.externalPlugins ?? []),
  ].sort(compareContribution);

  for (const candidate of candidates) {
    if (
      candidate.descriptor.source.kind === 'managed_pypi_wheel_asset' &&
      !isCuratedFirstPartyInstallableOwner(candidate.owner)
    ) {
      diagnostics.push(createDisallowedSourceProvenanceDiagnostic(candidate));
      continue;
    }

    const existingByKey = descriptorsByKey[candidate.descriptor.key];
    if (existingByKey) {
      if (!isIntentionalIdenticalDuplicate(existingByKey, candidate)) {
        diagnostics.push(createDiagnostic({
          code: 'installable_duplicate_key',
          field: 'key',
          existing: existingByKey,
          candidate,
        }));
      }
      continue;
    }

    const existingByCapabilityId = descriptorsByCapabilityId[candidate.descriptor.capabilityId];
    if (existingByCapabilityId) {
      if (!isIntentionalIdenticalDuplicate(existingByCapabilityId, candidate)) {
        diagnostics.push(createDiagnostic({
          code: 'installable_duplicate_capability',
          field: 'capabilityId',
          existing: existingByCapabilityId,
          candidate,
        }));
      }
      continue;
    }

    descriptorsByKey[candidate.descriptor.key] = candidate;
    descriptorsByCapabilityId[candidate.descriptor.capabilityId] = candidate;
    descriptors.push(candidate);
  }

  return Object.freeze({
    descriptors: Object.freeze(descriptors),
    descriptorsByKey: Object.freeze({ ...descriptorsByKey }),
    descriptorsByCapabilityId: Object.freeze({ ...descriptorsByCapabilityId }),
    diagnostics: Object.freeze(diagnostics),
  });
}
