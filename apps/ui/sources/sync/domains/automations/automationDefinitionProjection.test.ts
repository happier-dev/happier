import { describe, expect, it } from 'vitest';
import { AutomationTriggerDetailSchema, type AutomationDefinitionDetail } from '@happier-dev/protocol';

import {
    applyAutomationDefinitionDetail,
    attachAutomationDefinitionDetail,
    createAutomationDefinitionFromDetail,
    createAutomationDefinitionSummary,
    hasMatchingAutomationDefinitionSummary,
    markAutomationDefinitionContentUnavailable,
} from './automationDefinitionProjection';

const timestamp = 1_786_257_600_000;

function scheduleTrigger(id: string, revision: number) {
    return AutomationTriggerDetailSchema.parse({
        id,
        revision,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: 'schedule' as const,
        schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null },
        nextRunAt: timestamp + 60_000,
        triggerDefinitionEnvelope: null,
    });
}

function eventTrigger(id: string, revision: number) {
    return AutomationTriggerDetailSchema.parse({
        id,
        revision,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: 'pluginEvent' as const,
        eventRef: { pluginId: 'example.github', localId: 'push' },
        sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull' as const,
            watcher: null,
        },
        sourceStatus: null,
        sourceCatalogStatus: null,
        triggerDefinitionEnvelope: 'opaque-event-definition',
    });
}

function detail(overrides: Partial<AutomationDefinitionDetail> = {}): AutomationDefinitionDetail {
    return {
        id: 'automation-1',
        name: 'Review work',
        description: null,
        enabled: true,
        targetType: 'existingSession',
        existingSessionId: 'session-1',
        templateVersion: 4,
        lastRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        assignments: [],
        retiredTriggers: [],
        triggers: [
            scheduleTrigger('11111111-1111-4111-8111-111111111111', 2),
            eventTrigger('33333333-3333-4333-8333-333333333333', 7),
        ],
        executionRecipe: {
            v: 1,
            templateVersion: 4,
            template: { t: 'plain', v: { v: 1, prompt: 'Review the current work.' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'session-1' },
        },
        ...overrides,
    };
}

describe('Automation definition projection', () => {
    it('correlates the complete plural trigger set by exact identity and revision without choosing a first row', () => {
        const current = detail();
        expect(hasMatchingAutomationDefinitionSummary(current, {
            ...current,
            triggers: [...current.triggers].reverse(),
        })).toBe(true);
        expect(hasMatchingAutomationDefinitionSummary(current, {
            ...current,
            triggers: current.triggers.map((trigger, index) => (
                index === 1 ? { ...trigger, revision: trigger.revision + 1 } : trigger
            )),
        })).toBe(false);
        expect(hasMatchingAutomationDefinitionSummary(current, { ...current, triggers: [] })).toBe(false);
    });

    it('keeps private recipe and Event definition content direct-detail-only', () => {
        const current = detail();
        const projected = createAutomationDefinitionFromDetail(current);
        const summary = createAutomationDefinitionSummary((({ executionRecipe: _recipe, ...value }) => value)(current));

        expect(summary.detail).toEqual({ kind: 'unloaded', templateVersion: 4 });
        expect(summary).not.toHaveProperty('executionRecipe');
        expect(projected.detail).toEqual({ kind: 'available', templateVersion: 4, value: current });
        expect(projected.linkedExistingSessionId).toBe('session-1');
    });

    it('attaches only an exact summary/detail pair and preserves unavailable currentness', () => {
        const current = detail();
        const summary = createAutomationDefinitionSummary((({ executionRecipe: _recipe, ...value }) => value)(current));

        expect(attachAutomationDefinitionDetail(summary, current)?.detail.kind).toBe('available');
        expect(attachAutomationDefinitionDetail(summary, detail({
            triggers: [scheduleTrigger('11111111-1111-4111-8111-111111111111', 3)],
        }))).toBeNull();

        const unavailable = markAutomationDefinitionContentUnavailable(summary);
        expect(applyAutomationDefinitionDetail(unavailable, current)).toBe(unavailable);
        expect(applyAutomationDefinitionDetail(unavailable, current, { replaceEqualRevision: true }).detail.kind)
            .toBe('available');
    });

    it('accepts zero triggers as a complete current definition', () => {
        const manualOnly = detail({ triggers: [] });
        const projected = createAutomationDefinitionFromDetail(manualOnly);

        expect(projected.triggers).toEqual([]);
        expect(projected.detail.kind).toBe('available');
    });
});
