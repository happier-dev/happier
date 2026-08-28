import { describe, expect, it } from 'vitest';

import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';
import { AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1 } from '../plugins/events/hostReferencesV1.js';
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
            runCause: {
                kind: 'conversation',
                occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                occurredAt: 1,
            },
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

    it('carries the authoritative cancellation cause on the lifecycle carrier', () => {
        const uncertain = {
            t: 'automation-run-state-changed',
            runId: 'run_1',
            automationId: 'auto_1',
            runCause: {
                kind: 'trigger',
                triggerId: 'trigger-schedule-1',
                triggerRevision: 1,
                triggerKind: 'schedule',
                occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                occurredAt: 1,
                evidence: { scheduledFor: 1 },
            },
            previousState: 'running',
            currentState: 'outcome_uncertain',
            transitionedAt: 1,
            claimedByMachineId: 'machine_1',
        } as const;
        // The daemon can only treat a post-dispatch cancellation as
        // authoritative if the cause survives the wire body, so the carrier
        // must transport it rather than reject or drop it.
        expect(UpdateBodySchema.parse({
            ...uncertain,
            transitionCause: AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
        })).toEqual({
            ...uncertain,
            transitionCause: AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
        });
        // Ordinary uncertainty stays causeless, and the cause stays bounded.
        expect(UpdateBodySchema.parse(uncertain)).toEqual(uncertain);
        expect(UpdateBodySchema.safeParse({
            ...uncertain,
            transitionCause: 'x'.repeat(65),
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
