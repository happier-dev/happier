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

const CONFIDENTIAL_ARRAY_ELEMENT = '[]';
const CONFIDENTIAL_DESCENDANT = '**';

/** `[]` matches one element; `**` matches zero or more descendant segments. */
export function matchesConfidentialInputPath(secret: readonly string[], path: readonly string[]): boolean {
  if (!secret.includes(CONFIDENTIAL_DESCENDANT)) return secret.length === path.length
    && secret.every((segment, index) => segment === CONFIDENTIAL_ARRAY_ELEMENT || segment === path[index]);
  let reachable = [true];
  for (const segment of secret) reachable.push(segment === CONFIDENTIAL_DESCENDANT && reachable[reachable.length - 1] === true);
  for (const segment of path) {
    const next = [false];
    for (const [index, expected] of secret.entries()) {
      next.push(expected === CONFIDENTIAL_DESCENDANT
        ? next[index] === true || reachable[index + 1] === true
        : reachable[index] === true && (expected === CONFIDENTIAL_ARRAY_ELEMENT || expected === segment));
    }
    reachable = next;
  }
  return reachable[secret.length] === true;
}

/** Redaction patterns describe values that exist and cannot name a required field. */
function isConfidentialInputPathPattern(path: string): boolean {
  return path.split('.').some(segment => segment === CONFIDENTIAL_ARRAY_ELEMENT || segment === CONFIDENTIAL_DESCENDANT);
}

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
  return { paths, missingPaths: paths.filter(path => !isConfidentialInputPathPattern(path) && readInputPath(input, path) === undefined) };
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
