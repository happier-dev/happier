import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import type { AcpConfigOptionOverridesV1 } from '../../sessions/metadata/metadataOverridesV1.js';
import { PersonalSessionModelRefSchema, type PersonalSessionModelRef } from '../../providers/selection/v2.js';
import { TeamCredentialProviderModelSelectionV1Schema, type TeamCredentialProviderModelSelectionV1 } from '../../teams/credentials/resourceV1.js';
import { ConnectedServiceBindingsV2Schema, type ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';

/** Safe projection of the host-admitted child choice, never an input or a credential materialization. */
export const ExecutionRunResolvedSelectionSchema = lazyZodSchema(() => z.strictObject({
  source: z.enum(['inherited', 'explicit', 'independent', 'retained']),
  modelSelection: z.optional(PersonalSessionModelRefSchema),
  teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
  modelId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(1000))),
  connectedServices: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)),
}).check(z.superRefine((value, context) => {
  if (value.modelSelection && value.teamCredentialModel) {
    context.addIssue({ code: 'custom', message: 'Resolved model selections must not compete' });
  }
  const selectedModelId = value.modelSelection?.modelId ?? value.teamCredentialModel?.modelId;
  if (selectedModelId && value.modelId !== undefined && selectedModelId !== value.modelId) {
    context.addIssue({ code: 'custom', path: ['modelId'], message: 'Resolved model id must match its selection' });
  }
})));
export type ExecutionRunResolvedSelection = z.infer<typeof ExecutionRunResolvedSelectionSchema>;

export function projectExecutionRunResolvedSelection(params: Readonly<{
  source?: ExecutionRunResolvedSelection['source'];
  modelSelection?: PersonalSessionModelRef;
  teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
  modelId?: string;
  connectedServices?: ConnectedServiceBindingsV2 | null;
}>): ExecutionRunResolvedSelection | undefined {
  if (params.source === undefined) return undefined;
  const parsed = ExecutionRunResolvedSelectionSchema.safeParse({
    source: params.source,
    ...(params.modelSelection !== undefined ? { modelSelection: params.modelSelection } : {}),
    ...(params.teamCredentialModel !== undefined ? { teamCredentialModel: params.teamCredentialModel } : {}),
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Privacy-bounded echo of the launch configuration accepted by an execution-run host.
 * This is requested configuration, not proof of what the provider ultimately realized.
 */
export const ExecutionRunRequestedConfigurationSchema = lazyZodSchema(() => z.object({
  modelId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(1000))),
  reasoningEffort: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(1000))),
}).check(z.refine((value) => value.modelId !== undefined || value.reasoningEffort !== undefined, { message: 'requested configuration must contain at least one projected field' })));
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
