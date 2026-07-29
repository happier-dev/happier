import {
    EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
    buildExternalSessionStatusDemandReplaceV1,
    type ExternalSessionStatusDemandEntryV1,
} from '@happier-dev/protocol';

type DemandLink = Readonly<Omit<ExternalSessionStatusDemandEntryV1, 'demand'>>;

type DemandSnapshot = Readonly<{
    loaded: ReadonlyArray<DemandLink>;
    visible: ReadonlyArray<DemandLink>;
    open: ReadonlyArray<DemandLink>;
}>;

type DemandEmitter = (
    event: typeof EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
    payload: ReturnType<typeof buildExternalSessionStatusDemandReplaceV1>,
) => void;

function buildEntries(snapshot: DemandSnapshot): ExternalSessionStatusDemandEntryV1[] {
    return [
        ...snapshot.loaded.map((entry) => ({ ...entry, demand: 'loaded' as const })),
        ...snapshot.visible.map((entry) => ({ ...entry, demand: 'visible' as const })),
        ...snapshot.open.map((entry) => ({ ...entry, demand: 'open' as const })),
    ];
}

/**
 * Converts one viewport snapshot into one monotonic semantic replace-set.
 * It owns neither socket lifecycle nor per-row effects.
 */
export function createExternalSessionStatusDemandBatcher(
    params: Readonly<{ emit: DemandEmitter }>,
) {
    let revision = 0;
    let currentEntries: ExternalSessionStatusDemandEntryV1[] = [];
    let currentSignature: string | null = null;

    const emitCurrent = (): void => {
        revision += 1;
        const payload = buildExternalSessionStatusDemandReplaceV1({
            revision,
            entries: currentEntries,
        });
        params.emit(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1, payload);
    };

    return {
        replace(snapshot: DemandSnapshot): void {
            const next = buildExternalSessionStatusDemandReplaceV1({
                revision: 0,
                entries: buildEntries(snapshot),
            }).entries;
            const signature = JSON.stringify(next);
            if (signature === currentSignature) return;
            currentEntries = next;
            currentSignature = signature;
            emitCurrent();
        },

        resend(): void {
            if (currentSignature === null) return;
            emitCurrent();
        },
    };
}
