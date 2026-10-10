import {
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountGroupMemberMutationV4Schema,
    buildProviderAccountUsageRecordId,
    buildQualifiedPluginContributionKey,
    QualifiedConnectedAccountListResponseV4Schema,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';

import { QualifiedConnectedAccountGroupConflictError } from '@/api/client/qualifiedConnectedAccountApi';
import { applyConnectedAccountRequestAuthRecovery } from '../requestAuth/ConnectedAccountRequestAuthRecovery';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from './createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { createProviderAccountUsageStore } from '../accountUsage/store';

const service = {
    pluginId: 'example.connected-accounts',
    localId: 'service/with/path',
} as const;
const primaryCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const backupCredentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
const replacementCredentialRevision = 'csr_cccccccccccccccccccccc';

function group(input: Readonly<{
    activeConnectedAccountId: string;
    generation: number;
    runtimeStateRevision: number;
    includePrimary?: boolean;
}>): QualifiedConnectedAccountGroupV4 {
    return QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1,
        ref: { service, groupId: 'fallbacks' },
        incarnation: 'qualified-group-row-fallbacks',
        displayName: 'Fallbacks',
        policy: {
            ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
            autoSwitch: true,
        },
        activeConnectedAccountId: input.activeConnectedAccountId,
        generation: input.generation,
        runtimeStateRevision: input.runtimeStateRevision,
        state: {},
        createdAt: 1,
        updatedAt: 1,
        members: [
            ...(input.includePrimary === false ? [] : [{
                v: 1,
                connectedAccountId: 'primary',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 1,
            }]),
            {
                v: 1,
                connectedAccountId: 'backup',
                priority: 20,
                enabled: true,
                state: {},
                createdAt: 2,
                updatedAt: 2,
            },
        ],
    });
}

function accounts(
    input: Readonly<{
        accountService?: QualifiedConnectedAccountServiceRef;
        primaryRevision?: string;
        primaryConfigurationRevision?: string | null;
        includePrimary?: boolean;
    }> = {},
) {
    return QualifiedConnectedAccountListResponseV4Schema.parse({
        service,
        accounts: [
            ...(input.includePrimary === false ? [] : [{
                ref: {
                    service: input.accountService ?? service,
                    accountId: 'primary',
                },
                status: 'connected',
                authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned',
                credentialRevision:
                    input.primaryRevision
                    ?? primaryCredentialRevision,
                configurationReady: true,
                configurationRevision:
                    input.primaryConfigurationRevision === undefined
                        ? 'configuration-primary'
                        : input.primaryConfigurationRevision,
                scopes: [],
            }]),
            {
                ref: {
                    service: input.accountService ?? service,
                    accountId: 'backup',
                },
                status: 'connected',
                authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned',
                credentialRevision: backupCredentialRevision,
                configurationReady: true,
                configurationRevision: null,
                scopes: [],
            },
        ],
    });
}

function resolved() {
    return {
        account: { service, accountId: 'primary' },
        group: { groupId: 'fallbacks', generation: 7 },
        credentialRevision: primaryCredentialRevision,
    } as const;
}

function accountScopedUsageFailure() {
    return {
        class: 'quota',
        evidence: {
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            evidenceSource: { kind: 'structured' },
        },
    } as const;
}

