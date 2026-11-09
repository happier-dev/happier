import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { AttentionQuietHoursInputSchema, AttentionQuietHoursWindowInputSchema,
    type AttentionQuietHoursInput } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveAppLocalDateTimePicker } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { t, usePreferredLanguage } from '@/text';

type Window = AttentionQuietHoursInput['windows'][number];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Drafts exist only while this editor is open; the established setting Action owns the write. */
export function QuietHoursScheduleEditor(props: Readonly<{
    initial: AttentionQuietHoursInput;
    testIDPrefix: string;
    onSave: (schedule: AttentionQuietHoursInput) => Promise<boolean>;
    onCancel: () => void;
}>): React.ReactElement {
    const [draft, setDraft] = React.useState(() => ({ ...props.initial,
        windows: props.initial.windows.map(window => ({ ...window, ...(window.days ? { days: [...window.days] } : {}) })) }));
    const [submitted, setSubmitted] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const prefix = props.testIDPrefix;
    const zoneValid = AttentionQuietHoursInputSchema.shape.timezone.safeParse(draft.timezone).success;
    const updateWindow = (index: number, window: Window) => setDraft(current => ({ ...current,
        windows: current.windows.map((value, at) => at === index ? window : value) }));
    const save = async () => {
        setSubmitted(true);
        const parsed = AttentionQuietHoursInputSchema.safeParse(draft);
        if (!parsed.success || pending) return;
        setPending(true);
        try { await props.onSave(parsed.data); }
        finally { setPending(false); }
    };
    return <>
        <Item title={t('settingsNotifications.quietHours.timezone')} showChevron={false} accessoryLayout="stacked"
            subtitle={t('settingsNotifications.quietHours.timezoneHint')}
            rightElement={<FieldTextInput testID={prefix + '-timezone'} value={draft.timezone}
                accessibilityLabel={t('settingsNotifications.quietHours.timezone')}
                autoCapitalize="none" editable={!pending} error={submitted && !zoneValid ? t('settingsNotifications.quietHours.invalidTimezone') : undefined}
                onChangeText={timezone => setDraft(current => ({ ...current, timezone }))} />} />
        {draft.windows.map((window, index) => <React.Fragment key={index}>
            <Item title={t('settingsNotifications.quietHours.windowTitle', { number: index + 1 })}
                subtitle={t('settingsNotifications.quietHours.overnightHint')} showChevron={false}
                rightElement={<RoundButton size="small" display="inverted" title={t('common.remove')}
                    testID={prefix + '-window-' + index + '-remove'} disabled={pending}
                    onPress={() => setDraft(current => ({ ...current, windows: current.windows.filter((_, at) => at !== index) }))} />} />
            <QuietHoursTimeField title={t('settingsNotifications.quietHours.startTime')} value={window.startLocalTime}
                testID={prefix + '-window-' + index + '-start'} disabled={pending}
                invalid={submitted && !AttentionQuietHoursWindowInputSchema.shape.startLocalTime.safeParse(window.startLocalTime).success}
                onChange={startLocalTime => updateWindow(index, { ...window, startLocalTime })} />
            <QuietHoursTimeField title={t('settingsNotifications.quietHours.endTime')} value={window.endLocalTime}
                testID={prefix + '-window-' + index + '-end'} disabled={pending}
                invalid={submitted && !AttentionQuietHoursWindowInputSchema.shape.endLocalTime.safeParse(window.endLocalTime).success}
                onChange={endLocalTime => updateWindow(index, { ...window, endLocalTime })} />
            <QuietHoursDaysField window={window} disabled={pending} testID={prefix + '-window-' + index + '-days'}
                onChange={days => updateWindow(index, { ...window, days })} />
        </React.Fragment>)}
        <SectionContentRow><View style={styles.actions}>
            <RoundButton testID={prefix + '-add'} size="small" display="secondary" disabled={pending}
                title={t('settingsNotifications.quietHours.addWindow')}
                onPress={() => setDraft(current => ({ ...current, windows: [...current.windows,
                    { startLocalTime: '22:00', endLocalTime: '07:00' }] }))} />
        </View></SectionContentRow>
        <SectionContentRow><View style={styles.actions}>
            <RoundButton testID={prefix + '-save'} size="small" title={t('common.save')} disabled={pending} onPress={() => { void save(); }} />
            <RoundButton testID={prefix + '-cancel'} size="small" display="inverted" title={t('common.cancel')}
                disabled={pending} onPress={props.onCancel} />
        </View></SectionContentRow>
    </>;
}

