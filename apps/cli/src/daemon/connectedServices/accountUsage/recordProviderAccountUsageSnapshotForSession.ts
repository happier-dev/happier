import type { QualifiedProviderAccountUsageIdentity } from './qualifiedAccountIdentity';
import { mergeProviderAccountSubscription } from '@happier-dev/protocol/connect/accountSubscription';
import { ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { ConnectedServiceUsageSourceV1, ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import {
    ProviderAccountUsageAdoptionV1Schema,
    type ProviderAccountUsageAdoptionV1,
} from './adoption';

import {
    ProviderAccountUsageSourceQualificationError,
    type ProviderAccountUsagePersistenceScheduler,
    type QualifiedProviderAccountUsagePersistenceTarget,
} from './persistence';
import {
    type ProviderAccountUsageObservation,
    type ProviderAccountUsageStore,
    type ProviderAccountUsageStoreMutationStatus,
} from './store';
import { normalizeConnectedServiceAccessTokenFingerprint } from '../refresh/credentialFreshness/tokenFingerprint';

type TrackedSessionLike = Readonly<{
    happySessionId?: unknown;
}>;

type QualifiedPersistenceTargetResolver = (input: Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    sources: readonly ConnectedServiceUsageSourceV1[];
}>) => Promise<readonly QualifiedProviderAccountUsagePersistenceTarget[]>;

type UnpersistedSnapshotObservation = Extract<
    Awaited<ReturnType<ProviderAccountUsagePersistenceScheduler['recordInBandSnapshot']>>,
    { status: 'not_persisted' }
>;

function normalizeSessionId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
    children: ReadonlyArray<TrackedSessionLike | unknown>,
    sessionId: string,
): TrackedSessionLike | null {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    return (children as ReadonlyArray<TrackedSessionLike>)
        .find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

export async function recordProviderAccountUsageSnapshotForSession(input: Readonly<{
    getChildren: () => ReadonlyArray<TrackedSessionLike | unknown>;
    store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'>;
    persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
    observation?: Readonly<{
        sources?: readonly ConnectedServiceUsageSourceV1[];
    }>;
    credentialFingerprint?: string | null;
    sourceProviderAccountId?: string;
    requiresProviderOrganizationId?: boolean;
    verifyCredentialFingerprint?: (input: Readonly<{
        serviceId: string;
        profileId: string;
        providerAccountId: string;
        providerOrganizationId?: string | null;
        credentialFingerprint: string;
    }>) => Promise<boolean>;
    resolveAuthoritativeSource?: (
        source: ConnectedServiceUsageSourceV1,
    ) => Promise<ConnectedServiceUsageSourceV1 | null>;
    /** Identity-free native usage borrows the already-selected account's host-owned identity. */
    resolveRuntimeSourceIdentity?: (source: ConnectedServiceUsageSourceV1) => Promise<QualifiedProviderAccountUsageIdentity | null>;
    /**
     * The runtime source owner resolves the exact V4 account/group relation and
     * current credential/configuration basis after source qualification. This
     * recorder owns neither identity translation nor a second currentness read.
     */
    resolvePersistenceTargets?: QualifiedPersistenceTargetResolver;
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<
    | Readonly<{ status: ProviderAccountUsageStoreMutationStatus; recordId: string; persisted: boolean; persistence?: UnpersistedSnapshotObservation; qualifiedSource?: ConnectedServiceUsageSourceV1; verifiedLocalSource?: ConnectedServiceUsageSourceV1; sourceProviderAccountId?: string }>
    | Readonly<{ status: 'session_not_found' }>
    | Readonly<{ status: 'credential_fingerprint_mismatch'; recordId: string; persisted: boolean }>
    | Readonly<{ status: 'source_qualification_failed'; reason: ProviderAccountUsageSourceQualificationError['reason']; recordId: string; persisted: false }>
> {
    const tracked = findTrackedSession(input.getChildren(), input.sessionId);
    if (!tracked) return { status: 'session_not_found' };

    let snapshot = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
    const claimedSources = input.observation?.sources?.length
        ? input.observation.sources
        : null;
    const observedProviderAccountId = input.sourceProviderAccountId?.trim()
        || (snapshot.accountSubject.kind === 'providerSubject' ? snapshot.accountSubject.id : null);
    const globalIdentityQualified = snapshot.accountSubject.kind === 'providerSubject'
        && (!input.requiresProviderOrganizationId || (snapshot.recordKey.quotaScope === 'organization' && Boolean(snapshot.recordKey.quotaScopeId?.trim())));
    let sourceQualificationMismatch = Boolean(claimedSources && !globalIdentityQualified && !input.sourceProviderAccountId);
    let qualifiedSources: readonly ConnectedServiceUsageSourceV1[] | null = null;
    let verifiedLocalSource: ConnectedServiceUsageSourceV1 | undefined;
    if (claimedSources?.length === 1 && input.credentialFingerprint === undefined
        && snapshot.source === 'runtimeSignal' && snapshot.accountSubject.kind === 'provisionalLocalSubject'
        && input.resolveRuntimeSourceIdentity && input.resolveAuthoritativeSource) {
        const claimed = claimedSources[0]!;
        const current = await input.resolveAuthoritativeSource(claimed);
        const matches = current && current.serviceId === claimed.serviceId && current.profileId === claimed.profileId
            && current.bindingKind === claimed.bindingKind
            && (current.bindingKind !== 'group_member' || (claimed.bindingKind === 'group_member'
                && current.groupId === claimed.groupId && current.groupGeneration === claimed.groupGeneration));
        const identity = matches ? await input.resolveRuntimeSourceIdentity(current) : null;
        if (identity && (!input.requiresProviderOrganizationId
            || (identity.recordKey.quotaScope === 'organization' && Boolean(identity.recordKey.quotaScopeId?.trim())))) {
            snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot, ...identity });
            qualifiedSources = [current!];
            sourceQualificationMismatch = false;
        }
    }
    if (input.credentialFingerprint !== undefined) {
        const credentialFingerprint = normalizeConnectedServiceAccessTokenFingerprint(input.credentialFingerprint);
        if (claimedSources && credentialFingerprint && input.verifyCredentialFingerprint && observedProviderAccountId
            && (snapshot.accountSubject.kind !== 'providerSubject' || snapshot.accountSubject.id === observedProviderAccountId)) {
            const matches = await Promise.all(claimedSources.map(async (source) =>
                await input.verifyCredentialFingerprint!({
                    serviceId: source.serviceId,
                    profileId: source.profileId,
                    providerAccountId: observedProviderAccountId,
                    providerOrganizationId: snapshot.recordKey.quotaScope === 'organization'
                        ? snapshot.recordKey.quotaScopeId ?? null : null,
                    credentialFingerprint,
                }),
            ));
            if (matches.every((matchesCurrentCredential) => matchesCurrentCredential === true)) {
                const authoritativeSources = input.resolveAuthoritativeSource
                    ? await Promise.all(claimedSources.map(async (source) => await input.resolveAuthoritativeSource!(source)))
                    : claimedSources;
                if (authoritativeSources.every((source): source is ConnectedServiceUsageSourceV1 => source !== null)) {
                    if (globalIdentityQualified) qualifiedSources = authoritativeSources;
                    if (input.sourceProviderAccountId && authoritativeSources.length === 1) verifiedLocalSource = authoritativeSources[0];
                } else sourceQualificationMismatch = true;
            } else sourceQualificationMismatch = true;
        } else sourceQualificationMismatch = true;
    }

    // A credential-qualified source claim that does not match current authority must not
    // advance the canonical account record. Source links are durable and resolve the record's
    // latest snapshot, so storing this observation as "display-only" would silently make stale
    // evidence actionful through an older valid link.
    if (sourceQualificationMismatch) {
        return {
            status: 'credential_fingerprint_mismatch',
            recordId: snapshot.recordId,
            persisted: false,
        };
    }

    const observation: ProviderAccountUsageObservation = {
        ...(qualifiedSources ? { sources: qualifiedSources } : {}),
    };
    const subscription = mergeProviderAccountSubscription(
        input.store.resolveRecordId(snapshot.recordId)?.subscription,
        snapshot.subscription,
    );
    const currentSnapshot = subscription
        ? { ...snapshot, subscription }
        : snapshot;

    let persisted = false;
    let unpersistedObservation: UnpersistedSnapshotObservation | undefined;
    if (input.persistence) {
        let targets: readonly QualifiedProviderAccountUsagePersistenceTarget[];
        try {
            targets = input.resolvePersistenceTargets && qualifiedSources?.length
                ? await input.resolvePersistenceTargets({
                    sessionId: input.sessionId,
                    snapshot: currentSnapshot,
                    sources: qualifiedSources,
                })
                : [];
        } catch (error) {
            if (!(error instanceof ProviderAccountUsageSourceQualificationError)) throw error;
            return {
                status: 'source_qualification_failed',
                reason: error.reason,
                recordId: currentSnapshot.recordId,
                persisted: false,
            };
        }
        const persistence = await input.persistence.recordInBandSnapshot(
            currentSnapshot,
            { targets },
        );
        persisted = persistence.status !== 'not_persisted';
        if (persistence.status === 'not_persisted') unpersistedObservation = persistence;
    }

    const recorded = input.store.recordSnapshot(currentSnapshot, observation);

    if (persisted) {
        void Promise.resolve().then(async () => {
            await input.publishRecordId?.({
                sessionId: input.sessionId,
                recordId: recorded.recordId,
            });
        }).catch(() => {
            // Session metadata refs are a best-effort projection over the canonical persisted record.
        });
    }

    return {
        status: recorded.status,
        recordId: recorded.recordId,
        persisted,
        ...(unpersistedObservation ? { persistence: unpersistedObservation } : {}),
        ...(qualifiedSources?.length === 1 ? { qualifiedSource: qualifiedSources[0] } : {}),
        ...(verifiedLocalSource && observedProviderAccountId ? { verifiedLocalSource, sourceProviderAccountId: observedProviderAccountId } : {}),
    };
}

export async function recordProviderAccountUsageAdoptionForSession(input: Readonly<{
    getChildren: () => ReadonlyArray<TrackedSessionLike | unknown>;
    store: Pick<ProviderAccountUsageStore, 'prepareAdoption'>;
    persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
    resolvePersistenceTargets?: QualifiedPersistenceTargetResolver;
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
}>): Promise<
    | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string; persisted: boolean }>
    | Readonly<{ status: 'session_not_found' }>
