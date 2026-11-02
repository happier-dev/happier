import type { InputHintsDescriptor } from '../inputs/inputFields.js';
import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';
import { readInputPath } from '../inputs/inputPredicates.js';
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

export function readActionSecretInputPaths<TText>(spec: Readonly<{
  inputHints?: InputHintsDescriptor<TText> | null;
  secretInputPaths?: readonly string[];
}>, input: unknown, options?: Readonly<{ includeInactive?: boolean }>): readonly string[] {
  const declared = [...resolveEffectiveInputFields({ inputHints: spec.inputHints ?? undefined }, input)
    .filter(field => field.widget === 'secret' && !field.disabled
      && (field.required || readInputPath(input, field.path) !== undefined)).map(field => field.path),
    ...(spec.inputHints?.fields ?? []).filter(field => field.widget === 'secret'
      && (options?.includeInactive || readInputPath(input, field.path) !== undefined)).map(field => field.path),
    ...spec.secretInputPaths ?? []];
  return [...new Set(declared)];
}

export function readActionSecretInputAdmission<TText>(spec: Readonly<{
  inputHints?: InputHintsDescriptor<TText> | null;
  secretInputPaths?: readonly string[];
}>, input: unknown): Readonly<{ paths: readonly string[]; missingPaths: readonly string[] }> {
  const paths = readActionSecretInputPaths(spec, input);
  return { paths, missingPaths: paths.filter(path => readInputPath(input, path) === undefined) };
}

export function isMissingActionSecretInputError(error: Readonly<{
  issues: readonly Readonly<{ code: string; path: readonly PropertyKey[] }>[];
}>, input: unknown, missingPaths: readonly string[]): boolean {
  return error.issues.length > 0 && error.issues.every(issue => issue.code === 'invalid_type'
    && missingPaths.includes(issue.path.join('.')) && readInputPath(input, issue.path.join('.')) === undefined);
}

export function readMissingActionSecretInputPaths<TText>(spec: Readonly<{
  inputHints?: InputHintsDescriptor<TText> | null;
  secretInputPaths?: readonly string[];
}>, input: unknown): readonly string[] {
  return readActionSecretInputAdmission(spec, input).missingPaths;
}
