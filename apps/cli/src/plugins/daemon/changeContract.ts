import {
  type MarketplaceRegistryProfileRequiredResultV1,
  type MarketplaceRegistryProfileRequirementV1,
  type PluginRequestInterceptorContributionV1,
  type PluginInstallReviewPrincipalDigest,
  type PluginInstallReviewPrincipalPresentationV1,
  type PluginUpdatePolicyV1,
  type ManagedResourceDependencyV1,
  type ManagedResourceDispositionV1,
} from '@happier-dev/protocol';
import {
  type ExpectedMarketplaceListingV1,
  type PluginChangePendingReviewResult,
  type PluginInstallationReview,
  type PluginInstallationReviewRequestInterceptor,
} from '@happier-dev/protocol/marketplace/internal';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PreparedPluginDevelopmentActivationGraph } from '@/plugins/authoring/sourceModule';
import type { DevelopmentPluginSourceCustody, PluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type { PluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import type { PluginStateRecord } from '@/plugins/store/state';
import type { PluginAuthorityExpansionCategory } from './updateReviewPolicy';

export type PluginChangeRequest =
  | Readonly<{
      kind: 'installPath';
      locator: string;
      /** Retained only as an explicit managed-install marker; development uses registered roots. */
      development?: false;
    }>
  | Readonly<{ kind: 'installArchive'; locator: string; expectedIntegrity?: string }>
  | Readonly<{
      kind: 'installNpm';
      packageName: string;
      selector?: string;
      registryOrigin?: string;
      registryProfileId?: string;
      expectedMarketplaceListing?: ExpectedMarketplaceListingV1;
    }>
  | Readonly<{ kind: 'update'; pluginId: string }>
  | Readonly<{ kind: 'setUpdatePolicy'; pluginId: string; policy: PluginUpdatePolicyV1 }>
  | Readonly<{
      kind: 'development';
      pluginId?: string;
      sourceRootPath: string;
      changedPaths?: readonly string[];
      observedRevision?: number;
      sdkRegistryOrigin?: string;
    }>
  | Readonly<{ kind: 'enable' | 'rollback' | 'forgetTrust'; pluginId: string }>
  | Readonly<{ kind: 'disable' | 'uninstall' | 'uninstallAndDeleteData'; pluginId: string;
      managedResourceDispositions?: readonly ManagedResourceDispositionV1[] }>;

/**
 * Projects one declared request-policy contribution into the serialized
 * installation-review fact a human reviews. The review fact schema and shape
 * are owned by `@happier-dev/protocol/marketplace/internal`; this is the
 * daemon-side emitter for that fact.
 */
export function projectPluginInstallationReviewRequestInterceptor(
  contribution: PluginRequestInterceptorContributionV1,
): PluginInstallationReviewRequestInterceptor {
  return Object.freeze({
    id: contribution.id,
    origins: Object.freeze([...contribution.origins].sort()),
    ...(contribution.methods === undefined
      ? {}
      : { methods: Object.freeze([...contribution.methods].sort()) }),
    priority: contribution.priority ?? 0,
  });
}

export type PluginResourceSelection = Readonly<{
  accessId: string;
  selected: boolean;
}>;

export type PluginChangePendingSurface =
  | 'reconciliation'
  | 'retirement'
  | 'cleanup'
  | 'temporaryCandidateCleanup';

export type PluginChangeSuccess = Readonly<{
  kind: 'committed';
  pluginId: string;
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  pendingSurfaces: readonly PluginChangePendingSurface[];
  dataRemoval?: Readonly<{
    alreadyUninstalled: boolean;
    removedData: Readonly<{
      daemonStorage: boolean;
      secrets: boolean;
    }>;
  }>;
}>;

export type PluginDataRemovalStep = 'uninstall' | 'daemonStorage' | 'secrets';

export type PluginDataRemovalPartial = Readonly<{
  kind: 'dataRemovalPartial';
  pluginId: string;
  completed: readonly PluginDataRemovalStep[];
  pending: readonly PluginDataRemovalStep[];
  causeCode: string;
}>;

export type PluginChangeApplyResult =
  | PluginChangeSuccess
  | Readonly<{ kind: 'managedResourcesReviewRequired'; pluginId: string; resources: readonly ManagedResourceDependencyV1[] }>
  | Readonly<{ kind: 'projectTrustAccepted'; projectRoot: string }>
  | PluginDataRemovalPartial
  | Readonly<{ kind: 'unavailable'; code: string }>
  | Readonly<{ kind: 'conflict'; pluginId: string }>
  | Readonly<{ kind: 'failed'; code: string; message?: string }>
  | Readonly<{ kind: 'outcomeUnknown'; pluginId: string; expectedCandidate?: string }>;

/**
 * The npm artifact a change needs is served by a registry this Home has no
 * usable profile for. The shape and the listing rule are the Protocol's
 * (`MarketplaceRegistryProfileRequirementV1`), so the preparer, the exact
 * install resolver, the RPC result and every present-user consumer read one
 * fact. Preparation stops before any package bytes are reviewed and names what
 * must be selected; the caller selects or creates a profile through the npm
 * registry profile service, binds it where a marketplace source applies, and
 * requests the same change again.
 */
export type PluginRegistryProfileRequirement = MarketplaceRegistryProfileRequirementV1;

export type PluginRegistryProfileRequiredResult = MarketplaceRegistryProfileRequiredResultV1;

/** Raised by a change preparer; the change owner projects it as {@link PluginRegistryProfileRequiredResult}. */
export class PluginRegistryProfileRequiredError extends Error {
  readonly requirement: PluginRegistryProfileRequirement;

  constructor(requirement: PluginRegistryProfileRequirement) {
    super(`Npm registry '${requirement.registryOrigin}' requires a registry profile on this Home`);
    this.name = 'PluginRegistryProfileRequiredError';
    this.requirement = Object.freeze({ ...requirement });
  }
}

export type PluginChangeRequestResult =
  | PluginChangePendingReviewResult
  | PluginChangeApplyResult
  | PluginRegistryProfileRequiredResult
  | Readonly<{ kind: 'busy'; pluginId: string }>;

/**
 * A decision names the daemon-issued pending change it answers and nothing
 * about its own author. The authenticated control route establishes that a
 * local present user is calling, and the change service resolves the pending
 * change itself, so a caller-supplied actor, interaction id, or timestamp
 * would be self-asserted rather than evidence. Approval and selection times
 * are taken from the daemon clock where the record is written.
 */
export type PluginChangeDecision =
  | Readonly<{
      pendingChangeId: string;
      decision: 'installAndTrust';
      optionalSelections?: readonly PluginResourceSelection[];
    }>
  | Readonly<{
      pendingChangeId: string;
      decision: 'cancel';
    }>;

export type PluginChangeDecisionResult =
  | PluginChangeRequestResult
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'busy'; pluginId: string }>;

/**
 * A reconnect carries only the daemon-issued pending id. It never recreates a
 * candidate or supplies approval evidence.
 */
export type PluginChangeStatusRequest = Readonly<{
  pendingChangeId: string;
}>;

export type PluginChangeTerminalResult = Exclude<
  PluginChangeDecisionResult,
  PluginChangePendingReviewResult | Readonly<{ kind: 'expired' }>
>;

/**
 * One daemon-lifetime pending change, as enumerated for a present user.
 *
 * It is exactly the subset of {@link PluginChangeStatusResult} that is still
 * waiting on, or executing, a decision. A terminal or expired change is nobody's
 * outstanding decision and is therefore never listed. Enumeration exists because
 * a change an Agent prepared has no caller left to hand the issued id to: the
 * change owner is the only place that knows a present user still owes a
 * decision.
 */
export type PluginPendingChangeEntry =
  | PluginChangePendingReviewResult
  | Readonly<{
      kind: 'applying';
      pendingChangeId: string;
    }>;

export type PluginChangeListResult = Readonly<{
  changes: readonly PluginPendingChangeEntry[];
}>;

/**
 * Daemon-lifetime only rejoin projection. A new daemon has no claim over a
 * predecessor's in-memory candidates, so callers receive `expired` after a
 * restart rather than a synthetic recovery record.
 */
export type PluginChangeStatusResult =
  | PluginChangePendingReviewResult
  | Readonly<{
      kind: 'applying';
      pendingChangeId: string;
    }>
  | Readonly<{
      kind: 'terminal';
      pendingChangeId: string;
      result: PluginChangeTerminalResult;
    }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'daemonUnavailable' }>;

