import { DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1, PluginUpdateReviewModeV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';
import { PluginHostAccessRequestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginHostAccessRequestV2, PluginUpdateReviewModeV1 } from '@happier-dev/protocol';
import type {
  PluginInstallationReview,
  PluginInstallationReviewRequestInterceptor,
} from '@happier-dev/protocol/marketplace/internal';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  projectConnectedAccountPurposeDeclarationsToHostAccess,
  qualifyHostAccessContributionReference,
} from '@/plugins/runtime/hostAccess/resolve';
import {
  projectPluginInstallationReviewRequestInterceptor,
} from './changeContract';
import {
  projectPluginInstallationReviewRawCredentialAccess,
} from './installationReview';

import {
  createDefaultPluginAccessScopeRegistry,
  type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';

const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();

type RawCredentialAccessFact = PluginInstallationReview['rawCredentialAccess'][number];

/**
 * An update expands authority only when the candidate can reach further than
 * the incumbent grant. `exact` and `narrower`
 * are both admissible; every other relation — including a scope whose
 * direction the canonical registry cannot rank — reopens review.
 */
function isWithinGrantedScope(
  capability: string,
  candidateScope: unknown,
  grantedScope: unknown,
): boolean {
  const relation = accessScopeRegistry.compare(capability, candidateScope, grantedScope).relation;
  return relation === 'exact' || relation === 'narrower';
}

function qualifyNetworkTargetReference(
  ownerPluginId: string,
  target: Extract<PluginHostAccessRequestV2, {
    capability: 'network' | 'network.client';
  }>['scope']['targets'][number],
) {
  switch (target.kind) {
    // Both carry their whole meaning inline: there is no contribution
    // reference to qualify against the owning plugin.
    case 'fixedOrigin':
    case 'httpsHostSuffix':
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
          discoverySourceRefs: request.scope.discoverySourceRefs.map((reference) =>
            qualifyHostAccessContributionReference(ownerPluginId, reference)),
        },
      };
    default:
      return request;
  }
}

/**
 * The scope a preserved selection actually granted, expressed as a qualified
 * host-access request against the current declaration. A selection stores the
 * unqualified scope it was minted from, so both sides are qualified through
 * the same owner before any comparison. Returns `null` when the stored
 * selection cannot be read as a request for this declaration at all.
 */
function readSelectionGrantedRequest(
  pluginId: string,
  declaration: PluginHostAccessRequestV2,
  selection: PluginAccessSelection,
): PluginHostAccessRequestV2 | null {
  const parsed = PluginHostAccessRequestV2Schema.safeParse({
    ...declaration,
    scope: selection.normalizedScope,
  });
  if (!parsed.success) return null;
  return qualifyHostAccessRequestReferences(selection.pluginId || pluginId, parsed.data);
}

function readValidSelectionsByAccessId(
  pluginId: string,
  selections: readonly PluginAccessSelection[],
): ReadonlyMap<string, PluginAccessSelection> {
  const byAccessId = new Map<string, PluginAccessSelection>();
  for (const selection of selections) {
    if (selection.pluginId !== pluginId || !accessScopeRegistry.validateSelection(selection)) continue;
    byAccessId.set(selection.accessId, selection);
  }
  return byAccessId;
}

/**
 * Required host access is unconditional authority, so every candidate
 * declaration must stay inside the request of the same id the user already
 * approved. Removed declarations and reworded reasons disclose no new reach
 * and therefore do not expand authority.
 */
function hasRequiredHostAccessExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const granted = new Map(previous.hostAccess.required.map((request) => [request.id, request]));
  return candidate.hostAccess.required.some((rawRequest) => {
    const rawPrior = granted.get(rawRequest.id);
    if (!rawPrior || rawPrior.capability !== rawRequest.capability) return true;
    const request = qualifyHostAccessRequestReferences(candidate.id, rawRequest);
    const prior = qualifyHostAccessRequestReferences(previous.id, rawPrior);
    return !isWithinGrantedScope(request.capability, request.scope, prior.scope);
  });
}

/**
 * An optional declaration is a request, not authority: it grants nothing until
 * the user selects it, and the selection the host persisted is the exact scope
 * that was granted. A declaration the user never selected can therefore appear
 * or widen freely, while a selected one is measured against its own selection —
 * the same fact {@link preserveValidPluginOptionalSelections} carries forward.
 */
