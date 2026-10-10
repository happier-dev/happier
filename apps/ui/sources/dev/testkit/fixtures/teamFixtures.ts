import {
    NO_TEAM_CAPABILITIES_V1,
    NO_TEAM_GROUP_CAPABILITIES_V1,
    NO_TEAM_MEMBERSHIP_CAPABILITIES_V1,
    resolveTeamAdmissionProjectionV1,
    type TeamCapabilitiesV1,
    type TeamCredentialResourceSummaryV1,
    type TeamCredentialSourceResourceAdministrationV1,
    type TeamCredentialSourceCandidateV1,
    type TeamCredentialViewerCapabilitiesV1,
    type TeamGroupMemberV1,
    type TeamGroupV1,
    type TeamInvitationRowV1,
    type TeamMembershipV1,
    type TeamPolicyV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';

import { accountDisplayProfileFixture } from './homeGovernanceFixtures';

/**
 * The Team answers the Team destination suites share.
 *
 * They are the shapes a Home actually returns, so they travel through the same
 * strict schemas the app parses: a contract change fails these suites instead of
 * being absorbed by a per-file literal that quietly drifted away from it.
 *
 * Capabilities start denied and are granted explicitly by each case, because a
 * fixture that granted everything by default would hide exactly the bug these
 * screens must not have — a control rendered from a role rather than from the
 * server's own projection.
 */
export function teamPolicyFixture(overrides?: Partial<TeamPolicyV1>): TeamPolicyV1 {
    return {
        v: 1,
        sessionCreationPolicy: 'team_default',
        externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership',
        admissionMode: 'invite_only',
        authenticationPolicy: null,
        ...overrides,
    };
}

export function teamSummaryFixture(overrides?: Partial<TeamSummaryV1>): TeamSummaryV1 {
    return {
        id: 'team-1',
        name: 'Platform',
        description: null,
        logo: null,
        archivedAt: null,
        // The Home's own condition. Denied by default like every capability, so
        // a case that renders the governance notice has to ask for it.
        recovery: null,
        policy: teamPolicyFixture(),
        viewerRole: 'owner',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        // Built by its own owner so a change to what a Team may offer fails here
        // rather than being frozen into a local literal.
        admission: resolveTeamAdmissionProjectionV1(),
        counts: null,
        ...overrides,
    };
}

export function teamCapabilitiesFixture(
    granted: Partial<TeamCapabilitiesV1>,
): TeamCapabilitiesV1 {
    // A member's read pair: the Team and its roster/Groups. A case for a viewer who sees the
    // Team but not its roster (a non-member Home administrator) withdraws `viewRoster` itself.
    return { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true, viewRoster: true, ...granted };
}

export function teamGroupFixture(overrides?: Partial<TeamGroupV1>): TeamGroupV1 {
    return {
        v: 1,
        id: 'group-1',
        teamId: 'team-1',
        name: 'Developers',
        description: null,
        memberCount: 1,
        archivedAt: null,
        management: { kind: 'native' },
        capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
        ...overrides,
    };
}

export function teamGroupMemberFixture(
    overrides?: Partial<TeamGroupMemberV1>,
): TeamGroupMemberV1 {
    return {
        accountId: 'account-ada',
        membershipId: 'membership-1',
        account: accountDisplayProfileFixture('Ada'),
        historyAccess: 'from_membership',
        contributions: { native: true, external: [] },
        ...overrides,
    };
}

export function teamMembershipFixture(
    overrides?: Partial<TeamMembershipV1>,
): TeamMembershipV1 {
    return {
        v: 1,
        id: 'membership-1',
        teamId: 'team-1',
        accountId: 'account-ada',
        account: accountDisplayProfileFixture('Ada'),
        role: 'member',
        status: 'active',
        historyAccess: 'from_membership',
        management: { kind: 'native' },
        capabilities: NO_TEAM_MEMBERSHIP_CAPABILITIES_V1,
        joinedAt: 1_000_000_000_000,
        ...overrides,
    };
}

export function teamInvitationRowFixture(
    overrides?: Partial<TeamInvitationRowV1>,
): TeamInvitationRowV1 {
    return {
        id: 'invitation-1',
        teamId: 'team-1',
        state: 'active',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmailMask: null,
        expiresAt: 4_000_000_000_000,
        createdAt: 1_000_000_000_000,
        createdByAccountId: 'account-ada',
        acceptedByAccountId: null,
        lastEmailDelivery: null,
        ...overrides,
    };
}

/**
 * One shared credential resource, as the Home projects it.
 *
 * The audience starts empty and the source is a Pool, which is the shape the
 * plan's own example uses. Both halves are explicit so a case that cares about
 * an audience or a delivery mode has to say so rather than inheriting one.
 */
export function teamCredentialResourceFixture(
    overrides?: Partial<TeamCredentialResourceSummaryV1>,
): TeamCredentialResourceSummaryV1 {
    return {
        id: 'resource-1',
        teamId: 'team-1',
        custodianAccountId: 'account-ada',
        sourceOwnerDisplayName: 'Ada Lovelace',
        displayName: 'Claude Enterprise',
        enabled: true,
        revision: 3,
        disclosureCeiling: 'brokered_only',
        sessionUsePolicy: 'personal_allowed',
        source: {
            v: 1,
            kind: 'connected_pool',
            target: {
                kind: 'group',
                service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
                groupId: 'fallbacks',
            },
            poolIncarnation: 'pool-life-1',
        },
        sourcePresentation: {
            kind: 'connected_service',
            service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
        },
        activeUsageLimitCount: 0,
        requestPolicy: null,
        brokerPlacement: null,
        allMembersDeliveryMode: null,
        groupGrants: [],
        memberGrants: [],
        readiness: { kind: 'available' },
        recoveryAction: null,
        brokerPresentation: {
            selectedTarget: null,
            eligibleTargets: [],
            selectedPool: null,
            eligiblePools: [],
        },
        capabilities: {
            manageAudience: true,
            managePolicy: true,
            manageLimits: true,
            updateBrokerPlacement: true,
            narrowDisclosure: true,
            widenDisclosure: true,
            refreshDirectMaterial: true,
            disable: true,
            enable: true,
            delete: true,
        },
        directExportSupport: 'unsupported',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        ...overrides,
    };
}

export function teamCredentialSourceResourceFixture(
    overrides?: Partial<TeamCredentialSourceResourceAdministrationV1>,
): TeamCredentialSourceResourceAdministrationV1 {
    const resource = teamCredentialResourceFixture();
    return {
        id: resource.id,
        displayName: resource.displayName,
        enabled: resource.enabled,
        revision: resource.revision,
        disclosureCeiling: resource.disclosureCeiling,
        brokerPlacement: resource.brokerPlacement,
        brokerPresentation: resource.brokerPresentation,
        readiness: resource.readiness,
        recoveryAction: resource.recoveryAction,
        capabilities: resource.capabilities,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
        ...overrides,
    };
}

/**
 * One source the viewer may offer, as the Home projects it to the chooser.
 *
 * The pinned lifetime matches {@link teamCredentialResourceFixture}'s Pool, so a
 * case can hand both to a surface and have "this source is already shared"
 * resolve the way the Home would resolve it.
 */
export function teamCredentialSourceCandidateFixture(
    overrides?: Partial<TeamCredentialSourceCandidateV1>,
): TeamCredentialSourceCandidateV1 {
    return {
        source: {
            v: 1,
            kind: 'connected_pool',
            target: {
                kind: 'group',
                service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
                groupId: 'fallbacks',
            },
            poolIncarnation: 'pool-life-1',
        },
        candidateId: 'candidate-pool-1',
        label: 'Fallbacks',
        memberCount: 3,
        offeredByResourceId: null,
        directExportSupport: 'unsupported',
        ...overrides,
    };
}

/** Denied by default, for the same reason Team capabilities are. */
export function teamCredentialViewerFixture(
    overrides?: Partial<TeamCredentialViewerCapabilitiesV1>,
): TeamCredentialViewerCapabilitiesV1 {
    return { manageCredentials: false, offerOwnCredential: false, ...overrides };
}
