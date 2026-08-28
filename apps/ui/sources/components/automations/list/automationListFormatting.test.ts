import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AutomationOccurrenceKeyV1Schema,
    AutomationRunCauseSchema,
    AutomationRunStateV3Schema,
    AutomationTriggerListItemSchema,
} from '@happier-dev/protocol';

import { setPreferredLanguageFromSettings } from '@/text';
import {
    formatAutomationNextRun,
    formatAutomationRunCauseLabel,
    formatAutomationRunStateLabel,
    formatAutomationScheduleLabel,
    formatAutomationTriggerLabel,
    formatAutomationTriggerStatusLabel,
    getAutomationRunCauseAt,
    getAutomationRunCauseTranslationKey,
} from './automationListFormatting';

afterEach(() => {
    setPreferredLanguageFromSettings(null);
    vi.restoreAllMocks();
});

describe('formatAutomationTriggerLabel', () => {
    const sourceSelectorId = '11111111-1111-4111-8111-111111111111';

    it('labels a Plugin Event from its safe event reference without reading private source content', () => {
        const trigger = AutomationTriggerListItemSchema.parse({
            id: 'trigger-event-1',
            revision: 3,
            enabled: true,
            createdAt: 1,
            updatedAt: 2,
            kind: 'pluginEvent',
            eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
            sourceSelectorId,
            sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: null,
            sourceCatalogStatus: null,
        });
        expect(formatAutomationTriggerLabel(trigger)).toBe('Event: pull-request-opened-v1');
        expect(formatAutomationTriggerStatusLabel(trigger)).toBe('Waiting for the first report');
    });

    it('formats trigger and next-run labels through the active locale', () => {
        setPreferredLanguageFromSettings('es');
        vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('fecha-localizada');

        expect(formatAutomationScheduleLabel({
            schedule: { kind: 'interval', everyMs: 15 * 60_000, scheduleExpr: null, timezone: null },
        })).toBe('Cada 15 min');
        expect(formatAutomationScheduleLabel({
            schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 9 * * 1', timezone: 'Europe/Madrid' },
        })).toBe('Cron: 0 9 * * 1 (Europe/Madrid)');
        expect(formatAutomationTriggerLabel(AutomationTriggerListItemSchema.parse({
            id: 'trigger-event-1',
            revision: 3,
            enabled: true,
            createdAt: 1,
            updatedAt: 2,
            kind: 'pluginEvent',
            eventRef: { pluginId: 'happier.scm.github', localId: 'issue-opened-v1' },
            sourceSelectorId,
            sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: null,
            sourceCatalogStatus: null,
        }))).toBe('Evento: issue-opened-v1');
        expect(formatAutomationNextRun(null)).toBe('Sin próxima ejecución');
        expect(formatAutomationNextRun(1_700_000_000_000)).toBe('Próxima: fecha-localizada');
    });

    it('presents each trigger status from its canonical trigger projection', () => {
        const lifecycleTrigger = AutomationTriggerListItemSchema.parse({
            id: 'turn-trigger-1',
            revision: 1,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
            kind: 'sessionLifecycle',
            event: 'parentTurnCompleted',
            scope: { kind: 'exactTurn', sourceSessionId: 'session-1', sourceTurnId: 'turn-1' },
            consumption: 'once',
            status: { state: 'sourceCancelled', runId: null },
        });
        if (lifecycleTrigger.kind !== 'sessionLifecycle') throw new Error('expected lifecycle trigger fixture');
        expect(formatAutomationTriggerStatusLabel(lifecycleTrigger)).toBe('Source turn cancelled');
        expect(formatAutomationTriggerStatusLabel(lifecycleTrigger, false)).toBe('Source turn cancelled');

        expect(formatAutomationTriggerStatusLabel(AutomationTriggerListItemSchema.parse({
            id: 'event-trigger-1',
            revision: 1,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
            kind: 'pluginEvent',
            eventRef: { pluginId: 'happier.scm.github', localId: 'push-v1' },
            sourceSelectorId,
            sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: {
                automationId: 'automation-1',
                triggerId: 'event-trigger-1',
                triggerRevision: 1,
                eventRef: { pluginId: 'happier.scm.github', localId: 'push-v1' },
                sourceSelectorId,
                reporterMaterializationRef: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                    pluginId: 'happier.scm.github',
                },
                reporterImmutableGenerationId: 'generation-1',
                state: 'backingOff',
                code: 'rateLimited',
                observedCount: 2,
                admittedCount: 1,
                skippedCount: 1,
                lastObservedAt: 10,
                lastDispositionAt: 10,
                nextRetryAt: 20,
                revision: 1,
            },
            sourceCatalogStatus: null,
        }))).toBe('Waiting to retry');
    });
});

