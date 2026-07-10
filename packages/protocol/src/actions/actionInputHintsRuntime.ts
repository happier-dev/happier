import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';
import { evaluateActionInputPredicate } from './actionInputPredicates.js';

export type EffectiveActionInputField = ActionInputFieldHint & Readonly<{
  visible: boolean;
  required: boolean;
  disabled: boolean;
}>;

export function resolveEffectiveActionInputFields(spec: ActionSpec, input: unknown): readonly EffectiveActionInputField[] {
  const hints: any = (spec as any).inputHints;
  const fields: ActionInputFieldHint[] = Array.isArray(hints?.fields) ? hints.fields : [];

  const out: EffectiveActionInputField[] = [];
  for (const field of fields) {
    const visibleWhen = (field as any).visibleWhen;
    const requiredWhen = (field as any).requiredWhen;
    const disabledWhen = (field as any).disabledWhen;

    const visible = visibleWhen ? evaluateActionInputPredicate(visibleWhen, input) : true;
    if (!visible) continue;

    const required = Boolean((field as any).required === true) || (requiredWhen ? evaluateActionInputPredicate(requiredWhen, input) : false);
    const disabled = disabledWhen ? evaluateActionInputPredicate(disabledWhen, input) : false;

    out.push({ ...(field as any), visible, required, disabled });
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
  const maxSelections = (field as Readonly<{ maxSelections?: unknown }>).maxSelections;
  if (!Number.isSafeInteger(maxSelections) || (maxSelections as number) <= 0) return input;

  const current = readInputPath(input, field.path);
  if (!Array.isArray(current) || current.length <= (maxSelections as number)) return input;
  return writeInputPath(input, field.path, current.slice(-(maxSelections as number)));
}

export function normalizeActionInputByFieldHints(
  spec: ActionSpec,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const hints: any = (spec as any).inputHints;
  const fields: ActionInputFieldHint[] = Array.isArray(hints?.fields) ? hints.fields : [];

  let normalized = input;
  for (const field of fields) {
    normalized = normalizeFieldMaxSelections(normalized, field);
  }
  return normalized;
}
