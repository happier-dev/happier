import { containsProviderRegisteredSensitiveValue } from '@happier-dev/protocol/providers/sensitive-value-redaction';

export type ProviderValidationIssue = Readonly<{ path: string; code: string }>;
// Pydantic's structural validation categories; arbitrary provider messages are excluded.
const VALIDATION_CODES = new Set([
  'extra_forbidden', 'missing', 'string_type', 'string_pattern_mismatch', 'string_too_long',
  'string_too_short', 'literal_error', 'enum', 'int_type', 'int_parsing', 'float_type',
  'float_parsing', 'bool_type', 'bool_parsing', 'list_type', 'dict_type', 'model_type',
  'greater_than', 'greater_than_equal', 'less_than', 'less_than_equal', 'too_long', 'too_short',
]);

export function projectProviderValidationIssues(value: unknown): readonly ProviderValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) => {
    if (!issue || typeof issue !== 'object' || !('path' in issue) || !('code' in issue)
      || typeof issue.path !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(issue.path)
      || typeof issue.code !== 'string' || !VALIDATION_CODES.has(issue.code)) return [];
    return [{ path: issue.path, code: issue.code }];
  });
}

export function readProviderValidationIssues(value: unknown, credentials: readonly string[]): readonly ProviderValidationIssue[] {
  if (!value || typeof value !== 'object' || !('detail' in value) || !Array.isArray(value.detail)) return [];
  const issues = value.detail.flatMap((issue: unknown) => {
    if (!issue || typeof issue !== 'object' || !('loc' in issue) || !Array.isArray(issue.loc)
      || !issue.loc.every((part: unknown) => typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part)))
      || !('type' in issue)) return [];
    return [{ path: issue.loc.join('.'), code: issue.type }];
  });
  return projectProviderValidationIssues(issues).filter(issue =>
    !containsProviderRegisteredSensitiveValue(JSON.stringify(issue), credentials));
}
