import { describe, expect, it } from 'vitest';
import { DaemonExecutionRunEntrySchema } from '@happier-dev/protocol/daemon/executionRuns';
import { t } from '@/text';

import { aggregateMachineRunReads, selectMachineRunsForPresentation, summarizeRunListPresentation } from './runListPresentation';

describe('Runs presentation', () => {
    it('retains owned rows and one typed unavailable fact when another Machine refuses its registry read', () => {
        const run = DaemonExecutionRunEntrySchema.parse({
            happyHomeDir: '/tmp/happier', pid: 123, happySessionId: null,
            runId: 'owned-run', callId: 'call', sidechainId: 'side', intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' }, runClass: 'bounded',
            ioMode: 'request_response', retentionPolicy: 'ephemeral', status: 'running',
            startedAtMs: 1, updatedAtMs: 1,
        });
        const aggregate = aggregateMachineRunReads([
            { serverId: 'home', machineId: 'shared', result: { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' } },
            { serverId: 'home', machineId: 'owned', result: { ok: true, runs: [run] } },
        ]);
        expect(aggregate.status).toBe('loaded');
        expect(aggregate.unavailableMachines).toEqual([
            { serverId: 'home', machineId: 'shared', reason: 'read_failed', error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' },
        ]);
        if (aggregate.status !== 'loaded') throw new Error('Owned read was hidden');
        const visible = selectMachineRunsForPresentation({
            runs: aggregate.runsByMachineAddressKey[JSON.stringify(['home', 'owned'])], showFinished: false, requestedRunId: null,
        });
        const unavailable = selectMachineRunsForPresentation({
            runs: aggregate.runsByMachineAddressKey[JSON.stringify(['home', 'shared'])], showFinished: false, requestedRunId: null,
        });
        expect(visible).toEqual([run]);
        expect(unavailable).toBeNull();
        expect(summarizeRunListPresentation([visible, unavailable])).toEqual({ emptyState: null, unknownMachineCount: 1 });
    });

    it('replaces only a pushed Machine read while preserving other Homes and unavailable facts', () => {
        const run = DaemonExecutionRunEntrySchema.parse({
            happyHomeDir: '/tmp/happier', pid: 123, happySessionId: null,
            runId: 'retained', callId: 'call', sidechainId: 'side', intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' }, runClass: 'bounded',
            ioMode: 'request_response', retentionPolicy: 'ephemeral', status: 'cancelled',
            startedAtMs: 1, updatedAtMs: 1,
        });
        const previous = aggregateMachineRunReads([
            { serverId: 'home-a', machineId: 'same', result: { ok: true, runs: [run] } },
            { serverId: 'home-b', machineId: 'same', result: { ok: true, runs: [run] } },
            { serverId: 'home-b', machineId: 'refused', result: { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' } },
        ]);
        const next = aggregateMachineRunReads([
            { serverId: 'home-a', machineId: 'same', result: { ok: true, runs: [] } },
        ], previous);
        expect(next).toMatchObject({ status: 'loaded', runsByMachineAddressKey: {
            [JSON.stringify(['home-a', 'same'])]: [],
            [JSON.stringify(['home-b', 'same'])]: [run],
        }, unavailableMachines: previous.unavailableMachines });
    });

    it('distinguishes unread and failed Machines from successful zero, and errors only when every attempted read fails', () => {
        const unread = { serverId: 'home', machineId: 'offline', result: undefined } as const;
        const failed = { serverId: 'home', machineId: 'refused',
            result: { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' } } as const;
        const empty = { serverId: 'home', machineId: 'owned', result: { ok: true, runs: [] } } as const;
        expect(aggregateMachineRunReads([empty, failed, unread])).toMatchObject({ status: 'loaded', unavailableMachines: [
            { machineId: 'refused', reason: 'read_failed', errorCode: 'RPC_FORBIDDEN' },
            { machineId: 'offline', reason: 'not_read', error: null, errorCode: null },
        ] });
        expect(aggregateMachineRunReads([unread])).toMatchObject({ status: 'loaded', unavailableMachines: [{ reason: 'not_read' }] });
        expect(aggregateMachineRunReads([failed, unread])).toMatchObject({ status: 'error', error: t('detailPages.runs.machineNotShared') });
        expect(aggregateMachineRunReads([{ ...failed, result: { ok: false, error: 'Daemon connection failed' } }]))
            .toMatchObject({ status: 'error', error: 'Daemon connection failed' });
        expect(aggregateMachineRunReads([empty])).toMatchObject({ status: 'loaded', unavailableMachines: [] });
        expect(aggregateMachineRunReads([empty, { serverId: 'home', machineId: 'unknown',
            result: { ok: false, error: 'Unsupported response from machine RPC' } }])).toMatchObject({
            status: 'loaded', unavailableMachines: [{ reason: 'read_failed', errorCode: null }],
        });
        expect(aggregateMachineRunReads([])).toMatchObject({ status: 'loaded', unavailableMachines: [] });
    });

    it('keeps a skipped, offline or unobserved Machine unknown instead of confirming no runs', () => {
        expect(selectMachineRunsForPresentation({ runs: undefined, showFinished: false, requestedRunId: null })).toBeNull();
        expect(selectMachineRunsForPresentation({ runs: [], showFinished: false, requestedRunId: null })).toEqual([]);
    });

    it('preserves status and exact Run filters for an observed Machine', () => {
        const running = DaemonExecutionRunEntrySchema.parse({
            happyHomeDir: '/tmp/happier', pid: 123, happySessionId: null,
            runId: 'running', callId: 'call', sidechainId: 'side', intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' }, runClass: 'bounded',
            ioMode: 'request_response', retentionPolicy: 'ephemeral', status: 'running',
            startedAtMs: 1, updatedAtMs: 1,
        });
        const finished = DaemonExecutionRunEntrySchema.parse({ ...running, runId: 'finished', status: 'succeeded' });
        const rows = [running, finished];
        expect(selectMachineRunsForPresentation({ runs: rows, showFinished: false, requestedRunId: null })).toEqual([running]);
        expect(selectMachineRunsForPresentation({ runs: rows, showFinished: true, requestedRunId: null })).toBe(rows);
        expect(selectMachineRunsForPresentation({ runs: rows, showFinished: true, requestedRunId: 'finished' })).toEqual([finished]);
        expect(selectMachineRunsForPresentation({ runs: [finished], showFinished: false, requestedRunId: null })).toEqual([]);
        const unknown = selectMachineRunsForPresentation({ runs: undefined, showFinished: false, requestedRunId: null });
        const visible = selectMachineRunsForPresentation({ runs: rows, showFinished: false, requestedRunId: null });
        expect(summarizeRunListPresentation([visible, unknown])).toEqual({ emptyState: null, unknownMachineCount: 1 });
    });

    it('aggregates confirmed empty and unknown Machines into one honest page state', () => {
        expect(summarizeRunListPresentation([[], [], []])).toEqual({ emptyState: 'empty', unknownMachineCount: 0 });
        expect(summarizeRunListPresentation([[], null, null])).toEqual({ emptyState: 'unknown', unknownMachineCount: 2 });
        expect(summarizeRunListPresentation([null])).toEqual({ emptyState: 'unknown', unknownMachineCount: 1 });
        // No inventory rows is the inventory owner's no-Machines state, not proof of no Runs.
        expect(summarizeRunListPresentation([])).toEqual({ emptyState: null, unknownMachineCount: 0 });
    });
});
