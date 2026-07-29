import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginHostAccessRequestV2Schema,
  type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
  projectConnectedAccountPurposeDeclarationsToHostAccess,
  qualifyHostAccessContributionReference,
} from '@/plugins/runtime/hostAccess/resolve';
import {
  fingerprintPluginHostAccessRequest,
} from '@/plugins/runtime/hostAccess/scope';
import {
  createDefaultPluginAccessScopeRegistry,
  type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';

const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();

function hasDaemonExecution(manifest: CanonicalPluginManifest): boolean {
  return Boolean(manifest.entrypoints?.daemon || manifest.entrypoints?.development);
}

function hasReactNativeExecution(manifest: CanonicalPluginManifest): boolean {
  return manifest.contributes.ui.renderers.some((renderer) => renderer.kind === 'reactNative');
}

function hasExecutableRealmExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  return (!hasDaemonExecution(previous) && hasDaemonExecution(candidate))
    || (!hasReactNativeExecution(previous) && hasReactNativeExecution(candidate));
}

function qualifyNetworkTargetReference(
  ownerPluginId: string,
  target: Extract<PluginHostAccessRequestV2, {
    capability: 'network' | 'network.client';
  }>['scope']['targets'][number],
) {
  switch (target.kind) {
    case 'fixedOrigin':
      return target;
    case 'connectedAccountOrigin':
      return {
        ...target,
        service: qualifyHostAccessContributionReference(ownerPluginId, target.service),
      };
    case 'scmProviderOrigin':
      return {
        ...target,
        provider: qualifyHostAccessContributionReference(ownerPluginId, target.provider),
      };
  }
}

function qualifyHostAccessRequestReferences(
  ownerPluginId: string,
  request: PluginHostAccessRequestV2,
): PluginHostAccessRequestV2 {
  switch (request.capability) {
    case 'network':
      return {
        ...request,
        scope: {
          ...request.scope,
          targets: request.scope.targets.map((target) =>
            qualifyNetworkTargetReference(ownerPluginId, target)),
        },
      };
    case 'network.client':
      return {
        ...request,
        scope: {
          ...request.scope,
          targets: request.scope.targets.map((target) =>
            qualifyNetworkTargetReference(ownerPluginId, target)),
        },
      };
    case 'connectedAccounts':
      return {
        ...request,
        scope: {
          ...request.scope,
          serviceRefs: request.scope.serviceRefs.map((reference) =>
            qualifyHostAccessContributionReference(ownerPluginId, reference)),
        },
      };
    case 'mcp':
      return {
        ...request,
        scope: {
          ...request.scope,
          serverRefs: request.scope.serverRefs.map((reference) =>
            qualifyHostAccessContributionReference(ownerPluginId, reference)),
        },
      };
    default:
      return request;
  }
}

function hasReviewSensitiveHostAccessChange(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const previousRequired = new Map(previous.hostAccess.required.map((request) => [request.id, request]));
  for (const rawRequest of candidate.hostAccess.required) {
    const rawPrior = previousRequired.get(rawRequest.id);
    const request = qualifyHostAccessRequestReferences(candidate.id, rawRequest);
    const prior = rawPrior
      ? qualifyHostAccessRequestReferences(previous.id, rawPrior)
      : undefined;
    if (
      !prior
      || prior.capability !== request.capability
      || prior.reason !== request.reason
    ) {
      return true;
    }
    const comparison = accessScopeRegistry.compare(
      request.capability,
      request.scope,
      prior.scope,
    );
    if (comparison.relation !== 'exact') return true;
  }

  const previousOptional = new Map(previous.hostAccess.optional.map((request) => [request.id, request]));
  for (const rawRequest of candidate.hostAccess.optional) {
    const rawPrior = previousOptional.get(rawRequest.id);
    const request = qualifyHostAccessRequestReferences(candidate.id, rawRequest);
    const prior = rawPrior
      ? qualifyHostAccessRequestReferences(previous.id, rawPrior)
      : undefined;
    if (
      !prior
      || prior.capability !== request.capability
      || prior.reason !== request.reason
      || accessScopeRegistry.compare(request.capability, request.scope, prior.scope).relation !== 'exact'
    ) {
      return true;
    }
  }
  return false;
}

