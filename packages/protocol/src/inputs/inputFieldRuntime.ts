import type { InputFieldHint, InputFieldHintDescriptor, InputHints, InputHintsDescriptor } from './inputFields.js';
import { evaluateInputPredicate, readInputPath } from './inputPredicates.js';
import { readRecord } from './inputRecords.js';
export {
  inputOptionValueKey,
  inputOptionValueSearchText,
  isSameInputOptionValue,
  readInputOptionValue,
} from './inputFields.js';
export type { InputOptionValue } from './inputFields.js';

/** Browser-safe field vocabulary for SDK/UI consumers of this owner. */
export type {
  InputFieldHint,
  InputHints,
  InputOption,
} from './inputFields.js';
export type { InputPredicate } from './inputPredicates.js';

export type EffectiveInputField = InputFieldHint & Readonly<{
  visible: boolean;
  required: boolean;
  disabled: boolean;
}>;

export function resolveEffectiveInputFields<TText = string, TField extends InputFieldHintDescriptor<TText> = InputFieldHintDescriptor<TText>>(
  spec: Readonly<{ inputHints?: InputHintsDescriptor<TText> & Readonly<{ fields: readonly TField[] }> }>,
  input: unknown,
  options: Readonly<{ includeHidden?: boolean; contextSlots?: readonly string[] }> = {},
): readonly (TField & InputFieldHintDescriptor<TText> & Pick<EffectiveInputField, 'visible' | 'required' | 'disabled'>)[] {
  const fields = spec.inputHints?.fields ?? [];

  const out: (TField & InputFieldHintDescriptor<TText> & Pick<EffectiveInputField, 'visible' | 'required' | 'disabled'>)[] = [];
  for (const field of fields) {
    const { visibleWhen, requiredWhen, disabledWhen } = field;

    const visible = (!visibleWhen || evaluateInputPredicate(visibleWhen, input))
      && (field.visibleWhenContextSlot === undefined || options.contextSlots === undefined
        || options.contextSlots.includes(field.visibleWhenContextSlot));
    // Hidden fields stay out of forms, but any forwarded value still requires admission.
    if (!visible && options.includeHidden !== true) continue;

    const required = field.required === true || (requiredWhen ? evaluateInputPredicate(requiredWhen, input) : false);
    const disabled = disabledWhen ? evaluateInputPredicate(disabledWhen, input) : false;

    out.push({ ...field, visible, required, disabled });
  }
  return out;
}

export function writeInputPath(
  input: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return { ...input };

  const write = (source: Readonly<Record<string, unknown>>, index: number): Record<string, unknown> => {
    const segment = segments[index]!;
    if (index === segments.length - 1) {
      return { ...source, [segment]: value };
    }
    const current = source[segment];
    return { ...source, [segment]: writeChild(current, index + 1) };
  };

  const writeChild = (source: unknown, index: number): unknown => {
    if (Array.isArray(source)) {
      const segment = segments[index]!;
      const position = Number(segment);
      // Indexed paths update prepared slots, not wildcard or property-shaped entries.
      if (!/^(0|[1-9]\d*)$/.test(segment) || position >= source.length || !Object.hasOwn(source, segment)) return source;
      const next: unknown[] = source.slice();
      next[position] = index === segments.length - 1 ? value : writeChild(source[position], index + 1);
      return next;
    }
    return write(readRecord(source), index);
  };

  return write(input, 0);
}

/** Seeds a new form once; explicit values and subsequent draft replacements remain authoritative. */
export function seedInputByFieldHints(
  spec: Readonly<{ inputHints?: InputHints }>,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let seeded = { ...input };
  for (const field of spec.inputHints?.fields ?? []) {
    if (field.defaultValue !== undefined && readInputPath(seeded, field.path) === undefined) {
      seeded = writeInputPath(seeded, field.path, field.defaultValue);
    }
  }
  return seeded;
}

function normalizeFieldMaxSelections(
  input: Record<string, unknown>,
  field: InputFieldHint,
): Record<string, unknown> {
  if (field.widget !== 'multiselect') return input;
  const { maxSelections } = field;
  if (maxSelections === undefined) return input;

  const current = readInputPath(input, field.path);
  if (!Array.isArray(current) || current.length <= maxSelections) return input;
  return writeInputPath(input, field.path, current.slice(-maxSelections));
}

export function normalizeInputByFieldHints(
  spec: Readonly<{ inputHints?: InputHints }>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields = spec.inputHints?.fields ?? [];

  let normalized = input;
  for (const field of fields) {
    normalized = normalizeFieldMaxSelections(normalized, field);
  }
  return normalized;
}
