import type { DeploymentEnvironmentDetailV1, DeploymentEnvironmentHeaderV1, DeploymentEnvironmentContentV1, DeploymentEnvironmentCollectionV1, DeploymentReceiptHistoryV1, DeploymentReceiptDetailV1, DeploymentReceiptHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentHealthStatusV1, DeploymentEnvironmentHealthAggregateV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentEnvironmentListInputV1, DeploymentReceiptListInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentDatabaseSizeV1, DeploymentDomainHealthFactsV1, DeploymentSecretRevisionFactV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import type { DeploymentMemberVersionV1 } from '../projection/deploymentStepProjection.js';
import type { DeploymentActivityV1, DeploymentChipV1 } from '../projection/deploymentSurfaceFacts.js';
import type { DeploymentReceiptFactsV1 } from '../projection/deploymentReceiptFacts.js';
import type { AutomationDatabaseSubjectReadV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

/** Local read projection over admitted link and demand-loaded receipt content, never a stored member vector. */
export type DeploymentEnvironmentReadDetailV1 = DeploymentEnvironmentDetailV1 & Readonly<{
    runtimeTargetLink: DeploymentTargetLinkHeaderV1 | null;
    /** Built-in routing addresses from the opened serving receipt; null until observed, [] when observed absent. */
    builtInUrls: DeploymentReceiptFactsV1['builtInUrls'];
    memberVersions: Readonly<Record<string, DeploymentMemberVersionV1>>;
    secretRevisions: readonly Readonly<{ machineId: string; installationId: string; facts: readonly DeploymentSecretRevisionFactV1[] }>[];
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

export type DeploymentCollectionQueryV1 = Readonly<Omit<DeploymentEnvironmentListInputV1,
    'serverId' | 'projectSourceId' | 'projection' | 'environmentIds' | 'previewPullRequestIds'> & {
    /** A Resource observes all matching children, independently of page navigation. */
    allPages?: true;
    /** Exact visible owner-header demand. Internally [] means no demand. */
    environmentIds?: readonly string[];
    previewPullRequestIds?: readonly string[];
}>;
export type DeploymentHistoryQueryV1 = Readonly<Pick<DeploymentReceiptListInputV1,
    'cursor' | 'state' | 'actorAccountId' | 'operation' | 'requestedAtFromMs' | 'requestedAtToMs'>>;
export type DeploymentDomainReadItemV1 = Readonly<{
    domain: DeploymentDomainHeaderV1; title: string; content: DeploymentDomainContentV1;
    health?: DeploymentDomainHealthFactsV1;
    healthUnavailableReason?: string;
}>;
export type DeploymentAccountPageQueryV1 = Readonly<{ cursor?: string | undefined; limit?: number }>;
/** A selected Environment reads its database facts independently of Account page navigation. */
export type DeploymentDataServiceQueryV1 = DeploymentAccountPageQueryV1 & Readonly<{ environmentId?: string }>;
export type DeploymentAccountDomainReadItemV1 = DeploymentDomainReadItemV1 & Readonly<{
    environment: DeploymentEnvironmentHeaderV1; environmentTitle: string; projectSourceName: string | null;
}>;
export type DeploymentDataServiceReadItemV1 = Readonly<{
    environment: DeploymentEnvironmentHeaderV1; title: string; content: DeploymentEnvironmentContentV1;
    projectSourceName?: string | null;
    databaseSizes?: readonly DeploymentDatabaseSizeV1[];
    /** Keys are the incumbent database page's service or data-link address. */
    databaseSubjects?: Readonly<Record<string, AutomationDatabaseSubjectReadV1>>;
    /** Descriptor discovery can fail independently of the Environment's database facts. */
    databaseSubjectFailure?: DeploymentReadFailureV1;
}>;
export type DeploymentAccountReadPageV1<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>
    & Pick<DeploymentEnvironmentCollectionV1, 'coverage'>;
export type DeploymentAccountDomainReadPageV1 = Omit<DeploymentAccountReadPageV1<DeploymentAccountDomainReadItemV1>, 'nextCursor'> & DeploymentReadPageFactsV1;
export type DeploymentDataServiceReadPageV1 = Omit<DeploymentAccountReadPageV1<DeploymentDataServiceReadItemV1>, 'nextCursor'> & DeploymentReadPageFactsV1;
export type DeploymentDomainPageV1 = Readonly<{ items: readonly DeploymentDomainReadItemV1[]; nextCursor: string | null }>
    & Pick<DeploymentEnvironmentCollectionV1, 'coverage'>;
export type DeploymentDomainReadPageV1 = Omit<DeploymentDomainPageV1, 'nextCursor'> & DeploymentReadPageFactsV1;
/** Continuation tokens are request state, never part of a published page's identity. */
export type DeploymentReadPageFactsV1 = Readonly<{ hasNextPage: boolean; hasPreviousPage: boolean }>;
export type DeploymentEnvironmentReadCollectionV1 = Omit<DeploymentEnvironmentCollectionV1, 'nextCursor' | 'items'> & DeploymentReadPageFactsV1 & Readonly<{
    items: readonly (DeploymentEnvironmentCollectionV1['items'][number] & Readonly<{ chip: DeploymentChipV1 | null }>)[];
}>;
export type DeploymentReceiptReadDetailV1 = DeploymentReceiptDetailV1 & Readonly<{ chip: DeploymentChipV1; facts: DeploymentReceiptFactsV1 }>;
export type DeploymentHistoryPageV1 = Omit<DeploymentReceiptHistoryV1, 'nextCursor'> & DeploymentReadPageFactsV1;
export type DeploymentReadPageLeaseV1<T, PageOption extends string = never> = DeploymentReadLeaseV1<T> & Readonly<{
    nextPage(option?: PageOption): void;
    previousPage(): void;
}>;
export type DeploymentReadOptionsV1 = Readonly<{ signal: AbortSignal }>;

/** The host binds this network boundary to its current authenticated Home. */
export type DeploymentReadTransportV1 = Readonly<{
    listDomainPage?(scope: DeploymentReadScopeV1, query: DeploymentAccountPageQueryV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<DeploymentAccountReadPageV1<DeploymentAccountDomainReadItemV1>>>;
    listDataServicePage?(scope: DeploymentReadScopeV1, query: DeploymentDataServiceQueryV1, options: DeploymentReadOptionsV1 & Readonly<{ previousItems?: readonly DeploymentDataServiceReadItemV1[] }>): Promise<DeploymentReadResultV1<DeploymentAccountReadPageV1<DeploymentDataServiceReadItemV1>>>;
    /** One selected Domain page, opened by the host's mode-aware Artifact owner. */
    listDomains?(scope: DeploymentReadScopeV1, environmentId: string, query: DeploymentHistoryQueryV1,
        options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<DeploymentDomainPageV1>>;
    /** Metadata-only summary through the same deployment list owner. */
    readActivity?(scope: DeploymentReadScopeV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<DeploymentActivityV1>>;
    listEnvironments(scope: DeploymentReadScopeV1, query: DeploymentCollectionQueryV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    readEnvironment(scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    listHistory(scope: DeploymentReadScopeV1, environmentId: string, query: DeploymentHistoryQueryV1, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    readReceipt(scope: DeploymentReadScopeV1, environmentId: string, deploymentId: string, options: DeploymentReadOptionsV1): Promise<DeploymentReadResultV1<unknown>>;
    /** One shared, demand-bound subscription to the existing Machine Services Resource. */
    observeEnvironmentHealth?(scope: DeploymentReadScopeV1, detail: DeploymentEnvironmentReadDetailV1,
        publish: (feed: DeploymentEnvironmentHealthFeedV1, aggregate?: DeploymentEnvironmentHealthAggregateV1) => void, options: DeploymentReadOptionsV1): () => void;
    /** One shared, demand-bound subscription for every Environment currently in a collection page. */
    observeEnvironmentCollectionHealth?(scope: DeploymentReadScopeV1,
        items: readonly DeploymentEnvironmentCollectionV1['items'][number][],
        publish: (environmentId: string, aggregate?: DeploymentEnvironmentHealthAggregateV1) => void,
        options: DeploymentReadOptionsV1): () => void;
    /** Current saved-check facts for this visible page, independent of its Home metadata read. */
    observeDomainHealth?(scope: DeploymentReadScopeV1, environmentId: string, items: readonly DeploymentDomainReadItemV1[],
        publish: (items: readonly DeploymentDomainReadItemV1[]) => void, options: DeploymentReadOptionsV1 & Readonly<{
            environmentDetail?: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'runtimeTargetLink'>;
        }>): () => void;
}>;

export type DeploymentReadInvalidationV1 = Readonly<{
    projectSourceId?: string;
    environmentId: string;
    deploymentId?: string;
    activityChanged?: true;
}>;

export type DeploymentReadControllerV1 = Readonly<{
    scope: DeploymentReadScopeV1;
    acquireDomainPage(query: DeploymentAccountPageQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentAccountDomainReadPageV1>;
    acquireDataServicePage(query: DeploymentDataServiceQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentDataServiceReadPageV1>;
    acquireDomains(environmentId: string, query: DeploymentHistoryQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentDomainReadPageV1>;
    acquireCollection(query: DeploymentCollectionQueryV1, demand: DeploymentReadDemandV1):
        DeploymentReadPageLeaseV1<DeploymentEnvironmentReadCollectionV1, 'includeTotal'>;
    acquireActivity(demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentActivityV1>;
    acquireEnvironment(environmentId: string, demand: DeploymentReadDemandV1,
        options?: Readonly<{ health?: boolean }>): DeploymentReadLeaseV1<DeploymentEnvironmentReadDetailV1>;
    acquireHistory(environmentId: string, query: DeploymentHistoryQueryV1, demand: DeploymentReadDemandV1): DeploymentReadPageLeaseV1<DeploymentHistoryPageV1>;
    acquireReceipt(environmentId: string, deploymentId: string, demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentReceiptReadDetailV1>;
    acquireReceiptChip(environmentId: string, deploymentId: string, demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<DeploymentChipV1>;
    invalidate(hint: DeploymentReadInvalidationV1 | readonly DeploymentReadInvalidationV1[]): void;
    /** Existing saved-resource push, narrowed to bound Environments when resource ids are supplied. */
    invalidateSavedSecrets(resourceIds?: readonly string[]): void;
    /** Connection repair or explicit refresh supersedes stale reads, only for active demand. */
    refreshDemanded(): Promise<void>;
    /** A new Home, Account, Source authority or target-currentness basis gets a new controller. */
    retire(): void;
}>;
