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
});

