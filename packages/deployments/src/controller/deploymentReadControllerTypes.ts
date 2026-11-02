import type {
    DeploymentEnvironmentDetailV1,
    DeploymentEnvironmentCollectionV1,
    DeploymentReceiptHistoryV1,
    DeploymentReceiptDetailV1,
    DeploymentTargetLinkHeaderV1,
    DeploymentHealthStatusV1,
    DeploymentDomainContentV1,
    DeploymentEnvironmentHealthAggregateV1,
} from '@happier-dev/deployment-protocol/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentMemberVersionV1 } from '../projection/deploymentStepProjection.js';
import type { DeploymentActivityV1, DeploymentChipV1 } from '../projection/deploymentSurfaceFacts.js';
import type { DeploymentReceiptFactsV1 } from '../projection/deploymentReceiptFacts.js';

/** Local read projection over admitted link and demand-loaded receipt content, never a stored member vector. */
export type DeploymentEnvironmentReadDetailV1 = DeploymentEnvironmentDetailV1 & Readonly<{
    runtimeTargetLink: DeploymentTargetLinkHeaderV1 | null;
    memberVersions: Readonly<Record<string, DeploymentMemberVersionV1>>;
    healthFeed?: DeploymentEnvironmentHealthFeedV1;
}>;

/** Current native facts, independent of the historical receipt's captured health. */
export type DeploymentEnvironmentHealthServiceV1 = Readonly<{
    serviceId: string;
    state: DeploymentHealthStatusV1;
    observedAt: number | null;
    reason: string | null;
    name?: string;
    expectedDown?: 'stop';
}>;
export type DeploymentEnvironmentHealthMemberV1 = Readonly<{
    machineId: string;
    installationId: string;
    status: 'loading' | 'ready' | 'unavailable';
    services: readonly DeploymentEnvironmentHealthServiceV1[];
    failure?: DeploymentReadFailureV1;
}>;
export type DeploymentEnvironmentHealthFeedV1 = Readonly<{
    environmentId: string;
    status: 'loading' | 'ready' | 'partial' | 'unavailable';
    members: readonly DeploymentEnvironmentHealthMemberV1[];
    aggregate?: DeploymentEnvironmentHealthAggregateV1;
}>;

export type DeploymentReadScopeV1 = Readonly<{
    serverId: string;
    accountId: string;
    projectSourceId?: string;
}>;

/** All three facts come from the mounted host surface, never a package timer. */
export type DeploymentReadDemandV1 = Readonly<{ mounted: boolean; visible: boolean; focused: boolean }>;
export type DeploymentReadFailureV1 = Readonly<{ code: string; retryable: boolean }>;
export type DeploymentReadResultV1<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: DeploymentReadFailureV1 }>;
export type DeploymentReadSnapshotV1<T> = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'unavailable';
    value: T | null;
    failure: DeploymentReadFailureV1 | null;
}>;
export type DeploymentReadLeaseV1<T> = Readonly<{
    getSnapshot(): DeploymentReadSnapshotV1<T>;
    subscribe(listener: () => void): () => void;
    /** Ordinary borrowers join; user-initiated recovery may supersede a stalled read. */
    refresh(options?: Readonly<{ supersede?: boolean }>): Promise<void>;
    setDemand(demand: DeploymentReadDemandV1): void;
    release(): void;
}>;

