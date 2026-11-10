import { z } from '../../zodRuntimePolicy.js';

import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { RunnerConsentDisplayFactsV1Schema, RunnerCredentialSelectionBindingV1Schema } from '../../ephemeralRunner/review.js';
import { TeamCredentialProviderModelSelectionV1Schema } from './resourceV1.js';
import { SessionTeamCredentialBindingRejectionV1Schema } from './sessionBindingV1.js';

export const RunnerCredentialSelectionResolutionRequestV1Schema = z.strictObject({
  v: z.literal(1),
  selection: TeamCredentialProviderModelSelectionV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  plannedSession: z.strictObject({
    primaryTeamId: z.nullable(z.string().check(z.minLength(1))),
    teamVisibilityTeamIds: z.array(z.string().check(z.minLength(1))).check(z.maxLength(128)),
  }),
}).check(z.superRefine((value, context) => {
  if (value.selection.agentTargetKey !== value.application.agentTargetKey) {
    context.addIssue({
      code: "custom",
      path: ['application', 'agentTargetKey'],
      message: 'Application must target the reviewed Agent',
    });
  }
}));
export type RunnerCredentialSelectionResolutionRequestV1 = z.infer<
  typeof RunnerCredentialSelectionResolutionRequestV1Schema
>;

export const RunnerCredentialSelectionResolutionUnavailableReasonV1Schema = z.union([
  SessionTeamCredentialBindingRejectionV1Schema,
  z.enum([
    'activation_unavailable',
    'activation_conflict',
    'application_unavailable',
    'model_unavailable',
    'source_changed',
  ]),
]);
export type RunnerCredentialSelectionResolutionUnavailableReasonV1 = z.infer<
  typeof RunnerCredentialSelectionResolutionUnavailableReasonV1Schema
>;

export const RunnerCredentialSelectionResolutionResponseV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    v: z.literal(1),
    status: z.literal('resolved'),
    credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
    displayFacts: RunnerConsentDisplayFactsV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    status: z.literal('unavailable'),
    reason: RunnerCredentialSelectionResolutionUnavailableReasonV1Schema,
  }),
]);
export type RunnerCredentialSelectionResolutionResponseV1 = z.infer<
  typeof RunnerCredentialSelectionResolutionResponseV1Schema
>;