function hasSelectedOptionalHostAccessExpansion(
  candidate: CanonicalPluginManifest,
  selections: readonly PluginAccessSelection[],
): boolean {
  const selectionsByAccessId = readValidSelectionsByAccessId(candidate.id, selections);
  if (selectionsByAccessId.size === 0) return false;
  return candidate.hostAccess.optional.some((declaration) => {
    const selection = selectionsByAccessId.get(declaration.id);
    if (!selection) return false;
    if (selection.capability !== declaration.capability) return true;
    const granted = readSelectionGrantedRequest(candidate.id, declaration, selection);
    if (!granted) return true;
    const request = qualifyHostAccessRequestReferences(candidate.id, declaration);
    return !isWithinGrantedScope(request.capability, request.scope, granted.scope);
  });
}

/**
 * Agent Connected Account purposes are projected into required host access by
 * the canonical purpose projection, so they are compared through the same
 * scope registry, keyed by the Agent and purpose the user approved.
 */
function connectedAccountPurposeRequestsByKey(
  manifest: CanonicalPluginManifest,
): ReadonlyMap<string, PluginHostAccessRequestV2> {
  const byKey = new Map<string, PluginHostAccessRequestV2>();
  for (const agent of manifest.contributes.agents) {
    for (const { request } of projectConnectedAccountPurposeDeclarationsToHostAccess(
      agent.connectedAccounts ?? [],
    )) {
      byKey.set(
        JSON.stringify([agent.id, request.id]),
        qualifyHostAccessRequestReferences(manifest.id, request),
      );
    }
  }
  return byKey;
}

function hasConnectedAccountPurposeAccessExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const granted = connectedAccountPurposeRequestsByKey(previous);
  for (const [key, request] of connectedAccountPurposeRequestsByKey(candidate)) {
    const prior = granted.get(key);
    if (!prior || !isWithinGrantedScope(request.capability, request.scope, prior.scope)) return true;
  }
  return false;
}

function isStringSetContained(
  candidate: readonly string[],
  granted: readonly string[],
): boolean {
  const allowed = new Set(granted);
  return candidate.every((entry) => allowed.has(entry));
}

/**
 * A request interceptor reaches exactly the origin/method pairs it declares —
 * `contributionAllowsRequest` treats an absent `methods` list as every method —
 * and it may only rewrite a request back inside that same declared reach.
 * `priority` is the ascending chain-order key, so a lower number moves the
 * interceptor ahead of interceptors that previously ran before it.
 */
function isRequestInterceptorWithinGrant(
  candidate: PluginInstallationReviewRequestInterceptor,
  granted: PluginInstallationReviewRequestInterceptor,
): boolean {
  return isStringSetContained(candidate.origins, granted.origins)
    && (granted.methods === undefined
      || (candidate.methods !== undefined && isStringSetContained(candidate.methods, granted.methods)))
    && candidate.priority >= granted.priority;
}

function hasRequestInterceptorExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const granted = new Map(previous.contributes.requestInterceptors.map((contribution) => [
    contribution.id,
    projectPluginInstallationReviewRequestInterceptor(contribution),
  ]));
  return candidate.contributes.requestInterceptors.some((contribution) => {
    const prior = granted.get(contribution.id);
    if (!prior) return true;
    return !isRequestInterceptorWithinGrant(
      projectPluginInstallationReviewRequestInterceptor(contribution),
      prior,
    );
  });
}

/**
 * A declared contribution's identity is not its disclosure: an already-declared
 * Voice provider can add or widen a raw credential grant without changing any
 * contribution key. The review-sensitivity check therefore reads the exact
 * raw-credential facts the installation review disclosed, from that one
 * projection owner, and keys each disclosure by the contribution, slot,
 * credential source, realm, phase and request target it names. The slot title
 * is presentation copy and is deliberately absent from the key and from the
 * comparison.
 */
function rawCredentialAccessKey(fact: RawCredentialAccessFact): string {
  return JSON.stringify([
    fact.contribution.pluginId,
    fact.contribution.localId,
    fact.credentialSlot.id,
    fact.credentialSlot.purpose,
    fact.sourceClass.kind,
    fact.sourceClass.kind === 'connectedAccount' ? fact.sourceClass.service : null,
    fact.realm,
    fact.phase,
    fact.accessMode,
    fact.request.kind,
    fact.request.kind === 'httpHeaders' ? fact.request.origin : null,
  ]);
}

function isRawCredentialRequestWithinGrant(
  candidate: RawCredentialAccessFact['request'],
  granted: RawCredentialAccessFact['request'],
): boolean {
  if (candidate.kind === 'httpHeaders') {
    return granted.kind === 'httpHeaders'
      && isStringSetContained(candidate.headerNames, granted.headerNames);
  }
  if (candidate.kind === 'environment') {
    return granted.kind === 'environment' && isStringSetContained(candidate.keys, granted.keys);
  }
  return granted.kind === 'files' && isStringSetContained(candidate.fileIds, granted.fileIds);
}

