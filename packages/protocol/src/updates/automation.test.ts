import { describe, expect, it } from 'vitest';

import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';
import { UpdateBodySchema } from './index.js';

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
            state: 'outcome_uncertain',
            scheduledAt: now - 30_000,
            startedAt: now - 5_000,
            finishedAt: null,
            updatedAt: now,
            machineId: 'machine_1',
            attempt: 2,
        });

        expect(parsed.t).toBe('automation-run-updated');
        expect(parsed.state).toBe('outcome_uncertain');
        expect(parsed.attempt).toBe(2);
    });

    it('accepts every canonical Automation Run state in the legacy invalidation', () => {
        for (const state of AutomationRunStateV3Schema.options) {
            expect(UpdateBodySchema.safeParse({
                t: 'automation-run-updated',
                runId: 'run_1',
                automationId: 'auto_1',
                state,
                scheduledAt: 1,
                updatedAt: 1,
            }).success).toBe(true);
        }
    });

    it('accepts only the strict additive Automation lifecycle carrier', () => {
        const payload = {
            t: 'automation-run-state-changed',
            runId: 'run_1',
            automationId: 'auto_1',
            originKind: 'conversation',
            previousState: 'running',
            currentState: 'succeeded',
            transitionedAt: 1,
            claimedByMachineId: null,
        } as const;
        expect(UpdateBodySchema.parse(payload)).toEqual(payload);
        expect(UpdateBodySchema.safeParse({
            ...payload,
            accountId: 'must-not-leak',
        }).success).toBe(false);
        expect(UpdateBodySchema.safeParse({
            ...payload,
            currentState: 'unknown',
        }).success).toBe(false);
        expect(UpdateBodySchema.parse({
            ...payload,
            previousState: null,
            currentState: 'queued',
        })).toEqual({
            ...payload,
            previousState: null,
            currentState: 'queued',
        });
        expect(UpdateBodySchema.safeParse({
            ...payload,
            previousState: null,
            currentState: 'claimed',
        }).success).toBe(false);
        expect(UpdateBodySchema.safeParse({
            ...payload,
            currentState: 'running',
        }).success).toBe(false);
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

    it('parses a content-free Automation source-status invalidation', () => {
        const parsed = UpdateBodySchema.parse({
            t: 'automation-source-status-updated',
        });

        expect(parsed.t).toBe('automation-source-status-updated');
        expect(UpdateBodySchema.safeParse({
            t: 'automation-source-status-updated',
            automationId: 'must-not-leak',
        }).success).toBe(false);
    });
});
