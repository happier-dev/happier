import type { MachineResourceState } from './machineResourceStore';

type ReadState = Pick<MachineResourceState, 'status' | 'snapshot'>;
export type MachineVitalsPublication = Readonly<{
    state: 'reporting' | 'unavailable';
    reason?: string | null;
    since?: number | null;
}>;
export type MachineResourceObservation = Readonly<{
    stale: boolean;
    readStatus: 'slow' | 'error' | undefined;
    readerFailed: boolean;
    freshness: 'live' | 'held' | 'stale';
    unsupported: boolean;
}>;

export function isMachineResourceStateStale(state: Pick<ReadState, 'snapshot'>, now: number): boolean {
    const sample = state.snapshot?.sample;
    return sample !== null && sample !== undefined && now - sample.sampledAt >= sample.intervalMs * 2;
}

export function readMachineResourceReadStatus(state: Pick<ReadState, 'status'>): 'slow' | 'error' | undefined {
    return state.status === 'slow' || state.status === 'error' ? state.status : undefined;
}

/** Shared availability facts; surfaces retain their own compact/full presentation. */
export function readMachineResourceObservation(state: ReadState & Readonly<{ stale: boolean }>, publication: MachineVitalsPublication | null = null): MachineResourceObservation {
    const reportingAt = state.status === 'ready' && state.snapshot?.state === 'reporting'
        ? state.snapshot.sample?.sampledAt ?? null : null;
    // The authorized reporting answer owns recovery. A later failure still wins;
    // old durable metadata cannot turn the same recovered observation into an error in another view.
    const readerFailed = publication?.reason === 'reader_failed'
        && (reportingAt === null || (publication.since != null && publication.since >= reportingAt));
    const readStatus = readMachineResourceReadStatus(state);
    const freshness: 'live' | 'held' | 'stale' = state.stale || readerFailed ? 'stale'
        : readStatus || state.snapshot?.state === 'unavailable' ? 'held' : 'live';
    return {
        stale: state.stale, readStatus, readerFailed, freshness,
        unsupported: publication?.reason === 'helper_missing' || state.snapshot?.reason === 'helper_missing',
    };
}
