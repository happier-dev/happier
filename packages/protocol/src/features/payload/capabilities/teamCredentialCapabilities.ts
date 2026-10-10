import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import {
  TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1,
  TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1,
} from '../../../teams/credentials/externalProviderApiV1.js';
import { TeamCredentialRequestProtocolKindV1Schema } from '../../../teams/credentials/resourceV1.js';
import { readServerEnabledBit } from '../../serverEnabledBit.js';
import type { FeatureId } from '../../catalog.js';
import type { FeaturesResponse } from '../../../features.js';

export const TeamCredentialExternalApiUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'feature_disabled',
  'home_not_public_https',
  'deployment_readiness_unavailable',
]));
export type TeamCredentialExternalApiUnavailableReasonV1 = z.infer<
  typeof TeamCredentialExternalApiUnavailableReasonV1Schema
>;

const ExternalProviderApiBaseUrlV1Schema = lazyZodSchema(() => z.string().trim().min(1).superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'External Provider API base URL must be valid.' });
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'External Provider API base URL must be public HTTPS.' });
  }
  if (!parsed.pathname.endsWith(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'External Provider API base URL has the wrong route.' });
  }
}));

export const TeamCredentialExternalApiAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    baseUrl: ExternalProviderApiBaseUrlV1Schema,
    protocols: z.array(TeamCredentialRequestProtocolKindV1Schema)
      .length(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1.length)
      .superRefine((protocols, context) => {
        if (protocols.some((protocol, index) => protocol !== TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1[index])) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'External Provider API protocols are not canonical.' });
        }
      }),
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: TeamCredentialExternalApiUnavailableReasonV1Schema,
  }).strict(),
]));
export type TeamCredentialExternalApiAvailabilityV1 = z.infer<
  typeof TeamCredentialExternalApiAvailabilityV1Schema
>;

export const TeamCredentialCapabilitiesSchema = lazyZodSchema(() => z.object({
  credentialResources: z.object({
    externalApi: TeamCredentialExternalApiAvailabilityV1Schema,
  }).strict(),
}).strict());
export type TeamCredentialCapabilities = z.infer<typeof TeamCredentialCapabilitiesSchema>;

const UNAVAILABLE_DEPLOYMENT_READINESS = Object.freeze({
  available: false as const,
  reason: 'deployment_readiness_unavailable' as const,
});

/**
 * One fail-closed operation decision shared by server admission and clients.
 * The feature bit remains the capability gate; deployment details can only
 * narrow it and never make a disabled or malformed feature usable.
 */
export function resolveTeamCredentialExternalApiAvailability(
  payload: FeaturesResponse,
): TeamCredentialExternalApiAvailabilityV1 {
  if (readServerEnabledBit(payload, 'teams.credentialResources.externalApi') !== true) {
    return { available: false, reason: 'feature_disabled' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return UNAVAILABLE_DEPLOYMENT_READINESS;
  const capabilities = Reflect.get(payload, 'capabilities');
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return UNAVAILABLE_DEPLOYMENT_READINESS;
  }
  const teams = Reflect.get(capabilities, 'teams');
  const credentialResources = teams && typeof teams === 'object' && !Array.isArray(teams)
    ? Reflect.get(teams, 'credentialResources')
    : null;
  const candidate = credentialResources && typeof credentialResources === 'object' && !Array.isArray(credentialResources)
    ? Reflect.get(credentialResources, 'externalApi')
    : null;
  const parsed = TeamCredentialExternalApiAvailabilityV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : UNAVAILABLE_DEPLOYMENT_READINESS;
}

/**
 * Whether this exact Home can actually serve the operations a feature switches
 * on. A bit says the capability is enabled; the external Provider API is only
 * usable when the Home also publishes its public-HTTPS readiness, so hosts that
 * advertise or admit that family compose this one decision instead of reading
 * the bit alone. Families without a deployment readiness answer `true`.
 */
export function isServerFeatureOperationReady(
  payload: FeaturesResponse,
  featureId: FeatureId,
): boolean {
  if (featureId !== 'teams.credentialResources.externalApi') return true;
  return resolveTeamCredentialExternalApiAvailability(payload).available;
}
