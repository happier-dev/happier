import { z } from 'zod';

import { PluginIdSchema, PluginSourceSpecV1Schema } from '@happier-dev/protocol';

import { PluginCompatibilityDiagnosticSchema } from '@/plugins/validation/diagnostics/types';
import {
  createDefaultPluginAccessScopeRegistry,
  PluginAccessSelectionSchema,
} from './install/accessScopeRegistry';
import {
  PluginTrustRecordSchema,
  PluginCuratedUpdateSourceBindingSchema,
  PluginUpdatePolicySchema,
} from './install/trustIdentity';

export const PluginCompatibilityStatusSchema = z.enum(['unknown', 'compatible', 'incompatible', 'load_error']);
export type PluginCompatibilityStatus = z.infer<typeof PluginCompatibilityStatusSchema>;

export const PluginInstallModeSchema = z.enum(['link', 'managed_install']);
export type PluginInstallMode = z.infer<typeof PluginInstallModeSchema>;

export const PluginStateSourceRecordSchema = PluginSourceSpecV1Schema.safeExtend({
  resolvedPath: z.string().min(1),
  manifestPath: z.string().min(1),
  devWatch: z.boolean().optional(),
}).strict();
export type PluginStateSourceRecord = z.infer<typeof PluginStateSourceRecordSchema>;

export const PluginStateCompatibilityRecordSchema = z.object({
  status: PluginCompatibilityStatusSchema,
  checkedAtMs: z.number().int().nonnegative().optional(),
  diagnostics: z.array(PluginCompatibilityDiagnosticSchema).default([]),
}).strict();
export type PluginStateCompatibilityRecord = z.infer<typeof PluginStateCompatibilityRecordSchema>;

export const PluginStateInstallRecordSchema = z.object({
  mode: PluginInstallModeSchema,
  manifestVersion: z.string().min(1),
  installedPath: z.string().min(1).nullable().optional(),
  trust: PluginTrustRecordSchema.optional(),
  updatePolicy: PluginUpdatePolicySchema.optional(),
  /** Present only for reviewed curated automatic-update channels. */
  curatedUpdateSource: PluginCuratedUpdateSourceBindingSchema.optional(),
  optionalAccess: z.array(PluginAccessSelectionSchema).optional(),
}).strict();
export type PluginStateInstallRecord = z.infer<typeof PluginStateInstallRecordSchema>;

export const PluginStateLifecycleRecordSchema = z.object({
  enabled: z.boolean(),
  lastLoadedAtMs: z.number().int().nonnegative().optional(),
  lastError: z.string().min(1).nullable().optional(),
}).strict();
export type PluginStateLifecycleRecord = z.infer<typeof PluginStateLifecycleRecordSchema>;

export const PluginStateRecordSchema = z.object({
  source: PluginStateSourceRecordSchema,
  compatibility: PluginStateCompatibilityRecordSchema,
  install: PluginStateInstallRecordSchema,
  state: PluginStateLifecycleRecordSchema,
}).strict();
export type PluginStateRecord = z.infer<typeof PluginStateRecordSchema>;

const PluginStateFileV1BaseSchema = z.object({
  t: z.literal('happier_plugin_state_v1'),
  schemaVersion: z.literal(1),
  plugins: z.record(z.string().superRefine((value, context) => {
    const parsed = PluginIdSchema.safeParse(value);
    if (!parsed.success || parsed.data !== value) {
      context.addIssue({ code: 'custom', message: 'Expected a canonical plugin id' });
    }
  }), PluginStateRecordSchema),
}).strict();

const pluginAccessScopeRegistry = createDefaultPluginAccessScopeRegistry();

export const PluginStateFileV1Schema = PluginStateFileV1BaseSchema.superRefine((state, context) => {
  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (record.install.trust && record.install.trust.pluginId !== pluginId) {
      context.addIssue({
        code: 'custom',
        path: ['plugins', pluginId, 'install', 'trust', 'pluginId'],
        message: 'Plugin trust identity must match its installed-state plugin id',
      });
    }
    const accessIds = new Set<string>();
    for (const [index, selection] of (record.install.optionalAccess ?? []).entries()) {
      if (selection.pluginId !== pluginId || !pluginAccessScopeRegistry.validateSelection(selection)) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', pluginId, 'install', 'optionalAccess', index],
          message: 'Invalid canonical plugin optional access selection',
        });
      }
      if (accessIds.has(selection.accessId)) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', pluginId, 'install', 'optionalAccess', index, 'accessId'],
          message: 'Duplicate plugin optional access selection id',
        });
      }
      accessIds.add(selection.accessId);
    }
  }
});
export type PluginStateFileV1 = z.infer<typeof PluginStateFileV1Schema>;

export { resolvePluginStorePaths } from './paths';
