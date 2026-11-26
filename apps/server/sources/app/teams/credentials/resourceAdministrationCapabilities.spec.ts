import { describe, expect, it } from "vitest";

import { projectTeamCredentialResourceAdministrationCapabilities } from "./resourceAdministrationCapabilities";

describe("Team credential resource administration capabilities", () => {
    it("keeps manager and source-custodian authority distinct and unions both roles", () => {
        const resource = { enabled: true, deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] as ('brokered' | 'direct')[] } };

        expect(projectTeamCredentialResourceAdministrationCapabilities({
            resource,
            isSourceCustodian: true,
            isQualifiedTeamManager: false,
            isQualifiedTeamMember: true,
        })).toEqual({
            manageAudience: false,
            managePolicy: false,
            manageLimits: false,
            updateBrokerPlacement: true,
            updateDeliveryPolicy: true,
            narrowDisclosure: true,
            widenDisclosure: false,
            refreshDirectMaterial: true,
            disable: true,
            enable: false,
            delete: true,
        });

        expect(projectTeamCredentialResourceAdministrationCapabilities({
            resource,
            isSourceCustodian: false,
            isQualifiedTeamManager: true,
            isQualifiedTeamMember: true,
        })).toEqual({
            manageAudience: true,
            managePolicy: true,
            manageLimits: true,
            updateBrokerPlacement: false,
            updateDeliveryPolicy: false,
            narrowDisclosure: false,
            widenDisclosure: false,
            refreshDirectMaterial: false,
            disable: true,
            enable: false,
            delete: true,
        });

        expect(projectTeamCredentialResourceAdministrationCapabilities({
            resource,
            isSourceCustodian: true,
            isQualifiedTeamManager: true,
            isQualifiedTeamMember: true,
        })).toEqual({
            manageAudience: true,
            managePolicy: true,
            manageLimits: true,
            updateBrokerPlacement: true,
            updateDeliveryPolicy: true,
            narrowDisclosure: true,
            widenDisclosure: false,
            refreshDirectMaterial: true,
            disable: true,
            enable: false,
            delete: true,
        });
    });

    it("withdraws current-Team-only and state-inapplicable operations", () => {
        // A custodian outside current, qualified Team participation keeps only
        // withdrawal: no broker retargeting and no widening of route consent.
        expect(projectTeamCredentialResourceAdministrationCapabilities({
            resource: { enabled: false, deliveryPolicy: { preferredAllowedModes: ['brokered'] } },
            isSourceCustodian: true,
            isQualifiedTeamManager: false,
            isQualifiedTeamMember: false,
        })).toEqual({
            manageAudience: false,
            managePolicy: false,
            manageLimits: false,
            updateBrokerPlacement: false,
            updateDeliveryPolicy: true,
            narrowDisclosure: false,
            widenDisclosure: false,
            refreshDirectMaterial: false,
            disable: false,
            enable: false,
            delete: true,
        });

        expect(projectTeamCredentialResourceAdministrationCapabilities({
            resource: { enabled: false, deliveryPolicy: { preferredAllowedModes: ['brokered'] } },
            isSourceCustodian: false,
            isQualifiedTeamManager: true,
            isQualifiedTeamMember: true,
        })).toMatchObject({
            updateBrokerPlacement: false,
            narrowDisclosure: false,
            widenDisclosure: false,
            refreshDirectMaterial: false,
            disable: false,
            enable: true,
            delete: true,
        });
    });
});