function isRawCredentialAccessWithinGrant(
  candidate: RawCredentialAccessFact,
  granted: RawCredentialAccessFact,
): boolean {
  if (
    candidate.sourceClass.kind === 'savedSecret'
    && granted.sourceClass.kind === 'savedSecret'
    && !isStringSetContained(candidate.sourceClass.secretKinds, granted.sourceClass.secretKinds)
  ) {
    return false;
  }
  return isRawCredentialRequestWithinGrant(candidate.request, granted.request);
}

function hasRawCredentialAccessExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
): boolean {
  const granted = new Map<string, RawCredentialAccessFact[]>();
  for (const fact of projectPluginInstallationReviewRawCredentialAccess(previous)) {
    const key = rawCredentialAccessKey(fact);
    granted.set(key, [...(granted.get(key) ?? []), fact]);
  }
  return projectPluginInstallationReviewRawCredentialAccess(candidate).some((fact) => (
    !(granted.get(rawCredentialAccessKey(fact)) ?? []).some((prior) => (
      isRawCredentialAccessWithinGrant(fact, prior)
    ))
  ));
}

/**
 * Whether an explicit update expands the reach the present user granted. The
 * question is directional: a decision is required when the candidate can
 * reach somewhere the approved grant could not — new or widened required host
 * access, a selected optional grant that no longer contains its declaration,
 * new or widened Connected Account purpose authority, wider request
 * interceptor reach, or wider raw-credential disclosure. Plugins are trusted
 * code, so new contributions and new executable realms change bytes, not
 * granted authority, and never reopen review. Reworded reasons and other
 * disclosure copy, removed declarations, unselected optional declarations,
 * and provably narrowed authority reach no further than what the user already
 * approved and are admitted without review.
 *
 * `selectedOptionalAccess` is the installed record's persisted
 * `install.optionalAccess`, which both preparers read before deciding.
 */
export type PluginAuthorityExpansionCategory =
  | 'requiredHostAccess'
  | 'selectedOptionalHostAccess'
  | 'connectedAccountPurpose'
  | 'requestInterceptor'
  | 'rawCredentialAccess';

/**
 * Projects authority requested by a first development admission whose code
 * trust was settled by the owning project/root decision. The empty baseline
 * grants no host, interception, or credential reach. Executable realms and
 * contribution identity are part of the code trust that the project decision
 * already settled; optional declarations remain requests until selected.
 */
export function listInitialPluginAuthorityExpansions(
  candidate: CanonicalPluginManifest,
): readonly PluginAuthorityExpansionCategory[] {
  return Object.freeze([
    ...(candidate.hostAccess.required.length > 0 ? ['requiredHostAccess' as const] : []),
    ...(connectedAccountPurposeRequestsByKey(candidate).size > 0
      ? ['connectedAccountPurpose' as const]
      : []),
    ...(candidate.contributes.requestInterceptors.length > 0 ? ['requestInterceptor' as const] : []),
    ...(projectPluginInstallationReviewRawCredentialAccess(candidate).length > 0
      ? ['rawCredentialAccess' as const]
      : []),
  ]);
}

export function listPluginAuthorityExpansions(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
  selectedOptionalAccess: readonly PluginAccessSelection[],
): readonly PluginAuthorityExpansionCategory[] {
  return Object.freeze([
    ...(hasRequiredHostAccessExpansion(previous, candidate) ? ['requiredHostAccess' as const] : []),
    ...(hasSelectedOptionalHostAccessExpansion(candidate, selectedOptionalAccess) ? ['selectedOptionalHostAccess' as const] : []),
    ...(hasConnectedAccountPurposeAccessExpansion(previous, candidate) ? ['connectedAccountPurpose' as const] : []),
    ...(hasRequestInterceptorExpansion(previous, candidate) ? ['requestInterceptor' as const] : []),
    ...(hasRawCredentialAccessExpansion(previous, candidate) ? ['rawCredentialAccess' as const] : []),
  ]);
}

export function hasPluginAuthorityExpansion(
  previous: CanonicalPluginManifest,
  candidate: CanonicalPluginManifest,
  selectedOptionalAccess: readonly PluginAccessSelection[],
): boolean {
  return listPluginAuthorityExpansions(previous, candidate, selectedOptionalAccess).length > 0;
}

