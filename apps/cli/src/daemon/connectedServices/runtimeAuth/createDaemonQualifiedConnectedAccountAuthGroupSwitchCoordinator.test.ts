import {
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { QualifiedConnectedAccountGroupConflictError } from '@/api/client/qualifiedConnectedAccountApi';
import { applyConnectedAccountRequestAuthRecovery } from '../requestAuth/ConnectedAccountRequestAuthRecovery';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from './createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';

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
