import {
  actionInputOptionValueKey as canonicalActionInputOptionValueKey,
  isSameActionInputOptionValue as canonicalIsSameActionInputOptionValue,
  normalizeActionInputByFieldHints as canonicalNormalizeActionInputByFieldHints,
  readActionInputOptionValue as canonicalReadActionInputOptionValue,
  resolveEffectiveActionInputFields as canonicalResolveEffectiveActionInputFields,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';

import type {
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  EffectiveActionInputField,
} from './actionTypeMap.generated.js';
import type { ActionSpec } from './service.js';

export type {
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  EffectiveActionInputField,
};

/**
 * The normalized, author-visible Action form contract consumed by UI
 * presenters. Host option-source instructions are intentionally excluded;
 * hosts resolve those into ordinary options before crossing this boundary.
 * UI presenters may add their own rendering-only option metadata, but do not
 * create another Action-form vocabulary.
 */
export type ActionFormFieldHint = Omit<
  ActionInputFieldHint,
  'optionsSourceId' | 'connectedAccountOptions' | 'resolvedEmptyConnectedAccountOptions'
>;

export type ActionFormHints = Omit<ActionInputHints, 'fields'> & Readonly<{
  fields: readonly ActionFormFieldHint[];
}>;

/** Resolves visibility, required, and disabled state through the Protocol-owned Action form owner. */
export const resolveEffectiveActionInputFields: (
  spec: Pick<ActionSpec, 'inputHints'>,
  input: unknown,
) => readonly EffectiveActionInputField[] = canonicalResolveEffectiveActionInputFields;
/** Normalizes schema-admitted Action input through the Protocol-owned form owner. */
export const normalizeActionInputByFieldHints: (
  spec: Pick<ActionSpec, 'inputHints'>,
  input: Record<string, unknown>,
) => Record<string, unknown> = canonicalNormalizeActionInputByFieldHints;
/** Stable semantic identity for Action-form option values. */
export const actionInputOptionValueKey: (
  value: ActionInputOptionValue,
) => string = canonicalActionInputOptionValueKey;
/** Compares structured option values by their exact canonical ref, never object identity. */
export const isSameActionInputOptionValue: (
  left: ActionInputOptionValue,
  right: ActionInputOptionValue,
) => boolean = canonicalIsSameActionInputOptionValue;
/** Reads a draft/control option value through the Protocol's canonical strict schema. */
export const readActionInputOptionValue: (
  value: unknown,
) => ActionInputOptionValue | undefined = canonicalReadActionInputOptionValue;