export type PreparedDaemonPluginChangeCandidate = Readonly<{
  pluginId: string;
  review?: PluginInstallationReview;
  reviewReason?: 'firstInstall' | 'authorityExpansion';
  currentVersion?: string;
  authorityExpansion?: readonly PluginAuthorityExpansionCategory[];
  requiresReview?: boolean;
  apply: (decision?: Readonly<{
    optionalSelections: readonly PluginResourceSelection[];
  }>, control?: Readonly<{
    /** Releases same-plugin apply exclusivity after the serving lease is swapped. */
    onApplied: () => void;
  }>) => Promise<PluginChangeApplyResult>;
  cleanup: () => Promise<void>;
}>;

/**
 * Fully evaluated process-local development candidate. The daemon lifecycle
 * may publish this candidate after review/readiness; persistence may retain
 * only its root registration/trust facts, never the graph or revision.
 */
export type PreparedPluginDevelopmentCandidate = Readonly<{
  kind: 'preparedDevelopmentCandidate';
  pluginId: string;
  sourceAuthority: Extract<PluginRuntimeSourceAuthority, DevelopmentPluginSourceCustody>;
  manifest: CanonicalPluginManifest;
  preparedActivationGraph: PreparedPluginDevelopmentActivationGraph;
  review?: PluginInstallationReview;
  reviewReason?: 'firstInstall' | 'authorityExpansion';
  currentVersion?: string;
  authorityExpansion?: readonly PluginAuthorityExpansionCategory[];
  registryRevision?: number;
  priorOptionalAccess?: readonly PluginAccessSelection[];
  preservedOptionalAccess?: readonly PluginAccessSelection[] | null;
  installReviewPrincipal?: Readonly<{
    digest: PluginInstallReviewPrincipalDigest;
    presentation: PluginInstallReviewPrincipalPresentationV1;
  }>;
  priorInstallReviewPrincipal?: Readonly<{
    digest: PluginInstallReviewPrincipalDigest;
    presentation: PluginInstallReviewPrincipalPresentationV1;
  }>;
  catalogRecord: PluginStateRecord;
  trust: PluginTrustRecord;
  updatePolicy: PluginUpdatePolicyV1;
  requiresReview: boolean;
  cleanup: () => Promise<void>;
}>;

export type PreparedDaemonPluginChange =
  | PreparedDaemonPluginChangeCandidate
  | PreparedPluginDevelopmentCandidate;
