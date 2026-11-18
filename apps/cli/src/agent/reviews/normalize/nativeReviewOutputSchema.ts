import { zodSchemaToJsonSchemaObject, forEachJsonSchemaChild } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { ReviewModelFindingSchema } from '@happier-dev/protocol/reviews/ReviewFinding';
import { ReviewModelOutputV1Schema } from '@happier-dev/protocol/reviews/reviewModelOutputV1';
import { ReviewFollowUpV1Schema } from '@happier-dev/protocol/messages/structured/reviewFollowUpV1';
import { ReviewQuestionSchema } from '@happier-dev/protocol/reviews/ReviewQuestion';
import { ReviewAssumptionSchema } from '@happier-dev/protocol/reviews/ReviewAssumption';
import { z } from '@happier-dev/protocol/zodRuntimePolicy';

import { ReviewFollowUpIntentInputSchema } from '../followUp/reviewFollowUpIntentInput';

/** Native strict-output contracts encode absent optional properties as null. */
function closeNativeOutputSchema(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const fields = properties as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, field] of Object.entries(fields)) {
      if (!required.has(key)) fields[key] = { anyOf: [field, { type: 'null' }] };
    }
    schema.required = Object.keys(fields);
    schema.additionalProperties = false;
  }
  forEachJsonSchemaChild(schema, closeNativeOutputSchema);
}

export function buildNativeReviewOutputSchema(intentInput: unknown): PluginJsonSchemaV2 {
  const finding = ReviewModelFindingSchema;
  const questions = z.array(z.strictObject(ReviewQuestionSchema.shape));
  const assumptions = z.array(z.strictObject(ReviewAssumptionSchema.shape));
  const model = ReviewFollowUpIntentInputSchema.safeParse(intentInput).success
    ? z.strictObject({ answerMarkdown: ReviewFollowUpV1Schema.shape.answerMarkdown,
      updatedFindings: z.optional(z.array(finding)), questions: z.optional(questions), assumptions: z.optional(assumptions) })
    : ReviewModelOutputV1Schema;
  const schema = zodSchemaToJsonSchemaObject(model, { target: 'draft-7' });
  closeNativeOutputSchema(schema);
  return normalizePluginJsonSchema(schema);
}
