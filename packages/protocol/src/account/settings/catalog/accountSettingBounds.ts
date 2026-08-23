import { z } from 'zod';

export const ACCOUNT_SETTING_MAX_STRING_BYTES = 64 * 1024;
export const ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES = 256;
export const ACCOUNT_SETTING_MAX_NESTING_DEPTH = 12;
export const ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES = 512 * 1024;

/**
 * The Account-owned persistence ceiling for the Provider settings root. Account
 * Settings owns the document envelope and this byte budget; the Provider schemas
 * own Provider semantics and cardinality inside it. The Provider limit owner
 * advertises this same number so a Provider-accepted write cannot exceed what the
 * Account document can persist.
 */
export const ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES = 256 * 1024;

/**
 * Who owns the *shape* inside an Account root.
 *
 * `accountGeneric` applies the Account document's own node/entry/depth policy,
 * which is the correct default for compatibility carriers with no domain owner.
 * `domainOwned` says a named domain schema already enforces the subtree's
 * cardinality and nesting, so re-imposing the generic node policy here would
 * reinterpret — and silently discard — a value that domain accepted. The Account
 * byte ceiling still applies in both cases.
 */
export type AccountSettingStructuralBoundsOwner = 'accountGeneric' | 'domainOwned';

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export type AccountSettingValueBoundIssue = Readonly<{
  reason: 'tooLarge' | 'tooDeep';
  message: string;
}>;

function validateJsonBounds(value: unknown, depth: number): AccountSettingValueBoundIssue | null {
  if (depth > ACCOUNT_SETTING_MAX_NESTING_DEPTH) {
    return {
      reason: 'tooDeep',
      message: `exceeds maximum nesting depth ${ACCOUNT_SETTING_MAX_NESTING_DEPTH}`,
    };
  }
  if (typeof value === 'string') {
    return utf8ByteLength(value) > ACCOUNT_SETTING_MAX_STRING_BYTES
      ? {
        reason: 'tooLarge',
        message: `contains a string larger than ${ACCOUNT_SETTING_MAX_STRING_BYTES} UTF-8 bytes`,
      }
      : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    if (value.length > ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES) {
      return {
        reason: 'tooLarge',
        message: `contains more than ${ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES} array entries`,
      };
    }
    for (const child of value) {
      const issue = validateJsonBounds(child, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES) {
    return {
      reason: 'tooLarge',
      message: `contains more than ${ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES} record entries`,
    };
  }
  for (const [key, child] of entries) {
    if (utf8ByteLength(key) > ACCOUNT_SETTING_MAX_STRING_BYTES) {
      return {
        reason: 'tooLarge',
        message: `contains a key larger than ${ACCOUNT_SETTING_MAX_STRING_BYTES} UTF-8 bytes`,
      };
    }
    const issue = validateJsonBounds(child, depth + 1);
    if (issue) return issue;
  }
  return null;
}

export function inspectAccountSettingJsonStructuralBounds(
  value: unknown,
): AccountSettingValueBoundIssue | null {
  return validateJsonBounds(value, 0);
}

export function inspectAccountSettingValueBounds(
  value: unknown,
  maximumSerializedValueBytes: number,
  structuralBoundsOwner: AccountSettingStructuralBoundsOwner = 'accountGeneric',
): AccountSettingValueBoundIssue | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized !== undefined && utf8ByteLength(serialized) > maximumSerializedValueBytes) {
    return {
      reason: 'tooLarge',
      message: `exceeds ${maximumSerializedValueBytes} serialized UTF-8 bytes`,
    };
  }
  if (structuralBoundsOwner === 'domainOwned') return null;
  return inspectAccountSettingJsonStructuralBounds(value);
}

/**
 * Adds the Account document's structural ceiling around a domain schema without changing the
 * domain schema's static input/output type. The per-key serialized ceiling avoids a single
 * compatibility root claiming the whole 512 KiB document budget.
 */
export function withAccountSettingBounds<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  maximumSerializedValueBytes: number,
  structuralBoundsOwner: AccountSettingStructuralBoundsOwner = 'accountGeneric',
): TSchema {
  return schema.superRefine((value, ctx) => {
    try {
      JSON.stringify(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be JSON serializable' });
      return;
    }
    const issue = inspectAccountSettingValueBounds(
      value,
      maximumSerializedValueBytes,
      structuralBoundsOwner,
    );
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message });
    }
  }) as TSchema;
}
