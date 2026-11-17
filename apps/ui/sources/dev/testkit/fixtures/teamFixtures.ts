import {
    TeamPolicyV1Schema,
    TeamSummaryV1Schema,
    TeamCapabilitiesV1Schema,
    TeamGroupV1Schema,
    TeamGroupMemberV1Schema,
    TeamMembershipV1Schema,
    TeamInvitationRowV1Schema,
    TeamInvitationPreviewV1Schema,
    TeamIdentityConnectionV1Schema,
    TeamDirectorySourceSummaryV1Schema,
    TeamCredentialResourceSummaryV1Schema,
    TeamCredentialSourceResourceAdministrationV1Schema,
    TeamCredentialSourceCandidateV1Schema,
    TeamCredentialViewerCapabilitiesV1Schema,
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
    type TeamInvitationPreviewV1,
    type TeamIdentityConnectionV1,
    type TeamDirectorySourceSummaryV1,
    type TeamMembershipV1,
    type TeamPolicyV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';
import { PrivateLabelReadV1Schema, type PrivateLabelReadV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

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
    return TeamPolicyV1Schema.parse({
        v: 1,
        sessionCreationPolicy: 'team_default',
        externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership',
        admissionMode: 'invite_only',
        authenticationPolicy: null,
        ...overrides,
    });
}

export function teamSummaryFixture(overrides?: Partial<TeamSummaryV1>): TeamSummaryV1 {
    return TeamSummaryV1Schema.parse({
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
    });
}

export function teamCapabilitiesFixture(
    granted: Partial<TeamCapabilitiesV1>,
): TeamCapabilitiesV1 {
    // A member's read pair: the Team and its roster/Groups. A case for a viewer who sees the
    // Team but not its roster (a non-member Home administrator) withdraws `viewRoster` itself.
    return TeamCapabilitiesV1Schema.parse({ ...NO_TEAM_CAPABILITIES_V1, viewTeam: true, viewRoster: true, ...granted });
}

export function teamGroupFixture(overrides?: Omit<Partial<TeamGroupV1>, 'name' | 'description'> & { name?: string | TeamGroupV1['name']; description?: string | TeamGroupV1['description'] }): TeamGroupV1 {
    const name = overrides?.name ?? 'Developers';
    const description = overrides?.description ?? null;
    return TeamGroupV1Schema.parse({
        v: 1,
        id: 'group-1',
        teamId: 'team-1',
        memberCount: 1,
        archivedAt: null,
        management: { kind: 'native' },
        capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
        ...overrides,
        name: typeof name === 'string'
            ? { kind: 'available', label: { content: { t: 'plain', v: name }, recipientEnvelope: null } }
            : name,
        description: typeof description === 'string'
            ? { kind: 'available', label: { content: { t: 'plain', v: description }, recipientEnvelope: null } }
            : description,
    });
}

export function teamGroupMemberFixture(
    overrides?: Partial<TeamGroupMemberV1>,
): TeamGroupMemberV1 {
    return TeamGroupMemberV1Schema.parse({
        accountId: 'account-ada',
        membershipId: 'membership-1',
        account: accountDisplayProfileFixture('Ada'),
        historyAccess: 'from_membership',
        contributions: { native: true, external: [] },
        ...overrides,
    });
}

export function teamMembershipFixture(
    overrides?: Partial<TeamMembershipV1>,
): TeamMembershipV1 {
    return TeamMembershipV1Schema.parse({
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
    });
}

/** The shared invitation preview returned before Account authentication or admission. */
export function teamInvitationPreviewFixture(
    overrides?: Omit<Partial<TeamInvitationPreviewV1>, 'home' | 'team'> & {
        home?: Partial<TeamInvitationPreviewV1['home']>;
        team?: Partial<TeamInvitationPreviewV1['team']>;
    },
): TeamInvitationPreviewV1 {
    return TeamInvitationPreviewV1Schema.parse({
        role: 'member',
        historyAccess: 'from_membership',
        state: 'active',
        expiresAt: Date.UTC(2030, 0, 1),
        recipientEmailMask: null,
        ...overrides,
        home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null, ...overrides?.home },
        team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1', ...overrides?.team },
    });
}

export function teamInvitationRowFixture(
    overrides?: Partial<TeamInvitationRowV1>,
): TeamInvitationRowV1 {
    return TeamInvitationRowV1Schema.parse({
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
    });
}

/**
 * One shared credential resource, as the Home projects it.
 *
 * The audience starts empty and the source is a Pool, which is the shape the
 * plan's own example uses. Both halves are explicit so a case that cares about
 * an audience or a delivery mode has to say so rather than inheriting one.
 */
export function teamCredentialDisplayNameFixture(displayName: string): PrivateLabelReadV1 {
    return PrivateLabelReadV1Schema.parse({ content: { t: 'plain', v: displayName }, recipientEnvelope: null });
}

