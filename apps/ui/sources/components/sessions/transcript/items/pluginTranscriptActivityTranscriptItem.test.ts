import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    appendPluginTranscriptActivityTranscriptItems,
    buildPluginTranscriptActivityIdentityKey,
    createPluginTranscriptActivityTranscriptItemsCache,
    type PluginTranscriptActivityLiveRow,
} from './pluginTranscriptActivityTranscriptItem';

function activity(params: Readonly<{
    pluginId: string;
    contributionId: string;
    generation?: string;
    sessionId?: string;
    resourceId?: string;
    localActivityId: string;
}>): PluginTranscriptActivityLiveRow {
    return {
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        generation: params.generation ?? '7',
        sessionId: params.sessionId ?? 'session-1',
        resourceId: params.resourceId ?? 'progress',
        localActivityId: params.localActivityId,
        phase: 'running',
        title: `${params.pluginId}:${params.localActivityId}`,
        status: null,
        progress: null,
        checklist: [],
        dismissible: false,
        actions: [],
        freshness: 'current',
    };
}

describe('appendPluginTranscriptActivityTranscriptItems', () => {
    it('keeps colliding local activity ids qualified, ordered, and outside the sequence axis with a truthful overflow row', () => {
        const rows = appendPluginTranscriptActivityTranscriptItems([], {
            sessionId: 'session-1',
            activities: [
                activity({ pluginId: 'plugin-z', contributionId: 'same-profile', localActivityId: 'same-local-id' }),
                activity({ pluginId: 'plugin-a', contributionId: 'same-profile', localActivityId: 'same-local-id' }),
                ...Array.from({ length: 34 }, (_, index) => activity({
                    pluginId: 'plugin-zz',
                    contributionId: 'bulk-profile',
                    localActivityId: `item-${String(index).padStart(2, '0')}`,
                })),
            ],
            dismissedActivityIds: new Set(),
            isActionAvailable: () => true,
        });

        expect(rows).toHaveLength(17);
        expect(rows.map((row) => row.kind)).toEqual(Array(17).fill('plugin-transcript-activity'));
        expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([
            expect.stringContaining('plugin-a'),
            expect.stringContaining('plugin-z'),
        ]));
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
        expect(rows.every((row) => !Object.hasOwn(row, 'seq'))).toBe(true);
        expect(rows[0]).toMatchObject({
            pluginId: 'plugin-a',
            contributionId: 'same-profile',
            localActivityId: 'same-local-id',
        });
        expect(rows.at(-1)).toMatchObject({ aggregateHiddenCount: 20 });
    });

    it('bounds the aggregate across profiles and reports the omitted valid rows', () => {
        const rows = appendPluginTranscriptActivityTranscriptItems([], {
            sessionId: 'session-1',
            activities: [
                ...Array.from({ length: 16 }, (_, index) => activity({
                    pluginId: 'plugin-one',
                    contributionId: 'progress-card',
                    localActivityId: `one-${String(index).padStart(2, '0')}`,
                })),
                ...Array.from({ length: 16 }, (_, index) => activity({
                    pluginId: 'plugin-two',
                    contributionId: 'progress-card',
                    localActivityId: `two-${String(index).padStart(2, '0')}`,
                })),
            ],
            dismissedActivityIds: new Set(),
            isActionAvailable: () => true,
        });

        expect(rows).toHaveLength(17);
        expect(rows.filter((row) => row.pluginId === 'plugin-one')).toHaveLength(16);
        expect(rows.filter((row) => row.pluginId === 'plugin-two')).toHaveLength(0);
        expect(rows.at(-1)).toMatchObject({ aggregateHiddenCount: 16 });
    });

    it('keeps only the mounted session and drops a locally dismissed terminal activity', () => {
        const dismissed = activity({
            pluginId: 'plugin-a',
            contributionId: 'progress-card',
            localActivityId: 'done',
        });
        const visible = activity({
            pluginId: 'plugin-a',
            contributionId: 'progress-card',
            localActivityId: 'still-running',
        });
        const rows = appendPluginTranscriptActivityTranscriptItems([], {
            sessionId: 'session-1',
            activities: [
                dismissed,
                visible,
                activity({
                    pluginId: 'plugin-a',
                    contributionId: 'other-session',
                    sessionId: 'session-2',
                    localActivityId: 'other',
                }),
            ],
            dismissedActivityIds: new Set([buildPluginTranscriptActivityIdentityKey(dismissed)]),
            isActionAvailable: () => true,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ localActivityId: 'still-running' });
    });

    it('keeps unchanged synthetic rows referentially stable so only a changed card rerenders', () => {
        const cache = createPluginTranscriptActivityTranscriptItemsCache();
        const initialActivities = Array.from({ length: 16 }, (_, index) => activity({
            pluginId: 'plugin-a',
            contributionId: 'progress-card',
            localActivityId: `activity-${index}`,
        }));
        const renders = new Map<string, number>();
        const Row = React.memo(function Row(props: Readonly<{ row: Readonly<{ id: string; title: string }> }>) {
            renders.set(props.row.id, (renders.get(props.row.id) ?? 0) + 1);
            return null;
        });
        const List = (props: Readonly<{ activities: readonly PluginTranscriptActivityLiveRow[] }>) => {
            const rows = appendPluginTranscriptActivityTranscriptItems([], {
                sessionId: 'session-1',
                activities: props.activities,
                dismissedActivityIds: new Set(),
                isActionAvailable: () => true,
                cache,
            });
            const pluginRows = rows.filter((row) => row.kind === 'plugin-transcript-activity');
            return React.createElement(React.Fragment, null, ...pluginRows.map((row) => (
                React.createElement(Row, { key: row.id, row })
            )));
        };

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => { tree = renderer.create(React.createElement(List, { activities: initialActivities })); });
        const initialDerivedRows = appendPluginTranscriptActivityTranscriptItems([], {
            sessionId: 'session-1',
            activities: initialActivities,
            dismissedActivityIds: new Set(),
            isActionAvailable: () => true,
            cache,
        });
        const changedActivities = initialActivities.map((row, index) => (
            // Resource JSON is decoded anew on every successful read. The
            // derivation must retain unchanged row identity itself rather than
            // rely on a caller reusing the old decoded object references.
            { ...row, title: index === 6 ? 'updated only this card' : row.title }
        ));
        act(() => { tree?.update(React.createElement(List, { activities: changedActivities })); });

        const rows = appendPluginTranscriptActivityTranscriptItems([], {
            sessionId: 'session-1',
            activities: changedActivities,
            dismissedActivityIds: new Set(),
            isActionAvailable: () => true,
            cache,
        });
        const changedIdentity = buildPluginTranscriptActivityIdentityKey(changedActivities[6]!);
        const changedId = rows.find((row) => (
            row.kind === 'plugin-transcript-activity' && row.identityKey === changedIdentity
        ))!.id;
        expect(renders.get(changedId)).toBe(2);
        for (const row of rows) {
            if (row.id === changedId) continue;
            expect(renders.get(row.id)).toBe(1);
            expect(row).toBe(initialDerivedRows.find((prior) => prior.id === row.id));
        }
        act(() => { tree?.unmount(); });
    });
});
