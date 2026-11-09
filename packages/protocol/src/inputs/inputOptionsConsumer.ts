import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { WorkflowDefinitionRefV1StringSchema } from '../workflows/workflowDefinitionRefV1.js';
import { WidgetDefinitionRefV1Schema, WidgetSurfaceRefV1Schema } from '../widgets/widgetInstanceV1.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedSessionAddressV1.js';

/** References to real consuming descriptors, never caller-authored field/schema bags. */
export const InputOptionsConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workflow'), workflow: WorkflowDefinitionRefV1StringSchema }),
  z.strictObject({ kind: z.literal('widget'), surface: WidgetSurfaceRefV1Schema, definition: WidgetDefinitionRefV1Schema,
    selectedSession: z.optional(VoiceTrackedSessionAddressV1Schema) }),
]));
export type InputOptionsConsumerV1 = z.infer<typeof InputOptionsConsumerV1Schema>;

export function inputOptionsConsumerActionId(consumer: InputOptionsConsumerV1) {
  return consumer.kind === 'workflow' ? 'workflow.run.start' as const : 'widgets.catalog.list' as const;
}
