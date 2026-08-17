import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

/** The only dynamic Resource media type the transcript tail accepts. */
export const PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1 =
  'application/vnd.happier.transcript-activity+json;v=1';
export const PluginTranscriptActivityContentTypeV1Schema = z.literal(
  PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
);
export type PluginTranscriptActivityContentTypeV1 = z.infer<
  typeof PluginTranscriptActivityContentTypeV1Schema
>;

export const MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1 = 16;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1 = 4;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_CHECKLIST_ITEMS_V1 = 8;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1 = 280;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1 = 64 * 1024;

function boundedText(label: string) {
  return z.string().trim().min(1).superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} exceeds the ${MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1}-byte UTF-8 limit.`,
      });
    }
  });
}

/**
 * One static profile binds one same-plugin dynamic Resource and a closed Action
 * allowlist. The host owns all live tail placement and lifecycle.
 */
export const PluginTranscriptActivityContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  resourceId: asProtocolZod(PluginContributionLocalIdSchema),
  actions: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .max(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1)
    .default([])
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transcript activity actions must be unique.' });
      }
    }),
}).strict();
export type PluginTranscriptActivityContributionV1 = z.infer<
  typeof PluginTranscriptActivityContributionV1Schema
>;

const PluginTranscriptActivityChecklistItemV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  label: boundedText('Transcript activity checklist label'),
  state: z.enum(['pending', 'active', 'complete', 'failed']),
}).strict();

const PluginTranscriptActivityActionSnapshotV1Schema = z.object({
  actionId: asProtocolZod(PluginContributionLocalIdSchema),
  label: boundedText('Transcript activity action label').optional(),
}).strict();

export const PluginTranscriptActivitySnapshotV1Schema = z.object({
  localActivityId: asProtocolZod(PluginContributionLocalIdSchema),
  title: boundedText('Transcript activity title'),
  phase: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  status: boundedText('Transcript activity status').optional(),
  progress: z.object({
    completed: z.number().int().nonnegative().max(1_000_000),
    total: z.number().int().positive().max(1_000_000),
  }).strict().refine((value) => value.completed <= value.total, {
    message: 'Transcript activity progress completed must not exceed total.',
  }).optional(),
  checklist: z.array(PluginTranscriptActivityChecklistItemV1Schema)
    .max(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_CHECKLIST_ITEMS_V1)
    .default([]),
  dismissible: z.boolean().default(false),
  actions: z.array(PluginTranscriptActivityActionSnapshotV1Schema)
    .max(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1)
    .default([]),
}).strict().superRefine((value, ctx) => {
    if (value.phase === 'running' && value.dismissible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dismissible'],
        message: 'Only terminal transcript activities may be dismissible.',
      });
    }
    const checklistIds = new Set<string>();
    value.checklist.forEach((item, index) => {
      if (checklistIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checklist', index, 'id'],
          message: 'Transcript activity checklist ids must be unique per activity.',
        });
      }
      checklistIds.add(item.id);
    });
    const actionIds = new Set<string>();
    value.actions.forEach((action, index) => {
      if (actionIds.has(action.actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'actionId'],
          message: 'Transcript activity action ids must be unique per activity.',
        });
      }
      actionIds.add(action.actionId);
    });
});
export type PluginTranscriptActivitySnapshotV1 = z.infer<
  typeof PluginTranscriptActivitySnapshotV1Schema
>;

export const PluginTranscriptActivityResourceSnapshotV1Schema = z.object({
  version: z.literal(1),
  activities: z.array(PluginTranscriptActivitySnapshotV1Schema)
    .max(MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1)
    .superRefine((activities, ctx) => {
      const ids = new Set<string>();
      activities.forEach((activity, index) => {
        if (ids.has(activity.localActivityId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'localActivityId'],
            message: 'Transcript activity localActivityId must be unique per Resource snapshot.',
          });
        }
        ids.add(activity.localActivityId);
      });
    }),
}).strict();
export type PluginTranscriptActivityResourceSnapshotV1 = z.infer<
  typeof PluginTranscriptActivityResourceSnapshotV1Schema
>;

export function isPluginTranscriptActivityContentTypeV1(
  contentType: unknown,
): contentType is PluginTranscriptActivityContentTypeV1 {
  return PluginTranscriptActivityContentTypeV1Schema.safeParse(contentType).success;
}
