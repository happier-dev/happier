import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readDeviceTimeZone, type TriggerWhenValue } from './sessionTriggerForm';
import { buildSimpleScheduleCron, formatClockTimeInput, parseClockTime, SIMPLE_SCHEDULE_REPEATS } from './triggerSchedule';

/** The controlled schedule draft is shared by its visible fields and mounted commands. */
export function useTriggerScheduleCommands(props: Readonly<{
    currentUiContextCommandScope?: string;
    when: Extract<TriggerWhenValue, { kind: 'schedule' }>;
    onChange: (next: TriggerWhenValue) => void;
}>) {
    const { when, currentUiContextCommandScope: scope } = props;
    const readValue = (input?: PluginUiJsonValueV1) => isRecord(input)
        && typeof input.value === 'string' ? input.value : null;
    const changeRepeat = (repeat: string) => {
        if (repeat === 'once') {
            props.onChange({ kind: 'schedule', schedule: null, expression: '', timezone: readDeviceTimeZone(),
                once: when.once ?? { date: '', time: '09:00', relative: '' } });
            return true;
        }
        const selected = SIMPLE_SCHEDULE_REPEATS.find(candidate => candidate === repeat);
        if (selected === undefined) return false;
        const schedule = { ...(when.schedule ?? { hour: 9, minute: 0, day: 1 }), repeat: selected };
        props.onChange({ kind: 'schedule', schedule, expression: buildSimpleScheduleCron(schedule), timezone: when.timezone });
        return true;
    };
    const changeTime = (value: string) => {
        const time = parseClockTime(value);
        if (when.schedule === null || time === null) return false;
        const schedule = { ...when.schedule, ...time };
        props.onChange({ ...when, schedule, expression: buildSimpleScheduleCron(schedule) });
        return true;
    };
    const changeExpression = (expression: string) => {
        if (when.once !== undefined || when.schedule !== null || when.everyMs !== undefined) return false;
        props.onChange({ ...when, expression });
        return true;
    };
    const changeOnceDateTime = (date: string, time: string) => {
        if (when.once === undefined) return false;
        props.onChange({ ...when, once: { date, time, relative: '' } });
        return true;
    };
    const changeRelative = (relative: string) => {
        if (when.once === undefined) return false;
        props.onChange({ ...when, once: { date: when.once.date, time: when.once.time, relative } });
        return true;
    };
    const commands = useCurrentUiContextLocalCommands(scope === undefined ? [] : [
        { key: 'repeat', title: t('workflows.triggers.popover.repeat'),
            description: JSON.stringify({ control: `${scope}.schedule.repeat`, value: when.once ? 'once' : when.schedule?.repeat ?? (when.everyMs === undefined ? 'custom' : 'interval'),
                input: { value: ['once', ...SIMPLE_SCHEDULE_REPEATS] } }),
            invoke: (input?: PluginUiJsonValueV1) => { const value = readValue(input); return value !== null && changeRepeat(value); } },
        ...(when.once === undefined ? [] : [
            { key: 'dateTime', title: t('workflows.triggers.popover.at'),
                description: JSON.stringify({ control: `${scope}.schedule.dateTime`, value: { date: when.once.date, time: when.once.time },
                    input: { date: 'YYYY-MM-DD', time: 'HH:MM' } }),
                invoke: (input?: PluginUiJsonValueV1) => isRecord(input) && typeof input.date === 'string' && typeof input.time === 'string'
                    && changeOnceDateTime(input.date, input.time) },
            { key: 'relative', title: t('workflows.triggers.once.relative'),
                description: JSON.stringify({ control: `${scope}.schedule.relative`, value: when.once.relative, input: { value: 'in 20 min' } }),
                invoke: (input?: PluginUiJsonValueV1) => { const value = readValue(input); return value !== null && changeRelative(value); } },
        ]),
        ...(when.schedule !== null ? [{ key: 'at', title: t('workflows.triggers.popover.at'),
            description: JSON.stringify({ control: `${scope}.schedule.at`, value: formatClockTimeInput(when.schedule), input: { value: 'HH:MM' } }),
            invoke: (input?: PluginUiJsonValueV1) => { const value = readValue(input); return value !== null && changeTime(value); } }] : []),
        ...(when.once === undefined && when.schedule === null && when.everyMs === undefined ? [{ key: 'expression', title: t('workflows.triggers.popover.expression'),
            description: JSON.stringify({ control: `${scope}.schedule.expression`, value: when.expression, input: { value: 'cron expression' } }),
            invoke: (input?: PluginUiJsonValueV1) => { const value = readValue(input); return value !== null && changeExpression(value); } }] : []),
    ], { foregroundOverlay: true, contextKey: scope });

    return {
        changeRepeat: (repeat: string) => { if (scope === undefined) changeRepeat(repeat); else void commands.invoke('repeat', { value: repeat }); },
        changeOnceDateTime: (value: Readonly<{ date: string; time: string }>) => {
            if (scope === undefined) changeOnceDateTime(value.date, value.time);
            else void commands.invoke('dateTime', value);
        },
        commitRelative: (value: string) => { if (scope === undefined) changeRelative(value); else void commands.invoke('relative', { value }); },
        commitTime: (value: string) => {
            if (when.schedule === null) return;
            // The field retains its synchronous invalid-draft feedback; the Action owns the edit.
            if (scope === undefined) { if (!changeTime(value)) return formatClockTimeInput(when.schedule); }
            else { void commands.invoke('at', { value }); if (parseClockTime(value) === null) return formatClockTimeInput(when.schedule); }
        },
        commitExpression: (value: string) => { if (scope === undefined) changeExpression(value); else void commands.invoke('expression', { value }); },
    };
}
