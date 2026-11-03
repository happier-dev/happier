import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionInputFieldHint } from '@happier-dev/protocol';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { ActionFieldOption } from './ActionInputFields';
import type { InputFieldOptionsState } from './inputFieldOptionsStore';
import type { InputOptionsConsumerV1 } from '@happier-dev/protocol/inputs';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { InputTypePickerHostContext } from './InputTypePickerHostProvider';
import { usageDimensionLabel } from '@/sync/domains/usage/usageLabels';
import { localizeBuiltinInputLabel } from '@/text/builtinInputPrompts';
import { UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';

export type InputFieldOptionsContext = Readonly<Pick<PublicActionInputById['action.options.resolve'], 'query' | 'cursor'> & {
    actionId?: string; consumer?: InputOptionsConsumerV1; draftInput?: Readonly<Record<string, unknown>>;
    /** Check these picked values only: a source that can answer them directly does not read its whole inventory. */
    values?: readonly JsonValue[] }>;
export type ResolveSessionActionFieldOptions = ((
    field: Pick<ActionInputFieldHint, 'optionsSourceId' | 'options' | 'inputType' | 'connectedAccountOptions'> & { path?: string },
    context?: InputFieldOptionsContext,
) => readonly ActionFieldOption[]) & Readonly<{
    state?: (field: Pick<ActionInputFieldHint, 'path' | 'optionsSourceId' | 'options' | 'inputType' | 'connectedAccountOptions'>, context?: InputFieldOptionsContext) => InputFieldOptionsState;
    retry?: () => void;
    pickerContext?: InputTypePickerHostContext;
}>;
export type SessionActionFieldOptionLists = Readonly<Record<string, readonly ActionFieldOption[]>>;
const EMPTY_OPTIONS: readonly ActionFieldOption[] = Object.freeze([]);

/** A pure paint projection; all source decisions and reads belong to Action discovery. */
export function buildSessionActionFieldOptionsResolver(lists: SessionActionFieldOptionLists): ResolveSessionActionFieldOptions {
    const projected = Object.fromEntries(Object.entries(lists).map(([source, options]) => {
        if (source === 'usage.query.breakdown') return [source, options.map(option => ({ ...option, label: localizeBuiltinInputLabel(option.label) }))];
        // The Period's choices read as the Usage page names them; a custom range reads as its dates.
        if (source === 'usage.query.period') return [source, options.map(option => {
            const period = UsageQuerySchema.shape.period.safeParse(option.value);
            return period.success ? { ...option, label: formatUsageCalendarPeriod(period.data) } : option;
        })];
        const dimension = source === 'usage.filters.agents' ? 'agent' : source === 'usage.filters.machines' ? 'machine'
            : source === 'usage.filters.projects' ? 'project' : source === 'usage.filters.sources' ? 'source' : null;
        if (!dimension) return [source, options];
        // Names were opened in the captured Account read, never in the ambient active server.
        const machineNames = new Map(options.flatMap(option => typeof option.value === 'string' && option.label !== option.value
            ? [[option.value, option.label] as const] : []));
        return [source, options.map(option => {
            if (typeof option.value !== 'string') return option;
            const label = usageDimensionLabel(dimension, option.value, option.label, machineNames);
            return { ...option, label: dimension === 'source' ? label.charAt(0).toUpperCase() + label.slice(1) : label };
        })];
    }));
    return (field) => field.options?.length || !field.optionsSourceId
        ? field.options ?? EMPTY_OPTIONS
        : projected[field.optionsSourceId] ?? EMPTY_OPTIONS;
}

/** Changes only when option content can change row geometry; availability is interaction-only. */
export function buildSessionActionFieldOptionsHeightSignature(lists: SessionActionFieldOptionLists): string {
    return JSON.stringify(Object.entries(lists).map(([key, options]) => [key,
        options.map((option) => [actionInputOptionValueKey(option.value), option.label, option.description])]));
}
