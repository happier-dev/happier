import type { ActionInputFieldHint } from '@happier-dev/protocol';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { ActionFieldOption } from './ActionInputFields';
import type { InputFieldOptionsState } from './inputFieldOptionsStore';
import type { InputOptionsConsumerV1 } from '@happier-dev/protocol/inputs';
import type { InputTypePickerHostContext } from './InputTypePickerHostProvider';

export type InputFieldOptionsContext = Readonly<{ actionId?: string; consumer?: InputOptionsConsumerV1; draftInput?: Readonly<Record<string, unknown>> }>;
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
    return (field) => field.options?.length || !field.optionsSourceId
        ? field.options ?? EMPTY_OPTIONS
        : lists[field.optionsSourceId] ?? EMPTY_OPTIONS;
}

/** Changes only when option content can change row geometry; availability is interaction-only. */
export function buildSessionActionFieldOptionsHeightSignature(lists: SessionActionFieldOptionLists): string {
    return JSON.stringify(Object.entries(lists).map(([key, options]) => [key,
        options.map((option) => [actionInputOptionValueKey(option.value), option.label, option.description])]));
}
