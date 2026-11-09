import { describe, expect, it } from 'vitest';
import {
    applyExecutionRunLinkDeliveryV1,
    applyExecutionRunLinkRelayV1,
    applyExecutionRunLinkReportV1,
} from '@happier-dev/protocol';

import {
    readExecutionRunLinkPresentationSource,
    resolveExecutionRunDeliveryState,
    resolveExecutionRunTurnState,
    shouldShowExecutionRunLinkPresentation,
    type ExecutionRunLinkPresentationSource,
} from './executionRunLinkPresentation';

function link(
    overrides: Partial<ExecutionRunLinkPresentationSource> = {},
): ExecutionRunLinkPresentationSource {
    return {
        v: 1 as const,
        parentSessionId: 'lead',
        runId: 'run-1',
        turnEpoch: 0,
        ...overrides,
    };
}

const report = (turnEpoch: number, ack: 'pending' | 'accepted' | 'failed') => ({
    turnEpoch, ack, reportedAt: 100, attempts: 1,
});
const relay = (turnEpoch: number, status: 'queued' | 'failed') => ({
    turnEpoch, status, localId: 'completion-1', at: 110,
});
const delivery = (turnEpoch: number) => ({
    turnEpoch, status: 'verified' as const, localId: 'completion-1', transcriptSeq: 12, verifiedAt: 120,
});

describe('executionRunLinkPresentation', () => {
    it.each([
        ['verified delivery', link({
            report: report(1, 'accepted'),
            relay: relay(1, 'queued'),
            delivery: delivery(1),
        }), 'sent'],
        ['queued relay without delivery', link({
            report: report(1, 'accepted'),
            relay: relay(1, 'queued'),
        }), 'queued'],
        ['accepted report without relay', link({
            report: report(1, 'accepted'),
        }), 'reported'],
        ['failed report', link({
            report: report(1, 'failed'),
        }), 'report_failed'],
        ['failed relay', link({
            report: report(1, 'accepted'),
            relay: relay(1, 'failed'),
        }), 'relay_failed'],
        ['no receipt', link(), 'not_sent'],
        ['pending report', link({
            report: report(1, 'pending'),
        }), 'report_pending'],
    ] as const)('resolves %s as %s', (_label, source, expected) => {
        expect(resolveExecutionRunDeliveryState(source)).toBe(expected);
    });

    it('lets the protocol resolver prefer the newest receipt epoch over an older verified delivery', () => {
        expect(resolveExecutionRunDeliveryState(link({
            report: report(2, 'accepted'),
            relay: relay(2, 'queued'),
            delivery: delivery(1),
        }))).toBe('queued');
    });

    it.each([
        ['verified delivery', { report: report(1, 'accepted'), relay: relay(1, 'queued'), delivery: delivery(1) }, 'sent'],
        ['queued relay only', { relay: relay(1, 'queued') }, 'queued'],
        ['accepted report only', { report: report(1, 'accepted') }, 'reported'],
        ['no receipt', {}, 'not_sent'],
    ] as const)('resolves writer-shaped %s records as %s', (_label, records, expected) => {
        let metadata: Record<string, unknown> = { executionRunLinkV1: link() };
        if ('report' in records && records.report) {
            metadata = applyExecutionRunLinkReportV1(metadata, { runId: 'run-1', report: records.report });
        }
        if ('relay' in records && records.relay) {
            metadata = applyExecutionRunLinkRelayV1(metadata, { runId: 'run-1', relay: records.relay });
        }
        if ('delivery' in records && records.delivery) {
            metadata = applyExecutionRunLinkDeliveryV1(metadata, { runId: 'run-1', delivery: records.delivery });
        }

        expect(resolveExecutionRunDeliveryState(readExecutionRunLinkPresentationSource(metadata))).toBe(expected);
    });

    it.each([
        [{ latestTurnStatus: 'completed', pendingCount: 0, hasPendingRequests: false }, 'finished'],
        [{ latestTurnStatus: 'completed', pendingCount: 1, hasPendingRequests: false }, 'existing'],
        [{ latestTurnStatus: 'completed', pendingCount: 0, hasPendingRequests: true }, 'existing'],
        [{ latestTurnStatus: 'in_progress', pendingCount: 0, hasPendingRequests: false }, 'existing'],
        [{ latestTurnStatus: 'failed', pendingCount: 0, hasPendingRequests: false }, 'finished'],
        [{ latestTurnStatus: 'cancelled', pendingCount: 0, hasPendingRequests: false }, 'finished'],
    ] as const)('keeps turn completion separate from pending work for %o', (input, expected) => {
        expect(resolveExecutionRunTurnState(input)).toBe(expected);
    });

    it('reads the exact metadata carrier and keeps malformed records fail-closed', () => {
        expect(readExecutionRunLinkPresentationSource({ executionRunLinkV1: link() })).toEqual(link());
        expect(readExecutionRunLinkPresentationSource({ executionRunLinkV1: { ...link(), turnEpoch: -1 } })).toBeNull();
        expect(readExecutionRunLinkPresentationSource({ executionRunLinkV1: { ...link(), runId: '' } })).toBeNull();
    });

    it('shows delivery state for linked runs and unbound team placeholders, but not ordinary agent children', () => {
        expect(shouldShowExecutionRunLinkPresentation({ executionRunLinkV1: link() })).toBe(true);
        expect(shouldShowExecutionRunLinkPresentation({
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } },
        })).toBe(true);
        expect(shouldShowExecutionRunLinkPresentation({
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead' },
        })).toBe(false);
    });
});
