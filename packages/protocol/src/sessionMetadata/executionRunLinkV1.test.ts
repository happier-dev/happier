import { describe, expect, it } from 'vitest';

import {
    EXECUTION_RUN_LINK_V1_META_KEY,
    ExecutionRunLinkV1Schema,
    SessionExecutionRunChildTurnReportV1RequestSchema,
    SessionExecutionRunChildTurnReportV1ResponseSchema,
    applyExecutionRunLinkDeliveryV1,
    applyExecutionRunLinkRelayV1,
    applyExecutionRunLinkReportV1,
    applyExecutionRunLinkV1ToMetadata,
    resolveExecutionRunLinkDeliveryStateV1,
    readExecutionRunLinkV1,
    readExecutionRunLinkV1FromMessageMeta,
    stripExecutionRunLinkV1FromMessageMeta,
} from './executionRunLinkV1.js';

describe('executionRunLinkV1 session metadata', () => {
    const link = { v: 1 as const, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };

    it('reads a seeded link and treats absent, malformed, and newer links as unlinked', () => {
        expect(readExecutionRunLinkV1({ executionRunLinkV1: { ...link, future: true } })).toEqual({ ...link, future: true });
        for (const metadata of [null, {}, { executionRunLinkV1: { ...link, v: 2 } },
            { executionRunLinkV1: { ...link, runId: ' ' } }, { executionRunLinkV1: { ...link, turnEpoch: -1 } }]) {
            expect(readExecutionRunLinkV1(metadata)).toBeNull();
        }
    });

    it('replaces only the link and preserves every other metadata key by reference', () => {
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'lead' };
        const metadata = { sessionOriginV1: origin, executionRunLinkV1: { ...link, runId: 'run_0' } };
        const next = applyExecutionRunLinkV1ToMetadata(metadata, link);
        expect(next.executionRunLinkV1).toEqual(link);
        expect(next.sessionOriginV1).toBe(origin);
    });

    it('reads the link from message meta and strips a caller-supplied copy from user-facing sends', () => {
        const meta = { [EXECUTION_RUN_LINK_V1_META_KEY]: link, other: 1 };
        expect(readExecutionRunLinkV1FromMessageMeta(meta)).toEqual(link);
        expect(stripExecutionRunLinkV1FromMessageMeta(meta)).toEqual({ other: 1 });
        const untouched = { other: 1 };
        expect(stripExecutionRunLinkV1FromMessageMeta(untouched)).toBe(untouched);
    });
});

describe('session.executionRun.childTurn.report.v1', () => {
    it('accepts the linked handshake and turn-completed wake-ups only with a non-negative epoch', () => {
        const report = { runId: 'run_1', linkedSessionId: 'child', turnEpoch: 3, kind: 'turn_completed' };
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.parse(report)).toEqual(report);
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.parse({ ...report, kind: 'linked', turnEpoch: 0 }).kind).toBe('linked');
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.safeParse({ ...report, turnEpoch: -1 }).success).toBe(false);
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.safeParse({ ...report, kind: 'final_text' }).success).toBe(false);
        // A failed child turn is reported too, so the parent can evaluate or fail the run.
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.parse({ ...report, turnStatus: 'failed' }).turnStatus).toBe('failed');
        expect(SessionExecutionRunChildTurnReportV1RequestSchema.safeParse({ ...report, turnStatus: 'aborted' }).success).toBe(false);
        expect(SessionExecutionRunChildTurnReportV1ResponseSchema.parse({ ok: true, accepted: false, reason: 'stale_epoch' }))
            .toEqual({ ok: true, accepted: false, reason: 'stale_epoch' });
    });
});