describe('immutable Run cause presentation', () => {
    const occurrenceKey = AutomationOccurrenceKeyV1Schema.parse('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const retiredLifecycleCause = AutomationRunCauseSchema.parse({
        kind: 'trigger',
        triggerId: 'retired-turn-trigger',
        triggerRevision: 7,
        triggerKind: 'sessionLifecycle',
        occurrenceKey,
        occurredAt: 90,
        evidence: {
            event: 'parentTurnCompleted',
            sourceSessionId: 'session-1',
            sourceTurnId: 'turn-9',
        },
    });

    it('derives time and kind from immutable cause instead of mutable Run timestamps', () => {
        expect(getAutomationRunCauseAt(retiredLifecycleCause)).toBe(90);
        expect(getAutomationRunCauseTranslationKey(retiredLifecycleCause))
            .toBe('automations.detail.runMeta.cause.sessionLifecycle');
        expect(getAutomationRunCauseAt({ kind: 'manual', invokedAt: 40 })).toBe(40);
        expect(getAutomationRunCauseAt({ kind: 'conversation', occurrenceKey, occurredAt: 50 }))
            .toBe(50);
    });

    it('keeps a retired trigger cause renderable after its mutable row is removed', () => {
        expect(formatAutomationRunCauseLabel(retiredLifecycleCause))
            .toBe('Session turn completed');
        expect(formatAutomationRunCauseLabel(AutomationRunCauseSchema.parse({
            kind: 'trigger',
            triggerId: 'retired-event-trigger',
            triggerRevision: 4,
            triggerKind: 'pluginEvent',
            occurrenceKey,
            occurredAt: 100,
            evidence: {
                eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111',
            },
        }))).toBe('Event: pull-request-opened-v1');
    });
});

describe('formatAutomationRunStateLabel', () => {
    it('gives every canonical Run state a product label instead of the raw state token', () => {
        const labels = AutomationRunStateV3Schema.options.map((state) => ({
            state,
            label: formatAutomationRunStateLabel(state),
        }));

        expect(labels).toEqual([
            { state: 'queued', label: 'Queued' },
            { state: 'claimed', label: 'Claimed' },
            { state: 'running', label: 'Running' },
            { state: 'succeeded', label: 'Succeeded' },
            { state: 'failed', label: 'Failed' },
            { state: 'cancelled', label: 'Cancelled' },
            { state: 'expired', label: 'Expired' },
            { state: 'dispatch_failed', label: 'Dispatch failed' },
            { state: 'skipped', label: 'Skipped' },
            { state: 'missed', label: 'Missed' },
            { state: 'outcome_uncertain', label: 'Outcome uncertain' },
        ]);
        for (const { state, label } of labels) {
            expect(label).not.toBe(state);
            expect(label).not.toBe(state.toUpperCase());
            expect(label).not.toMatch(/^automations\./u);
        }
    });

    it('resolves every Run state through the active locale', () => {
        setPreferredLanguageFromSettings('es');

        const labels = AutomationRunStateV3Schema.options.map((state) => formatAutomationRunStateLabel(state));

        expect(labels).toEqual([
            'En cola',
            'Reclamada',
            'En curso',
            'Correcta',
            'Fallida',
            'Cancelada',
            'Caducada',
            'Envío fallido',
            'Omitida',
            'Perdida',
            'Resultado incierto',
        ]);
    });
});
