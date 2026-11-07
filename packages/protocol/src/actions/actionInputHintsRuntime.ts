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

import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import type { InputHintsDescriptor } from '../inputs/inputFields.js';

/** Required or supplied confidential operands; includeInactive retains every declaration for redaction. */
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

export function readMissingActionSecretInputPaths<TText>(spec: Readonly<{
  inputHints?: InputHintsDescriptor<TText> | null;
  secretInputPaths?: readonly string[];
}>, input: unknown): readonly string[] {
  return readActionSecretInputAdmission(spec, input).missingPaths;
}

/** One admission fact: optional absence never requests confidential input. */
export function readActionSecretInputAdmission<TText>(spec: Readonly<{
  inputHints?: InputHintsDescriptor<TText> | null;
  secretInputPaths?: readonly string[];
}>, input: unknown): Readonly<{ paths: readonly string[]; missingPaths: readonly string[] }> {
  const paths = readActionSecretInputPaths(spec, input);
  return { paths, missingPaths: paths.filter(path => readInputPath(input, path) === undefined) };
}

/** Missing confidential leaves may defer; every other schema error remains an admission failure. */
type SecretInputIssue = Readonly<{
  code: string;
  path: readonly PropertyKey[];
  errors?: readonly (readonly SecretInputIssue[])[];
}>;
export function isMissingActionSecretInputError(error: Readonly<{
  issues: readonly SecretInputIssue[];
}>, input: unknown, missingPaths: readonly string[]): boolean {
  const onlyMissingSecrets = (issues: readonly SecretInputIssue[], parent: readonly PropertyKey[]): boolean =>
    issues.length > 0 && issues.every(issue => {
      const path = [...parent, ...issue.path];
      // A union can be completed when one complete branch lacks only declared
      // confidential leaves. Errors in its other alternatives are irrelevant.
      if (issue.code === 'invalid_union') return issue.errors?.some(branch => onlyMissingSecrets(branch, path)) === true;
      const inputPath = path.join('.');
      return issue.code === 'invalid_type' && missingPaths.includes(inputPath)
        && readInputPath(input, inputPath) === undefined;
    });
  return onlyMissingSecrets(error.issues, []);
}
