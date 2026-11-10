import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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
const BoundedIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));
const PreviewIdSchema = lazyZodSchema(() => z.string().check(z.regex(/^hook-install-preview:v1:[0-9a-f]{64}$/u)));
const PreviewBoundedIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512), z.refine((value) => !value.includes('\u0000'), 'must be NUL-free')));
const PreviewNativeEventNameSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128), z.refine((value) => !value.includes('\u0000'), 'must be NUL-free')));
const PreviewAbsolutePathSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine((value) => !value.includes('\u0000'), 'must be NUL-free'), z.refine((value) => textEncoder.encode(value).byteLength <= 4_096, 'must contain at most 4,096 UTF-8 bytes'), z.refine((value) => (
      value.startsWith('/')
      || /^[A-Za-z]:[\\/]/u.test(value)
      || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
    ), 'must be an absolute POSIX, drive, or UNC path')));
const PreviewCommandSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES), z.refine((value) => !value.includes('\u0000'), 'must be NUL-free')));
const PreviewMatcherSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512), z.refine((value) => !value.includes('\u0000'), 'must be NUL-free')));

const PluginSessionHookInstallPreviewChangeV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  kind: z.literal('append_json_array_entry'),
  collectionId: PreviewBoundedIdSchema,
  eventId: PreviewBoundedIdSchema,
  nativeEventName: PreviewNativeEventNameSchema,
  entry: z.readonly(z.strictObject({
    matcher: z.nullable(PreviewMatcherSchema),
    hooks: z.readonly(z.tuple([
      z.readonly(z.strictObject({
        type: z.literal('command'),
        command: PreviewCommandSchema,
        timeout: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
      })),
    ])),
  })),
})));

const PluginSessionHookInstallPreviewTargetV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  targetId: PreviewBoundedIdSchema,
  absolutePath: PreviewAbsolutePathSchema,
  changes: z.readonly(z.array(PluginSessionHookInstallPreviewChangeV1Schema).check(z.minLength(1), z.maxLength(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES))),
})));

export const PluginSessionHookInstallPreviewV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  previewId: PreviewIdSchema,
  targets: z.readonly(z.array(PluginSessionHookInstallPreviewTargetV1Schema).check(z.minLength(1), z.maxLength(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS))),
}).check(z.superRefine((preview, context) => {
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
}))));
export type PluginSessionHookInstallPreviewV1 = z.infer<
  typeof PluginSessionHookInstallPreviewV1Schema
>;

const BoundedPluginContributionIdentityV1Schema =
  // The canonical identity owner already caps each ASCII field at 256 units.
  asProtocolZod(PluginContributionIdentityV1Schema);

const PluginSessionHookContributionTargetFieldsV1 = {
  machineId: BoundedIdSchema,
  agent: BoundedPluginContributionIdentityV1Schema,
} as const;

const PluginSessionHookStatusPaginationFieldsV1 = {
  machineId: BoundedIdSchema,
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)), PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
} as const;

export const PluginSessionHookStatusInputV1Schema = lazyZodSchema(() => z.discriminatedUnion(
  'intent',
  [
    z.strictObject({
      ...PluginSessionHookStatusPaginationFieldsV1,
      intent: z.literal('passive_inventory'),
      agent: zMini.optional(BoundedPluginContributionIdentityV1Schema),
    }),
    z.strictObject({
      machineId: BoundedIdSchema,
      intent: z.literal('install_preview'),
      agent: BoundedPluginContributionIdentityV1Schema,
    }),
    z.strictObject({
      machineId: BoundedIdSchema,
      intent: z.literal('installation_recheck'),
      agent: BoundedPluginContributionIdentityV1Schema,
      installationId: BoundedIdSchema,
    }),
  ],
));
export type PluginSessionHookStatusInputV1 = z.input<typeof PluginSessionHookStatusInputV1Schema>;

export const PluginSessionHookInstallInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...PluginSessionHookContributionTargetFieldsV1,
    expectedPreviewId: PreviewIdSchema,
  }));
export type PluginSessionHookInstallInputV1 = z.infer<typeof PluginSessionHookInstallInputV1Schema>;

export const PluginSessionHookInstallationMutationInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...PluginSessionHookContributionTargetFieldsV1,
  installationId: BoundedIdSchema,
}));
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
export const PluginSessionHookStatusActionInputV1Schema = lazyZodSchema(() => z.discriminatedUnion(
  'intent',
  [
    z.strictObject({
      intent: z.literal('passive_inventory'),
      agent: zMini.optional(BoundedPluginContributionIdentityV1Schema),
      cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
      limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)), PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
    }),
    z.strictObject({
      ...PluginSessionHookSemanticTargetFieldsV1,
      intent: z.literal('install_preview'),
    }),
    z.strictObject({
      ...PluginSessionHookSemanticTargetFieldsV1,
      intent: z.literal('installation_recheck'),
      installationId: BoundedIdSchema,
    }),
  ],
));
export type PluginSessionHookStatusActionInputV1 = z.input<
  typeof PluginSessionHookStatusActionInputV1Schema
>;

