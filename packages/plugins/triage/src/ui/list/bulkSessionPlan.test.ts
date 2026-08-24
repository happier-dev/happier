import { describe, expect, it } from 'vitest';

import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { TESTKIT_LINK_DISPLAY } from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import {
    planTriageBulkEntrySessions,
    runTriageBulkEntrySessions,
    type TriageBulkEntrySelectionV1,
    type TriageBulkSessionUnitV1,
} from './bulkSessionPlan.js';

function selected(entryId: string, overrides: Partial<TriageBulkEntrySelectionV1> = {}): TriageBulkEntrySelectionV1 {
    return {
        entryRef: testkitEntryRef({ entryId }),
        display: TESTKIT_LINK_DISPLAY,
        workspaceMode: 'pull_request',
        workflowSubject: 'issue',
        ...overrides,
    };
}

const ISSUE_ACTION: TriageActionV1 = Object.freeze({
    actionId: 'ask-issues',
    label: 'Ask about issue',
    enabled: true,
    appliesTo: ['issue'],
    profileId: null,
    workspaceMode: 'pull_request',
    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
});

function sequentialMint(): () => string {
    let ordinal = 0;
    return () => {
        ordinal += 1;
        return `key-${ordinal}`;
    };
}

function entryIdsOf(unit: TriageBulkSessionUnitV1): readonly string[] {
    return unit.entries.map((entry) => entry.entryRef.entryId);
}

describe('planTriageBulkEntrySessions', () => {
    it('asks for one Session per selected entry, each carrying its own entry and its own creation key', () => {
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [selected('17'), selected('18'), selected('19')],
            destination: 'oneSessionPerEntry',
            mintCreationKey: sequentialMint(),
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.units.map(entryIdsOf)).toEqual([['17'], ['18'], ['19']]);
        expect(plan.units.map((unit) => unit.creationKey)).toEqual(['key-1', 'key-2', 'key-3']);
        expect(new Set(plan.units.map((unit) => unit.creationKey)).size).toBe(3);
    });

    it('asks for exactly one Session carrying the whole selection, and spends exactly one creation key', () => {
        const mint = sequentialMint();
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [selected('17'), selected('18'), selected('19')],
            destination: 'oneSessionForAllEntries',
            mintCreationKey: mint,
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.units).toHaveLength(1);
        expect(entryIdsOf(plan.units[0]!)).toEqual(['17', '18', '19']);
        expect(plan.units[0]!.creationKey).toBe('key-1');
        // The very next mint is still the second one: the plan did not spend a
        // key per entry and discard the extras.
        expect(mint()).toBe('key-2');
    });

    it('seeds the whole deduped selection into New Session and spends NO creation key', () => {
        // The third destination creates nothing, so a key minted for it would
        // be a spent creation identity that never reached the canonical
        // creator — and the arm exists at all only because both halves of the
        // host seam now do (§0a A6a, U-HOST-NEW-SESSION-SEED).
        let minted = 0;
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [selected('17'), selected('18'), selected('17')],
            destination: 'attachAllToNewSession',
            mintCreationKey: () => {
                minted += 1;
                return `key-${minted}`;
            },
        });

        expect(plan.status).toBe('seedNewSession');
        if (plan.status !== 'seedNewSession') return;
        expect(plan.entries.map((entry) => entry.entryRef.entryId)).toEqual(['17', '18']);
        expect(minted).toBe(0);
    });

    it('refuses an empty selection without spending a creation key', () => {
        let minted = 0;
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [],
            destination: 'oneSessionPerEntry',
            mintCreationKey: () => {
                minted += 1;
                return `key-${minted}`;
            },
        });

        expect(plan).toEqual({ status: 'refused', reason: 'emptySelection' });
        expect(minted).toBe(0);
    });

    it('refuses rather than silently rejoining when a mint answers twice with one key', () => {
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [selected('17'), selected('18')],
            destination: 'oneSessionPerEntry',
            mintCreationKey: () => 'the-same-key',
        });

        expect(plan).toEqual({ status: 'refused', reason: 'creationKeyCollision' });
    });

    it('keeps one entry once when the selection repeats it', () => {
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [selected('17'), selected('18'), selected('17')],
            destination: 'oneSessionPerEntry',
            mintCreationKey: sequentialMint(),
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.units.map(entryIdsOf)).toEqual([['17'], ['18']]);
    });

    it('keeps two entries a delimiter join would merge as two Sessions', () => {
        // `origin` + `region\u241f42` and `origin\u241f region` + `42` are two
        // contract-valid distinct entries whose `${collisionScope}\u241f${entryId}`
        // join is the SAME string. A joined key silently drops one of the two
        // Sessions the user asked for.
        const left = selected('42', { entryRef: testkitEntryRef({ collisionScope: 'origin', entryId: 'region␟42' }) });
        const right = selected('42', { entryRef: testkitEntryRef({ collisionScope: 'origin␟region', entryId: '42' }) });

        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [left, right],
            destination: 'oneSessionPerEntry',
            mintCreationKey: sequentialMint(),
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.units).toHaveLength(2);
    });

    it('keeps two entries that differ only in kind as two Sessions', () => {
        // Identity is all four canonical components. A comparator that read only
        // `collisionScope` and `entryId` merges a pull request with an issue that
        // happens to share a number.
        const pull = selected('42', { entryRef: testkitEntryRef({ kindId: 'pull-request', entryId: '42' }) });
        const issue = selected('42', { entryRef: testkitEntryRef({ kindId: 'issue', entryId: '42' }) });

        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [pull, issue],
            destination: 'oneSessionPerEntry',
            mintCreationKey: sequentialMint(),
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.units).toHaveLength(2);
    });

    it('refuses each inapplicable row and plans side effects only for applicable rows', async () => {
        const plan = planTriageBulkEntrySessions({
            action: ISSUE_ACTION,
            selection: [
                selected('17', { workflowSubject: 'issue' }),
                selected('18', { workflowSubject: 'pullRequest' }),
                selected('19', { workflowSubject: 'issue' }),
            ],
            destination: 'oneSessionPerEntry',
            mintCreationKey: sequentialMint(),
        });

        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned') return;
        expect(plan.refusals).toEqual([{
            entry: expect.objectContaining({ entryRef: expect.objectContaining({ entryId: '18' }) }),
            reason: 'actionInapplicable',
        }]);
        const attempted: string[] = [];
        await runTriageBulkEntrySessions({
            units: plan.units,
            start: async (unit) => {
                attempted.push(unit.entries[0]!.entryRef.entryId);
                return 'opened';
            },
        });
        expect(attempted).toEqual(['17', '19']);
    });
});

