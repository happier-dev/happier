import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';
import { evaluateActionInputPredicate } from './actionInputPredicates.js';
export {
  actionInputOptionValueKey,
  actionInputOptionValueSearchText,
  isSameActionInputOptionValue,
  readActionInputOptionValue,
} from './actionInputHints.js';
export type { ActionInputOptionValue } from './actionInputHints.js';

/** Browser-safe Action-form vocabulary for SDK/UI consumers of this owner. */
export type {
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
} from './actionSpecs.js';
export type { ActionInputPredicate } from './actionInputPredicates.js';

export type EffectiveActionInputField = ActionInputFieldHint & Readonly<{
  visible: boolean;
  required: boolean;
  disabled: boolean;
}>;

export function resolveEffectiveActionInputFields(
  spec: Pick<ActionSpec, 'inputHints'>,
  input: unknown,
): readonly EffectiveActionInputField[] {
  const fields = spec.inputHints?.fields ?? [];

  const out: EffectiveActionInputField[] = [];
  for (const field of fields) {
    const { visibleWhen, requiredWhen, disabledWhen } = field;

    const visible = visibleWhen ? evaluateActionInputPredicate(visibleWhen, input) : true;
    if (!visible) continue;

    const required = field.required === true || (requiredWhen ? evaluateActionInputPredicate(requiredWhen, input) : false);
    const disabled = disabledWhen ? evaluateActionInputPredicate(disabledWhen, input) : false;

    out.push({ ...field, visible, required, disabled });
  }
  return out;
}

function readInputPath(input: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let cursor: unknown = input;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function writeInputPath(
  input: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return input;

  const write = (source: Record<string, unknown>, index: number): Record<string, unknown> => {
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
  field: ActionInputFieldHint,
): Record<string, unknown> {
  if (field.widget !== 'multiselect') return input;
  const { maxSelections } = field;
  if (maxSelections === undefined) return input;

  const current = readInputPath(input, field.path);
  if (!Array.isArray(current) || current.length <= maxSelections) return input;
  return writeInputPath(input, field.path, current.slice(-maxSelections));
}

export function normalizeActionInputByFieldHints(
  spec: Pick<ActionSpec, 'inputHints'>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields = spec.inputHints?.fields ?? [];

  let normalized = input;
  for (const field of fields) {
    normalized = normalizeFieldMaxSelections(normalized, field);
  }
  return normalized;
}
