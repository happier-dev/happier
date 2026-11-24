import { resolveHappierActionFieldPresentation } from '@happier-dev/plugin-ui/presentation';
import { isSameInputOptionValue, type InputFieldHint } from '@happier-dev/protocol/inputs';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { describeHostInputTypePickerValue } from '@/components/sessions/actions/hostInputTypePickerForm';

/** A name, an intentional withholding, or a value left to its typed formatter. */
export type WidgetBindingValueLabel = string | null | undefined;
export type WidgetBindingValueLabels = Readonly<Record<string, WidgetBindingValueLabel>>;

/** A filesystem location is never used as the name of a binding. */
const TYPED_LOCATION = /^(?:[\\/~]|[A-Za-z]:[\\/])/;

/** A value as people read it: text and numbers as they are, an object by its own name. */
function describeWidgetBindingValue(value: JsonValue): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['label', 'name', 'title'] as const) {
      const named = (value as Readonly<Record<string, JsonValue>>)[key];
      if (typeof named === 'string' && named.length > 0) return named;
    }
  }
  return null;
}

/**
 * The label owner uses this for pins without a resolved inventory name, including a new group draft.
 * Inventory values carry the declared field name until their own safe label is available.
 */
export function describeWidgetBindingPinValue(
    field: InputFieldHint | undefined, value: JsonValue, sessionTarget: boolean,
): WidgetBindingValueLabel {
    if (sessionTarget || field?.widget === 'secret') return null;
    const type = field?.inputType;
    const period = type && 'hostType' in type && type.hostType === 'usageQuery' && type.field === 'period';
    if (type && 'hostType' in type && !period) return null;
    const option = field?.options?.find(entry => isSameInputOptionValue(entry.value, value));
    if (option) return option.label;
    if (typeof value === 'string' && TYPED_LOCATION.test(value)) return null;
    if (period) return undefined;
    if (field?.options || field?.optionsSourceId || type) return null;
    return describeWidgetBindingValue(value) ?? (field?.widget === 'text_list' ? undefined : null);
}

export function describeWidgetGroupFollowedInput(field: InputFieldHint, reading: {
    value: JsonValue;
    slotLabel: WidgetBindingValueLabel;
}): string | null {
    const { value, slotLabel } = reading;
    if (slotLabel === null) return null;
    const option = field.options?.find(option => isSameInputOptionValue(option.value, value));
    if (option) return option.label;
    if (slotLabel) return slotLabel;

    const typedLabel = field.inputType && 'hostType' in field.inputType
        ? describeHostInputTypePickerValue(field.inputType, value) : null;
    if (typedLabel) return typedLabel;
    if (field.allowCustomValue && typeof value === 'string') return value;
    if (typeof value !== 'string' && typeof value !== 'number' && field.widget !== 'text_list' && field.widget !== 'json') return null;
    const presentation = resolveHappierActionFieldPresentation(field, value);
    return presentation.kind === 'text' && !presentation.secure ? presentation.value : null;
}
