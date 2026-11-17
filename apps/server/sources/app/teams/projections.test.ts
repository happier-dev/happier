import { describe, expect, it } from "vitest";
import { NO_TEAM_CAPABILITIES_V1, TeamSummaryV1Schema } from "@happier-dev/protocol/teams";

import { projectTeamSummaryV1, type TeamRecord } from "./projections";

describe("Team managed defaults audience", () => {
    it.each(["guest", "member", "admin", "owner"] as const)("projects Team defaults for the %s audience", (viewerRole) => {
        const managedDefaults = { team: { permissionModeByAgentTargetKey: { "agent:example.agent/example": "read-only" as const } }, groups: {} };
        const homeDefaults = { permissionModeByAgentTargetKey: { "agent:example.agent/example": "default" as const } };
        const capabilities = { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true };
        const membership = { viewerJoinedAt: 1700000000000, hasSetup: true };
        const summary = projectTeamSummaryV1({
            ...membership,
            team: {
                id: "team", name: "Team", description: null, logo: null, archivedAt: null,
                sessionCreationPolicy: "private_default", externalSharingPolicy: "allowed",
                defaultSessionHistoryAccess: "from_membership", admissionMode: "invite_only",
                authenticationPolicy: null, managedDefaults,
            },
            viewerRole, capabilities, teamCapabilities: capabilities, ownerRequired: false,
            homeAuthority: { manageAllTeams: false }, homeDefaults,
            counts: { members: 4, suspendedMembers: 0, groups: 0, archivedGroups: 0, waitingInvitations: 0 },
        });
        expect(summary.policy.managedDefaults).toEqual(viewerRole === "guest" ? null : managedDefaults);
        expect(summary.policy.homeDefaults).toEqual(homeDefaults);
        expect(summary).toMatchObject(membership);
        expect(TeamSummaryV1Schema.parse(summary)).toEqual(summary);
    });

    it("withholds managed defaults from a safe summary when Team reading is denied", () => {
        const team: TeamRecord = {
            id: "team", name: "Team", description: null, logo: null, archivedAt: null,
            sessionCreationPolicy: "private_default", externalSharingPolicy: "allowed",
            defaultSessionHistoryAccess: "from_membership", admissionMode: "invite_only",
            authenticationPolicy: null,
            managedDefaults: { team: { permissionModeByAgentTargetKey: { "agent:example.agent/example": "read-only" } }, groups: {} },
        };
        const summary = projectTeamSummaryV1({
            team, viewerRole: "member", capabilities: NO_TEAM_CAPABILITIES_V1,
            teamCapabilities: NO_TEAM_CAPABILITIES_V1, ownerRequired: false,
            homeAuthority: { manageAllTeams: false },
            counts: { members: 1, suspendedMembers: 0, groups: 0, archivedGroups: 0, waitingInvitations: 0 },
        });
        expect(summary.id).toBe(team.id);
        expect(summary.policy.managedDefaults).toBeNull();
        expect(summary.managedDefaultsGroupIds).toEqual([]);
        expect(summary).toMatchObject({ viewerJoinedAt: null, hasSetup: null });
        expect(TeamSummaryV1Schema.parse(summary)).toEqual(summary);
    });
});
