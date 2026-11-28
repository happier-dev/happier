import { isSameInputOptionValue, type InputFieldHint } from '@happier-dev/protocol/inputs';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { describeHostInputTypePickerValue } from '@/components/sessions/actions/hostInputTypePickerForm';

/** A name, an intentional withholding, or a value left to its typed formatter. */
export type WidgetBindingValueLabel = string | null | undefined;
export type WidgetBindingValueLabels = Readonly<Record<string, WidgetBindingValueLabel>>;
export type WidgetBindingLabelField = Readonly<{ slot: string; field: InputFieldHint; sessionTarget: boolean }>;
export type WidgetBindingValueSource = 'page' | 'group';
export type WidgetBindingReading = Readonly<{ value: JsonValue; label: WidgetBindingValueLabel }>;

/** Prefer a shared declared title, then the common slot, then the editor's field name. */
export function readWidgetBindingFieldTitle(fallback: string, declarations: readonly WidgetBindingLabelField[]): string {
    const titles = new Set(declarations.map(({ field }) => field.title));
    if (titles.size === 1) return titles.values().next().value!;
    const slots = new Set(declarations.map(({ slot }) => slot));
    return slots.size === 1 ? slots.values().next().value! : fallback;
}

/** Summarize the whole set. Multiple resolved operands take precedence over an incomplete name. */
export function summarizeWidgetBindingReadings(readings: readonly (WidgetBindingReading | null)[]):
    Readonly<{ kind: 'several' }> | Readonly<{ kind: 'single'; label: string }> | null {
    const labels = new Set<string>();
    let first: WidgetBindingReading | null = null;
    let several = false;
    let incomplete = false;
    for (const reading of readings) {
        if (reading) {
            first ??= reading;
            if (!sameStrictJsonValue(first.value, reading.value)) several = true;
        }
        if (reading?.label) labels.add(reading.label);
        else incomplete = true;
    }
    if (several) return { kind: 'several' };
    if (!first || incomplete || labels.size !== 1) return null;
    return { kind: 'single', label: labels.values().next().value! };
}

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
    field: InputFieldHint | undefined, value: JsonValue, sessionTarget: boolean, group = false,
): WidgetBindingValueLabel {
    if (!field || sessionTarget || field.widget === 'secret') return null;
    const type = field.inputType;
    const period = type && 'hostType' in type && type.hostType === 'usageQuery' && type.field === 'period';
    if (type && 'hostType' in type && !period) return null;
    const option = field.options?.find(entry => isSameInputOptionValue(entry.value, value));
    if (option) return option.label;
    if (typeof value === 'string' && TYPED_LOCATION.test(value)) return null;
    if (period) return group ? describeHostInputTypePickerValue(type, value) : undefined;
    if (field.options || field.optionsSourceId || type) return null;
    return describeWidgetBindingValue(value);
}

// An admitted page name belongs to its bound slot. The child's declared choice can name that same value.
export function describeWidgetPageBindingValue(field: InputFieldHint, value: JsonValue, pageLabel: WidgetBindingValueLabel): string | null {
    if (!pageLabel) return null;
    return field.options?.find(option => isSameInputOptionValue(option.value, value))?.label ?? pageLabel;
}
