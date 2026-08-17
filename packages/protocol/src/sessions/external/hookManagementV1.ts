import { z } from 'zod';

import { PluginDiagnosticDataV1Schema } from '../../daemon/pluginContributionIntrospection.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/**
 * `sessions.direct` is the deployed, fail-closed wire id retained by A12. Consumers must check
 * the server-enabled bit before exposing or executing these management actions.
 */
export const PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID = 'sessions.direct' as const;

export const PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS = 4;
export const PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES = 64;
export const PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES = 64 * 1024;
export const PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT = 50;
export const PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS = 50;
export const PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_DIAGNOSTICS = 32;
export const PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();
const BoundedIdSchema = z.string().trim().min(1).max(512);
const PreviewIdSchema = z.string().regex(
  /^hook-install-preview:v1:[0-9a-f]{64}$/u,
);
const PreviewBoundedIdSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\u0000'), 'must be NUL-free');
const PreviewNativeEventNameSchema = z.string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\u0000'), 'must be NUL-free');
const PreviewAbsolutePathSchema = z.string()
  .min(1)
  .refine((value) => !value.includes('\u0000'), 'must be NUL-free')
  .refine(
    (value) => textEncoder.encode(value).byteLength <= 4_096,
    'must contain at most 4,096 UTF-8 bytes',
  )
  .refine(
    (value) => (
      value.startsWith('/')
      || /^[A-Za-z]:[\\/]/u.test(value)
      || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
    ),
    'must be an absolute POSIX, drive, or UNC path',
  );
const PreviewCommandSchema = z.string()
  .min(1)
  .max(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES)
  .refine((value) => !value.includes('\u0000'), 'must be NUL-free');
const PreviewMatcherSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\u0000'), 'must be NUL-free');

const PluginSessionHookInstallPreviewChangeV1Schema = z.object({
  kind: z.literal('append_json_array_entry'),
  collectionId: PreviewBoundedIdSchema,
  eventId: PreviewBoundedIdSchema,
  nativeEventName: PreviewNativeEventNameSchema,
  entry: z.object({
    matcher: PreviewMatcherSchema.nullable(),
    hooks: z.tuple([
      z.object({
        type: z.literal('command'),
        command: PreviewCommandSchema,
        timeout: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      }).strict().readonly(),
    ]).readonly(),
  }).strict().readonly(),
}).strict().readonly();

const PluginSessionHookInstallPreviewTargetV1Schema = z.object({
  targetId: PreviewBoundedIdSchema,
  absolutePath: PreviewAbsolutePathSchema,
  changes: z.array(PluginSessionHookInstallPreviewChangeV1Schema)
    .min(1)
    .max(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES)
    .readonly(),
}).strict().readonly();

export const PluginSessionHookInstallPreviewV1Schema = z.object({
  previewId: PreviewIdSchema,
  targets: z.array(PluginSessionHookInstallPreviewTargetV1Schema)
    .min(1)
    .max(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS)
    .readonly(),
}).strict().superRefine((preview, context) => {
  const targetIds = new Set<string>();
  const absolutePaths = new Set<string>();
  const eventIds = new Set<string>();
  let totalChanges = 0;

  for (const [targetIndex, target] of preview.targets.entries()) {
    if (targetIds.has(target.targetId)) {
      context.addIssue({
        code: 'custom',
        path: ['targets', targetIndex, 'targetId'],
        message: 'Install-preview target ids must be unique',
      });
    }
    targetIds.add(target.targetId);

    if (absolutePaths.has(target.absolutePath)) {
      context.addIssue({
        code: 'custom',
        path: ['targets', targetIndex, 'absolutePath'],
        message: 'Install-preview target paths must be unique',
      });
    }
    absolutePaths.add(target.absolutePath);

    totalChanges += target.changes.length;
    for (const [changeIndex, change] of target.changes.entries()) {
      if (eventIds.has(change.eventId)) {
        context.addIssue({
          code: 'custom',
          path: ['targets', targetIndex, 'changes', changeIndex, 'eventId'],
          message: 'Install-preview event ids must be unique',
        });
      }
      eventIds.add(change.eventId);
    }
  }

  if (totalChanges > PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES) {
    context.addIssue({
      code: 'custom',
      path: ['targets'],
      message:
        `Install preview must contain at most `
        + `${PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES} total changes`,
    });
  }

  const serializedBytes = textEncoder.encode(JSON.stringify(preview)).byteLength;
  if (serializedBytes > PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES) {
    context.addIssue({
      code: 'custom',
      message:
        `Session-hook install preview exceeds `
        + `${PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes`,
    });
  }
}).readonly();
export type PluginSessionHookInstallPreviewV1 = z.infer<
  typeof PluginSessionHookInstallPreviewV1Schema
>;

