import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';

/** Shared Run lifecycle vocabulary, independent of progress/definition and collection graphs. */
export const WORKFLOW_RUN_STATES_V1 = [
  ...AutomationRunStateV3Schema.options,
  'pause_requested', 'paused', 'interrupted', 'waiting_for_review',
] as const;
export const WorkflowRunStateV1Schema = lazyZodSchema(() => z.enum(WORKFLOW_RUN_STATES_V1));
export type WorkflowRunStateV1 = z.infer<typeof WorkflowRunStateV1Schema>;
