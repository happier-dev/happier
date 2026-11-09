import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID, type BuiltInLegacyConnectedAccountOperation } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { ConnectedServiceAuthGroupPolicyV2Schema, type ConnectedServiceAuthGroupMemberStateV1, type ConnectedServiceAuthGroupPolicyV2, type ConnectedServiceAuthGroupStateV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { CONNECTED_SERVICE_POOL_MEMBER_PRIORITY_STEP, type ConnectedServiceConfigurationActionIdV1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { QualifiedConnectedAccountGroupResponseV4Schema, sameQualifiedConnectedAccountGroupRef, type QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

export type QualifiedConnectedAccountUiSource = Readonly<{ protocol: 'v4' }>;

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

export type QualifiedConnectedAccountUiGroupRevision = Readonly<{
    protocol: 'v4';
    incarnation: string;
    generation: number;
    runtimeStateRevision: number;
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
    policy: ConnectedServiceAuthGroupPolicyV2;
    activeAccountId: string | null;
    activeSince?: Readonly<{ accountId: string; atMs: number }> | null;
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
export const MEMBER_PRIORITY_STEP = CONNECTED_SERVICE_POOL_MEMBER_PRIORITY_STEP;

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

export function fromQualifiedGroup(
    group: QualifiedConnectedAccountGroupV4,
    expectedService: PluginContributionIdentityV1,
): QualifiedConnectedAccountUiGroup {
    assertQualifiedGroupService(group, expectedService);
    const activeSince = group.state.activeSince?.accountId === group.activeConnectedAccountId
        ? group.state.activeSince
        : null;
    return {
        ref: group.ref,
        displayName: group.displayName,
        policy: group.policy,
        activeAccountId: group.activeConnectedAccountId,
        activeSince,
        revision: {
            protocol: 'v4',
            incarnation: group.incarnation,
            generation: group.generation,
            runtimeStateRevision: group.runtimeStateRevision,
        },
        state: { ...group.state, activeSince },
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

function mergePolicy(
    current: ConnectedServiceAuthGroupPolicyV2,
    patch: Partial<ConnectedServiceAuthGroupPolicyV2>,
): ConnectedServiceAuthGroupPolicyV2 {
    return ConnectedServiceAuthGroupPolicyV2Schema.parse({
        ...current,
        ...patch,
        ...(patch.switchOn
            ? { switchOn: { ...current.switchOn, ...patch.switchOn } }
            : {}),
    });
}

function readV4Revision(
    group: QualifiedConnectedAccountUiGroup,
): QualifiedConnectedAccountUiGroupRevision {
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
    get(ref: QualifiedConnectedAccountUiGroup['ref']): Promise<QualifiedConnectedAccountGroupV4>;
    create(params: Readonly<{
        groupId: string;
        displayName: string | null;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
    patch(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        displayName?: string | null;
        policy?: Partial<ConnectedServiceAuthGroupPolicyV2>;
    }>): Promise<QualifiedConnectedAccountUiGroup>;
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
    service: PluginContributionIdentityV1;
    /** Edits never fall back to a raw writer when Action custody is absent. */
    mutation?: Readonly<{
        execute(actionId: ConnectedServiceConfigurationActionIdV1, input: unknown): Promise<unknown>;
    }>;
}>): QualifiedConnectedAccountGroupsClient {
    const { service } = params;
    const mutation = () => {
        if (!params.mutation) throw new QualifiedConnectedAccountUiSourceError('action_authorization_unavailable');
        return params.mutation;
    };
    const mutateGroup = async (actionId: ConnectedServiceConfigurationActionIdV1, input: unknown) =>
        QualifiedConnectedAccountGroupResponseV4Schema.parse(await mutation().execute(actionId, input)).group;

    const assertAccount = (account: QualifiedConnectedAccountRef) => {
        if (!sameService(account.service, service)) {
            throw new QualifiedConnectedAccountUiSourceError(
                'qualified_connected_accounts_cross_service_ref',
            );
        }
    };
    const assertGroup = (group: QualifiedConnectedAccountUiGroup) => {
        if (!sameService(group.ref.service, service)) {
            throw new QualifiedConnectedAccountUiSourceError(
                'qualified_connected_accounts_cross_source_ref',
            );
        }
    };
    const normalize = (group: QualifiedConnectedAccountGroupV4): QualifiedConnectedAccountUiGroup =>
        fromQualifiedGroup(group, service);
    const normalizeExpected = (
        group: QualifiedConnectedAccountGroupV4,
        expectedRef: QualifiedConnectedAccountUiGroup['ref'],
    ): QualifiedConnectedAccountUiGroup => {
        const normalized = normalize(group);
        if (!sameQualifiedConnectedAccountGroupRef(normalized.ref, expectedRef)) {
            throw new QualifiedConnectedAccountUiSourceError(
                'qualified_connected_accounts_inconsistent_peer',
            );
        }
        return normalized;
    };
    const get = async (ref: QualifiedConnectedAccountUiGroup['ref']) => {
        if (!sameService(ref.service, service)) {
            throw new QualifiedConnectedAccountUiSourceError('qualified_connected_accounts_cross_source_ref');
        }
        const group = await mutateGroup('connectedServices.pools.get', { group: ref });
        normalizeExpected(group, ref);
        return group;
    };

    return {
        get,
        async create(input) {
            return normalizeExpected(await mutateGroup('connectedServices.pools.create',
                {
                    service,
                    group: {
                        groupId: input.groupId,
                        displayName: input.displayName,
                    },
                },
            ), { service, groupId: input.groupId });
        },
        async patch(input) {
            assertGroup(input.group);
            const policy = input.policy
                ? mergePolicy(input.group.policy, input.policy)
                : undefined;
            const revision = readV4Revision(input.group);
            return normalizeExpected(await mutateGroup('connectedServices.pools.patch',
                {
                    service,
                    groupId: input.group.ref.groupId,
                    ...(input.displayName !== undefined
                        ? { displayName: input.displayName }
                        : {}),
                    ...(policy ? { policy } : {}),
                    expectedGeneration: revision.generation,
                    expectedIncarnation: revision.incarnation,
                    expectedRuntimeStateRevision:
                        revision.runtimeStateRevision,
                },
            ), input.group.ref);
        },
        async addMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            const priority = nextMemberPriority(input.group.members);
            const revision = readV4Revision(input.group);
            return normalizeExpected(await mutateGroup('connectedServices.pools.members.add',
                {
                    group: input.group.ref,
                    connectedAccountId: input.account.accountId,
                    priority,
                    enabled: true,
                    expectedGeneration: revision.generation,
                    expectedIncarnation: revision.incarnation,
                    expectedRuntimeStateRevision:
                        revision.runtimeStateRevision,
                },
            ), input.group.ref);
        },
        async patchMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            const revision = readV4Revision(input.group);
            return normalizeExpected(await mutateGroup('connectedServices.pools.members.patch',
                {
                    group: input.group.ref,
                    connectedAccountId: input.account.accountId,
                    ...(input.enabled === undefined
                        ? {}
                        : { enabled: input.enabled }),
                    ...(input.priority === undefined
                        ? {}
                        : { priority: input.priority }),
                    expectedGeneration: revision.generation,
                    expectedIncarnation: revision.incarnation,
                    expectedRuntimeStateRevision:
                        revision.runtimeStateRevision,
                },
            ), input.group.ref);
        },
        async removeMember(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            const revision = readV4Revision(input.group);
            return normalizeExpected(await mutateGroup('connectedServices.pools.members.remove',
                {
                    group: input.group.ref,
                    connectedAccountId: input.account.accountId,
                    expectedGeneration: revision.generation,
                    expectedIncarnation: revision.incarnation,
                    expectedRuntimeStateRevision:
                        revision.runtimeStateRevision,
                },
            ), input.group.ref);
        },
        async setActiveAccount(input) {
            assertGroup(input.group);
            assertAccount(input.account);
            const revision = readV4Revision(input.group);
            const admitted = mutation();
            await admitted.execute('connectedServices.pools.switchNow',
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
            );
            return normalizeExpected(await get(input.group.ref), input.group.ref);
        },
    };
}
