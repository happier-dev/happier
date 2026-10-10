import { isSameInputOptionValue, type InputFieldHint, type InputOption } from '@happier-dev/protocol/inputs';
import { validateHostInputTypeValue, type InputTypePickerHostV1 } from '@happier-dev/protocol/inputs/runtime';
import { normalizeUsageQuery, UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';

import { createActionInputForm, type ActionInputFormAccountLifetime } from '@/components/plugins/actions/actionInputForm';
import { USAGE_PERIODS, getUsagePeriodDefinition, resolveUsagePeriodStartTimeSeconds } from '@/sync/api/account/usagePeriods';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { getPreferredLanguage, t } from '@/text';

type HostPickerRequest = Parameters<NonNullable<InputTypePickerHostV1['openHostPicker']>>[0];

/** Host semantic projections use the same transient form as every other typed input. */
export function createHostInputTypePickerForm(params: Readonly<{
    request: HostPickerRequest;
    serverId: string;
    draftInput?: Readonly<Record<string, unknown>>;
    nowMs: number;
    accountLifetime?: ActionInputFormAccountLifetime | null;
    isCurrent?: () => boolean;
}>) {
    const { request } = params;
    const reference = request.reference;
    const projection = reference.hostType === 'usageQuery' ? reference.field : undefined;
    const validation = validateHostInputTypeValue(reference, request.value ?? (projection === 'session' ? null : {}));
    const current = validation.status === 'valid' ? validation.value : undefined;
    let fields: readonly InputFieldHint[] = request.fields;
    let initial: Readonly<Record<string, unknown>> = reference.hostType === 'usageQuery' && projection === undefined && current !== undefined
        ? normalizeUsageQuery(current) : normalizeUsageQuery({});

    if (projection === 'period') {
        const offset = UsageQuerySchema.shape.timeZoneOffsetMinutes.parse(params.draftInput?.timeZoneOffsetMinutes);
        const options: InputOption[] = USAGE_PERIODS.map(period => ({
            value: { startMs: resolveUsagePeriodStartTimeSeconds(period, params.nowMs, offset) * 1000, endMs: params.nowMs },
            label: t(getUsagePeriodDefinition(period).translationKey),
        }));
        if (current !== undefined && !options.some(option => isSameInputOptionValue(option.value, current))) {
            options.unshift({ value: current, label: describeHostInputTypePickerValue(reference, current) ?? t('usage.allTime') });
        }
        fields = [{ path: 'value', title: t('usage.board.page.periodLabel'), widget: 'select', required: true, options }];
        initial = { value: current ?? options[0]!.value };
    } else if (projection === 'session') {
        const ids = typeof current === 'string' ? [current] : Array.isArray(current) ? current : [];
        fields = [{ path: 'value', title: t('usage.summary.export.session'), widget: 'multiselect', optionsSourceId: 'sessions' }];
        initial = { value: ids.map(sessionId => ({ serverId: params.serverId, sessionId })) };
    }

    let settle: (value: unknown) => void = () => {};
    const result = new Promise<unknown>(resolve => { settle = resolve; });
    const form = createActionInputForm({
        presentation: { title: projection === 'period' ? t('usage.board.page.periodLabel')
            : projection === 'session' ? t('usage.summary.export.session') : t('usage.summary.title'),
            description: null, inputHints: { fields: [...fields] } },
        accountLifetime: params.accountLifetime, signal: request.signal, isCurrent: params.isCurrent,
        submit: async candidate => {
            let value: unknown = projection ? candidate.value : candidate;
            if (projection === 'session') {
                if (!Array.isArray(value)) return { ok: false };
                const sessions = value.map(entry => VoiceTrackedSessionAddressV1Schema.safeParse(entry));
                if (sessions.some(session => !session.success || session.data.serverId !== params.serverId)) return { ok: false };
                const ids = sessions.flatMap(session => session.success ? [session.data.sessionId] : []);
                value = ids.length === 0 ? null : ids;
            }
            const selected = validateHostInputTypeValue(reference, value);
            if (selected.status !== 'valid') return { ok: false };
            settle({ kind: 'completed', input: selected.value });
            return { ok: true };
        },
        onRetire: () => settle({ kind: 'cancelled' }),
    });
    form.replaceInput(initial);
    return { form, result };
}

/** A typed pin reads as a period or selection, never as serialized query JSON. */
export function describeHostInputTypePickerValue(reference: HostPickerRequest['reference'], value: unknown): string | null {
    if (reference.hostType !== 'usageQuery' || !reference.field) return null;
    const admitted = validateHostInputTypeValue(reference, value);
    if (admitted.status !== 'valid') return null;
    if (reference.field === 'session') {
        return admitted.value === null ? t('usage.board.page.filterAll')
            : Array.isArray(admitted.value) ? t('usage.board.page.filterCount', { count: admitted.value.length }) : String(admitted.value);
    }
    const period = UsageQuerySchema.shape.period.parse(admitted.value);
    const format = (time: number) => formatWithCachedDateTimeFormatter(time, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
    return period.startMs === undefined && period.endMs === undefined ? t('usage.allTime')
        : [period.startMs === undefined ? t('usage.allTime') : format(period.startMs),
            ...(period.endMs === undefined ? [] : [format(period.endMs)])].join(' – ');
}