describe('runTriageBulkEntrySessions', () => {
    const units: readonly TriageBulkSessionUnitV1[] = [
        { creationKey: 'key-1', entries: [selected('17')] },
        { creationKey: 'key-2', entries: [selected('18')] },
        { creationKey: 'key-3', entries: [selected('19')] },
    ];

    it('starts the units in order, one at a time', async () => {
        const inFlight: string[] = [];
        const order: string[] = [];
        const results = await runTriageBulkEntrySessions({
            units,
            start: async (unit) => {
                inFlight.push(unit.creationKey);
                expect(inFlight).toHaveLength(1);
                await Promise.resolve();
                order.push(unit.creationKey);
                inFlight.pop();
                return `opened:${unit.creationKey}`;
            },
        });

        expect(order).toEqual(['key-1', 'key-2', 'key-3']);
        expect(results.map((result) => result.status)).toEqual(['settled', 'settled', 'settled']);
    });

    it('keeps starting the remaining units when one start rejects, and does not claim its outcome', async () => {
        const attempted: string[] = [];
        const results = await runTriageBulkEntrySessions({
            units,
            start: async (unit) => {
                attempted.push(unit.creationKey);
                if (unit.creationKey === 'key-2') throw new Error('transport');
                return `opened:${unit.creationKey}`;
            },
        });

        expect(attempted).toEqual(['key-1', 'key-2', 'key-3']);
        expect(results.map((result) => result.status)).toEqual(['settled', 'unknownOutcome', 'settled']);
        // A retry is only safe because the unknown result still carries the unit
        // it attempted, and therefore the EXACT key already sent: re-sending it
        // makes the canonical creator rejoin rather than create a second Session
        // for one entry.
        expect(results[1]!.unit).toBe(units[1]!);
        expect(results[1]!.unit.creationKey).toBe('key-2');
    });

    it('stops on cancellation, keeps what already settled, and never claims the rest ran', async () => {
        const controller = new AbortController();
        const attempted: string[] = [];
        const results = await runTriageBulkEntrySessions({
            units,
            signal: controller.signal,
            start: async (unit) => {
                attempted.push(unit.creationKey);
                if (unit.creationKey === 'key-2') {
                    controller.abort();
                    throw new DOMException('aborted', 'AbortError');
                }
                return `opened:${unit.creationKey}`;
            },
        });

        expect(attempted).toEqual(['key-1', 'key-2']);
        expect(results.map((result) => result.status)).toEqual(['settled', 'unknownOutcome', 'notStarted']);
        expect(results[0]!).toMatchObject({ status: 'settled', outcome: 'opened:key-1' });
        // Every result names the unit it reports on, in the planned order, so a
        // caller can retry the unknown one and the unstarted one by their own keys.
        expect(results.map((result) => result.unit.creationKey)).toEqual(['key-1', 'key-2', 'key-3']);
    });
});
