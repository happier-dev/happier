import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationRunStateV3Schema } from '@happier-dev/protocol';

import { setPreferredLanguageFromSettings } from '@/text';
import {
    formatAutomationNextRun,
    formatAutomationRunStateLabel,
    formatAutomationScheduleLabel,
    formatAutomationTriggerLabel,
} from './automationListFormatting';

afterEach(() => {
    setPreferredLanguageFromSettings(null);
    vi.restoreAllMocks();
});

describe('formatAutomationTriggerLabel', () => {
    it('labels an on-demand definition as manual', () => {
        expect(formatAutomationTriggerLabel({ kind: 'manual' })).toBe('Manual');
    });

    it('labels a Plugin Event from its safe event reference without reading private source content', () => {
        expect(formatAutomationTriggerLabel({
            kind: 'pluginEvent',
            eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
            sourceSelectorId: 'selector-1',
            sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null },
        })).toBe('Event: repository-event-v1');
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
        expect(formatAutomationTriggerLabel({
            kind: 'pluginEvent',
            eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
            sourceSelectorId: 'selector-1',
            sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null },
        })).toBe('Evento: repository-event-v1');
        expect(formatAutomationNextRun(null)).toBe('Sin próxima ejecución');
        expect(formatAutomationNextRun(1_700_000_000_000)).toBe('Próxima: fecha-localizada');
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