describe('executionRunLinkV1 turn-report, relay, and delivery state (R21)', () => {
    const link = { v: 1 as const, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };
    const linked = { executionRunLinkV1: link, other: true };

    it('records the child report ack from its RPC outcome, success or failure, without touching other writers\' records', () => {
        const relay = { turnEpoch: 1, status: 'queued' as const, localId: 'completion:run_1', at: 5 };
        const withRelay = applyExecutionRunLinkRelayV1(linked, { runId: 'run_1', relay });
        const accepted = applyExecutionRunLinkReportV1(withRelay, { runId: 'run_1', report: { turnEpoch: 1, reportedAt: 6, ack: 'accepted', attempts: 1 } });
        expect(readExecutionRunLinkV1(accepted)).toEqual({ ...link, relay, report: { turnEpoch: 1, reportedAt: 6, ack: 'accepted', attempts: 1 } });
        const failed = applyExecutionRunLinkReportV1(linked, { runId: 'run_1', report: { turnEpoch: 1, reportedAt: 7, ack: 'failed', attempts: 3 } });
        expect(readExecutionRunLinkV1(failed)?.report?.ack).toBe('failed');
        expect(failed.other).toBe(true);
    });

    it('records the parent relay as queued or failed, and never writes onto another run\'s link', () => {
        const queued = applyExecutionRunLinkRelayV1(linked, { runId: 'run_1', relay: { turnEpoch: 1, status: 'queued', localId: 'l1', at: 5 } });
        expect(readExecutionRunLinkV1(queued)?.relay?.status).toBe('queued');
        const failed = applyExecutionRunLinkRelayV1(linked, { runId: 'run_1', relay: { turnEpoch: 1, status: 'failed', localId: 'l1', at: 5 } });
        expect(readExecutionRunLinkV1(failed)?.relay?.status).toBe('failed');
        expect(applyExecutionRunLinkRelayV1(linked, { runId: 'run_other', relay: { turnEpoch: 1, status: 'queued', localId: 'l1', at: 5 } })).toBe(linked);
        expect(applyExecutionRunLinkRelayV1({}, { runId: 'run_1', relay: { turnEpoch: 1, status: 'queued', localId: 'l1', at: 5 } })).toEqual({});
    });

    it('records delivery only as verified transcript evidence for a queued relay with the same localId and epoch', () => {
        const queued = applyExecutionRunLinkRelayV1(linked, { runId: 'run_1', relay: { turnEpoch: 1, status: 'queued', localId: 'l1', at: 5 } });
        const delivery = { turnEpoch: 1, status: 'verified' as const, localId: 'l1', transcriptSeq: 42, verifiedAt: 9 };
        expect(readExecutionRunLinkV1(applyExecutionRunLinkDeliveryV1(queued, { runId: 'run_1', delivery }))?.delivery).toEqual(delivery);
        // Completion alone or a relay without a matching queued record never yields delivery.
        expect(applyExecutionRunLinkDeliveryV1(linked, { runId: 'run_1', delivery })).toBe(linked);
        expect(applyExecutionRunLinkDeliveryV1(queued, { runId: 'run_1', delivery: { ...delivery, localId: 'other' } })).toBe(queued);
        const relayFailed = applyExecutionRunLinkRelayV1(linked, { runId: 'run_1', relay: { turnEpoch: 1, status: 'failed', localId: 'l1', at: 5 } });
        expect(applyExecutionRunLinkDeliveryV1(relayFailed, { runId: 'run_1', delivery })).toBe(relayFailed);
        expect(ExecutionRunLinkV1Schema.safeParse({ ...link, delivery: { ...delivery, transcriptSeq: undefined } }).success).toBe(false);
    });

    it('derives one delivery state that never claims delivery from completion, a report, or a queued relay', () => {
        const state = (value: Record<string, unknown> | null) => resolveExecutionRunLinkDeliveryStateV1(value ? { ...link, ...value } : null);
        expect(state(null)).toBe('not_sent');
        expect(state({})).toBe('not_sent');
        expect(state({ report: { turnEpoch: 1, reportedAt: 1, ack: 'pending', attempts: 1 } })).toBe('report_pending');
        expect(state({ report: { turnEpoch: 1, reportedAt: 1, ack: 'failed', attempts: 3 } })).toBe('report_failed');
        expect(state({ report: { turnEpoch: 1, reportedAt: 1, ack: 'accepted', attempts: 1 } })).toBe('reported');
        const relay = { turnEpoch: 1, status: 'queued', localId: 'l1', at: 2 };
        expect(state({ report: { turnEpoch: 1, reportedAt: 1, ack: 'accepted', attempts: 1 }, relay })).toBe('queued');
        expect(state({ relay: { ...relay, status: 'failed' } })).toBe('relay_failed');
        expect(state({ relay, delivery: { turnEpoch: 1, status: 'verified', localId: 'l1', transcriptSeq: 3, verifiedAt: 4 } })).toBe('sent');
        // A newer reported turn supersedes an older verified delivery.
        expect(state({
            report: { turnEpoch: 2, reportedAt: 5, ack: 'accepted', attempts: 1 },
            relay,
            delivery: { turnEpoch: 1, status: 'verified', localId: 'l1', transcriptSeq: 3, verifiedAt: 4 },
        })).toBe('reported');
    });
});