export type TeamCredentialResourceFixtureOverrides = Omit<Partial<TeamCredentialResourceSummaryV1>, 'capabilities' | 'displayName'> & Readonly<{
    /** Text remains convenient test input; production rows carry a recipient projection. */
    displayName?: string | PrivateLabelReadV1;
    capabilities?: Partial<TeamCredentialResourceSummaryV1['capabilities']>;
}>;

export function teamCredentialResourceFixture(
    overrides?: TeamCredentialResourceFixtureOverrides,
): TeamCredentialResourceSummaryV1 {
    const { displayName: displayNameOverride, capabilities: capabilityOverrides, ...rest } = overrides ?? {};
    return TeamCredentialResourceSummaryV1Schema.parse({
        id: 'resource-1',
        teamId: 'team-1',
        custodianAccountId: 'account-ada',
        sourceOwnerDisplayName: 'Ada Lovelace',
        displayName: typeof displayNameOverride === 'string'
            ? teamCredentialDisplayNameFixture(displayNameOverride)
            : displayNameOverride ?? teamCredentialDisplayNameFixture('Claude Enterprise'),
        enabled: true,
        revision: 3,
        deliveryPolicy: { preferredAllowedModes: ['brokered'] },
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
        allMembersAllowedRoutes: null,
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
        directExportSupport: 'unsupported',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        ...rest,
        capabilities: {
            manageAudience: true,
            managePolicy: true,
            manageLimits: true,
            updateBrokerPlacement: true,
            updateDeliveryPolicy: true,
            narrowDisclosure: true,
            widenDisclosure: true,
            refreshDirectMaterial: true,
            disable: true,
            enable: true,
            delete: true,
            ...capabilityOverrides,
        },
    });
}

export type TeamCredentialSourceResourceFixtureOverrides = Omit<Partial<TeamCredentialSourceResourceAdministrationV1>, 'capabilities' | 'displayName'> & Readonly<{
    /** Match the main resource fixture: concise text input still becomes a recipient projection. */
    displayName?: string | PrivateLabelReadV1;
    capabilities?: Partial<TeamCredentialSourceResourceAdministrationV1['capabilities']>;
}>;

export function teamCredentialSourceResourceFixture(
    overrides?: TeamCredentialSourceResourceFixtureOverrides,
): TeamCredentialSourceResourceAdministrationV1 {
    const { displayName: displayNameOverride, capabilities: capabilityOverrides, ...rest } = overrides ?? {};
    const resource = teamCredentialResourceFixture();
    return TeamCredentialSourceResourceAdministrationV1Schema.parse({
        id: resource.id,
        displayName: typeof displayNameOverride === 'string'
            ? teamCredentialDisplayNameFixture(displayNameOverride)
            : displayNameOverride ?? resource.displayName,
        enabled: resource.enabled,
        revision: resource.revision,
        deliveryPolicy: resource.deliveryPolicy,
        brokerPlacement: resource.brokerPlacement,
        brokerPresentation: resource.brokerPresentation,
        readiness: resource.readiness,
        recoveryAction: resource.recoveryAction,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
        ...rest,
        capabilities: { ...resource.capabilities, ...capabilityOverrides },
    });
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
    return TeamCredentialSourceCandidateV1Schema.parse({
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
    });
}

/** Denied by default, for the same reason Team capabilities are. */
export function teamCredentialViewerFixture(
    overrides?: Partial<TeamCredentialViewerCapabilitiesV1>,
): TeamCredentialViewerCapabilitiesV1 {
    return TeamCredentialViewerCapabilitiesV1Schema.parse({ manageCredentials: false, offerOwnCredential: false, ...overrides });
}

/** A Team-owned OIDC connection; allowed mutations are explicit in each case. */
export function teamIdentityConnectionFixture(overrides?: Partial<TeamIdentityConnectionV1>): TeamIdentityConnectionV1 {
    return TeamIdentityConnectionV1Schema.parse({
        v: 1, id: 'connection-1', teamId: 'team-1',
        provider: { id: 'provider-1', kind: 'oidc', displayName: 'OIDC' },
        externalReference: { v: 1, kind: 'oidc' },
        settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
        enabled: true, firstEnabledAt: 1, revision: 1, state: 'connected', allowedActions: [],
        lastObservation: { v: 1, kind: 'oidc' }, lastSuccessfulTest: null, createdAt: 1, updatedAt: 1,
        ...overrides,
    });
}

/** A settled directory projection; lifecycle and permitted mutations stay server-projected. */
export function teamDirectorySourceFixture(overrides?: Partial<TeamDirectorySourceSummaryV1>): TeamDirectorySourceSummaryV1 {
    return TeamDirectorySourceSummaryV1Schema.parse({
        v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
        state: 'active', allowedActions: [],
        sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null,
            lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
        error: null,
        ...overrides,
    });
}
