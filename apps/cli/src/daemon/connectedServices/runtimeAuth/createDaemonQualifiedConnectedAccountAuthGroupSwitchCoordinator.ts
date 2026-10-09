import { QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';

import {
    QualifiedConnectedAccountGroupConflictError,
    listQualifiedConnectedAccountsV4,
    readQualifiedConnectedAccountGroupV4,
    setQualifiedConnectedAccountGroupActiveAccountV4,
    updateQualifiedConnectedAccountGroupMemberV4,
    updateQualifiedConnectedAccountGroupRuntimeStateV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import {
    ConnectedServiceAuthGroupSwitchCoordinator,
    InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
    type ConnectedServiceAuthGroupAccountScope,
    type ConnectedServiceAuthGroupGenerationApplyInput,
    type ConnectedServiceAuthGroupGenerationApplyResult,
    type ConnectedServiceAuthGroupSwitchEvent,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import {
    buildQualifiedConnectedAccountAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
    buildConnectedServiceAuthGroupObservedFailureMemberState,
    resolveConnectedServiceAuthGroupFailureRetryAtMs,
} from '../accountGroups/runtimeState/buildConnectedServiceAuthGroupObservedFailureMemberState';
import {
    updateConnectedServiceAuthGroupRuntimeStateWithRetry,
} from '../accountGroups/runtimeState/updateConnectedServiceAuthGroupRuntimeStateWithRetry';
import type { ConnectedServiceAuthGroupCandidatePreparationResult } from '../refresh/ConnectedServiceRefreshCoordinator';
import {
    buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
    buildQualifiedConnectedAccountAuthGroupAccountUsageView,
    type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import type { ConnectedServiceAuthGroupQuotaProbeResult } from '../accountGroups/quotas/preTurnQuotaProbe';
import type { ConnectedServiceQuotaRecoveryCreditConsumeResult } from '../quotas/ConnectedServiceQuotasCoordinator';

type QualifiedConnectedAccountAuthGroupApi = Readonly<{
    readGroup: typeof readQualifiedConnectedAccountGroupV4;
    listAccounts: typeof listQualifiedConnectedAccountsV4;
    setActiveAccount:
        typeof setQualifiedConnectedAccountGroupActiveAccountV4;
    updateRuntimeState:
        typeof updateQualifiedConnectedAccountGroupRuntimeStateV4;
    updateMember?: typeof updateQualifiedConnectedAccountGroupMemberV4;
}>;

const defaultQualifiedConnectedAccountAuthGroupApi:
    QualifiedConnectedAccountAuthGroupApi = {
        readGroup: readQualifiedConnectedAccountGroupV4,
        listAccounts: listQualifiedConnectedAccountsV4,
        setActiveAccount:
            setQualifiedConnectedAccountGroupActiveAccountV4,
        updateRuntimeState:
            updateQualifiedConnectedAccountGroupRuntimeStateV4,
        updateMember: updateQualifiedConnectedAccountGroupMemberV4,
    };

function sameQualifiedService(
    left: QualifiedConnectedAccountServiceRef,
    right: QualifiedConnectedAccountServiceRef,
): boolean {
    return left.pluginId === right.pluginId
        && left.localId === right.localId;
}

function assertExactGroup(
    group: QualifiedConnectedAccountGroupV4,
    service: QualifiedConnectedAccountServiceRef,
    groupId: string,
): void {
    if (
        !sameQualifiedService(group.ref.service, service)
        || group.ref.groupId !== groupId
    ) {
        throw new Error(
            'qualified_connected_account_group_identity_mismatch',
        );
    }
}

function assertExactAccountList(
    service: QualifiedConnectedAccountServiceRef,
    response: Readonly<{
        service: QualifiedConnectedAccountServiceRef;
        accounts: readonly QualifiedConnectedAccountProfileV4[];
    }>,
): void {
    if (!sameQualifiedService(response.service, service)) {
        throw new Error(
            'qualified_connected_account_list_service_mismatch',
        );
    }
    if (
        response.accounts.some(
            (profile) => !sameQualifiedService(
                profile.ref.service,
                service,
            ),
        )
    ) {
        throw new Error(
            'qualified_connected_account_list_service_mismatch',
        );
    }
}

function resolveQualifiedGroupGenerationConflict(
    error: unknown,
): number | null {
    if (
        !(error instanceof QualifiedConnectedAccountGroupConflictError)
        || error.code !== 'connect_group_generation_conflict'
    ) {
        return null;
    }
    return error.generation;
}

export function createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator(
    params: Readonly<{
        token: string;
        accountScope?: ConnectedServiceAuthGroupAccountScope;
        isCurrent?: () => Promise<boolean>;
        quotaFreshnessMs: number;
        nowMs: () => number;
        accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState;
        probeQuotaSnapshotsForGroup?: (input: Readonly<{
            serviceId: QualifiedConnectedAccountServiceRef; groupId: string; profileIds: ReadonlyArray<string>; reason: string;
        }>) => Promise<ConnectedServiceAuthGroupQuotaProbeResult | void>;
        consumeAvailableRecoveryCreditForProfile?: (input: Readonly<{
            serviceId: QualifiedConnectedAccountServiceRef; groupId: string; profileId: string;
            automaticResetContext: Readonly<{ groupId: string; sessionId?: string }>;
        }>) => Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>;
        api?: QualifiedConnectedAccountAuthGroupApi;
        leases?: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
            QualifiedConnectedAccountServiceRef
        >;
        applyGeneration: (
            input: ConnectedServiceAuthGroupGenerationApplyInput<
                QualifiedConnectedAccountServiceRef
            >,
        ) => Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
        prepareCandidateForSwitch?: (input: Readonly<{
            serviceId: QualifiedConnectedAccountServiceRef;
            groupId: string;
            profileId: string;
            reason: string;
        }>) => Promise<ConnectedServiceAuthGroupCandidatePreparationResult>;
        emitEvent?: (
            event: ConnectedServiceAuthGroupSwitchEvent<
                QualifiedConnectedAccountServiceRef
            >,
        ) => void;
    }>,
): ConnectedServiceAuthGroupSwitchCoordinator<
    QualifiedConnectedAccountServiceRef
> {
    const api =
        params.api ?? defaultQualifiedConnectedAccountAuthGroupApi;
    const assertCurrent = async () => {
        if (params.isCurrent && !await params.isCurrent()) throw new Error('requester_session_not_current');
    };
    const buildState = (input: Parameters<typeof buildQualifiedConnectedAccountAuthGroupSwitchState>[0]) => {
        const state = buildQualifiedConnectedAccountAuthGroupSwitchState(input);
        const usage = params.accountUsageStore ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
            group: buildQualifiedConnectedAccountAuthGroupAccountUsageView(input.group), accountUsageStore: params.accountUsageStore,
        }) : null;
        if (!usage) return state;
        return { ...state, memberStatesByProfileId: new Map([...state.memberStatesByProfileId].map(([profileId, member]) => [
            profileId, { ...usage.state.memberStatesByProfileId.get(profileId), ...member },
        ])) };
    };

    const loadState = async (input: Readonly<{
        serviceId: QualifiedConnectedAccountServiceRef;
        groupId: string;
    }>) => {
        const service =
            QualifiedConnectedAccountServiceRefSchema.parse(
                input.serviceId,
            );
        await assertCurrent();
        const group = await api.readGroup({
            token: params.token,
            group: { service, groupId: input.groupId },
        });
        if (!group) {
            throw new Error(
                'qualified_connected_account_group_not_found',
            );
        }
        assertExactGroup(group, service, input.groupId);
        await assertCurrent();
        const listed = await api.listAccounts({
            token: params.token,
            service,
        });
        assertExactAccountList(service, listed);
        await assertCurrent();
        const accountIds = new Set(
            listed.accounts.map((profile) => profile.ref.accountId),
        );
        if (
            group.members.some(
                (member) => !accountIds.has(
                    member.connectedAccountId,
                ),
            )
        ) {
            throw new Error(
                'qualified_connected_account_group_member_missing',
            );
        }
        return buildState({
            group,
            profiles: listed.accounts,
        });
    };

    return new ConnectedServiceAuthGroupSwitchCoordinator({
        accountScope: params.accountScope,
        leases: params.leases
            ?? new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
                QualifiedConnectedAccountServiceRef
            >(),
        nowMs: params.nowMs,
        quotaFreshnessMs: params.quotaFreshnessMs,
        loadState,
        probeQuotaSnapshotsForGroup: params.probeQuotaSnapshotsForGroup,
        consumeAvailableRecoveryCreditForProfile: params.consumeAvailableRecoveryCreditForProfile,
        commitSwitch: async (input) => {
            const service =
                QualifiedConnectedAccountServiceRefSchema.parse(
                    input.serviceId,
                );
            if (
                !input.fromProfileId
                || !input.expectedIncarnation
                || input.expectedRuntimeStateRevision === undefined
                || input.expectedCredentialRevision == null
                || input.expectedConfigurationRevision === undefined
            ) {
                throw new Error(
                    'qualified_connected_account_switch_basis_unavailable',
                );
            }
            await assertCurrent();
            const group = await api.setActiveAccount({
                token: params.token,
                mutation: {
                    group: {
                        service,
                        groupId: input.groupId,
                    },
                    connectedAccountId: input.toProfileId,
                    expectedGeneration: input.expectedGeneration,
                    expectedIncarnation: input.expectedIncarnation,
                    expectedRuntimeStateRevision:
                        input.expectedRuntimeStateRevision,
                    expectedSource: {
                        connectedAccountId: input.fromProfileId,
                        credentialRevision:
                            input.expectedCredentialRevision,
                        configurationRevision:
                            input.expectedConfigurationRevision,
                    },
                    overrideRuntimeCooldown: true,
                },
            });
            assertExactGroup(group, service, input.groupId);
            await assertCurrent();
            const listed = await api.listAccounts({
                token: params.token,
                service,
            });
            assertExactAccountList(service, listed);
            await assertCurrent();
            return buildState({
                group,
                profiles: listed.accounts,
            });
        },
        ...(params.prepareCandidateForSwitch
            ? {
                prepareCandidateForSwitch:
                    params.prepareCandidateForSwitch,
            }
            : {}),
        recordObservedFailureState: async (input) => {
            const service =
                QualifiedConnectedAccountServiceRefSchema.parse(
                    input.serviceId,
                );
            const observedAccountId =
                input.observedProfileId?.trim()
                || input.loaded.activeProfileId;
            if (!observedAccountId) return;
            await updateConnectedServiceAuthGroupRuntimeStateWithRetry<
                QualifiedConnectedAccountServiceRef,
                QualifiedConnectedAccountGroupV4,
                Readonly<{
                    expectedIncarnation: string;
                    runtimeState: Readonly<{
                        memberStates: ReadonlyArray<Readonly<{
                            connectedAccountId: string;
                            state:
                                QualifiedConnectedAccountGroupV4[
                                    'members'
                                ][number]['state'];
                        }>>;
                    }>;
                }>
            >({
                serviceId: service,
                groupId: input.groupId,
                expectedGeneration: input.loaded.generation,
                loadGroup: async () => {
                    await assertCurrent();
                    const group = await api.readGroup({
                        token: params.token,
                        group: {
                            service,
                            groupId: input.groupId,
                        },
                    });
                    await assertCurrent();
                    if (group) {
                        assertExactGroup(
                            group,
                            service,
                            input.groupId,
                        );
                    }
                    return group;
                },
                buildPatch: (group) => {
                    const member = group.members.find(
                        (candidate) => (
                            candidate.connectedAccountId
                                === observedAccountId
                        ),
                    );
                    if (!member) return null;
                    const observedAtMs = params.nowMs();
                    return {
                        expectedIncarnation: group.incarnation,
                        runtimeState: {
                            memberStates: [{
                                connectedAccountId:
                                    observedAccountId,
                                state:
                                    buildConnectedServiceAuthGroupObservedFailureMemberState({
                                        existing: member.state,
                                        reason: input.reason,
                                        limitCategory:
                                            input.limitCategory,
                                        quotaScope: input.quotaScope,
                                        providerLimitId:
                                            input.providerLimitId,
                                        retryAtMs:
                                            resolveConnectedServiceAuthGroupFailureRetryAtMs({
                                                retryAtMs:
                                                    input.retryAtMs,
                                                retryAfterMs:
                                                    input.retryAfterMs,
                                                resetsAtMs:
                                                    input.resetsAtMs,
                                                nowMs:
                                                    observedAtMs,
                                            }),
                                        cooldownMs:
                                            input.loaded.policy
                                                .cooldownMs,
                                        autoDisablePlanInvalidAccounts:
                                            input.loaded.policy
                                                .autoDisablePlanInvalidAccounts,
                                        planType:
                                            input.planType,
                                        observedAtMs,
                                    }),
                            }],
                        },
                    };
                },
                update: async ({
                    serviceId,
                    groupId,
                    expectedGeneration,
                    expectedIncarnation,
                    expectedRuntimeStateRevision,
                    runtimeState,
                }) => {
                    await assertCurrent();
                    const observedState = runtimeState.memberStates.find(
                        (candidate) => candidate.connectedAccountId
                            === observedAccountId,
                    )?.state;
                    if (
                        observedState?.autoDisabledReason
                            === 'model_not_entitled'
                        && api.updateMember
                    ) {
                        return await api.updateMember({
                            token: params.token,
                            mutation: {
                                group: { service: serviceId, groupId },
                                connectedAccountId: observedAccountId,
                                expectedGeneration:
                                    expectedGeneration,
                                expectedIncarnation:
                                    expectedIncarnation,
                                expectedRuntimeStateRevision:
                                    expectedRuntimeStateRevision,
                                enabled: false,
                                state: observedState,
                            },
                        });
                    }
                    return await api.updateRuntimeState({
                        token: params.token,
                        patch: {
                            service: serviceId,
                            groupId,
                            expectedGeneration,
                            expectedIncarnation,
                            expectedRuntimeStateRevision,
                            runtimeState,
                        },
                    });
                },
            });
        },
        applyGeneration: async (input) => { await assertCurrent(); return await params.applyGeneration(input); },
        resolveGenerationConflict:
            resolveQualifiedGroupGenerationConflict,
        ...(params.emitEvent
            ? { emitEvent: params.emitEvent }
            : {}),
    });
}