function QuietHoursTimeField(props: Readonly<{
    title: string; value: string; testID: string; disabled: boolean; invalid: boolean; onChange: (value: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const anchor = React.useRef<View | null>(null);
    const picker = resolveAppLocalDateTimePicker();
    const parsed = AttentionQuietHoursWindowInputSchema.shape.startLocalTime.safeParse(props.value);
    const [hour, minute] = parsed.success ? parsed.data.split(':').map(Number) : [0, 0];
    return <>
        <Item title={props.title} showChevron={false} accessoryLayout="stacked" rightElement={
            <View ref={anchor}><FieldTextInput value={props.value} testID={props.testID} accessibilityLabel={props.title}
                accessibilityHint={t('settingsNotifications.quietHours.timeFormat')} keyboardType="numbers-and-punctuation"
                editable={!props.disabled} error={props.invalid ? t('settingsNotifications.quietHours.invalidTime') : undefined}
                onChangeText={props.onChange} trailing={picker ? <IconButton testID={props.testID + '-picker'} accessibilityLabel={props.title}
                    disabled={props.disabled} iconName="clock" onPress={() => setOpen(value => !value)} /> : undefined} /></View>} />
        {picker && open && !props.disabled ? picker.renderPicker({ mode: 'time', anchorRef: anchor,
            value: new Date(2000, 0, 1, hour, minute), minimumDate: new Date(2000, 0, 1),
            onDismiss: () => setOpen(false), onChange: value => props.onChange(
                String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0')) }) : null}
    </>;
}

function QuietHoursDaysField(props: Readonly<{
    window: Window; disabled: boolean; testID: string; onChange: (days: Window['days']) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const language = usePreferredLanguage();
    const labels = React.useMemo(() => {
        const formatter = new Intl.DateTimeFormat(language, { weekday: 'long' });
        return WEEKDAYS.map((day, index) => ({ day, title: formatter.format(new Date(2024, 0, 1 + index, 12)) }));
    }, [language]);
    const days = props.window.days ?? [];
    const summary = days.length === 0 ? t('settingsNotifications.quietHours.everyDay')
        : labels.filter(({ day }) => days.includes(day)).map(({ title }) => title).join(', ');
    return <DropdownMenu testID={props.testID} open={open} onOpenChange={setOpen} closeOnSelect={false}
        itemTrigger={{ title: t('settingsNotifications.quietHours.days'), showSelectedSubtitle: false,
            subtitle: t('settingsNotifications.quietHours.daysHint'), detailFormatter: () => summary,
            itemProps: { testID: props.testID + '-trigger', disabled: props.disabled, accessoryLayout: 'stacked' } }}
        items={[{ id: 'all', testID: props.testID + ':all', title: t('settingsNotifications.quietHours.everyDay'), checked: days.length === 0 },
            ...labels.map(({ day, title }) => ({ id: day, title, checked: days.includes(day), testID: props.testID + ':' + day }))]}
        onSelect={id => {
            if (id === 'all') props.onChange([]);
            else {
                const day = WEEKDAYS.find(value => value === id);
                if (day) props.onChange(days.includes(day) ? days.filter(value => value !== day) : [...days, day]);
            }
        }} />;
}

const styles = StyleSheet.create(theme => ({
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'center' },
}));
