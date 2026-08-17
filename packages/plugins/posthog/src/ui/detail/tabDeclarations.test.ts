import { describe, expect, it } from 'vitest';

import {
    POSTHOG_DETAIL_TABS_V1,
    posthogDetailTabDeclaration,
    type PosthogDetailTabDeclarationV1,
} from './tabDeclarations.js';

describe('POSTHOG_DETAIL_TABS_V1', () => {
    it('declares retention explicitly on every concrete tab', () => {
        expect(POSTHOG_DETAIL_TABS_V1.length).toBeGreaterThan(0);
        for (const tab of POSTHOG_DETAIL_TABS_V1) {
            // The shared primitive treats an omitted retention as `discard`. Inheriting
            // that default silently is exactly what this source may not do: every panel
            // here states its own lifetime.
            expect(['retain', 'discard']).toContain(tab.retention);
            expect(tab.title.length).toBeGreaterThan(0);
            expect(tab.retainedState.length).toBeGreaterThan(0);
        }
    });

    it('gives every tab exactly one vertical scroll owner', () => {
        const scrollOwners = new Map<string, PosthogDetailTabDeclarationV1['scrollOwner']>(
            POSTHOG_DETAIL_TABS_V1.map((tab) => [tab.id, tab.scrollOwner]),
        );

        // Overview is prose and facts, so it owns one `ScrollArea`. Every row-shaped
        // panel makes the public `List` both its window owner and its sole scroller;
        // wrapping one in a `ScrollArea` would split gesture ownership in two.
        expect(scrollOwners.get('overview')).toBe('scrollArea');
        for (const tab of POSTHOG_DETAIL_TABS_V1) {
            if (tab.id === 'overview') continue;
            expect(tab.scrollOwner).toBe('list');
        }
    });

    it('keeps one sampled loader behind every sampled-data consumer', () => {
        const sampledConsumers = POSTHOG_DETAIL_TABS_V1
            .filter((tab) => tab.readPlane === 'detailInstanceSample')
            .map((tab) => tab.id);

        // Occurrences, Stack Trace and Affected Sessions are consumers of one
        // detail-instance loader. A second read plane among them would be a second
        // owner of the same sampled rows.
        expect(sampledConsumers).toEqual(['occurrences', 'stack-trace', 'affected-sessions']);
        expect(POSTHOG_DETAIL_TABS_V1.filter((tab) => tab.readPlane === 'entryMaterialization')
            .map((tab) => tab.id)).toEqual(['overview']);
    });

    it('gives Activity its own read plane, its own lifetime and no sampled loader', () => {
        const activity = posthogDetailTabDeclaration('activity');

        // Activity is the one plane that is neither the entry materialization nor the
        // sampled loader. Attaching it to either would make a second owner of rows that
        // read differently and are discarded on a different lifetime.
        expect(activity.readPlane).toBe('activityPage');
        expect(POSTHOG_DETAIL_TABS_V1.filter((tab) => tab.readPlane === 'activityPage')
            .map((tab) => tab.id)).toEqual(['activity']);
        // It is the only panel that keeps nothing across a leave.
        expect(activity.retention).toBe('discard');
        expect(POSTHOG_DETAIL_TABS_V1.filter((tab) => tab.retention === 'discard')
            .map((tab) => tab.id)).toEqual(['activity']);
        expect(activity.scrollOwner).toBe('list');
    });

    it('declares one tab per id and resolves each by id', () => {
        const ids = POSTHOG_DETAIL_TABS_V1.map((tab) => tab.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect(posthogDetailTabDeclaration(id).id).toBe(id);
        }
    });
});
