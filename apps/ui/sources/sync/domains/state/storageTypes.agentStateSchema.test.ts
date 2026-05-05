import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from '@/sync/domains/state/storageTypes';

describe('AgentStateSchema', () => {
    it('parses JSON strings for backward compatibility', () => {
        const parsed = AgentStateSchema.safeParse(JSON.stringify({ controlledByUser: true }));
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.controlledByUser).toBe(true);
    });

    it('accepts object values', () => {
        const parsed = AgentStateSchema.safeParse({ controlledByUser: true });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.controlledByUser).toBe(true);
    });

    it('validates terminal pending handoff state shape', () => {
        const parsed = AgentStateSchema.safeParse({
            terminalControl: {
                pendingHandoffV1: {
                    v: 1,
                    status: 'deferred_until_terminal_turn_finishes',
                    pendingCount: 2,
                    updatedAtMs: 123,
                    interruptRequired: false,
                },
            },
        });

        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.terminalControl?.pendingHandoffV1?.status).toBe('deferred_until_terminal_turn_finishes');
    });

    it('rejects invalid terminal pending handoff status values', () => {
        const parsed = AgentStateSchema.safeParse({
            terminalControl: {
                pendingHandoffV1: {
                    v: 1,
                    status: 'not-a-real-status',
                    pendingCount: 2,
                    updatedAtMs: 123,
                },
            },
        });

        expect(parsed.success).toBe(false);
    });
});
