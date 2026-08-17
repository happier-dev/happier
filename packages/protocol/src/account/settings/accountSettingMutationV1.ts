import { z } from 'zod';

import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import {
  ACCOUNT_SETTING_DEFINITIONS,
  type AccountSettingKey,
  type AccountSettings,
  type AccountSettingsPersistedObject,
} from './accountSettings.js';
import {
  ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
  inspectAccountSettingJsonStructuralBounds,
  inspectAccountSettingValueBounds,
} from './catalog/accountSettingBounds.js';

export type AccountSettingsMutationInvalidReason =
  | 'unknownKey'
  | 'invalidValue'
  | 'duplicateKey'
  | 'tooLarge'
  | 'tooDeep';

export type AccountSettingsMutationResult =
  | Readonly<{ status: 'applied'; version: number; settings: AccountSettings }>
  | Readonly<{ status: 'satisfied'; version: number; settings: AccountSettings }>
  | Readonly<{ status: 'unchanged'; version: number; settings: AccountSettings }>
  | Readonly<{ status: 'conflict'; currentVersion: number }>
  | Readonly<{ status: 'outcomeUnknown'; lastKnownVersion: number }>
  | Readonly<{ status: 'cancelled'; submitted: false }>
  | Readonly<{
    status: 'locked';
    reason: 'encryptionMaterialUnavailable' | 'modeMismatch' | 'contentUnreadable';
  }>
  | Readonly<{ status: 'invalid'; reason: AccountSettingsMutationInvalidReason }>
  | Readonly<{ status: 'unavailable'; retryable: boolean }>;

const AccountSettingMutationOperationInputV1Schema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    key: z.string().min(1),
    value: StrictJsonValueSchema,
  }).strict(),
  z.object({
    op: z.literal('reset'),
    key: z.string().min(1),
  }).strict(),
]);

const AccountSettingMutationInputV1Schema = z.object({
  operations: z.array(AccountSettingMutationOperationInputV1Schema).min(1).max(64),
}).strict();

function isAccountSettingKey(value: string): value is AccountSettingKey {
  return Object.hasOwn(ACCOUNT_SETTING_DEFINITIONS, value);
}

const AccountSettingKeySchema = z.custom<AccountSettingKey>(
  (value) => typeof value === 'string' && isAccountSettingKey(value),
  'Unknown Account Setting key',
);

const AccountSettingMutationOperationV1Schema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    key: AccountSettingKeySchema,
    value: StrictJsonValueSchema,
  }).strict(),
  z.object({
    op: z.literal('reset'),
    key: AccountSettingKeySchema,
  }).strict(),
]);

export const AccountSettingMutationV1Schema = z.object({
  operations: z.array(AccountSettingMutationOperationV1Schema).min(1).max(64),
}).strict().superRefine(
  (mutation, context) => {
    const seen = new Set<string>();
    for (const [index, operation] of mutation.operations.entries()) {
      if (seen.has(operation.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index, 'key'],
          message: 'Duplicate Account Setting key',
        });
        continue;
      }
      seen.add(operation.key);
      if (operation.op === 'set') {
        const parsed = ACCOUNT_SETTING_DEFINITIONS[operation.key].parseMutationValue(operation.value);
        if (!parsed.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['operations', index, 'value'],
            message: 'Invalid Account Setting value',
          });
        }
      }
    }
  },
);

export type AccountSettingMutationV1 = z.infer<typeof AccountSettingMutationV1Schema>;

export type AccountSettingMutationApplicationV1 =
  | Readonly<{
    status: 'applied' | 'unchanged';
    raw: AccountSettingsPersistedObject;
  }>
  | Readonly<{
    status: 'invalid';
    reason: AccountSettingsMutationInvalidReason;
  }>;

function classifySettingValueIssues(messages: readonly string[]): AccountSettingsMutationInvalidReason {
  const normalizedMessages = messages.map((message) => message.toLowerCase());
  if (normalizedMessages.some((message) => (
    message.includes('nesting depth')
    || message.includes('depth limit')
  ))) return 'tooDeep';
  if (normalizedMessages.some((message) => (
    message.includes('serialized UTF-8 bytes')
    || message.includes('string larger')
    || message.includes('more than')
    || message.includes('too_big')
    || message.includes('string limit')
    || message.includes('key limit')
    || message.includes('node limit')
    || message.includes('aggregate byte limit')
  ))) {
    return 'tooLarge';
  }
  return 'invalidValue';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]));
}

function documentFits(raw: Readonly<Record<string, unknown>>): boolean {
  try {
    const serialized = JSON.stringify(raw);
    return serialized !== undefined
      && new TextEncoder().encode(serialized).byteLength <= ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES;
  } catch {
    return false;
  }
}

function inspectResultingRoots(
  raw: Readonly<Record<string, unknown>>,
): AccountSettingsMutationInvalidReason | null {
  for (const [key, value] of Object.entries(raw)) {
    const structuralIssue = inspectAccountSettingJsonStructuralBounds(value);
    if (structuralIssue) return structuralIssue.reason;
    if (isAccountSettingKey(key)) {
      const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
      if (!parsed.success) return classifySettingValueIssues(parsed.issues);
    }
  }
  return null;
}

function invalid(reason: AccountSettingsMutationInvalidReason): AccountSettingMutationApplicationV1 {
  return Object.freeze({ status: 'invalid', reason });
}

export function applyAccountSettingMutationV1(
  raw: Readonly<Record<string, unknown>>,
  mutationValue: unknown,
): AccountSettingMutationApplicationV1 {
  const mutation = AccountSettingMutationInputV1Schema.safeParse(mutationValue);
  if (!mutation.success) {
    return invalid(classifySettingValueIssues(mutation.error.issues.map((issue) => issue.message)));
  }

  const seen = new Set<string>();
  const next: Record<string, unknown> = { ...raw };
  for (const operation of mutation.data.operations) {
    if (!isAccountSettingKey(operation.key)) return invalid('unknownKey');
    if (seen.has(operation.key)) return invalid('duplicateKey');
    seen.add(operation.key);

    if (operation.op === 'reset') {
      delete next[operation.key];
      continue;
    }

    if (Object.hasOwn(raw, operation.key)) {
      const current = ACCOUNT_SETTING_DEFINITIONS[operation.key].parseMutationValue(raw[operation.key]);
      if (!current.success) {
        return invalid(classifySettingValueIssues(current.issues));
      }
    }

    const definition = ACCOUNT_SETTING_DEFINITIONS[operation.key];
    const boundIssue = inspectAccountSettingValueBounds(
      operation.value,
      definition.maximumSerializedValueBytes,
    );
    if (boundIssue) return invalid(boundIssue.reason);
    const parsedValue = definition.parseMutationValue(operation.value);
    if (!parsedValue.success) {
      return invalid(classifySettingValueIssues(parsedValue.issues));
    }
    next[operation.key] = parsedValue.data;
  }

  const resultingRootIssue = inspectResultingRoots(next);
  if (resultingRootIssue) return invalid(resultingRootIssue);
  if (!documentFits(next)) return invalid('tooLarge');
  const resultRaw = Object.freeze(next);
  return Object.freeze({
    status: valuesEqual(raw, resultRaw) ? 'unchanged' : 'applied',
    raw: resultRaw,
  });
}
