import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginActionFailureResponseV1Schema } from '../actions/failureResponse.js';
import { ActionExecuteFailureSchema } from '../../actions/actionExecutionResult.js';

/** Presentation only: the Action's existing closed failure envelope owns the input. */
export const PluginUiPresentActionFailureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...ActionExecuteFailureSchema.shape,
  // Reuse the author vocabulary already admitted by the Action failure owner.
  message: PluginActionFailureResponseV1Schema.shape.message,
  remediation: PluginActionFailureResponseV1Schema.shape.remediation,
  // Code-only failures can still use the presenter's generic fallback.
  error: z.optional(ActionExecuteFailureSchema.shape.error),
}));
export type PluginUiActionFailureV1 = z.infer<typeof PluginUiPresentActionFailureRequestV1Schema>;
export const PluginUiActionFailurePresentationV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.string(),
  nextStep: z.nullable(z.string()),
  technicalDetails: z.array(z.strictObject({ key: z.string(), label: z.string(), value: z.string() })),
}));
export type PluginUiActionFailurePresentationV1 = z.infer<typeof PluginUiActionFailurePresentationV1Schema>;
