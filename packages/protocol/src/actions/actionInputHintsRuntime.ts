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