> {
    const tracked = findTrackedSession(input.getChildren(), input.sessionId);
    if (!tracked) return { status: 'session_not_found' };
    const adoption = ProviderAccountUsageAdoptionV1Schema.parse(input.adoption);
    const prepared = input.store.prepareAdoption(adoption);
    if (prepared.status === 'already_adopted') {
        const applied = prepared.commit();
        return {
            status: applied.status,
            fromRecordId: applied.fromRecordId,
            toRecordId: applied.toRecordId,
            persisted: true,
        };
    }
    if (!prepared.snapshot) {
        throw new Error('Provider account usage adoption canonical snapshot unavailable');
    }
    if (!input.persistence) {
        throw new Error('Provider account usage adoption persistence unavailable');
    }
    const targets = input.resolvePersistenceTargets
        ? await input.resolvePersistenceTargets({
            sessionId: input.sessionId,
            snapshot: prepared.snapshot,
            sources: prepared.observation.sources ?? [],
        })
        : [];
    const persistence = await input.persistence.recordInBandSnapshot(
        prepared.snapshot,
        { targets },
    );
    if (persistence.status === 'not_persisted') {
        throw new Error('Provider account usage adoption persistence target unavailable');
    }
    const applied = prepared.commit();
    try {
        await input.publishRecordId?.({
            sessionId: input.sessionId,
            recordId: applied.toRecordId,
        });
    } catch {
        // Usage display metadata is a best-effort projection over the canonical persisted record.
    }
    return {
        status: applied.status,
        fromRecordId: applied.fromRecordId,
        toRecordId: applied.toRecordId,
        persisted: true,
    };
}