export const PluginSessionHookInstallActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...PluginSessionHookSemanticTargetFieldsV1,
  expectedPreviewId: PreviewIdSchema,
}));
export type PluginSessionHookInstallActionInputV1 = z.infer<
  typeof PluginSessionHookInstallActionInputV1Schema
>;

export const PluginSessionHookInstallationMutationActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...PluginSessionHookSemanticTargetFieldsV1,
  installationId: BoundedIdSchema,
}));
export type PluginSessionHookInstallationMutationActionInputV1 = z.infer<
  typeof PluginSessionHookInstallationMutationActionInputV1Schema
>;

const PluginSessionHookNotInstalledStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('not_installed'),
  installPreview: z.optional(PluginSessionHookInstallPreviewV1Schema),
}));

const PluginSessionHookMutationNotInstalledStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('not_installed'),
}));

const PluginSessionHookInstalledEnabledStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('installed_enabled'),
  installationId: BoundedIdSchema,
}));

const PluginSessionHookInstalledDisabledStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('installed_disabled'),
  installationId: BoundedIdSchema,
}));

const PluginSessionHookNeedsAttentionStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('needs_attention'),
  installationId: z.optional(BoundedIdSchema),
  diagnostic: PluginDiagnosticDataV1Schema,
}));

const PluginSessionHookInstalledNeedsAttentionStatusV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSessionHookNeedsAttentionStatusV1Schema, {
    installationId: BoundedIdSchema,
  })));

const PluginSessionHookInstalledStatusV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  PluginSessionHookInstalledEnabledStatusV1Schema,
  PluginSessionHookInstalledDisabledStatusV1Schema,
  PluginSessionHookInstalledNeedsAttentionStatusV1Schema,
]));

const PluginSessionHookUnsupportedStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('unsupported'),
  reason: z.enum(['version_unsupported', 'installation_unsupported']),
}));

const PluginSessionHookUnavailableStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('unavailable'),
  installationId: BoundedIdSchema,
}));

export const PluginSessionHookInstallationStatusV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  PluginSessionHookNotInstalledStatusV1Schema,
  PluginSessionHookInstalledEnabledStatusV1Schema,
  PluginSessionHookInstalledDisabledStatusV1Schema,
  PluginSessionHookNeedsAttentionStatusV1Schema,
  PluginSessionHookUnsupportedStatusV1Schema,
  PluginSessionHookUnavailableStatusV1Schema,
]));
export type PluginSessionHookInstallationStatusV1 = z.infer<
  typeof PluginSessionHookInstallationStatusV1Schema
>;

export const PluginSessionHookStatusInventoryRowV1Schema = lazyZodSchema(() => z.strictObject({
  agent: BoundedPluginContributionIdentityV1Schema,
  status: PluginSessionHookInstallationStatusV1Schema,
}));
export type PluginSessionHookStatusInventoryRowV1 = z.infer<
  typeof PluginSessionHookStatusInventoryRowV1Schema
>;

export const PluginSessionHookStatusInventoryDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.enum([
    'installation_record_invalid',
    'installation_record_read_failed',
  ]),
  retryable: z.boolean(),
}));
export type PluginSessionHookStatusInventoryDiagnosticV1 = z.infer<
  typeof PluginSessionHookStatusInventoryDiagnosticV1Schema
>;

export const PluginSessionHookManagementDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
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
}));
export type PluginSessionHookManagementDiagnosticV1 = z.infer<
  typeof PluginSessionHookManagementDiagnosticV1Schema
>;

const PluginSessionHookManagementFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  diagnostic: PluginSessionHookManagementDiagnosticV1Schema,
}));

export const PluginSessionHookStatusResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    rows: z.array(PluginSessionHookStatusInventoryRowV1Schema).check(z.maxLength(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)),
    nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(4_096))),
    diagnostics: z.array(PluginSessionHookStatusInventoryDiagnosticV1Schema).check(z.maxLength(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_DIAGNOSTICS)),
  }),
  PluginSessionHookManagementFailureV1Schema,
]).check(z.superRefine((response, context) => {
  const serializedBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  if (serializedBytes > PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES) {
    context.addIssue({
      code: 'custom',
      message:
        `Session-hook status inventory exceeds `
        + `${PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes`,
    });
  }
})));
export type PluginSessionHookStatusResponseV1 = z.infer<typeof PluginSessionHookStatusResponseV1Schema>;

export const PluginSessionHookInstallResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: PluginSessionHookInstalledStatusV1Schema,
  }),
  PluginSessionHookManagementFailureV1Schema,
]));
export type PluginSessionHookInstallResponseV1 = z.infer<
  typeof PluginSessionHookInstallResponseV1Schema
>;

export const PluginSessionHookToggleResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: PluginSessionHookInstalledStatusV1Schema,
  }),
  PluginSessionHookManagementFailureV1Schema,
]));
export type PluginSessionHookToggleResponseV1 = z.infer<typeof PluginSessionHookToggleResponseV1Schema>;

export const PluginSessionHookUninstallResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: PluginSessionHookMutationNotInstalledStatusV1Schema,
  }),
  PluginSessionHookManagementFailureV1Schema,
]));
export type PluginSessionHookUninstallResponseV1 = z.infer<
  typeof PluginSessionHookUninstallResponseV1Schema
>;