export type PluginAuthorityReviewEvaluation = Readonly<{
  requiresReview: boolean;
  authorityExpansion: readonly PluginAuthorityExpansionCategory[];
  preservedOptionalAccess: readonly PluginAccessSelection[] | null;
}>;

/**
 * One authority-delta decision for every update preparer. Invalid or stale
 * optional selections reopen review here rather than surfacing as a late
 * apply-time trust failure in only some source representations.
 */
export function evaluatePluginAuthorityReview(params: Readonly<{
  previous: CanonicalPluginManifest;
  candidate: CanonicalPluginManifest;
  selectedOptionalAccess: readonly PluginAccessSelection[];
  /** A change to a trusted development source never asks, in either review mode. */
  development?: boolean;
  /** Test seam over the active Account settings snapshot. */
  readAccountSettings?: () => Readonly<{ pluginUpdateReviewModeV1?: unknown }> | null;
}>): PluginAuthorityReviewEvaluation {
  const projected = listPluginAuthorityExpansions(
    params.previous,
    params.candidate,
    params.selectedOptionalAccess,
  );
  const preservedOptionalAccess = preserveValidPluginOptionalSelections(
    params.candidate.id,
    params.candidate,
    params.selectedOptionalAccess,
  );
  if (params.development === true || readPluginUpdateReviewMode(params.readAccountSettings) === 'autoApply') {
    // Applying without review keeps every optional grant that still fits its
    // declaration; a grant the candidate widened beyond is dropped, not widened.
    return Object.freeze({
      requiresReview: false,
      authorityExpansion: Object.freeze([]),
      preservedOptionalAccess: preservedOptionalAccess
        ?? narrowPluginOptionalSelections(params.candidate, params.selectedOptionalAccess),
    });
  }
  const authorityExpansion = preservedOptionalAccess === null
    && !projected.includes('selectedOptionalHostAccess')
    ? Object.freeze([...projected, 'selectedOptionalHostAccess' as const])
    : projected;
  return Object.freeze({
    requiresReview: authorityExpansion.length > 0,
    authorityExpansion,
    preservedOptionalAccess,
  });
}

/**
 * The user's Account-wide update review preference. A missing or malformed
 * value, or no active Account snapshot, means the safe default: confirm.
 */
function readPluginUpdateReviewMode(
  readAccountSettings: (() => Readonly<{ pluginUpdateReviewModeV1?: unknown }> | null) | undefined,
): PluginUpdateReviewModeV1 {
  const settings = readAccountSettings
    ? readAccountSettings()
    : getActiveAccountSettingsSnapshot()?.settings ?? null;
  const parsed = PluginUpdateReviewModeV1Schema.safeParse(settings?.pluginUpdateReviewModeV1);
  return parsed.success ? parsed.data : DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1;
}

/** Keeps each selection individually carried forward; drops ones that cannot be. */
function narrowPluginOptionalSelections(
  candidate: CanonicalPluginManifest,
  selections: readonly PluginAccessSelection[],
): readonly PluginAccessSelection[] {
  const kept: PluginAccessSelection[] = [];
  for (const selection of selections) {
    const preserved = preserveValidPluginOptionalSelections(candidate.id, candidate, [selection]);
    if (preserved) kept.push(...preserved);
  }
  return Object.freeze(kept);
}

/**
 * Carries the user's optional-access grants across an update. A declaration
 * that disappeared drops its selection, and a declaration that narrowed inside
 * its grant keeps the user's decision at the reduced authority by re-minting
 * the selection from the current declaration through the same scope registry
 * that created it. A declaration that reaches beyond its selection cannot be
 * carried forward at all and returns `null`, which reopens review.
 */
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
    const granted = readSelectionGrantedRequest(pluginId, declaration, selection);
    if (!granted) return null;
    const qualifiedDeclaration = qualifyHostAccessRequestReferences(pluginId, declaration);
    if (qualifiedDeclaration.capability !== selection.capability) return null;
    const relation = accessScopeRegistry.compare(
      qualifiedDeclaration.capability,
      qualifiedDeclaration.scope,
      granted.scope,
    ).relation;
    if (relation === 'exact') {
      // The grant is unchanged, so the incumbent selection is carried forward
      // byte for byte rather than re-minted from equivalent declaration text.
      preserved.push(selection);
      continue;
    }
    if (relation !== 'narrower') return null;
    preserved.push(accessScopeRegistry.createSelection({
      pluginId: selection.pluginId,
      accessId: selection.accessId,
      capability: declaration.capability,
      scope: declaration.scope,
      selectedAtMs: selection.selectedAtMs,
    }));
  }
  return Object.freeze(preserved);
}