export type DeploymentCollectionQueryV1 = Readonly<{
    cursor?: string; machineId?: string;
    /** Exact visible owner-header demand. Internally [] means no demand. */
    environmentIds?: readonly string[];
    /** P44's saved repository relation plus exact visible PR identities. */
    previewRepositoryId?: string;
    previewPullRequestIds?: readonly string[];
    /** Exact children of P44's admitted template Environment relation. */
    previewTemplateEnvironmentId?: string;
}>;
export type DeploymentHistoryQueryV1 = Readonly<{ cursor?: string }>;
export type DeploymentDomainReadItemV1 = Readonly<{
    domain: DeploymentDomainHeaderV1; title: string; content: DeploymentDomainContentV1;
}>;
export type DeploymentDomainPageV1 = Readonly<{ items: readonly DeploymentDomainReadItemV1[]; nextCursor: string | null }>;
export type DeploymentDomainReadPageV1 = Omit<DeploymentDomainPageV1, 'nextCursor'> & DeploymentReadPageFactsV1;
/** Continuation tokens are request state, never part of a published page's identity. */
export type DeploymentReadPageFactsV1 = Readonly<{ hasNextPage: boolean; hasPreviousPage: boolean }>;
export type DeploymentEnvironmentReadCollectionV1 = Omit<DeploymentEnvironmentCollectionV1, 'nextCursor' | 'items'> & DeploymentReadPageFactsV1 & Readonly<{
    items: readonly (DeploymentEnvironmentCollectionV1['items'][number] & Readonly<{ chip: DeploymentChipV1 | null }>)[];
}>;
export type DeploymentReceiptReadDetailV1 = DeploymentReceiptDetailV1 & Readonly<{ chip: DeploymentChipV1; facts: DeploymentReceiptFactsV1 }>;
export type DeploymentHistoryPageV1 = Omit<DeploymentReceiptHistoryV1, 'nextCursor'> & DeploymentReadPageFactsV1;
export type DeploymentReadPageLeaseV1<T> = DeploymentReadLeaseV1<T> & Readonly<{
    nextPage(): void;
    previousPage(): void;
}>;
export type DeploymentReadOptionsV1 = Readonly<{ signal: AbortSignal }>;

/** The host binds this network boundary to its current authenticated Home. */
export type DeploymentReadTransportV1 = Readonly<{
    /** One selected Domain page, opened by the host's mode-aware Artifact owner. */
    listDomains?(scope: DeploymentReadScopeV1, environmentId: string, query: DeploymentHistoryQueryV1,
        options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<DeploymentDomainPageV1>>;
    /** Metadata-only summary through the same deployment list owner. */
    readActivity?(scope: DeploymentReadScopeV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<DeploymentActivityV1>>;
    listEnvironments(scope: DeploymentReadScopeV1, query: DeploymentCollectionQueryV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    readEnvironment(scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    listHistory(scope: DeploymentReadScopeV1, environmentId: string, query: DeploymentHistoryQueryV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    readReceipt(scope: DeploymentReadScopeV1, environmentId: string, deploymentId: string, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    /** One finite observation of demanded running ids, grouped by their actual target. No page poll. */
    observeReceipts?(scope: DeploymentReadScopeV1, targetLinkId: string, deploymentIds: readonly string[], options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<readonly unknown[]>>;
    /** One shared, demand-bound subscription to the existing Machine Services Resource. */
    observeEnvironmentHealth?(scope: DeploymentReadScopeV1, detail: DeploymentEnvironmentReadDetailV1,
        publish: (feed: DeploymentEnvironmentHealthFeedV1) => void, options: DeploymentReadOptionsV1): () => void;
}>;

export type DeploymentReadInvalidationV1 = Readonly<{
    projectSourceId?: string;
    environmentId: string;
    deploymentId?: string;
    activityChanged?: true;
}>;

export type DeploymentReadControllerV1 = Readonly<{
    scope: DeploymentReadScopeV1;
    acquireDomains(environmentId: string, query: DeploymentHistoryQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentDomainReadPageV1>;
    acquireCollection(query: DeploymentCollectionQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentEnvironmentReadCollectionV1>;
    acquireActivity(demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentActivityV1>;
    acquireEnvironment(environmentId: string, demand: DeploymentReadDemandV1,
        options?: Readonly<{ health?: boolean }>): DeploymentReadLeaseV1<DeploymentEnvironmentReadDetailV1>;
    acquireHistory(environmentId: string, query: DeploymentHistoryQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentHistoryPageV1>;
    acquireReceipt(environmentId: string, deploymentId: string, demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentReceiptReadDetailV1>;
    acquireReceiptChip(environmentId: string, deploymentId: string, demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentChipV1>;
    invalidate(hint: DeploymentReadInvalidationV1 | readonly DeploymentReadInvalidationV1[]): void;
    /** Connection repair or explicit refresh supersedes stale reads, only for active demand. */
    refreshDemanded(): Promise<void>;
    /** A new Home, Account, Source authority or target-currentness basis gets a new controller. */
    retire(): void;
}>;
