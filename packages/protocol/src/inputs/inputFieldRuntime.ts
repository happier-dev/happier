import type { InputFieldHint, InputHints } from './inputFields.js';
import { evaluateInputPredicate, readInputPath } from './inputPredicates.js';
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

export function resolveEffectiveInputFields(
  spec: Readonly<{ inputHints?: InputHints }>,
  input: unknown,
  options: Readonly<{ includeHidden?: boolean }> = {},
): readonly EffectiveInputField[] {
  const fields = spec.inputHints?.fields ?? [];

  const out: EffectiveInputField[] = [];
  for (const field of fields) {
    const { visibleWhen, requiredWhen, disabledWhen } = field;

    const visible = visibleWhen ? evaluateInputPredicate(visibleWhen, input) : true;
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
    const child = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
    return { ...source, [segment]: write(child, index + 1) };
  };

  return write(input, 0);
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