const BoundedPluginContributionIdentityV1Schema =
  asProtocolZod(PluginContributionIdentityV1Schema).superRefine((identity, context) => {
    for (const [field, value] of [
      ['pluginId', identity.pluginId],
      ['localId', identity.localId],
    ] as const) {
      if (value.length > 512) {
        context.addIssue({
          code: 'too_big',
          maximum: 512,
          origin: 'string',
          inclusive: true,
          path: [field],
          message: `${field} must contain at most 512 code units`,
        });
      }
    }
  });

const PluginSessionHookContributionTargetFieldsV1 = {
  machineId: BoundedIdSchema,
  agent: BoundedPluginContributionIdentityV1Schema,
} as const;

const PluginSessionHookStatusPaginationFieldsV1 = {
  machineId: BoundedIdSchema,
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.number()
    .int()
    .min(1)
    .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)
    .default(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
} as const;

export const PluginSessionHookStatusInputV1Schema = z.discriminatedUnion(
  'intent',
  [
    z.object({
      ...PluginSessionHookStatusPaginationFieldsV1,
      intent: z.literal('passive_inventory'),
      agent: BoundedPluginContributionIdentityV1Schema.optional(),
    }).strict(),
    z.object({
      machineId: BoundedIdSchema,
      intent: z.literal('install_preview'),
      agent: BoundedPluginContributionIdentityV1Schema,
    }).strict(),
    z.object({
      machineId: BoundedIdSchema,
      intent: z.literal('installation_recheck'),
      agent: BoundedPluginContributionIdentityV1Schema,
      installationId: BoundedIdSchema,
    }).strict(),
  ],
);
export type PluginSessionHookStatusInputV1 = z.input<typeof PluginSessionHookStatusInputV1Schema>;

export const PluginSessionHookInstallInputV1Schema = z.object(
  {
    ...PluginSessionHookContributionTargetFieldsV1,
    expectedPreviewId: PreviewIdSchema,
  },
).strict();
export type PluginSessionHookInstallInputV1 = z.infer<typeof PluginSessionHookInstallInputV1Schema>;

export const PluginSessionHookInstallationMutationInputV1Schema = z.object({
  ...PluginSessionHookContributionTargetFieldsV1,
  installationId: BoundedIdSchema,
}).strict();
export type PluginSessionHookInstallationMutationInputV1 = z.infer<
  typeof PluginSessionHookInstallationMutationInputV1Schema
>;

const PluginSessionHookSemanticTargetFieldsV1 = {
  agent: BoundedPluginContributionIdentityV1Schema,
} as const;

/**
 * Canonical Action input. Machine routing is host authority and is present only
 * on the released daemon RPC carrier above.
 */
export const PluginSessionHookStatusActionInputV1Schema = z.discriminatedUnion(
  'intent',
  [
    z.object({
      intent: z.literal('passive_inventory'),
      agent: BoundedPluginContributionIdentityV1Schema.optional(),
      cursor: z.string().min(1).max(4_096).optional(),
      limit: z.number()
        .int()
        .min(1)
        .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)
        .default(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
    }).strict(),
    z.object({
      ...PluginSessionHookSemanticTargetFieldsV1,
      intent: z.literal('install_preview'),
    }).strict(),
    z.object({
      ...PluginSessionHookSemanticTargetFieldsV1,
      intent: z.literal('installation_recheck'),
      installationId: BoundedIdSchema,
    }).strict(),
  ],
);
export type PluginSessionHookStatusActionInputV1 = z.input<
  typeof PluginSessionHookStatusActionInputV1Schema
>;

export const PluginSessionHookInstallActionInputV1Schema = z.object({
  ...PluginSessionHookSemanticTargetFieldsV1,
  expectedPreviewId: PreviewIdSchema,
}).strict();
export type PluginSessionHookInstallActionInputV1 = z.infer<
  typeof PluginSessionHookInstallActionInputV1Schema
>;

export const PluginSessionHookInstallationMutationActionInputV1Schema = z.object({
  ...PluginSessionHookSemanticTargetFieldsV1,
  installationId: BoundedIdSchema,
}).strict();
export type PluginSessionHookInstallationMutationActionInputV1 = z.infer<
  typeof PluginSessionHookInstallationMutationActionInputV1Schema
>;

const PluginSessionHookNotInstalledStatusV1Schema = z.object({
  state: z.literal('not_installed'),
  installPreview: PluginSessionHookInstallPreviewV1Schema.optional(),
}).strict();

const PluginSessionHookMutationNotInstalledStatusV1Schema = z.object({
  state: z.literal('not_installed'),
}).strict();

const PluginSessionHookInstalledEnabledStatusV1Schema = z.object({
  state: z.literal('installed_enabled'),
  installationId: BoundedIdSchema,
}).strict();

const PluginSessionHookInstalledDisabledStatusV1Schema = z.object({
  state: z.literal('installed_disabled'),
  installationId: BoundedIdSchema,
}).strict();

