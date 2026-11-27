/** Positions in one holder instance's existing sequenced stdout. Offsets are bytes. */
export type HolderReplayPosition = Readonly<{ sequence: number; byteOffset: number }>;

export type HolderReplayRange = Readonly<{
    holderInstanceId: string;
    start: HolderReplayPosition;
    end: HolderReplayPosition;
}>;

const holderReplayRanges = new WeakMap<object, HolderReplayRange>();

/** Keep provenance in process as bytes and records pass through the provider transport. */
export function setHolderReplayRange<T extends object>(value: T, range: HolderReplayRange): T {
    holderReplayRanges.set(value, range);
    return value;
}

export function getHolderReplayRange(value: object): HolderReplayRange | undefined {
    return holderReplayRanges.get(value);
}

/** Join adjacent parts of the same raw record. */
export function joinHolderReplayRanges(
    first: HolderReplayRange | undefined,
    last: HolderReplayRange | undefined,
): HolderReplayRange | undefined {
    if (!first) return last;
    if (!last) return first;
    if (first.holderInstanceId !== last.holderInstanceId) {
        throw new Error('Holder stdout changed instance within one record');
    }
    return { holderInstanceId: first.holderInstanceId, start: first.start, end: last.end };
}

/** Validation and normalization may return a new object with the same source. */
export function carryHolderReplayRange<T extends object>(source: object | undefined, target: T): T {
    if (!source) return target;
    const range = getHolderReplayRange(source);
    const commit = getHolderReplayCommit(source);
    if (range) setHolderReplayRange(target, range);
    if (commit) setHolderReplayCommit(target, commit);
    return target;
}

/** One transcript effect of a decoded holder record. Callbacks are never serialized. */
export type HolderReplayCommit = Readonly<{
    range: HolderReplayRange;
    adopted?: boolean;
    onCommitted(committedSequence?: number): void;
}>;

export type HolderReplayRecord = Readonly<{
    beginEffect(): HolderReplayCommit;
    finishDispatch(): void;
}>;

const recordByRange = new WeakMap<HolderReplayRange, HolderReplayRecord>();
const commitByEvent = new WeakMap<object, HolderReplayCommit>();

export function bindHolderReplayRecord(
    range: HolderReplayRange,
    options: Readonly<{ adopted: boolean; acceptRange(range: HolderReplayRange): void }>,
): HolderReplayRecord {
    let pending = 0;
    let dispatched = false;
    const maybeAccept = () => {
        if (dispatched && pending === 0) options.acceptRange(range);
    };
    const record: HolderReplayRecord = {
        beginEffect() {
            pending += 1;
            let reported = false;
            return {
                range,
                adopted: options.adopted,
                onCommitted() {
                    if (reported) return;
                    reported = true;
                    pending -= 1;
                    maybeAccept();
                },
            };
        },
        finishDispatch() {
            if (dispatched) return;
            dispatched = true;
            maybeAccept();
        },
    };
    recordByRange.set(range, record);
    return record;
}

export function getHolderReplayRecord(source: object): HolderReplayRecord | undefined {
    const range = getHolderReplayRange(source);
    return range && recordByRange.get(range);
}

export function setHolderReplayCommit<T extends object>(value: T, commit: HolderReplayCommit): T {
    commitByEvent.set(value, commit);
    return value;
}

export function getHolderReplayCommit(value: object): HolderReplayCommit | undefined {
    return commitByEvent.get(value);
}
