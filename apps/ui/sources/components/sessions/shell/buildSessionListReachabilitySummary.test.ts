import { describe, expect, it } from 'vitest';

import { buildSessionListReachabilitySummary } from './buildSessionListReachabilitySummary';

describe('buildSessionListReachabilitySummary', () => {
    it('reuses a shared empty summary when there are no session rows', () => {
        const first = buildSessionListReachabilitySummary({
            listItems: [],
            machinesById: new Map(),
        });
        const second = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'server:server-a:day:2026-02-19',
                },
            ] as any,
            machinesById: new Map(),
        });

        expect(first).toBe(second);
        expect(first.displayById).toBe(second.displayById);
        expect(first.displayById.size).toBe(0);
        expect(first.hasMultipleMachines).toBe(false);
    });

    it('reuses the same non-empty summary for identical inputs', () => {
        const input = {
            listItems: [
                {
                    type: 'session',
                    session: {
                        id: 'sess-a',
                        metadata: {
                            machineId: 'machine-a',
                            host: 'machine-a.local',
                            path: '/repo-a',
                            homeDir: '/home/user',
                        },
                    },
                },
                {
                    type: 'session',
                    session: {
                        id: 'sess-b',
                        metadata: {
                            machineId: 'machine-b',
                            host: 'machine-b.local',
                            path: '/repo-b',
                            homeDir: '/home/user',
                        },
                    },
                },
            ] as any,
            machinesById: new Map([
                ['machine-a', { id: 'machine-a', metadata: { host: 'machine-a.local' } }],
                ['machine-b', { id: 'machine-b', metadata: { host: 'machine-b.local' } }],
            ]),
        } as const;

        const first = buildSessionListReachabilitySummary(input);
        const second = buildSessionListReachabilitySummary(input);

        expect(first).toBe(second);
        expect(first.hasMultipleMachines).toBe(true);
        expect(first.displayById.get('sess-a')).toEqual({
            machineId: 'machine-a',
            machineLabel: 'machine-a.local',
            pathSubtitle: '/repo-a',
        });
    });

    it('preserves path subtitles even when no machine metadata is available', () => {
        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    session: {
                        id: 'sess-path-only',
                        metadata: {
                            path: '/repo-only',
                            homeDir: '/home/user',
                        },
                    },
                },
            ] as any,
            machinesById: new Map(),
        });

        expect(summary.displayById.get('sess-path-only')).toEqual({
            machineId: null,
            machineLabel: '',
            pathSubtitle: '/repo-only',
        });
        expect(summary.hasMultipleMachines).toBe(false);
    });
});