const PluginSessionHookNeedsAttentionStatusV1Schema = z.object({
  state: z.literal('needs_attention'),
  installationId: BoundedIdSchema.optional(),
  diagnostic: PluginDiagnosticDataV1Schema,
}).strict();

const PluginSessionHookInstalledNeedsAttentionStatusV1Schema =
  PluginSessionHookNeedsAttentionStatusV1Schema.extend({
    installationId: BoundedIdSchema,
  }).strict();

const PluginSessionHookInstalledStatusV1Schema = z.discriminatedUnion('state', [
  PluginSessionHookInstalledEnabledStatusV1Schema,
  PluginSessionHookInstalledDisabledStatusV1Schema,
  PluginSessionHookInstalledNeedsAttentionStatusV1Schema,
]);

const PluginSessionHookUnsupportedStatusV1Schema = z.object({
  state: z.literal('unsupported'),
  reason: z.enum(['version_unsupported', 'installation_unsupported']),
}).strict();

const PluginSessionHookUnavailableStatusV1Schema = z.object({
  state: z.literal('unavailable'),
  installationId: BoundedIdSchema,
}).strict();

export const PluginSessionHookInstallationStatusV1Schema = z.discriminatedUnion('state', [
  PluginSessionHookNotInstalledStatusV1Schema,
  PluginSessionHookInstalledEnabledStatusV1Schema,
  PluginSessionHookInstalledDisabledStatusV1Schema,
  PluginSessionHookNeedsAttentionStatusV1Schema,
  PluginSessionHookUnsupportedStatusV1Schema,
  PluginSessionHookUnavailableStatusV1Schema,
]);
export type PluginSessionHookInstallationStatusV1 = z.infer<
  typeof PluginSessionHookInstallationStatusV1Schema
>;

export const PluginSessionHookStatusInventoryRowV1Schema = z.object({
  agent: BoundedPluginContributionIdentityV1Schema,
  status: PluginSessionHookInstallationStatusV1Schema,
}).strict();
export type PluginSessionHookStatusInventoryRowV1 = z.infer<
  typeof PluginSessionHookStatusInventoryRowV1Schema
>;

export const PluginSessionHookStatusInventoryDiagnosticV1Schema = z.object({
  code: z.enum([
    'installation_record_invalid',
    'installation_record_read_failed',
  ]),
  retryable: z.boolean(),
}).strict();
export type PluginSessionHookStatusInventoryDiagnosticV1 = z.infer<
  typeof PluginSessionHookStatusInventoryDiagnosticV1Schema
>;

export const PluginSessionHookManagementDiagnosticV1Schema = z.object({
  code: z.enum([
    'feature_disabled',
    'agent_unavailable',
    'installation_unsupported',
    'version_unsupported',
    'invalid_config',
    'concurrent_edit',
    'listener_unavailable',
    'permission_denied',
    'installation_replaced',
    'operation_failed',
  ]),
  retryable: z.boolean(),
}).strict();
export type PluginSessionHookManagementDiagnosticV1 = z.infer<
  typeof PluginSessionHookManagementDiagnosticV1Schema
>;

const PluginSessionHookManagementFailureV1Schema = z.object({
  ok: z.literal(false),
  diagnostic: PluginSessionHookManagementDiagnosticV1Schema,
}).strict();

export const PluginSessionHookStatusResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    rows: z.array(PluginSessionHookStatusInventoryRowV1Schema)
      .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS),
    nextCursor: z.string().min(1).max(4_096).nullable(),
    diagnostics: z.array(PluginSessionHookStatusInventoryDiagnosticV1Schema)
      .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_DIAGNOSTICS),
  }).strict(),
  PluginSessionHookManagementFailureV1Schema,
]).superRefine((response, context) => {
  const serializedBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  if (serializedBytes > PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES) {
    context.addIssue({
      code: 'custom',
      message:
        `Session-hook status inventory exceeds `
        + `${PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes`,
    });
  }
});
export type PluginSessionHookStatusResponseV1 = z.infer<typeof PluginSessionHookStatusResponseV1Schema>;

export const PluginSessionHookInstallResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: PluginSessionHookInstalledStatusV1Schema,
  }).strict(),
  PluginSessionHookManagementFailureV1Schema,
]);
export type PluginSessionHookInstallResponseV1 = z.infer<
  typeof PluginSessionHookInstallResponseV1Schema
>;

export const PluginSessionHookToggleResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: PluginSessionHookInstalledStatusV1Schema,
  }).strict(),
  PluginSessionHookManagementFailureV1Schema,
]);
export type PluginSessionHookToggleResponseV1 = z.infer<typeof PluginSessionHookToggleResponseV1Schema>;

export const PluginSessionHookUninstallResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: PluginSessionHookMutationNotInstalledStatusV1Schema,
  }).strict(),
  PluginSessionHookManagementFailureV1Schema,
]);
export type PluginSessionHookUninstallResponseV1 = z.infer<
  typeof PluginSessionHookUninstallResponseV1Schema
>;
