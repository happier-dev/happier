import type {
    AuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    addConnectedServiceAuthGroupMemberV3,
    createConnectedServiceAuthGroupV3,
    deleteConnectedServiceAuthGroupV3,
    listConnectedServiceAuthGroupsV3,
    patchConnectedServiceAuthGroupMemberV3,
    patchConnectedServiceAuthGroupV3,
    removeConnectedServiceAuthGroupMemberV3,
    setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import {
    addQualifiedConnectedAccountGroupMemberV4,
    createQualifiedConnectedAccountGroupV4,
    deleteQualifiedConnectedAccountGroupV4,
    listQualifiedConnectedAccountGroupsV4,
    patchQualifiedConnectedAccountGroupMemberV4,
    patchQualifiedConnectedAccountGroupV4,
    removeQualifiedConnectedAccountGroupMemberV4,
    setQualifiedConnectedAccountGroupActiveAccountV4,
} from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceAuthGroupPolicyV1Schema,
    type BuiltInLegacyConnectedAccountOperation,
    type ConnectedServiceAuthGroupMemberStateV1,
    type ConnectedServiceAuthGroupPolicyV1,
    type ConnectedServiceAuthGroupStateV1,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

export type QualifiedConnectedAccountUiSource =
    | Readonly<{ protocol: 'v4' }>
    | Readonly<{
        protocol: 'legacy-v3';
        legacyServiceId: ConnectedServiceId;
    }>;

export type QualifiedConnectedAccountUiLegacyPeerClass =
    | 'exact-v0.2.1'
    | 'revisioned-v2-v3';

export type QualifiedConnectedAccountUiPeerTransport =
    | Readonly<{ protocol: 'v4' }>
    | Readonly<{
        protocol: 'legacy';
        peerClass: QualifiedConnectedAccountUiLegacyPeerClass;
        legacyServiceId: ConnectedServiceId;
    }>;

export class QualifiedConnectedAccountUiSourceError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = 'QualifiedConnectedAccountUiSourceError';
        this.code = code;
        Object.setPrototypeOf(this, QualifiedConnectedAccountUiSourceError.prototype);
    }
}

export type QualifiedConnectedAccountUiGroupRevision =
    | Readonly<{
        protocol: 'v4';
        incarnation: string;
        generation: number;
        runtimeStateRevision: number;
    }>
    | Readonly<{
        protocol: 'legacy-v3';
        generation: number;
    }>;

export type QualifiedConnectedAccountUiGroupMember = Readonly<{
    ref: QualifiedConnectedAccountRef;
    priority: number;
    enabled: boolean;
    state: ConnectedServiceAuthGroupMemberStateV1;
}>;

export type QualifiedConnectedAccountUiGroup = Readonly<{
    ref: Readonly<{
        service: PluginContributionIdentityV1;
        groupId: string;
    }>;
    displayName: string | null;
    policy: ConnectedServiceAuthGroupPolicyV1;
    activeAccountId: string | null;
    revision: QualifiedConnectedAccountUiGroupRevision;
    state: ConnectedServiceAuthGroupStateV1;
    members: readonly QualifiedConnectedAccountUiGroupMember[];
}>;

/**
 * Spacing of the member priority ladder. Priorities are rewritten as
 * `(index + 1) * MEMBER_PRIORITY_STEP` on reorder, so the gap left between two
 * neighbours is what an append or a future insert can land in.
 *
 * Owned here, on the mutation seam, so the reorder consumer and `addMember`
 * cannot pick different spacings for the same ladder.
 */
export const MEMBER_PRIORITY_STEP = 100;

/**
 * The priority to give a member appended to the end of the ladder: one full step
 * past the current highest.
 */
export function nextMemberPriority(
    members: ReadonlyArray<Pick<QualifiedConnectedAccountUiGroupMember, 'priority'>>,
): number {
    const highest = members.reduce((max, member) => Math.max(max, member.priority), 0);
    return highest + MEMBER_PRIORITY_STEP;
}

