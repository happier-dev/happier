import type { ManagedServiceNativeLogResultV1, ManagedServiceUnavailableReasonV1 } from '@happier-dev/protocol';
import { buildLogIndexV1, type LogIndexV1 } from '@happier-dev/forge-ci/runtime';

export type MachineServiceLogProjection =
    | Readonly<{ kind: 'index'; index: LogIndexV1; truncated: boolean; secretMasking: boolean }>
    | Readonly<{ kind: 'sourceChanged'; index: LogIndexV1 | null }>
    | Readonly<{ kind: 'unavailable'; reason: ManagedServiceUnavailableReasonV1 }>;

/** Admit only the two finite native pages. Forge owns byte/ANSI indexing and all line projections. */
export function buildMachineServiceLogIndex(input: Readonly<{
    sourceKey: string;
    first: ManagedServiceNativeLogResultV1;
    followed?: ManagedServiceNativeLogResultV1;
    baseline?: LogIndexV1;
    /** False when the followed read is the latest window (a tail read without a cursor), not a continuation. */
    continues?: boolean;
}>): MachineServiceLogProjection {
    const { first, followed } = input;
    if (first.kind === 'unavailable') return { kind: 'unavailable', reason: first.reason };
    const previous = input.baseline?.sourceKey === input.sourceKey ? input.baseline : null;
    // A source transition is not an authority withdrawal. Keep only this exact
    // source/Account's already-admitted finite observation until Read again.
    if (first.kind === 'source-changed' || followed?.kind === 'source-changed')
        return { kind: 'sourceChanged', index: previous };
    if (followed?.kind === 'page' && followed.page.sourceRevision !== first.page.sourceRevision) {
        return { kind: 'sourceChanged', index: previous };
    }
    const next = followed?.kind === 'page' ? followed.page : null;
    // A cursor page continues exact bytes. Without a cursor the live answer is a replacement tail.
    const append = first.page.nextCursor !== null && input.continues !== false;
    const text = next ? append ? first.page.text + next.text : next.text : first.page.text;
    const index = buildLogIndexV1({
        sourceKey: input.sourceKey, positionBasis: 'page', baseline: input.baseline,
        log: { logId: first.page.sourceRevision, startLine: 1, startByte: 0,
            complete: false, continuation: next ? next.nextCursor : first.page.nextCursor, text },
    });
    // The source's own notice that masking is incomplete stays beside the log, never one of its lines.
    const secretMasking = (next ?? first.page).secretMasking === 'incomplete';
    return { kind: 'index', index, truncated: next ? next.truncated || append && first.page.truncated : first.page.truncated,
        secretMasking };
}
