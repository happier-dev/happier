import { describe, expect, it } from 'vitest';

import { normalizeCodexAppServerGoalToSessionWorkStateItem } from './appServerGoal.js';

describe('Codex app-server goal wire schema', () => {
    it.each([
        ['active', 'active', undefined],
        ['paused', 'paused', undefined],
        ['blocked', 'blocked', 'blocked'],
        ['usageLimited', 'blocked', 'usageLimited'],
        ['complete', 'complete', undefined],
    ] as const)(
        'normalizes the readable %s status without weakening the generic work-state contract',
        (providerStatus, expectedStatus, expectedStatusReason) => {
            const item = normalizeCodexAppServerGoalToSessionWorkStateItem({
                backendId: 'codex',
                goal: {
                    threadId: `thread-${providerStatus}`,
                    objective: `Handle ${providerStatus}`,
                    status: providerStatus,
                    updatedAt: '2026-05-13T10:05:00.000Z',
                },
            });

            expect(item?.status).toBe(expectedStatus);
            expect(item?.statusReason).toBe(expectedStatusReason);
        },
    );

    it('normalizes app-server goals into generic work-state goal items', () => {
        const item = normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            agentId: 'agent-codex',
            goal: {
                threadId: 'thread-1',
                objective: 'Ship plugin support',
                status: 'usageLimited',
                tokensUsed: 45,
                timeUsedSeconds: 6,
                createdAt: '2026-05-13T10:00:00.000Z',
                updatedAt: '2026-05-13T10:05:00.000Z',
            },
        });

        expect(item).toMatchObject({
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'blocked',
            statusReason: 'usageLimited',
            title: 'Ship plugin support',
            backendId: 'codex',
            agentId: 'agent-codex',
            vendorRef: 'thread-1',
            tokensUsed: 45,
            timeUsedSeconds: 6,
            createdAt: Date.parse('2026-05-13T10:00:00.000Z'),
        });
        expect(item?.updatedAt).toBe(Date.parse('2026-05-13T10:05:00.000Z'));
    });

    it('returns null for malformed app-server goals', () => {
        expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            goal: { threadId: '', objective: '', status: 'active', updatedAt: 'nope' },
        })).toBeNull();
    });

    it('converts official numeric Unix-second timestamps to milliseconds exactly once', () => {
        const item = normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            goal: {
                threadId: 'thread-numeric-time',
                objective: 'Normalize timestamps',
                status: 'active',
                createdAt: 1_715_594_400,
                updatedAt: 1_715_594_700,
            },
        });

        expect(item?.createdAt).toBe(1_715_594_400_000);
        expect(item?.updatedAt).toBe(1_715_594_700_000);
    });

    it.each([
        ['non-finite', Number.POSITIVE_INFINITY],
        ['fractional', 1_715_594_700.5],
        ['negative', -1],
        ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
        ['outside the ECMAScript Date range', 8_640_000_000_001],
    ])('rejects an invalid %s numeric updatedAt timestamp', (_label, updatedAt) => {
        expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            goal: {
                threadId: 'thread-invalid-updated-time',
                objective: 'Reject invalid timestamps',
                status: 'active',
                updatedAt,
            },
        })).toBeNull();
    });

    it.each([
        ['invalid ISO timestamp', 'not-a-date'],
        ['fractional numeric timestamp', 1_715_594_400.5],
        ['out-of-range numeric timestamp', 8_640_000_000_001],
    ])('rejects a present but %s createdAt timestamp', (_label, createdAt) => {
        expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            goal: {
                threadId: 'thread-invalid-created-time',
                objective: 'Reject invalid timestamps',
                status: 'active',
                createdAt,
                updatedAt: '2026-05-13T10:05:00.000Z',
            },
        })).toBeNull();
    });
});