function connectedAccountPurposeAccessFacts(
  manifest: CanonicalPluginManifest,
): readonly string[] {
  return manifest.contributes.agents.flatMap((agent) =>
    projectConnectedAccountPurposeDeclarationsToHostAccess(
      agent.connectedAccounts ?? [],
    ).map(({ request }) =>
      JSON.stringify([
        agent.id,
        fingerprintPluginHostAccessRequest(
          qualifyHostAccessRequestReferences(manifest.id, request),
        ),
      ])),
  ).sort();
}

function hasConnectedAccountPurposeAccessChange(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  return JSON.stringify(connectedAccountPurposeAccessFacts(previous))
    !== JSON.stringify(connectedAccountPurposeAccessFacts(candidate));
}

function contributionKeys(
  manifest: CanonicalPluginManifest,
): ReadonlyMap<string, ReadonlySet<string>> | null {
  try {
    const keysByFamily = new Map<string, ReadonlySet<string>>();
    for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      const keys = new Set<string>();
      for (const raw of entry.readEntries(manifest.contributes)) {
        const canonical = entry.canonicalize(raw);
        if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return null;
        const key = entry.conflictKey(canonical as Readonly<Record<string, unknown>>);
        if (!key) return null;
        keys.add(key);
      }
      keysByFamily.set(entry.manifestKey, keys);
    }
    return keysByFamily;
  } catch {
    return null;
  }
}

function hasDeclaredIntegrationExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const previousKeys = contributionKeys(previous);
  const candidateKeys = contributionKeys(candidate);
  if (!previousKeys || !candidateKeys) return true;
  for (const [family, keys] of candidateKeys) {
    const prior = previousKeys.get(family);
    if (!prior || [...keys].some((key) => !prior.has(key))) return true;
  }
  return false;
}

export function hasReviewSensitivePluginUpdate(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  return hasExecutableRealmExpansion(previous, candidate)
    || hasReviewSensitiveHostAccessChange(previous, candidate)
    || hasConnectedAccountPurposeAccessChange(previous, candidate)
    || hasDeclaredIntegrationExpansion(previous, candidate);
}

export function preserveValidPluginOptionalSelections(
  pluginId: string,
  manifest: CanonicalPluginManifest,
  selections: readonly PluginAccessSelection[],
): readonly PluginAccessSelection[] | null {
  const declarations = new Map(manifest.hostAccess.optional.map((request) => [request.id, request]));
  const preserved: PluginAccessSelection[] = [];
  for (const selection of selections) {
    const declaration = declarations.get(selection.accessId);
    if (
      !accessScopeRegistry.validateSelection(selection)
      || selection.pluginId !== pluginId
    ) {
      return null;
    }
    if (!declaration) continue;
    const parsedSelectedRequest = PluginHostAccessRequestV2Schema.safeParse({
      ...declaration,
      scope: selection.normalizedScope,
    });
    if (!parsedSelectedRequest.success) return null;
    const qualifiedDeclaration = qualifyHostAccessRequestReferences(pluginId, declaration);
    const qualifiedSelection = qualifyHostAccessRequestReferences(
      selection.pluginId,
      parsedSelectedRequest.data,
    );
    if (
      qualifiedDeclaration.capability !== selection.capability
      || accessScopeRegistry.compare(
        qualifiedDeclaration.capability,
        qualifiedDeclaration.scope,
        qualifiedSelection.scope,
      ).relation !== 'exact'
    ) {
      return null;
    }
    preserved.push(selection);
  }
  return Object.freeze(preserved);
}