function sameService(
    left: PluginContributionIdentityV1,
    right: PluginContributionIdentityV1,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function assertQualifiedGroupService(
    group: QualifiedConnectedAccountGroupV4,
    expectedService: PluginContributionIdentityV1,
): void {
    if (!sameService(group.ref.service, expectedService)) {
        throw new QualifiedConnectedAccountUiSourceError(
            'qualified_connected_accounts_inconsistent_peer',
        );
    }
}

function fromQualifiedGroup(
    group: QualifiedConnectedAccountGroupV4,
    expectedService: PluginContributionIdentityV1,
): QualifiedConnectedAccountUiGroup {
    assertQualifiedGroupService(group, expectedService);
    return {
        ref: group.ref,
        displayName: group.displayName,
        policy: group.policy,
        activeAccountId: group.activeConnectedAccountId,
        revision: {
            protocol: 'v4',
            incarnation: group.incarnation,
            generation: group.generation,
            runtimeStateRevision: group.runtimeStateRevision,
        },
        state: group.state,
        members: group.members.map((member) => ({
            ref: {
                service: expectedService,
                accountId: member.connectedAccountId,
            },
            priority: member.priority,
            enabled: member.enabled,
            state: member.state,
        })),
    };
}

function fromLegacyGroup(
    group: ConnectedServiceAuthGroupV1,
    expectedService: PluginContributionIdentityV1,
    expectedLegacyServiceId: ConnectedServiceId,
): QualifiedConnectedAccountUiGroup {
    if (
        group.serviceId !== expectedLegacyServiceId
        || group.members.some((member) => (
            member.serviceId !== expectedLegacyServiceId
            || member.groupId !== group.groupId
        ))
    ) {
        throw new QualifiedConnectedAccountUiSourceError(
            'qualified_connected_accounts_inconsistent_peer',
        );
    }
    return {
        ref: {
            service: expectedService,
            groupId: group.groupId,
        },
        displayName: group.displayName,
        policy: group.policy,
        activeAccountId: group.activeProfileId,
        revision: {
            protocol: 'legacy-v3',
            generation: group.generation,
        },
        state: group.state,
        members: group.members.map((member) => ({
            ref: {
                service: expectedService,
                accountId: member.profileId,
            },
            priority: member.priority,
            enabled: member.enabled,
            state: member.state,
        })),
    };
}

function mergePolicy(
    current: ConnectedServiceAuthGroupPolicyV1,
    patch: Partial<ConnectedServiceAuthGroupPolicyV1>,
): ConnectedServiceAuthGroupPolicyV1 {
    return ConnectedServiceAuthGroupPolicyV1Schema.parse({
        ...current,
        ...patch,
        ...(patch.switchOn
            ? { switchOn: { ...current.switchOn, ...patch.switchOn } }
            : {}),
    });
}

function readV4Revision(
    group: QualifiedConnectedAccountUiGroup,
): Extract<QualifiedConnectedAccountUiGroupRevision, { protocol: 'v4' }> {
    if (group.revision.protocol !== 'v4') {
        throw new QualifiedConnectedAccountUiSourceError(
            'qualified_connected_accounts_cross_source_ref',
        );
    }
    return group.revision;
}

export function isQualifiedConnectedAccountLegacyOperationSupported(params: Readonly<{
    service: PluginContributionIdentityV1;
    legacyServiceId: ConnectedServiceId;
    peerClass: QualifiedConnectedAccountUiLegacyPeerClass;
    operation: BuiltInLegacyConnectedAccountOperation;
}>): boolean {
    const compatibilityById = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID as unknown as Readonly<Record<string, unknown>>;
    const compatibility = compatibilityById[params.legacyServiceId];
    if (!compatibility || typeof compatibility !== 'object') return false;
    const record = compatibility as Readonly<Record<string, unknown>>;
    const mappedService = record.service;
    if (!mappedService || typeof mappedService !== 'object') return false;
    const mappedServiceRecord =
        mappedService as Readonly<Record<string, unknown>>;
    if (
        mappedServiceRecord.pluginId !== params.service.pluginId
        || mappedServiceRecord.localId !== params.service.localId
    ) {
        return false;
    }
    const peerOperations = record.peerOperations;
    if (!peerOperations || typeof peerOperations !== 'object') return false;
    const operations = (
        peerOperations as Readonly<Record<string, unknown>>
    )[params.peerClass === 'revisioned-v2-v3'
        ? 'revisionedV2V3'
        : 'exactV0_2_1'];
    return Array.isArray(operations)
        && operations.includes(params.operation);
}

export type QualifiedConnectedAccountGroupsClient = Readonly<{
    list(): Promise<readonly QualifiedConnectedAccountUiGroup[]>;
    create(params: Readonly<{
        groupId: string;
        displayName: string | null;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    patch(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        displayName?: string | null;
        policy?: Partial<ConnectedServiceAuthGroupPolicyV1>;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    delete(group: QualifiedConnectedAccountUiGroup): Promise<void>;
    addMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    patchMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        enabled?: boolean;
        priority?: number;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    removeMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    setActiveAccount(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        overrideRuntimeCooldown?: boolean;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
}>;

export function createQualifiedConnectedAccountGroupsClient(params: Readonly<{
    credentials: AuthCredentials;
    service: PluginContributionIdentityV1;
    source: QualifiedConnectedAccountUiSource;
}>): QualifiedConnectedAccountGroupsClient {
    const { credentials, service, source } = params;

    const assertAccount = (account: QualifiedConnectedAccountRef) => {
        if (!sameService(account.service, service)) {
            throw new QualifiedConnectedAccountUiSourceError(
                'qualified_connected_accounts_cross_service_ref',
            );
        }
    };
    const assertGroup = (group: QualifiedConnectedAccountUiGroup) => {
        if (
            !sameService(group.ref.service, service)
            || group.revision.protocol !== source.protocol
        ) {
            throw new QualifiedConnectedAccountUiSourceError(
                'qualified_connected_accounts_cross_source_ref',
            );
        }
    };
    const normalize = (
        group: QualifiedConnectedAccountGroupV4 | ConnectedServiceAuthGroupV1,
    ): QualifiedConnectedAccountUiGroup => source.protocol === 'v4'
        ? fromQualifiedGroup(group as QualifiedConnectedAccountGroupV4, service)
        : fromLegacyGroup(
            group as ConnectedServiceAuthGroupV1,
            service,
            source.legacyServiceId,
        );

    return {
        async list() {
            if (source.protocol === 'v4') {
                const response = await listQualifiedConnectedAccountGroupsV4(
                    credentials,
                    { service },
                );
                return response.groups.map((group) => fromQualifiedGroup(group, service));
            }
            const response = await listConnectedServiceAuthGroupsV3(credentials, {
                serviceId: source.legacyServiceId,
            });
            return response.groups.map((group) => fromLegacyGroup(
                group,
                service,
                source.legacyServiceId,
            ));
        },
        async create(input) {
            if (source.protocol === 'v4') {
                return normalize((await createQualifiedConnectedAccountGroupV4(
                    credentials,
                    {
                        service,
                        group: {
                            groupId: input.groupId,
                            displayName: input.displayName,
                        },
                    },
                )).group);
            }
            return normalize((await createConnectedServiceAuthGroupV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.groupId,
                    displayName: input.displayName,
                    members: [],
                    activeProfileId: null,
                },
            )).group);
        },
        async patch(input) {
            assertGroup(input.group);
            const policy = input.policy
                ? mergePolicy(input.group.policy, input.policy)
                : undefined;
            if (source.protocol === 'v4') {
                const revision = readV4Revision(input.group);
                return normalize((await patchQualifiedConnectedAccountGroupV4(
                    credentials,
                    {
                        service,
                        groupId: input.group.ref.groupId,
                        ...(input.displayName !== undefined
                            ? { displayName: input.displayName }
                            : {}),
                        ...(policy ? { policy } : {}),
                        expectedIncarnation: revision.incarnation,
                        expectedRuntimeStateRevision:
                            revision.runtimeStateRevision,
                    },
                )).group);
            }
            return normalize((await patchConnectedServiceAuthGroupV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.group.ref.groupId,
                    patch: {
                        ...(input.displayName !== undefined
                            ? { displayName: input.displayName }
                            : {}),
                        ...(policy ? { policy } : {}),
                        expectedGeneration: input.group.revision.generation,
                    },
                },
            )).group);
        },
        async delete(group) {
            assertGroup(group);
            if (source.protocol === 'v4') {
                const revision = readV4Revision(group);
                await deleteQualifiedConnectedAccountGroupV4(credentials, {
                    group: group.ref,
                    expectedIncarnation: revision.incarnation,
                    expectedRuntimeStateRevision:
                        revision.runtimeStateRevision,
                });
                return;
            }
            await deleteConnectedServiceAuthGroupV3(credentials, {
                serviceId: source.legacyServiceId,
                groupId: group.ref.groupId,
            });
        },
        async addMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            const priority = nextMemberPriority(input.group.members);
            if (source.protocol === 'v4') {
                const revision = readV4Revision(input.group);
                return normalize((await addQualifiedConnectedAccountGroupMemberV4(
                    credentials,
                    {
                        group: input.group.ref,
                        connectedAccountId: input.account.accountId,
                        priority,
                        enabled: true,
                        expectedIncarnation: revision.incarnation,
                        expectedRuntimeStateRevision:
                            revision.runtimeStateRevision,
                    },
                )).group);
            }
            return normalize((await addConnectedServiceAuthGroupMemberV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.group.ref.groupId,
                    profileId: input.account.accountId,
                    priority,
                    enabled: true,
                    expectedGeneration: input.group.revision.generation,
                },
            )).group);
        },
        async patchMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            if (source.protocol === 'v4') {
                const revision = readV4Revision(input.group);
                return normalize((await patchQualifiedConnectedAccountGroupMemberV4(
                    credentials,
                    {
                        group: input.group.ref,
                        connectedAccountId: input.account.accountId,
                        ...(input.enabled === undefined
                            ? {}
                            : { enabled: input.enabled }),
                        ...(input.priority === undefined
                            ? {}
                            : { priority: input.priority }),
                        expectedIncarnation: revision.incarnation,
                        expectedRuntimeStateRevision:
                            revision.runtimeStateRevision,
                    },
                )).group);
            }
            return normalize((await patchConnectedServiceAuthGroupMemberV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.group.ref.groupId,
                    profileId: input.account.accountId,
                    patch: {
                        ...(input.enabled === undefined
                            ? {}
                            : { enabled: input.enabled }),
                        ...(input.priority === undefined
                            ? {}
                            : { priority: input.priority }),
                        expectedGeneration: input.group.revision.generation,
                    },
                },
            )).group);
        },
        async removeMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            if (source.protocol === 'v4') {
                const revision = readV4Revision(input.group);
                return normalize((await removeQualifiedConnectedAccountGroupMemberV4(
                    credentials,
                    {
                        group: input.group.ref,
                        connectedAccountId: input.account.accountId,
                        expectedIncarnation: revision.incarnation,
                        expectedRuntimeStateRevision:
                            revision.runtimeStateRevision,
                    },
                )).group);
            }
            return normalize((await removeConnectedServiceAuthGroupMemberV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.group.ref.groupId,
                    profileId: input.account.accountId,
                    expectedGeneration: input.group.revision.generation,
                },
            )).group);
        },
        async setActiveAccount(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            if (source.protocol === 'v4') {
                const revision = readV4Revision(input.group);
                return normalize((await setQualifiedConnectedAccountGroupActiveAccountV4(
                    credentials,
                    {
                        group: input.group.ref,
                        connectedAccountId: input.account.accountId,
                        expectedGeneration: revision.generation,
                        expectedIncarnation: revision.incarnation,
                        expectedRuntimeStateRevision:
                            revision.runtimeStateRevision,
                        ...(input.overrideRuntimeCooldown
                            ? { overrideRuntimeCooldown: true }
                            : {}),
                    },
                )).group);
            }
            return normalize((await setConnectedServiceAuthGroupActiveProfileV3(
                credentials,
                {
                    serviceId: source.legacyServiceId,
                    groupId: input.group.ref.groupId,
                    profileId: input.account.accountId,
                    expectedGeneration: input.group.revision.generation,
                    ...(input.overrideRuntimeCooldown
                        ? { overrideRuntimeCooldown: true }
                        : {}),
                },
            )).group);
        },
    };
}
