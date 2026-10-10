import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { IrohEndpointDescriptorV1Schema } from '../../connectivity/iroh/endpointDescriptorV1.js';
import { RunnerCredentialSelectionBindingV1Schema } from '../../ephemeralRunner/review.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { TeamCredentialUsageLimitMetricV1Schema } from './usageV1.js';

export {
  createRunnerBrokerReadinessSigningInputV1,
  IrohRunnerBrokerReadinessHandshakeV1Schema,
  RunnerBrokerReadinessFactsV1Schema,
  RunnerBrokerReadinessRequestV1Schema,
  signRunnerBrokerReadinessRequestV1,
  verifyRunnerBrokerReadinessRequestV1,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';
export type {
  IrohRunnerBrokerReadinessHandshakeV1,
  RunnerBrokerReadinessFactsV1,
  RunnerBrokerReadinessRequestV1,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';
import {
  RunnerBrokerReadinessFactsV1Schema,
  type RunnerBrokerReadinessRequestV1 as RunnerBrokerReadinessRequest,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';

export const RunnerBrokerProviderPresentationV1Schema = lazyZodSchema(() => z.object({
  identity: asProtocolZod(PluginContributionIdentityV1Schema),
  definitionRevision: z.literal(1),
}).strict());

/** Safe, content-free readiness reported by the credential-resource owner. */
export const TeamCredentialResourceReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available') }).strict(),
  z.object({ kind: z.literal('resource_corrupt') }).strict(),
  z.object({ kind: z.literal('resource_unavailable') }).strict(),
  z.object({ kind: z.literal('source_unavailable') }).strict(),
  z.object({ kind: z.literal('broker_unavailable') }).strict(),
  z.object({ kind: z.literal('update_required') }).strict(),
  z.object({ kind: z.literal('policy_denied') }).strict(),
  z.object({
    kind: z.literal('limit_reached'),
    // The one metric vocabulary: the limit owner decides with it, the catalog
    // read copies the denial's metric into this readiness, and the picker
    // labels it. A second spelling here makes the whole catalog entry throw.
    metric: TeamCredentialUsageLimitMetricV1Schema,
    resetsAtUtc: z.string().datetime(),
  }).strict(),
]));
export type TeamCredentialResourceReadinessV1 = z.infer<typeof TeamCredentialResourceReadinessV1Schema>;

const RunnerBrokerReadinessResponseBindingV1Schema = lazyZodSchema(() => RunnerBrokerReadinessFactsV1Schema.omit({
  v: true,
  kind: true,
}));

export const RunnerBrokerReadinessResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  binding: RunnerBrokerReadinessResponseBindingV1Schema,
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  readiness: TeamCredentialResourceReadinessV1Schema,
}).strict().superRefine((value, context) => {
  const selection = value.credentialSelectionBinding;
  if (
    selection.resourceId !== value.binding.resourceId
    || selection.brokerMachineId !== value.binding.target.machineId
    || selection.application.agentTargetKey !== value.binding.agentTargetKey
    || selection.application.protocol !== value.binding.protocol
  ) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['credentialSelectionBinding'],
    message: 'Reviewed credential selection must match readiness facts',
  });
}));
export type RunnerBrokerReadinessResponseV1 = z.infer<typeof RunnerBrokerReadinessResponseV1Schema>;

/**
 * Keeps every readiness consumer bound to the exact signed request facts. The
 * response schema already binds the reviewed credential selection to these
 * facts; this check prevents a valid response for another activation or
 * transport endpoint from being substituted by an intermediary.
 */
export function doesRunnerBrokerReadinessResponseMatchRequestV1(
  request: RunnerBrokerReadinessRequest,
  response: RunnerBrokerReadinessResponseV1,
): boolean {
  const binding = response.binding;
  return binding.homeServerIdentityId === request.homeServerIdentityId
    && binding.activationId === request.activationId
    && binding.launchManifestCommitment === request.launchManifestCommitment
    && binding.resourceId === request.resourceId
    && binding.agentTargetKey === request.agentTargetKey
    && binding.modelId === request.modelId
    && binding.protocol === request.protocol
    && binding.initiator.installationId === request.initiator.installationId
    && binding.initiator.endpointId === request.initiator.endpointId
    && binding.target.machineId === request.target.machineId
    && binding.target.endpointId === request.target.endpointId;
}

/** Exact content-free broker projection returned only to the proof-bound endpoint. */
export const RunnerBrokerReadinessProjectionV1Schema = lazyZodSchema(() => z.object({
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  target: IrohEndpointDescriptorV1Schema,
  provider: RunnerBrokerProviderPresentationV1Schema.nullable(),
  readiness: TeamCredentialResourceReadinessV1Schema,
}).strict());
export type RunnerBrokerReadinessProjectionV1 = z.infer<typeof RunnerBrokerReadinessProjectionV1Schema>;
