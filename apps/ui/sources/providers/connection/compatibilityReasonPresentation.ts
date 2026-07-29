import {
    ProviderCompatibilityReasonCodeV1Schema,
    type ProviderCompatibilityReasonCodeV1,
} from '@happier-dev/protocol';

import type { TranslationKeyNoParams } from '@/text';

const REASON_DESCRIPTION_KEYS = Object.freeze({
    no_compatible_protocol: 'settingsProviders.compatibility.reasons.noCompatibleProtocol',
    no_auth_unsupported: 'settingsProviders.compatibility.reasons.noAuthUnsupported',
    credential_transport_unavailable: 'settingsProviders.compatibility.reasons.credentialTransportUnavailable',
    optional_credential_no_auth_unsupported: 'settingsProviders.compatibility.reasons.optionalCredentialNoAuthUnsupported',
    capability_streaming_unsupported: 'settingsProviders.compatibility.reasons.capabilityUnsupported',
    capability_streaming_unknown: 'settingsProviders.compatibility.reasons.capabilityUnknown',
    capability_toolRoundTrips_unsupported: 'settingsProviders.compatibility.reasons.capabilityUnsupported',
    capability_toolRoundTrips_unknown: 'settingsProviders.compatibility.reasons.capabilityUnknown',
    capability_statefulResponses_unsupported: 'settingsProviders.compatibility.reasons.capabilityUnsupported',
    capability_statefulResponses_unknown: 'settingsProviders.compatibility.reasons.capabilityUnknown',
    capability_reasoningControls_unsupported: 'settingsProviders.compatibility.reasons.capabilityUnsupported',
    capability_reasoningControls_unknown: 'settingsProviders.compatibility.reasons.capabilityUnknown',
    model_required_for_capability_resolution: 'settingsProviders.compatibility.reasons.modelEvidenceRequired',
    model_capability_toolRoundTrips_unsupported: 'settingsProviders.compatibility.reasons.modelCapabilityUnsupported',
    model_capability_toolRoundTrips_unknown: 'settingsProviders.compatibility.reasons.modelCapabilityUnknown',
    model_capability_reasoningControls_unsupported: 'settingsProviders.compatibility.reasons.modelCapabilityUnsupported',
    model_capability_reasoningControls_unknown: 'settingsProviders.compatibility.reasons.modelCapabilityUnknown',
    compatibility_override_incompatible: 'settingsProviders.compatibility.reasons.overrideIncompatible',
    compatibility_override_experimental: 'settingsProviders.compatibility.reasons.overrideExperimental',
    compatibility_evidence_missing: 'settingsProviders.compatibility.reasons.evidenceMissing',
    model_capability_evidence_required: 'settingsProviders.compatibility.reasons.modelEvidenceRequired',
    agent_external_providers_unsupported: 'settingsProviders.compatibility.reasons.agentUnsupported',
    adapter_contract_invalid: 'settingsProviders.compatibility.reasons.adapterInvalid',
} satisfies Record<ProviderCompatibilityReasonCodeV1, TranslationKeyNoParams>);

const UNKNOWN_REASON_KEY: TranslationKeyNoParams = 'settingsProviders.compatibility.reasons.unknown';

export function presentProviderCompatibilityReason(input: unknown): Readonly<{
    descriptionKey: TranslationKeyNoParams;
    known: boolean;
}> {
    const parsed = ProviderCompatibilityReasonCodeV1Schema.safeParse(input);
    return parsed.success
        ? { descriptionKey: REASON_DESCRIPTION_KEYS[parsed.data], known: true }
        : { descriptionKey: UNKNOWN_REASON_KEY, known: false };
}

export function presentProviderCompatibilityReasons(
    inputs: readonly unknown[],
): readonly Readonly<{ descriptionKey: TranslationKeyNoParams; known: boolean }>[] {
    const seen = new Set<TranslationKeyNoParams>();
    return inputs.flatMap((input) => {
        const presentation = presentProviderCompatibilityReason(input);
        if (seen.has(presentation.descriptionKey)) return [];
        seen.add(presentation.descriptionKey);
        return [presentation];
    });
}
