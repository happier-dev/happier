import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SavedSecretPasskeySourceV1Schema } from '../../account/settings/savedSecretPasskeySourceV1.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const BrowserLoginSourceV1Schema = lazyZodSchema(() => z.strictObject({
  browser: z.enum(['firefox', 'chromium', 'safari']), profileId: Id,
}));
const destination = { machineId: Id, browserSessionId: Id, viewId: Id, profileId: Id };

/** Public operands contain selection metadata only. Cookie/key material is never an Action input. */
export const BrowserProfileLoginsImportV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...destination, kind: z.literal('cookies'), sourceMachineId: Id,
    source: z.optional(BrowserLoginSourceV1Schema), sites: z.array(z.url()) }),
  z.strictObject({ ...destination, kind: z.literal('passkeys'), refs: z.array(Id) }),
]));
export type BrowserProfileLoginsImportV1 = z.infer<typeof BrowserProfileLoginsImportV1Schema>;

export const BrowserCookieV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string(), value: z.string(), domain: Id, path: Id,
  secure: z.boolean(), httpOnly: z.boolean(),
  expires: z.optional(z.number()), sameSite: z.optional(z.enum(['None', 'Lax', 'Strict'])),
}));
export type BrowserCookieV1 = z.infer<typeof BrowserCookieV1Schema>;

export const BrowserLoginImportFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  'source_unavailable', 'source_locked', 'permission_denied', 'source_format_unsupported',
  'partition_unsupported', 'expired', 'destination_unavailable', 'profile_mismatch',
  'engine_unsupported', 'import_failed', 'import_unknown', 'passkey_import_unavailable', 'canceled',
  // Windows Chrome 127+ binds cookie keys to Chrome itself; Happier does not circumvent it.
  'app_bound_encryption',
]));
export type BrowserLoginImportFailureCodeV1 = z.infer<typeof BrowserLoginImportFailureCodeV1Schema>;
export const BrowserLoginImportRecordV1Schema = lazyZodSchema(() => z.strictObject({
  domain: z.string(), name: z.string(), status: z.enum(['imported', 'skipped', 'failed']),
  code: z.optional(BrowserLoginImportFailureCodeV1Schema),
  reason: z.optional(z.literal('this passkey tracks a usage counter')),
}));
export type BrowserLoginImportRecordV1 = z.infer<typeof BrowserLoginImportRecordV1Schema>;
export const BrowserProfileLoginsImportResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), records: z.array(BrowserLoginImportRecordV1Schema) }),
  z.strictObject({ status: z.literal('needs_source') }),
  z.strictObject({ status: z.literal('unavailable'), code: BrowserLoginImportFailureCodeV1Schema }),
]));
export type BrowserProfileLoginsImportResultV1 = z.infer<typeof BrowserProfileLoginsImportResultV1Schema>;

export const BrowserCookieSourceReadV1Schema = lazyZodSchema(() => z.strictObject({
  source: BrowserLoginSourceV1Schema, sites: z.array(z.url()),
}));
export const BrowserCookieSourceResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), cookies: z.array(BrowserCookieV1Schema),
    skipped: z.array(BrowserLoginImportRecordV1Schema) }),
  z.strictObject({ status: z.literal('unavailable'), code: BrowserLoginImportFailureCodeV1Schema }),
]));
export type BrowserCookieSourceResultV1 = z.infer<typeof BrowserCookieSourceResultV1Schema>;
/** Private Machine RPC operand only; never public Action arguments/history. */
export const BrowserCookieApplyV1Schema = lazyZodSchema(() => z.strictObject({
  browserSessionId: Id, viewId: Id, profileId: Id, cookies: z.array(BrowserCookieV1Schema),
}));

/** Private, Account-mode protected Machine RPC operand after the shared import Action admission. */
export const BrowserPasskeysApplyV1Schema = lazyZodSchema(() => z.strictObject({
  browserSessionId: Id, viewId: Id, profileId: Id, credentials: z.array(SavedSecretPasskeySourceV1Schema),
}));
export type BrowserPasskeysApplyV1 = z.infer<typeof BrowserPasskeysApplyV1Schema>;

export const BrowserLoginSourcesResultV1Schema = lazyZodSchema(() => z.strictObject({
  sources: z.array(z.strictObject({ ...BrowserLoginSourceV1Schema.shape, label: z.string() })),
  unsupported: z.array(z.strictObject({ browser: z.enum(['firefox', 'chromium', 'safari']),
    code: BrowserLoginImportFailureCodeV1Schema })),
}));
