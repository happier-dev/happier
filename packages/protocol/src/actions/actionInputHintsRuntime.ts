/** Action defaults and validation remain domain-owned; field mechanics are shared. */
export {
  inputOptionValueKey as actionInputOptionValueKey,
  inputOptionValueSearchText as actionInputOptionValueSearchText,
  isSameInputOptionValue as isSameActionInputOptionValue,
  readInputOptionValue as readActionInputOptionValue,
  resolveEffectiveInputFields as resolveEffectiveActionInputFields,
  normalizeInputByFieldHints as normalizeActionInputByFieldHints,
  type EffectiveInputField as EffectiveActionInputField,
} from '../inputs/inputFieldRuntime.js';
export type {
  InputFieldHint as ActionInputFieldHint, InputHints as ActionInputHints,
  InputOption as ActionInputOption, InputOptionValue as ActionInputOptionValue,
} from '../inputs/inputFields.js';
export type { InputPredicate as ActionInputPredicate } from '../inputs/inputPredicates.js';
