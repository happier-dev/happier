import { describe, expect, it } from 'vitest';

import { buildSessionListFetchHydrationTelemetryFields } from './sessionListHydrationTelemetry';

describe('buildSessionListFetchHydrationTelemetryFields', () => {
    it('attributes required and priority hydration inputs without exposing session ids', () => {
        const fields = buildSessionListFetchHydrationTelemetryFields({
            mode: 'replace',
            awaitSessionListHydration: true,
            source: 'changesCatchUp',
            requiredHydrationSessionIds: ['s_loaded', 's_loaded', ''],
            organizationRequiredSessionIds: ['s_pinned', 's_loaded'],
            explicitPrioritizedSessionIds: ['s_loaded'],
            runtimePrioritizedSessionIds: ['s_runtime', 's_loaded'],
            prioritizedHydrationSessionIds: ['s_loaded', 's_runtime'],
            activeViewingSessionId: 's_open',
            visibleSessionIds: ['s_visible', 's_open'],
            activeHydrationSessionIds: ['s_open', 's_visible'],
            includeActiveSessionRows: true,
            includeSessionListAttentionRows: true,
        });

        expect(fields).toEqual(expect.objectContaining({
            append: 0,
            awaitSessionListHydration: 1,
            sourceChangesCatchUp: 1,
            sourceDirect: 0,
            explicitRequiredIds: 1,
            organizationRequiredIds: 2,
            requiredIds: 2,
            requiredOverlapIds: 1,
            explicitPriorityIds: 1,
            runtimePriorityIds: 2,
            priorityIds: 2,
            activeViewingIds: 1,
            visibleIds: 2,
            activeHydrationIds: 2,
            includeActiveSessionRows: 1,
            includeSessionListAttentionRows: 1,
        }));
        expect(JSON.stringify(fields)).not.toContain('s_loaded');
    });
});
