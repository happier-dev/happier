import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import {
    ProviderAccountUsageAdoptionV1Schema,
    type ProviderAccountUsageAdoptionV1,
} from './adoption';
import { computeProviderAccountUsageSnapshotMaterialRevision } from './fingerprint';

export type ProviderAccountUsageObservation = Readonly<{
    sources?: readonly ConnectedServiceUsageSourceV1[];
}>;

export type ProviderAccountUsageStoreMutationStatus =
    | 'snapshot_advanced'
    | 'source_linked'
    | 'duplicate'
    | 'older';

export type ProviderAccountUsageStoreMutationResult = Readonly<{
    status: ProviderAccountUsageStoreMutationStatus;
    recordId: ProviderAccountUsageRecordId;
    snapshotAdvanced: boolean;
    sourceLinked: boolean;
}>;

export function isProviderAccountUsageStoreMutationAccepted(
    result: Readonly<{ status: string }>,
): boolean {
    return result.status === 'snapshot_advanced' || result.status === 'source_linked';
}

export type ProviderAccountUsageAdoptionResult = Readonly<{
    status: 'adopted' | 'already_adopted';
    fromRecordId: ProviderAccountUsageRecordId;
    toRecordId: ProviderAccountUsageRecordId;
}>;

export type PreparedProviderAccountUsageAdoption = Readonly<{
    status: ProviderAccountUsageAdoptionResult['status'];
    fromRecordId: ProviderAccountUsageRecordId;
    toRecordId: ProviderAccountUsageRecordId;
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    observation: ProviderAccountUsageObservation;
    commit(): ProviderAccountUsageAdoptionResult;
}>;

export type ProviderAccountUsageStore = Readonly<{
    recordSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        observation?: ProviderAccountUsageObservation,
    ): ProviderAccountUsageStoreMutationResult;
    resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
    listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
    prepareAdoption(adoption: ProviderAccountUsageAdoptionV1): PreparedProviderAccountUsageAdoption;
}>;

function sourceKey(source: ConnectedServiceUsageSourceV1): string {
    const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
    return parsed.bindingKind === 'profile'
        ? JSON.stringify([parsed.serviceId, parsed.profileId, 'profile'])
        : JSON.stringify([
            parsed.serviceId,
            parsed.profileId,
            'group_member',
            parsed.groupId,
            parsed.groupGeneration ?? '',
        ]);
}

function normalizeObservation(
    rawSnapshot: ProviderAccountUsageSnapshotV1,
    observation?: ProviderAccountUsageObservation,
): Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    sources: readonly ConnectedServiceUsageSourceV1[];
}> {
    const sourceMap = new Map<string, ConnectedServiceUsageSourceV1>();
    for (const source of observation?.sources ?? []) {
        const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
        sourceMap.set(sourceKey(parsed), parsed);
    }
    return {
        snapshot: ProviderAccountUsageSnapshotV1Schema.parse(rawSnapshot),
        sources: [...sourceMap.values()],
    };
}

