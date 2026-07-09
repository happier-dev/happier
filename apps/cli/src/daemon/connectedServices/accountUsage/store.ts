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

export type ProviderAccountUsageObservation = Readonly<{
    sources?: readonly ConnectedServiceUsageSourceV1[];
}>;

export type ProviderAccountUsageStore = Readonly<{
    recordSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        observation?: ProviderAccountUsageObservation,
    ): Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId }>;
    resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
    listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
    applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
        status: 'adopted' | 'already_adopted';
        fromRecordId: ProviderAccountUsageRecordId;
        toRecordId: ProviderAccountUsageRecordId;
    }>;
}>;

function sourceKey(source: ConnectedServiceUsageSourceV1): string {
    const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
    return JSON.stringify([
        parsed.serviceId,
        parsed.profileId,
        parsed.bindingKind,
        parsed.groupId ?? '',
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
    ): Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId }> {
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

        const sources = mergeSources(sourcesByRecordId.get(targetRecordId) ?? [], normalized.sources);

        if (existing && parsed.fetchedAtMs < existing.fetchedAtMs) {
            setRecordSources(targetRecordId, sources);
            if (targetRecordId !== parsed.recordId) {
                snapshotsByRecordId.delete(parsed.recordId);
                sourcesByRecordId.delete(parsed.recordId);
            }
            return { status: 'recorded', recordId: targetRecordId as ProviderAccountUsageRecordId };
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
        snapshotsByRecordId.set(targetRecordId, next);
        setRecordSources(targetRecordId, sources);

        if (targetRecordId !== parsed.recordId) {
            snapshotsByRecordId.delete(parsed.recordId);
            sourcesByRecordId.delete(parsed.recordId);
        }
        return { status: 'recorded', recordId: targetRecordId as ProviderAccountUsageRecordId };
    }

    function applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
        status: 'adopted' | 'already_adopted';
        fromRecordId: ProviderAccountUsageRecordId;
        toRecordId: ProviderAccountUsageRecordId;
    }> {
        const parsed = ProviderAccountUsageAdoptionV1Schema.parse(adoption);
        const expectedToRecordId = buildProviderAccountUsageRecordId(parsed.stableRecordKey);
        if (expectedToRecordId !== parsed.toRecordId) {
            throw new Error('Provider account usage adoption target record id mismatch');
        }
        const existingRedirect = resolveRedirect(parsed.fromRecordId);
        if (existingRedirect !== parsed.fromRecordId) {
            if (existingRedirect === parsed.toRecordId) {
                return { status: 'already_adopted', fromRecordId: parsed.fromRecordId, toRecordId: parsed.toRecordId };
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

        redirectsByRecordId.set(parsed.fromRecordId, parsed.toRecordId);
        stableRecordKeysByRecordId.set(parsed.toRecordId, parsed.stableRecordKey);

        const targetSources = mergeSources(
            sourcesByRecordId.get(parsed.toRecordId) ?? [],
            sourcesByRecordId.get(parsed.fromRecordId) ?? [],
        );
        setRecordSources(parsed.toRecordId, targetSources);

        const toSnapshot = snapshotsByRecordId.get(parsed.toRecordId);
        if (toSnapshot) {
            snapshotsByRecordId.set(parsed.toRecordId, ProviderAccountUsageSnapshotV1Schema.parse({
                ...toSnapshot,
                recordId: parsed.toRecordId,
                recordKey: parsed.stableRecordKey,
                providerId: parsed.providerId,
                accountSubject: {
                    kind: 'providerSubject',
                    id: parsed.stableRecordKey.accountSubjectId,
                },
            }));
        } else if (fromSnapshot) {
            snapshotsByRecordId.set(parsed.toRecordId, ProviderAccountUsageSnapshotV1Schema.parse({
                ...fromSnapshot,
                recordId: parsed.toRecordId,
                recordKey: parsed.stableRecordKey,
                providerId: parsed.providerId,
                accountSubject: {
                    kind: 'providerSubject',
                    id: parsed.stableRecordKey.accountSubjectId,
                },
            }));
        }

        if (fromSnapshot) snapshotsByRecordId.delete(parsed.fromRecordId);
        sourcesByRecordId.delete(parsed.fromRecordId);

        return { status: 'adopted', fromRecordId: parsed.fromRecordId, toRecordId: parsed.toRecordId };
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
        applyAdoption,
    };
}
