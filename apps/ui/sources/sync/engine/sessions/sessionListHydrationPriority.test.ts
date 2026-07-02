import { describe, expect, it } from 'vitest';

import { orderRowsForSessionListHydration } from './sessionListHydrationPriority';

describe('orderRowsForSessionListHydration', () => {
    it('keeps required and route ids ahead of active viewing ids', () => {
        const params = {
            rows: [
                { id: 's_active', active: false },
                { id: 's_route', active: false },
                { id: 's_required', active: false },
                { id: 's_eager', active: false },
            ],
            requiredSessionIds: ['s_required'],
            routeSessionIds: ['s_route'],
            activeSessionIds: ['s_active'],
            eagerHydrationCount: 1,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_required',
            's_route',
            's_active',
            's_eager',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 1,
            route: 1,
            active: 1,
            priority: 0,
            eager: 1,
            background: 0,
            skippedBackground: 0,
        });
    });

    it('prioritizes active viewing session ids before active and background rows', () => {
        const params = {
            rows: [
                { id: 's_background', active: false },
                { id: 's_active', active: true },
                { id: 's_visible', active: false },
            ],
            activeSessionIds: ['s_visible'],
            eagerHydrationCount: 0,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_visible',
            's_active',
            's_background',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 0,
            route: 0,
            active: 2,
            priority: 0,
            eager: 0,
            background: 1,
            skippedBackground: 0,
        });
    });

    it('hydrates priority rows before generic active rows and eager rows', () => {
        const result = orderRowsForSessionListHydration({
            rows: [
                { id: 's_active', active: true },
                { id: 's_background', active: false },
                { id: 's_priority', active: false },
                { id: 's_eager', active: false },
            ],
            prioritySessionIds: ['s_priority'],
            eagerHydrationCount: 1,
        });

        expect(result.rows.map((row) => row.id)).toEqual([
            's_priority',
            's_active',
            's_background',
            's_eager',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 0,
            route: 0,
            active: 1,
            priority: 1,
            eager: 1,
            background: 1,
            skippedBackground: 0,
        });
    });

    it('caps only generic background hydration after eager rows', () => {
        const params: Parameters<typeof orderRowsForSessionListHydration>[0] & { maxBackgroundHydrationRows: number } = {
            rows: [
                { id: 's_required', active: false },
                { id: 's_route', active: false },
                { id: 's_active', active: true },
                { id: 's_eager', active: false },
                { id: 's_background_1', active: false },
                { id: 's_background_2', active: false },
            ],
            requiredSessionIds: ['s_required'],
            routeSessionIds: ['s_route'],
            eagerHydrationCount: 1,
            maxBackgroundHydrationRows: 1,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_required',
            's_route',
            's_active',
            's_eager',
            's_background_1',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 1,
            route: 1,
            active: 1,
            priority: 0,
            eager: 1,
            background: 1,
            skippedBackground: 1,
        });
    });
});