export function createProviderAccountUsageStore(): ProviderAccountUsageStore {
    const snapshotsByRecordId = new Map<string, ProviderAccountUsageSnapshotV1>();
    const redirectsByRecordId = new Map<string, string>();
    const stableRecordKeysByRecordId = new Map<string, ProviderAccountUsageRecordKeyV1>();
    const sourcesByRecordId = new Map<string, readonly ConnectedServiceUsageSourceV1[]>();
    const sourceRecordIdsByKey = new Map<string, string>();

    function resolveRedirect(recordId: string): string {
        let current = recordId;
        const seen = new Set<string>();
        while (redirectsByRecordId.has(current) && !seen.has(current)) {
            seen.add(current);
            current = redirectsByRecordId.get(current) ?? current;
        }
        return current;
    }

    function redirectChainContains(startRecordId: string, targetRecordId: string): boolean {
        let current = startRecordId;
        const seen = new Set<string>();
        while (!seen.has(current)) {
            if (current === targetRecordId) return true;
            seen.add(current);
            const next = redirectsByRecordId.get(current);
            if (!next) return false;
            current = next;
        }
        return false;
    }

    function setRecordSources(recordId: string, sources: readonly ConnectedServiceUsageSourceV1[]): void {
        sourcesByRecordId.set(recordId, sources);
        for (const source of sources) {
            sourceRecordIdsByKey.set(sourceKey(source), recordId);
        }
    }

    function mergeSources(
        left: readonly ConnectedServiceUsageSourceV1[],
        right: readonly ConnectedServiceUsageSourceV1[],
    ): readonly ConnectedServiceUsageSourceV1[] {
        const merged = new Map<string, ConnectedServiceUsageSourceV1>();
        for (const source of [...left, ...right]) {
            const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
            merged.set(sourceKey(parsed), parsed);
        }
        return [...merged.values()];
    }

    function recordSnapshot(
        rawSnapshot: ProviderAccountUsageSnapshotV1,
        observation?: ProviderAccountUsageObservation,
    ): ProviderAccountUsageStoreMutationResult {
        const normalized = normalizeObservation(rawSnapshot, observation);
        const parsed = normalized.snapshot;
        const targetRecordId = resolveRedirect(parsed.recordId);
        const existing = snapshotsByRecordId.get(targetRecordId);
        const targetRecordKey =
            targetRecordId === parsed.recordId
                ? parsed.recordKey
                : existing?.recordKey ?? stableRecordKeysByRecordId.get(targetRecordId);

        if (!targetRecordKey) {
            throw new Error(`Missing provider account usage adoption target key for ${targetRecordId}`);
        }

        const existingSources = sourcesByRecordId.get(targetRecordId) ?? [];
        const existingSourceKeys = new Set(existingSources.map(sourceKey));
        const sourceLinked = normalized.sources.some((source) => !existingSourceKeys.has(sourceKey(source)));
        const sources = sourceLinked
            ? mergeSources(existingSources, normalized.sources)
            : existingSources;

        if (existing && parsed.fetchedAtMs < existing.fetchedAtMs) {
            if (sourceLinked) setRecordSources(targetRecordId, sources);
            if (targetRecordId !== parsed.recordId) {
                snapshotsByRecordId.delete(parsed.recordId);
                sourcesByRecordId.delete(parsed.recordId);
            }
            return {
                status: sourceLinked ? 'source_linked' : 'older',
                recordId: targetRecordId as ProviderAccountUsageRecordId,
                snapshotAdvanced: false,
                sourceLinked,
            };
        }

        const next = ProviderAccountUsageSnapshotV1Schema.parse({
            ...parsed,
            recordId: targetRecordId,
            recordKey: targetRecordKey,
            providerId: targetRecordKey.providerId,
            accountSubject: targetRecordId === parsed.recordId
                ? parsed.accountSubject
                : existing?.accountSubject ?? {
                    kind: 'providerSubject',
                    id: targetRecordKey.accountSubjectId,
                },
        });
        const snapshotAdvanced = !existing
            || parsed.fetchedAtMs > existing.fetchedAtMs
            || computeProviderAccountUsageSnapshotMaterialRevision(next)
                !== computeProviderAccountUsageSnapshotMaterialRevision(existing);
        if (snapshotAdvanced) snapshotsByRecordId.set(targetRecordId, next);
        if (sourceLinked || !existing) setRecordSources(targetRecordId, sources);

        if (targetRecordId !== parsed.recordId) {
            snapshotsByRecordId.delete(parsed.recordId);
            sourcesByRecordId.delete(parsed.recordId);
        }
        return {
            status: snapshotAdvanced ? 'snapshot_advanced' : sourceLinked ? 'source_linked' : 'duplicate',
            recordId: targetRecordId as ProviderAccountUsageRecordId,
            snapshotAdvanced,
            sourceLinked,
        };
    }

    function prepareAdoption(adoption: ProviderAccountUsageAdoptionV1): PreparedProviderAccountUsageAdoption {
        const parsed = ProviderAccountUsageAdoptionV1Schema.parse(adoption);
        const expectedToRecordId = buildProviderAccountUsageRecordId(parsed.stableRecordKey);
        if (expectedToRecordId !== parsed.toRecordId) {
            throw new Error('Provider account usage adoption target record id mismatch');
        }
        const existingRedirect = resolveRedirect(parsed.fromRecordId);
        if (existingRedirect !== parsed.fromRecordId) {
            if (existingRedirect === parsed.toRecordId) {
                const snapshot = snapshotsByRecordId.get(parsed.toRecordId) ?? null;
                return {
                    status: 'already_adopted',
                    fromRecordId: parsed.fromRecordId,
                    toRecordId: parsed.toRecordId,
                    snapshot,
                    observation: {
                        sources: sourcesByRecordId.get(parsed.toRecordId) ?? [],
                    },
                    commit: () => {
                        if (resolveRedirect(parsed.fromRecordId) !== parsed.toRecordId) {
                            throw new Error(
                                `Provider account usage adoption ${parsed.fromRecordId} changed before commit`,
                            );
                        }
                        return {
                            status: 'already_adopted',
                            fromRecordId: parsed.fromRecordId,
                            toRecordId: parsed.toRecordId,
                        };
                    },
                };
            }
            throw new Error(`Provider account usage record ${parsed.fromRecordId} is already adopted to ${existingRedirect}`);
        }
        if (redirectChainContains(parsed.toRecordId, parsed.fromRecordId)) {
            throw new Error(`Provider account usage adoption would create a redirect cycle from ${parsed.fromRecordId} to ${parsed.toRecordId}`);
        }
        if (parsed.stableRecordKey.subjectKind === 'unknown') {
            throw new Error('Provider account usage adoption requires a stable target subject');
        }

        const fromSnapshot = snapshotsByRecordId.get(parsed.fromRecordId);
        if (fromSnapshot && fromSnapshot.accountSubject.kind !== 'provisionalLocalSubject') {
            throw new Error(`Provider account usage adoption source ${parsed.fromRecordId} is not provisional`);
        }
        const toSnapshot = snapshotsByRecordId.get(parsed.toRecordId);
        const hadFromSources = sourcesByRecordId.has(parsed.fromRecordId);
        const hadToSources = sourcesByRecordId.has(parsed.toRecordId);
        const fromSources = sourcesByRecordId.get(parsed.fromRecordId) ?? [];
        const toSources = sourcesByRecordId.get(parsed.toRecordId) ?? [];
        const targetSources = mergeSources(
            toSources,
            fromSources,
        );
        const snapshot = toSnapshot
            ? ProviderAccountUsageSnapshotV1Schema.parse({
                ...toSnapshot,
                recordId: parsed.toRecordId,
                recordKey: parsed.stableRecordKey,
                providerId: parsed.providerId,
                accountSubject: {
                    kind: 'providerSubject',
                    id: parsed.stableRecordKey.accountSubjectId,
                },
            })
            : fromSnapshot
                ? ProviderAccountUsageSnapshotV1Schema.parse({
                ...fromSnapshot,
                recordId: parsed.toRecordId,
                recordKey: parsed.stableRecordKey,
                providerId: parsed.providerId,
                accountSubject: {
                    kind: 'providerSubject',
                    id: parsed.stableRecordKey.accountSubjectId,
                },
            })
                : null;
        const targetRedirect = redirectsByRecordId.get(parsed.toRecordId);
        const targetStableRecordKey = stableRecordKeysByRecordId.get(parsed.toRecordId);
        const targetSourceRecordIds = new Map(
            targetSources.map((source) => {
                const key = sourceKey(source);
                return [key, sourceRecordIdsByKey.get(key)] as const;
            }),
        );

        return {
            status: 'adopted',
            fromRecordId: parsed.fromRecordId,
            toRecordId: parsed.toRecordId,
            snapshot,
            observation: { sources: targetSources },
            commit: () => {
                const currentFromRecordId = resolveRedirect(parsed.fromRecordId);
                if (currentFromRecordId !== parsed.fromRecordId) {
                    if (currentFromRecordId === parsed.toRecordId) {
                        return {
                            status: 'already_adopted',
                            fromRecordId: parsed.fromRecordId,
                            toRecordId: parsed.toRecordId,
                        };
                    }
                    throw new Error(
                        `Provider account usage record ${parsed.fromRecordId} changed before adoption commit`,
                    );
                }
                if (
                    snapshotsByRecordId.get(parsed.fromRecordId) !== fromSnapshot
                    || snapshotsByRecordId.get(parsed.toRecordId) !== toSnapshot
                    || sourcesByRecordId.has(parsed.fromRecordId) !== hadFromSources
                    || sourcesByRecordId.has(parsed.toRecordId) !== hadToSources
                    || (hadFromSources && sourcesByRecordId.get(parsed.fromRecordId) !== fromSources)
                    || (hadToSources && sourcesByRecordId.get(parsed.toRecordId) !== toSources)
                    || redirectsByRecordId.get(parsed.toRecordId) !== targetRedirect
                    || stableRecordKeysByRecordId.get(parsed.toRecordId) !== targetStableRecordKey
                    || [...targetSourceRecordIds].some(
                        ([key, recordId]) => sourceRecordIdsByKey.get(key) !== recordId,
                    )
                ) {
                    throw new Error(
                        `Provider account usage adoption ${parsed.fromRecordId} changed before commit`,
                    );
                }
                if (redirectChainContains(parsed.toRecordId, parsed.fromRecordId)) {
                    throw new Error(
                        `Provider account usage adoption would create a redirect cycle from ${parsed.fromRecordId} to ${parsed.toRecordId}`,
                    );
                }

                redirectsByRecordId.set(parsed.fromRecordId, parsed.toRecordId);
                stableRecordKeysByRecordId.set(parsed.toRecordId, parsed.stableRecordKey);
                setRecordSources(parsed.toRecordId, targetSources);
                if (snapshot) snapshotsByRecordId.set(parsed.toRecordId, snapshot);
                if (fromSnapshot) snapshotsByRecordId.delete(parsed.fromRecordId);
                sourcesByRecordId.delete(parsed.fromRecordId);

                return {
                    status: 'adopted',
                    fromRecordId: parsed.fromRecordId,
                    toRecordId: parsed.toRecordId,
                };
            },
        };
    }

    function resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null {
        return snapshotsByRecordId.get(resolveRedirect(recordId)) ?? null;
    }

    function listSnapshots(): readonly ProviderAccountUsageSnapshotV1[] {
        return [...snapshotsByRecordId.entries()]
            .filter(([recordId]) => resolveRedirect(recordId) === recordId)
            .map(([, snapshot]) => snapshot)
            .sort((left, right) => left.recordId.localeCompare(right.recordId));
    }

    function resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null {
        const recordId = sourceRecordIdsByKey.get(sourceKey(source));
        if (!recordId) return null;
        return snapshotsByRecordId.get(resolveRedirect(recordId)) ?? null;
    }

    return {
        recordSnapshot,
        resolveRecordId,
        resolveBySource,
        listSnapshots,
        prepareAdoption,
    };
}
