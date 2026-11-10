import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

/** The only dynamic Resource media type the transcript tail accepts. */
export const PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1 =
  'application/vnd.happier.transcript-activity+json;v=1';
export const PluginTranscriptActivityContentTypeV1Schema = lazyZodSchema(() => z.literal(
  PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
));
export type PluginTranscriptActivityContentTypeV1 = z.infer<
  typeof PluginTranscriptActivityContentTypeV1Schema
>;

export const MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1 = 16;
/** Concrete activity rows the host may render across all Resources in one Session tail. */
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_SESSION_TAIL_V1 = 16;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1 = 4;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_CHECKLIST_ITEMS_V1 = 8;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1 = 280;
export const MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1 = 64 * 1024;

function boundedText(label: string) {
  return z.string().check(z.trim(), z.minLength(1), z.superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1) {
      ctx.addIssue({
        code: "custom",
        message: `${label} exceeds the ${MAX_PLUGIN_TRANSCRIPT_ACTIVITY_TEXT_UTF8_BYTES_V1}-byte UTF-8 limit.`,
      });
    }
  }));
}

/**
 * One static profile binds one same-plugin dynamic Resource and a closed Action
 * allowlist. The host owns all live tail placement and lifecycle.
 */
export const PluginTranscriptActivityContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  resourceId: asProtocolZod(PluginContributionLocalIdSchema),
  actions: z._default(z.array(asProtocolZod(PluginContributionLocalIdSchema)).check(z.maxLength(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1)), []).check(z.superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", message: 'Transcript activity actions must be unique.' });
      }
    })),
}));
export type PluginTranscriptActivityContributionV1 = z.infer<
  typeof PluginTranscriptActivityContributionV1Schema
>;

const PluginTranscriptActivityChecklistItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  label: boundedText('Transcript activity checklist label'),
  state: z.enum(['pending', 'active', 'complete', 'failed']),
}));

const PluginTranscriptActivityActionSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: asProtocolZod(PluginContributionLocalIdSchema),
  label: z.optional(boundedText('Transcript activity action label')),
}));

export const PluginTranscriptActivitySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  localActivityId: asProtocolZod(PluginContributionLocalIdSchema),
  title: boundedText('Transcript activity title'),
  phase: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  status: z.optional(boundedText('Transcript activity status')),
  progress: z.optional(z.strictObject({
    completed: z.number().check(z.int(), z.nonnegative(), z.maximum(1_000_000)),
    total: z.number().check(z.int(), z.positive(), z.maximum(1_000_000)),
  }).check(z.refine((value) => value.completed <= value.total, {
    message: 'Transcript activity progress completed must not exceed total.',
  }))),
  checklist: z._default(z.array(PluginTranscriptActivityChecklistItemV1Schema).check(z.maxLength(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_CHECKLIST_ITEMS_V1)), []),
  dismissible: z._default(z.boolean(), false),
  actions: z._default(z.array(PluginTranscriptActivityActionSnapshotV1Schema).check(z.maxLength(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_ACTIONS_V1)), []),
}).check(z.superRefine((value, ctx) => {
    if (value.phase === 'running' && value.dismissible) {
      ctx.addIssue({
        code: "custom",
        path: ['dismissible'],
        message: 'Only terminal transcript activities may be dismissible.',
      });
    }
    const checklistIds = new Set<string>();
    value.checklist.forEach((item, index) => {
      if (checklistIds.has(item.id)) {
        ctx.addIssue({
          code: "custom",
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
          code: "custom",
          path: ['actions', index, 'actionId'],
          message: 'Transcript activity action ids must be unique per activity.',
        });
      }
      actionIds.add(action.actionId);
    });
})));
export type PluginTranscriptActivitySnapshotV1 = z.infer<
  typeof PluginTranscriptActivitySnapshotV1Schema
>;

export const PluginTranscriptActivityResourceSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  activities: z.array(PluginTranscriptActivitySnapshotV1Schema).check(z.maxLength(MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1), z.superRefine((activities, ctx) => {
      const ids = new Set<string>();
      activities.forEach((activity, index) => {
        if (ids.has(activity.localActivityId)) {
          ctx.addIssue({
            code: "custom",
            path: [index, 'localActivityId'],
            message: 'Transcript activity localActivityId must be unique per Resource snapshot.',
          });
        }
        ids.add(activity.localActivityId);
      });
    })),
}));
export type PluginTranscriptActivityResourceSnapshotV1 = z.infer<
  typeof PluginTranscriptActivityResourceSnapshotV1Schema
>;

export function isPluginTranscriptActivityContentTypeV1(
  contentType: unknown,
): contentType is PluginTranscriptActivityContentTypeV1 {
  return PluginTranscriptActivityContentTypeV1Schema.safeParse(contentType).success;
}
