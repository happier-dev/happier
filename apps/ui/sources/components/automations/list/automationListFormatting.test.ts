import { afterEach, describe, expect, it, vi } from 'vitest';

import { setPreferredLanguageFromSettings } from '@/text';
import {
    formatAutomationNextRun,
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
        expect(formatAutomationTriggerLabel({ kind: 'conversation' })).toBe('Disparador de conversación');
        expect(formatAutomationNextRun(null)).toBe('Sin próxima ejecución');
        expect(formatAutomationNextRun(1_700_000_000_000)).toBe('Próxima: fecha-localizada');
    });
});
