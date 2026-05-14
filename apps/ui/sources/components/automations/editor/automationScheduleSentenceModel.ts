import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { t, type TranslationKeyNoParams } from '@/text';

export type AutomationCronPresetId =
    | 'hourly'
    | 'weekdays-9am'
    | 'monday-9am'
    | 'daily-midnight';

export type AutomationIntervalUnit = 'minutes' | 'hours' | 'days';

export type AutomationIntervalUnitOption = Readonly<{
    id: AutomationIntervalUnit;
    labelKey: TranslationKeyNoParams;
    multiplierMinutes: number;
}>;

export type AutomationCronPreset = Readonly<{
    id: AutomationCronPresetId;
    labelKey: TranslationKeyNoParams;
    cadenceKey: TranslationKeyNoParams;
    expression: string;
}>;

export const AUTOMATION_INTERVAL_PRESET_MINUTES = [
    5,
    15,
    30,
    60,
    120,
    360,
    720,
    1440,
] as const;

export const AUTOMATION_INTERVAL_UNITS: ReadonlyArray<AutomationIntervalUnitOption> = [
    {
        id: 'minutes',
        labelKey: 'automations.form.sentence.intervalUnits.minutes',
        multiplierMinutes: 1,
    },
    {
        id: 'hours',
        labelKey: 'automations.form.sentence.intervalUnits.hours',
        multiplierMinutes: 60,
    },
    {
        id: 'days',
        labelKey: 'automations.form.sentence.intervalUnits.days',
        multiplierMinutes: 24 * 60,
    },
];

export const AUTOMATION_CRON_PRESETS: ReadonlyArray<AutomationCronPreset> = [
    {
        id: 'weekdays-9am',
        labelKey: 'automations.form.sentence.cronPresets.weekdays9am',
        cadenceKey: 'automations.form.sentence.cronCadences.weekdays9am',
        expression: '0 9 * * 1-5',
    },
    {
        id: 'hourly',
        labelKey: 'automations.form.sentence.cronPresets.hourly',
        cadenceKey: 'automations.form.sentence.cronCadences.hourly',
        expression: '0 * * * *',
    },
    {
        id: 'monday-9am',
        labelKey: 'automations.form.sentence.cronPresets.monday9am',
        cadenceKey: 'automations.form.sentence.cronCadences.monday9am',
        expression: '0 9 * * 1',
    },
    {
        id: 'daily-midnight',
        labelKey: 'automations.form.sentence.cronPresets.dailyMidnight',
        cadenceKey: 'automations.form.sentence.cronCadences.dailyMidnight',
        expression: '0 0 * * *',
    },
];

function clampEveryMinutes(value: number): number {
    return Math.min(Math.max(Math.floor(value), 1), 30 * 24 * 60);
}

function getIntervalUnitMultiplier(unit: AutomationIntervalUnit): number {
    return AUTOMATION_INTERVAL_UNITS.find((item) => item.id === unit)?.multiplierMinutes ?? 1;
}

export function deriveAutomationIntervalUnit(minutes: number): AutomationIntervalUnit {
    const normalized = clampEveryMinutes(minutes);
    if (normalized % (24 * 60) === 0) return 'days';
    if (normalized % 60 === 0) return 'hours';
    return 'minutes';
}

export function getAutomationIntervalUnitValue(minutes: number, unit: AutomationIntervalUnit): number {
    return Math.max(1, Math.round(clampEveryMinutes(minutes) / getIntervalUnitMultiplier(unit)));
}

export function applyAutomationIntervalPreset(
    draft: NewSessionAutomationDraft,
    minutes: number,
): NewSessionAutomationDraft {
    return {
        ...draft,
        scheduleKind: 'interval',
        everyMinutes: clampEveryMinutes(minutes),
    };
}

export function applyAutomationIntervalUnitValue(
    draft: NewSessionAutomationDraft,
    value: number,
    unit: AutomationIntervalUnit,
): NewSessionAutomationDraft {
    return applyAutomationIntervalPreset(draft, value * getIntervalUnitMultiplier(unit));
}

export function applyAutomationIntervalUnit(
    draft: NewSessionAutomationDraft,
    unit: AutomationIntervalUnit,
): NewSessionAutomationDraft {
    const value = getAutomationIntervalUnitValue(draft.everyMinutes, unit);
    return applyAutomationIntervalUnitValue(draft, value, unit);
}

export function applyAutomationCronPreset(
    draft: NewSessionAutomationDraft,
    presetId: AutomationCronPresetId,
): NewSessionAutomationDraft {
    const preset = AUTOMATION_CRON_PRESETS.find((item) => item.id === presetId);
    if (!preset) return draft;
    return {
        ...draft,
        scheduleKind: 'cron',
        cronExpr: preset.expression,
    };
}

export function formatIntervalPresetLabel(minutes: number): string {
    const normalized = clampEveryMinutes(minutes);
    if (normalized < 60) return `${normalized}m`;
    if (normalized % (24 * 60) === 0) return `${normalized / (24 * 60)}d`;
    const hours = normalized / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${normalized}m`;
}

export function formatAutomationCronPresetLabel(preset: AutomationCronPreset): string {
    return t(preset.labelKey);
}

export function formatAutomationScheduleTriggerLabel(draft: NewSessionAutomationDraft): string {
    if (draft.scheduleKind === 'cron') {
        const expr = draft.cronExpr.trim();
        const preset = AUTOMATION_CRON_PRESETS.find((item) => item.expression === expr);
        return preset ? t(preset.labelKey) : (expr || '0 * * * *');
    }

    return t('automations.form.sentence.intervalValue', { minutes: clampEveryMinutes(draft.everyMinutes) });
}

export function formatAutomationCadenceLabel(draft: NewSessionAutomationDraft): string {
    if (draft.scheduleKind === 'cron') {
        const expr = draft.cronExpr.trim();
        const preset = AUTOMATION_CRON_PRESETS.find((item) => item.expression === expr);
        return preset
            ? t(preset.cadenceKey)
            : t('automations.form.sentence.cronCadenceExpression', { expression: expr || '0 * * * *' });
    }

    return t('automations.form.sentence.intervalCadence', { minutes: clampEveryMinutes(draft.everyMinutes) });
}
