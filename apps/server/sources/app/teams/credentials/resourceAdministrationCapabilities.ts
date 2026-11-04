import { TeamCredentialResourceAdministrationCapabilitiesV1Schema, type TeamCredentialDeliveryPolicyV1, type TeamCredentialResourceAdministrationCapabilitiesV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';

type AdministrationCapabilityInput = Readonly<{
    resource: Readonly<{
        enabled: boolean;
        deliveryPolicy: TeamCredentialDeliveryPolicyV1;
    }>;
    isSourceCustodian: boolean;
    isQualifiedTeamManager: boolean;
    isQualifiedTeamMember: boolean;
}>;

/**
 * The one operation-specific administration projector consumed by both Team
 * administration and source-detail administration reads.
 *
 * Mutation leaves remain authoritative and repeat their currentness checks;
 * this projection is the truthful, least-privilege UI/API description of the
 * same roles, never an admission token.
 */
export function projectTeamCredentialResourceAdministrationCapabilities(
    input: AdministrationCapabilityInput,
): TeamCredentialResourceAdministrationCapabilitiesV1 {
    const manager = input.isQualifiedTeamManager;
    const custodian = input.isSourceCustodian;
    return TeamCredentialResourceAdministrationCapabilitiesV1Schema.parse({
        manageAudience: manager,
        managePolicy: manager,
        manageLimits: manager,
        updateBrokerPlacement: custodian,
        updateDeliveryPolicy: custodian,
        narrowDisclosure: custodian && input.resource.deliveryPolicy.preferredAllowedModes.some(route => route !== 'brokered'),
        widenDisclosure: custodian && !input.resource.deliveryPolicy.preferredAllowedModes.includes('direct'),
        refreshDirectMaterial: custodian
            && input.isQualifiedTeamMember
            && input.resource.enabled
            && input.resource.deliveryPolicy.preferredAllowedModes.includes('direct'),
        disable: input.resource.enabled && (manager || custodian),
        enable: !input.resource.enabled && manager,
        delete: manager || custodian,
    });
}
