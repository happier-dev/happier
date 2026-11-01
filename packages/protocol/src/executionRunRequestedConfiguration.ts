import { z } from 'zod';

import type { AcpConfigOptionOverridesV1 } from './sessionMetadata/metadataOverridesV1.js';
import { lazySchema } from './lazySchema.js';

/**
 * Privacy-bounded echo of the launch configuration accepted by an execution-run host.
 * This is requested configuration, not proof of what the provider ultimately realized.
 */
export const ExecutionRunRequestedConfigurationSchema = lazySchema(() => z.object({
  modelId: z.string().trim().min(1).max(1000).optional(),
  reasoningEffort: z.string().trim().min(1).max(1000).optional(),
}).refine(
  (value) => value.modelId !== undefined || value.reasoningEffort !== undefined,
  { message: 'requested configuration must contain at least one projected field' },
));
export type ExecutionRunRequestedConfiguration = z.infer<typeof ExecutionRunRequestedConfigurationSchema>;

function readBoundedNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 1000 ? normalized : undefined;
}

export function projectExecutionRunRequestedConfiguration(params: Readonly<{
  modelId?: string;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
}>): ExecutionRunRequestedConfiguration | undefined {
  const modelId = readBoundedNonEmptyString(params.modelId);
  const reasoningEffort = readBoundedNonEmptyString(
    params.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value,
  );
  if (modelId === undefined && reasoningEffort === undefined) return undefined;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}
