import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { BrowserExtensionIdV1Schema, BrowserExtensionSourceV1Schema, BrowserExtensionPermissionReviewV1Schema,
  BrowserExtensionRecordV1Schema } from '../browser/profile/extensionsV1.js';
import { BrowserCommandDispatchResultV1Schema, BrowserOpenViewCommandV1Schema } from '../browser/control/v1.js';
import { RegistryProvenanceV1Schema } from '../registries/registryItemsV1.js';
import type { BrowserExtensionActionIdV1 } from './actionIds.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const target = { machineId: Id, profileId: Id };
const extensionTarget = { ...target, extensionId: BrowserExtensionIdV1Schema };

export const BrowserProfileExtensionV1Schema = lazyZodSchema(() => z.strictObject({
  profileId: Id, extension: BrowserExtensionRecordV1Schema, restartRequired: z.boolean(),
}));
export type BrowserProfileExtensionV1 = z.infer<typeof BrowserProfileExtensionV1Schema>;

export const BrowserExtensionsListInputV1Schema = lazyZodSchema(() => z.strictObject({ machineId: Id, profileId: z.optional(Id) }));
export const BrowserExtensionInstallInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target,
  source: BrowserExtensionSourceV1Schema,
  reviewedPermissions: z.optional(BrowserExtensionPermissionReviewV1Schema),
  expectedVersion: z.optional(Id),
  provenance: z.optional(RegistryProvenanceV1Schema),
  restartConfirmed: z.optional(z.boolean()),
}));
export const BrowserExtensionMutationInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...extensionTarget, restartConfirmed: z.optional(z.boolean()),
}));
export const BrowserExtensionUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ ...extensionTarget,
  expectedVersion: Id,
  reviewedPermissions: z.optional(BrowserExtensionPermissionReviewV1Schema),
  restartConfirmed: z.optional(z.boolean()),
}));
export const BrowserExtensionOpenInputV1Schema = lazyZodSchema(() => z.strictObject({ ...extensionTarget,
  commandId: BrowserOpenViewCommandV1Schema.shape.commandId,
  browserSessionId: BrowserOpenViewCommandV1Schema.shape.browserSessionId,
  viewId: BrowserOpenViewCommandV1Schema.shape.viewId,
}));

export const BrowserExtensionUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('unavailable'),
  code: z.enum(['managed_browser_required', 'persistent_profile_required', 'extension_not_found', 'extension_disabled',
    'missing_popup', 'missing_options', 'source_unavailable', 'invalid_manifest', 'unsupported_manifest', 'permission_denied', 'canceled',
    'version_changed', 'profile_not_found', 'profile_unavailable', 'restart_failed']),
  message: z.optional(Id),
}));
export const BrowserExtensionsListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), entries: z.array(BrowserProfileExtensionV1Schema) }),
  BrowserExtensionUnavailableV1Schema,
]));
export type BrowserExtensionsListResultV1 = z.infer<typeof BrowserExtensionsListResultV1Schema>;
export const BrowserExtensionMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), entry: BrowserProfileExtensionV1Schema, restartRequired: z.literal(true) }),
  z.strictObject({ status: z.literal('removed'), profileId: Id, extensionId: BrowserExtensionIdV1Schema, restartRequired: z.literal(true) }),
  z.strictObject({ status: z.literal('needs_review'), review: BrowserExtensionPermissionReviewV1Schema,
    restartRequired: z.optional(z.literal(true)) }),
  z.strictObject({ status: z.literal('needs_restart_confirmation'), profileId: Id }),
  BrowserExtensionUnavailableV1Schema,
]));
export const BrowserExtensionOpenResultV1Schema = lazyZodSchema(() => z.union([
  BrowserCommandDispatchResultV1Schema, BrowserExtensionUnavailableV1Schema,
]));
export const BrowserExtensionActionResultV1Schema = lazyZodSchema(() => z.union([
  BrowserExtensionsListResultV1Schema, BrowserExtensionMutationResultV1Schema, BrowserExtensionOpenResultV1Schema,
]));
export type BrowserExtensionActionResultV1 = z.infer<typeof BrowserExtensionActionResultV1Schema>;
export type BrowserExtensionActionInputV1 = z.infer<typeof BrowserExtensionsListInputV1Schema>
  | z.infer<typeof BrowserExtensionInstallInputV1Schema> | z.infer<typeof BrowserExtensionMutationInputV1Schema>
  | z.infer<typeof BrowserExtensionOpenInputV1Schema> | z.infer<typeof BrowserExtensionUpdateInputV1Schema>;

export const BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS = {
  'browser.extensions.list': BrowserExtensionsListInputV1Schema,
  'browser.extensions.install': BrowserExtensionInstallInputV1Schema,
  'browser.extensions.update': BrowserExtensionUpdateInputV1Schema,
  'browser.extensions.enable': BrowserExtensionMutationInputV1Schema,
  'browser.extensions.disable': BrowserExtensionMutationInputV1Schema,
  'browser.extensions.remove': BrowserExtensionMutationInputV1Schema,
  'browser.extensions.openActionPopup': BrowserExtensionOpenInputV1Schema,
  'browser.extensions.openOptions': BrowserExtensionOpenInputV1Schema,
} as const satisfies Readonly<Record<BrowserExtensionActionIdV1, z.ZodMiniType>>;
export const BROWSER_EXTENSION_ACTION_OUTPUT_SCHEMAS = {
  'browser.extensions.list': BrowserExtensionsListResultV1Schema,
  'browser.extensions.install': BrowserExtensionMutationResultV1Schema,
  'browser.extensions.update': BrowserExtensionMutationResultV1Schema,
  'browser.extensions.enable': BrowserExtensionMutationResultV1Schema,
  'browser.extensions.disable': BrowserExtensionMutationResultV1Schema,
  'browser.extensions.remove': BrowserExtensionMutationResultV1Schema,
  'browser.extensions.openActionPopup': BrowserExtensionOpenResultV1Schema,
  'browser.extensions.openOptions': BrowserExtensionOpenResultV1Schema,
} as const satisfies Readonly<Record<BrowserExtensionActionIdV1, z.ZodMiniType>>;
