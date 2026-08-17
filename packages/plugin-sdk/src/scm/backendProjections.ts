import {
    ScmBackendCapabilitiesSchema as canonicalScmBackendCapabilitiesSchema,
    ScmBackendContributionSchema as canonicalScmBackendContributionSchema,
    createScmCapabilitiesFromBackendCapabilities as canonicalCreateScmCapabilitiesFromBackendCapabilities,
    mapGitScmErrorCode as canonicalMapGitScmErrorCode,
    mapSaplingScmErrorCode as canonicalMapSaplingScmErrorCode,
    supportedCapability as canonicalSupportedCapability,
    unsupportedCapability as canonicalUnsupportedCapability,
} from '@happier-dev/protocol/scm';

import type {
    ScmBackendCapabilities,
    ScmBackendCapabilityLeaf,
    ScmBackendCapabilityUnavailableReason,
    ScmBackendContribution,
} from './backend.js';
import type {
    ScmCapabilities,
    ScmOperationErrorCode,
} from './projections.js';

/** Canonical Protocol validators with SDK-local declaration contracts. */
export const ScmBackendCapabilitiesSchema: {
    parse(value: unknown): ScmBackendCapabilities;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmBackendCapabilities }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmBackendCapabilitiesSchema;
export const ScmBackendContributionSchema: {
    parse(value: unknown): ScmBackendContribution;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmBackendContribution }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmBackendContributionSchema;

export const createScmCapabilitiesFromBackendCapabilities: (
    input: ScmBackendCapabilities,
    overrides?: Partial<ScmCapabilities>,
) => ScmCapabilities = canonicalCreateScmCapabilitiesFromBackendCapabilities;

export const mapGitScmErrorCode: (stderr: string) => ScmOperationErrorCode =
    canonicalMapGitScmErrorCode;
export const mapSaplingScmErrorCode: (stderr: string) => ScmOperationErrorCode =
    canonicalMapSaplingScmErrorCode;
export const supportedCapability: () => ScmBackendCapabilityLeaf = canonicalSupportedCapability;
export const unsupportedCapability: (
    reason?: ScmBackendCapabilityUnavailableReason,
) => ScmBackendCapabilityLeaf = canonicalUnsupportedCapability;