describe('createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator', () => {
    it('reads selection from the live group and stored quota without preparing or switching', async () => {
        const currentGroup = group({ activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 3 });
        const accountUsageStore = createProviderAccountUsageStore();
        const recordKey = { providerId: 'example', accountSubjectId: 'backup', subjectKind: 'subscription' as const, quotaScope: 'account' as const };
        accountUsageStore.recordSnapshot({
            v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'example', accountSubject: { kind: 'providerSubject', id: 'backup' },
            observedAtMs: 900, fetchedAtMs: 900, staleAfterMs: 60_000,
            source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
            meters: [{ meterId: 'weekly', label: 'Weekly', used: 70, limit: 100, unit: 'credits', utilizationPct: 70, remainingPct: 30, resetsAt: 100_000, status: 'ok', details: { limitCategory: 'usage_limit' } }],
        }, { sources: [{
            serviceId: buildQualifiedPluginContributionKey(service), profileId: 'backup',
            bindingKind: 'group_member', groupId: 'fallbacks', groupGeneration: 7,
        }] });
        const forbiddenEffect = async () => { throw new Error('read must not mutate or refresh'); };
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: 'read-token', quotaFreshnessMs: 60_000, nowMs: () => 1_000,
            accountUsageStore,
            api: { readGroup: async () => currentGroup, listAccounts: async () => accounts(),
                setActiveAccount: forbiddenEffect, updateRuntimeState: forbiddenEffect },
            applyGeneration: forbiddenEffect, prepareCandidateForSwitch: forbiddenEffect,
            probeQuotaSnapshotsForGroup: forbiddenEffect,
        });
        const result = await coordinator.readSelection({ serviceId: service, groupId: 'fallbacks' });
        expect(ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group: currentGroup.ref, ...result })).toEqual({ group: currentGroup.ref, ...result });
        expect(result.observedAtMs).toBe(1_000);
        expect(result.selection.selected?.profileId).toBe('primary');
        expect(result.selection.decisionTrace.orderedEligibleCandidates.map((candidate) => candidate.profileId)).toEqual(['backup', 'primary']);
        expect(result.selection.decisionTrace.orderedEligibleCandidates[0]?.leastLimitedScore).toBe(30);
        expect(result.selection.decisionTrace.sticky).toBe(true);
        expect(currentGroup.activeConnectedAccountId).toBe('primary');
        expect(currentGroup.generation).toBe(7);
    });

    it('refuses a selection read when captured requester authority retires during hydration', async () => {
        let current = true;
        const currentGroup = group({ activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 3 });
        const forbiddenEffect = async () => { throw new Error('read must not mutate'); };
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: 'read-token', quotaFreshnessMs: 60_000, nowMs: () => 1_000, isCurrent: async () => current,
            api: { readGroup: async () => currentGroup, listAccounts: async () => { current = false; return accounts(); },
                setActiveAccount: forbiddenEffect, updateRuntimeState: forbiddenEffect },
            applyGeneration: forbiddenEffect,
        });
        await expect(coordinator.readSelection({ serviceId: service, groupId: 'fallbacks' })).rejects.toThrow('requester_session_not_current');
    });
    it('does not commit an Account group after requester admission is lost during its read', async () => {
        let current = true;
        let currentGroup = group({ activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 3 });
        const setActiveAccount = vi.fn(async () => {
            currentGroup = group({ activeConnectedAccountId: 'backup', generation: 8, runtimeStateRevision: 3 });
            return currentGroup;
        });
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: 'bob-token', quotaFreshnessMs: 60_000, nowMs: () => 1_000,
            isCurrent: async () => current,
            api: {
                readGroup: async () => currentGroup,
                listAccounts: async () => { current = false; return accounts(); },
                setActiveAccount,
                updateRuntimeState: async () => currentGroup,
            },
            applyGeneration: async () => ({ ok: true as const, mode: 'spawn_next_turn' as const }),
        });
        await coordinator.switchBeforeTurn({ sessionId: 'bob-session', serviceId: service,
            groupId: 'fallbacks', reason: 'auth_expired', observedProfileId: 'primary' }).catch(() => undefined);
        expect(currentGroup.activeConnectedAccountId).toBe('primary');
        expect(setActiveAccount).not.toHaveBeenCalled();
    });

    it('persistently disables the exact model-ineligible member when the pool opts in', async () => {
        let currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
            ...group({ activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 3 }),
            policy: {
                ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
                autoSwitch: true,
                autoDisablePlanInvalidAccounts: true,
            },
        });
        const updateRuntimeState = vi.fn(async () => currentGroup);
        const updateMember = vi.fn(async (input: Readonly<{ token: string; mutation: unknown }>) => {
            const mutation = QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(
                input.mutation,
            );
            currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
                ...currentGroup,
                activeConnectedAccountId: 'backup',
                generation: currentGroup.generation + 1,
                runtimeStateRevision: currentGroup.runtimeStateRevision + 1,
                members: currentGroup.members.map((member) => member.connectedAccountId === 'primary'
                    ? { ...member, enabled: false, state: mutation.state }
                    : member),
            });
            return currentGroup;
        });
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: 'server-token', quotaFreshnessMs: 60_000, nowMs: () => 1_000,
            api: {
                readGroup: async () => currentGroup,
                listAccounts: async () => accounts(),
                setActiveAccount: vi.fn(async () => currentGroup),
                updateRuntimeState,
                updateMember,
            },
            applyGeneration: vi.fn(async () => ({ ok: true as const, mode: 'spawn_next_turn' as const })),
        });

        await coordinator.switchAfterClassifiedFailure({
            serviceId: service,
            groupId: 'fallbacks',
            reason: 'plan',
            limitCategory: 'plan_invalid',
            quotaScope: 'model',
            providerLimitId: 'gpt-5.6-sol',
            observedProfileId: 'primary',
            planType: 'free',
        });

        expect(updateMember).toHaveBeenCalledWith({
            token: 'server-token',
            mutation: expect.objectContaining({
                connectedAccountId: 'primary',
                enabled: false,
                expectedGeneration: 7,
                expectedRuntimeStateRevision: 3,
                state: expect.objectContaining({
                    autoDisabledReason: 'model_not_entitled',
                    lastFailureCode: 'model_not_entitled',
                }),
            }),
        });
        expect(updateRuntimeState).not.toHaveBeenCalled();
        expect(currentGroup.members.find((member) => member.connectedAccountId === 'primary')).toMatchObject({
            enabled: false,
            state: {
                autoDisabledReason: 'model_not_entitled',
                lastFailureCode: 'model_not_entitled',
                modelUnavailableUntilMsByModelId: { 'gpt-5.6-sol': 86_401_000 },
            },
        });
    });

    it('uses canonical qualified account-usage evidence before choosing a group fallback', async () => {
        const accountUsageStore = createProviderAccountUsageStore();
        const recordKey = { providerId: 'example', accountSubjectId: 'backup', subjectKind: 'subscription' as const, quotaScope: 'account' as const };
        accountUsageStore.recordSnapshot({
            v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'example', accountSubject: { kind: 'providerSubject', id: 'backup' },
            observedAtMs: 900, fetchedAtMs: 900, staleAfterMs: 60_000,
            source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
            meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'credits', utilizationPct: 100, remainingPct: 0, resetsAt: 100_000, status: 'ok', details: { limitCategory: 'usage_limit' } }],
        }, { sources: [{
            serviceId: buildQualifiedPluginContributionKey(service), profileId: 'backup',
            bindingKind: 'group_member', groupId: 'fallbacks', groupGeneration: 7,
        }] });
        const currentGroup = group({ activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 3 });
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: 'server-token', quotaFreshnessMs: 60_000, nowMs: () => 1_000,
            accountUsageStore,
            api: {
                readGroup: async () => currentGroup,
                listAccounts: async () => accounts(),
                setActiveAccount: async () => { throw new Error('exhausted account must not be activated'); },
                updateRuntimeState: async () => currentGroup,
            },
            applyGeneration: async () => { throw new Error('exhausted account must not be applied'); },
        });
        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: service, groupId: 'fallbacks', reason: 'usage_limit', observedProfileId: 'primary',
        })).resolves.toMatchObject({
            status: 'no_eligible_member',
            excluded: expect.arrayContaining([expect.objectContaining({ profileId: 'backup', reason: 'quota_exhausted' })]),
        });
    });

    it('switches a novel service through the existing policy, selector, and coordinator with exact qualified CAS basis', async () => {
        let currentGroup = group({
            activeConnectedAccountId: 'primary',
            generation: 7,
            runtimeStateRevision: 3,
        });
        const updateRuntimeState = vi.fn(async (input: Readonly<{ patch: unknown }>) => {
            const patch = input.patch as {
                expectedRuntimeStateRevision: number;
                runtimeState: {
                    memberStates: Array<{
                        connectedAccountId: string;
                        state: Record<string, unknown>;
                    }>;
                };
            };
            currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
                ...currentGroup,
                runtimeStateRevision: currentGroup.runtimeStateRevision + 1,
                members: currentGroup.members.map((member) => {
                    const replacement = patch.runtimeState.memberStates.find(
                        (candidate) => candidate.connectedAccountId
                            === member.connectedAccountId,
                    );
                    return replacement
                        ? { ...member, state: replacement.state }
                        : member;
                }),
            });
            return currentGroup;
        });
        const setActiveAccount = vi.fn(async () => {
            currentGroup = group({
                activeConnectedAccountId: 'backup',
                generation: 8,
                runtimeStateRevision: 5,
            });
            return currentGroup;
        });
        const applyGeneration = vi.fn(async () => ({
            ok: true as const,
            mode: 'spawn_next_turn' as const,
        }));
        const coordinator =
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: 'server-token',
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                api: {
                    readGroup: vi.fn(async () => currentGroup),
                    listAccounts: vi.fn(async () => accounts()),
                    setActiveAccount,
                    updateRuntimeState,
                },
                applyGeneration,
            });

        await expect(applyConnectedAccountRequestAuthRecovery({
            resolved: resolved(),
            failure: accountScopedUsageFailure(),
            refreshCredential: vi.fn(async () => false),
            switchAfterClassifiedFailure:
                coordinator.switchAfterClassifiedFailure.bind(coordinator),
            recordTemporaryRetry: vi.fn(async () => ({
                status: 'recorded' as const,
            })),
        })).resolves.toMatchObject({
            effect: 'switch_account',
            decision: {
                action: 'switch_account',
                serviceId: service,
            },
        });

        expect(updateRuntimeState).not.toHaveBeenCalled();
        expect(setActiveAccount).toHaveBeenCalledWith({
            token: 'server-token',
            mutation: {
                group: { service, groupId: 'fallbacks' },
                connectedAccountId: 'backup',
                expectedIncarnation: 'qualified-group-row-fallbacks',
                expectedGeneration: 7,
                expectedRuntimeStateRevision: 3,
                expectedSource: {
                    connectedAccountId: 'primary',
                    credentialRevision: primaryCredentialRevision,
                    configurationRevision: 'configuration-primary',
                },
                overrideRuntimeCooldown: true,
            },
        });
        expect(applyGeneration).toHaveBeenCalledWith({
            serviceId: service,
            groupId: 'fallbacks',
            activeProfileId: 'backup',
            generation: 8,
            credentialRevision: backupCredentialRevision,
            reason: 'usage_limit',
        });
        expect(updateRuntimeState).not.toHaveBeenCalled();
        expect(setActiveAccount).toHaveBeenCalledOnce();
        expect(applyGeneration).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'replacement credential',
            group({
                activeConnectedAccountId: 'primary',
                generation: 7,
                runtimeStateRevision: 3,
            }),
            accounts({
                primaryRevision: replacementCredentialRevision,
            }),
        ],
        [
            'newer group generation',
            group({
                activeConnectedAccountId: 'primary',
                generation: 8,
                runtimeStateRevision: 3,
            }),
            accounts(),
        ],
        [
            'different current group member',
            group({
                activeConnectedAccountId: 'backup',
                generation: 8,
                runtimeStateRevision: 3,
            }),
            accounts(),
        ],
        [
            'removed failed account',
            group({
                activeConnectedAccountId: 'backup',
                generation: 8,
                runtimeStateRevision: 3,
                includePrimary: false,
            }),
            accounts({ includePrimary: false }),
        ],
    ] as const)(
        'ignores request-auth evidence after a %s before any qualified group effect',
        async (_label, currentGroup, currentAccounts) => {
            const updateRuntimeState = vi.fn();
            const setActiveAccount = vi.fn();
            const applyGeneration = vi.fn();
            const coordinator =
                createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                    token: 'server-token',
                    quotaFreshnessMs: 60_000,
                    nowMs: () => 1_000,
                    api: {
                        readGroup: vi.fn(async () => currentGroup),
                        listAccounts: vi.fn(async () => currentAccounts),
                        setActiveAccount,
                        updateRuntimeState,
                    },
                    applyGeneration,
                });

            await expect(applyConnectedAccountRequestAuthRecovery({
                resolved: resolved(),
                failure: accountScopedUsageFailure(),
                refreshCredential: vi.fn(async () => false),
                switchAfterClassifiedFailure:
                    coordinator.switchAfterClassifiedFailure.bind(
                        coordinator,
                    ),
                recordTemporaryRetry: vi.fn(async () => ({
                    status: 'recorded' as const,
                })),
            })).resolves.toMatchObject({
                effect: 'stale_context',
                decision: {
                    action: 'switch_account',
                },
            });
            expect(updateRuntimeState).not.toHaveBeenCalled();
            expect(setActiveAccount).not.toHaveBeenCalled();
            expect(applyGeneration).not.toHaveBeenCalled();
        },
    );

    it('revalidates replacement credentials returned after an awaited account read before any effect', async () => {
        const currentGroup = group({
            activeConnectedAccountId: 'primary',
            generation: 7,
            runtimeStateRevision: 3,
        });
        let releaseAccounts!: (
            value: ReturnType<typeof accounts>,
        ) => void;
        const pendingAccounts = new Promise<
            ReturnType<typeof accounts>
        >((resolve) => {
            releaseAccounts = resolve;
        });
        const listAccounts = vi.fn(async () => await pendingAccounts);
        const updateRuntimeState = vi.fn();
        const setActiveAccount = vi.fn();
        const applyGeneration = vi.fn();
        const coordinator =
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: 'server-token',
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                api: {
                    readGroup: vi.fn(async () => currentGroup),
                    listAccounts,
                    setActiveAccount,
                    updateRuntimeState,
                },
                applyGeneration,
            });

        const recovery =
            applyConnectedAccountRequestAuthRecovery({
                resolved: resolved(),
                failure: accountScopedUsageFailure(),
                refreshCredential: vi.fn(async () => false),
                switchAfterClassifiedFailure:
                    coordinator.switchAfterClassifiedFailure.bind(
                        coordinator,
                    ),
                recordTemporaryRetry: vi.fn(async () => ({
                    status: 'recorded' as const,
                })),
            });
        await vi.waitFor(() => {
            expect(listAccounts).toHaveBeenCalledOnce();
        });
        releaseAccounts(accounts({
            primaryRevision: replacementCredentialRevision,
        }));

        await expect(recovery).resolves.toMatchObject({
            effect: 'stale_context',
        });
        expect(updateRuntimeState).not.toHaveBeenCalled();
        expect(setActiveAccount).not.toHaveBeenCalled();
        expect(applyGeneration).not.toHaveBeenCalled();
    });

    it('does not write failure state when the failed credential is replaced after the initial qualified read', async () => {
        const currentGroup = group({
            activeConnectedAccountId: 'primary',
            generation: 7,
            runtimeStateRevision: 3,
        });
        let currentAccounts = accounts();
        let listCount = 0;
        const listAccounts = vi.fn(async () => {
            listCount += 1;
            const observed = currentAccounts;
            if (listCount === 1) {
                queueMicrotask(() => {
                    currentAccounts = accounts({
                        primaryRevision:
                            replacementCredentialRevision,
                    });
                });
            }
            return observed;
        });
        const updateRuntimeState = vi.fn(async () => currentGroup);
        const setActiveAccount = vi.fn();
        const applyGeneration = vi.fn();
        const coordinator =
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: 'server-token',
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                api: {
                    readGroup: vi.fn(async () => currentGroup),
                    listAccounts,
                    setActiveAccount,
                    updateRuntimeState,
                },
                applyGeneration,
            });

        await expect(applyConnectedAccountRequestAuthRecovery({
            resolved: resolved(),
            failure: accountScopedUsageFailure(),
            refreshCredential: vi.fn(async () => false),
            switchAfterClassifiedFailure:
                coordinator.switchAfterClassifiedFailure.bind(
                    coordinator,
                ),
            recordTemporaryRetry: vi.fn(async () => ({
                status: 'recorded' as const,
            })),
        })).resolves.toMatchObject({
            effect: 'stale_context',
        });
        expect(updateRuntimeState).not.toHaveBeenCalled();
        expect(setActiveAccount).not.toHaveBeenCalled();
        expect(applyGeneration).not.toHaveBeenCalled();
    });

    it.each([
        ['capacity', 'provider'],
        ['temporary_throttle', 'account'],
    ] as const)(
        'does not switch for %s with %s scope',
        async (limitCategory, quotaScope) => {
            const switchAfterClassifiedFailure = vi.fn();

            await expect(applyConnectedAccountRequestAuthRecovery({
                resolved: resolved(),
                failure: {
                    class: 'quota',
                    evidence: {
                        limitCategory,
                        quotaScope,
                        evidenceSource: { kind: 'structured' },
                    },
                },
                refreshCredential: vi.fn(async () => false),
                switchAfterClassifiedFailure,
                recordTemporaryRetry: vi.fn(async () => ({
                    status: 'recorded' as const,
                })),
            })).resolves.toMatchObject({
                effect: 'temporary_retry',
                decision: { action: 'temporary_retry' },
            });
            expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        },
    );

    it('atomically rejects a cross-daemon configuration replacement with the same group generation', async () => {
        let currentGroup = group({
            activeConnectedAccountId: 'primary',
            generation: 7,
            runtimeStateRevision: 3,
        });
        let currentAccounts = accounts();
        const applyGeneration = vi.fn();
        const setActiveAccount = vi.fn(async (input) => {
            currentAccounts = accounts({
                primaryConfigurationRevision:
                    'configuration-replaced-remotely',
            });
            const currentPrimary = currentAccounts.accounts.find(
                (candidate) => candidate.ref.accountId === 'primary',
            );
            if (
                input.mutation.expectedSource.configurationRevision
                !== currentPrimary?.configurationRevision
            ) {
                throw new QualifiedConnectedAccountGroupConflictError({
                    code: 'connect_group_source_revision_conflict',
                });
            }
            throw new Error('stale source unexpectedly committed');
        });
        const coordinator =
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: 'server-token',
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                api: {
                    readGroup: vi.fn(async () => currentGroup),
                    listAccounts: vi.fn(async () => currentAccounts),
                    setActiveAccount,
                    updateRuntimeState: vi.fn(async () => {
                        currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
                            ...currentGroup,
                            runtimeStateRevision: 4,
                        });
                        return currentGroup;
                    }),
                },
                applyGeneration,
            });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: service,
            groupId: 'fallbacks',
            observedProfileId: 'primary',
            reason: 'usage_limit',
        })).rejects.toMatchObject({
            code: 'connect_group_source_revision_conflict',
        });
        expect(setActiveAccount).toHaveBeenCalledWith(expect.objectContaining({
            mutation: expect.objectContaining({
                expectedSource: {
                    connectedAccountId: 'primary',
                    credentialRevision: primaryCredentialRevision,
                    configurationRevision: 'configuration-primary',
                },
            }),
        }));
        expect(applyGeneration).not.toHaveBeenCalled();
    });

    it('fails closed on a cross-service account-list response before selecting a candidate', async () => {
        const setActiveAccount = vi.fn();
        const applyGeneration = vi.fn();
        const coordinator =
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: 'server-token',
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                api: {
                    readGroup: vi.fn(async () => group({
                        activeConnectedAccountId: 'primary',
                        generation: 7,
                        runtimeStateRevision: 3,
                    })),
                    listAccounts: vi.fn(async () => accounts({
                        accountService: {
                            pluginId: 'another.plugin',
                            localId: service.localId,
                        },
                    })),
                    setActiveAccount,
                    updateRuntimeState: vi.fn(),
                },
                applyGeneration,
            });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: service,
            groupId: 'fallbacks',
            observedProfileId: 'primary',
            reason: 'usage_limit',
        })).rejects.toThrow(
            'qualified_connected_account_list_service_mismatch',
        );
        expect(setActiveAccount).not.toHaveBeenCalled();
        expect(applyGeneration).not.toHaveBeenCalled();
    });
});
