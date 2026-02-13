import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './updates.js';

describe('updates protocol automation payloads', () => {
    it('parses automation-upsert payload', () => {
        const parsed = UpdateBodySchema.parse({
            t: 'automation-upsert',
            automationId: 'auto_1',
            version: 3,
            enabled: true,
            updatedAt: Date.now(),
        });

        expect(parsed.t).toBe('automation-upsert');
    });

    it('parses automation-delete payload', () => {
        const parsed = UpdateBodySchema.parse({
            t: 'automation-delete',
            automationId: 'auto_1',
            deletedAt: Date.now(),
        });

        expect(parsed.t).toBe('automation-delete');
    });

    it('parses automation-run-updated payload', () => {
        const now = Date.now();
        const parsed = UpdateBodySchema.parse({
            t: 'automation-run-updated',
            runId: 'run_1',
            automationId: 'auto_1',
            state: 'running',
            scheduledAt: now - 30_000,
            startedAt: now - 5_000,
            finishedAt: null,
            updatedAt: now,
            machineId: 'machine_1',
        });

        expect(parsed.t).toBe('automation-run-updated');
        expect(parsed.state).toBe('running');
    });

    it('parses automation-assignment-updated payload', () => {
        const parsed = UpdateBodySchema.parse({
            t: 'automation-assignment-updated',
            machineId: 'machine_1',
            automationId: 'auto_1',
            enabled: false,
            updatedAt: Date.now(),
        });

        expect(parsed.t).toBe('automation-assignment-updated');
        expect(parsed.enabled).toBe(false);
    });
});
