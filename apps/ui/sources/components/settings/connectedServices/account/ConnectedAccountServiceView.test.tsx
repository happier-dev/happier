import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createRootLayoutFeaturesResponse,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';

const runControlMock = vi.hoisted(() => vi.fn());
const runAuthenticationMock = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());
const listQualifiedGroupsV4Mock = vi.hoisted(() => vi.fn());
const listLegacyGroupsV3Mock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
    credentials: {
        token: 'token',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
}));
const modalConfirmMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const applySettingsMock = vi.hoisted(() => vi.fn());
const administrationTargetState = vi.hoisted(() => ({
    current: {
        target: {
            serverIdentityId: 'server-identity-a',
            machineId: 'machine-1',
        },
        serverId: 'server-a',
        machine: {
            id: 'machine-1',
            active: true,
            metadata: { displayName: 'Machine' },
        },
    } as Readonly<{
        target: Readonly<{ serverIdentityId: string; machineId: string }>;
        serverId: string;
        machine: Readonly<{
            id: string;
            active: boolean;
            metadata: Readonly<{ displayName: string }>;
        }>;
    }> | null,
}));
const routeState = vi.hoisted(() => ({
    serviceId: undefined as string | undefined,
    pluginId: 'acme.accounts',
    localId: 'work',
    accountId: undefined as string | undefined,
    groupId: undefined as string | undefined,
    serverId: undefined as string | undefined,
    machineId: undefined as string | undefined,
}));
const machineState = vi.hoisted(() => ({
    current: [
        { id: 'machine-1', active: true, metadata: { displayName: 'Machine' } },
    ],
}));
const settingsState = vi.hoisted(() => ({
    current: {
        connectedServicesDefaultProfileByServiceId: {},
        connectedServicesProfileLabelByKey: {},
    } as {
        connectedServicesDefaultProfileByServiceId: Record<string, string>;
        connectedServicesProfileLabelByKey: Record<string, string>;
    },
}));
const profileState = vi.hoisted(() => ({
    connectedServicesV2: [] as ReadonlyArray<Readonly<{
        serviceId: string;
        profiles: readonly Readonly<Record<string, unknown>>[];
    }>>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The testkit owns this boundary. The previous inline mock returned the
// stylesheet FACTORY unevaluated and carried only four colour groups, which the
// full account block (surfaces, state tones, shadows) cannot render against.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
// The testkit owns this boundary. Params stay driven by `routeState` so each
// test picks the route focus, while navigation now goes through the tracked
// router the drill-in affordances push onto.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => ({ ...routeState }),
        router: { canGoBack: () => true },
    }).module;
});
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://server.test', generation: 1 }),
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: getReadyServerFeaturesMock,
}));
vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    listQualifiedConnectedAccountGroupsV4: listQualifiedGroupsV4Mock,
}));
vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => ({
    listConnectedServiceAuthGroupsV3: listLegacyGroupsV3Mock,
}));
vi.mock('@happier-dev/protocol', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/protocol')>(),
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID: {
        github: {
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            peerOperations: {
                exactV0_2_1: [],
                revisionedV2V3: [
                    'account_list',
                    'credential_read',
                    'credential_write',
                    'credential_delete',
                ],
            },
            defaultAuthenticationModeId: 'oauth',
            authenticationModeByCredentialKind: { oauth: 'oauth' },
            unsupportedAuthenticationModeByCredentialKind: {},
        },
        'openai-codex': {
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            peerOperations: {
                exactV0_2_1: [
                    'account_list',
                    'credential_read',
                    'one_shot_materialization',
                ],
                revisionedV2V3: [
                    'account_list',
                    'credential_read',
                    'credential_write',
                    'credential_delete',
                    'quota_read',
                    'quota_refresh',
                ],
            },
            defaultAuthenticationModeId: 'oauth',
            authenticationModeByCredentialKind: { oauth: 'oauth' },
            unsupportedAuthenticationModeByCredentialKind: {},
        },
        bitbucket: {
            service: {
                pluginId: 'happier.scm.forge.bitbucket',
                localId: 'bitbucket-account',
            },
            peerOperations: {
                exactV0_2_1: [],
                revisionedV2V3: [],
            },
        },
    },
}));
vi.mock('@/sync/store/hooks', async () => {
    // `useLocalSetting` reaches this module through the row-density and font-scale
    // hooks under Item/DropdownMenu; the testkit owns that boundary's defaults.
    const {
        createUseLocalSettingMock,
        createUseSettingMutableMock,
    } = await import('@/dev/testkit/mocks/storage');
    const useSetting = ((name: string) =>
        (settingsState.current as Record<string, unknown>)[name]
    ) as never;
    return {
        useAllMachines: () => machineState.current,
        useMachineListByServerId: () => ({ 'server-a': machineState.current }),
        useProfile: () => profileState,
        useSessions: () => [],
        useSettings: () => settingsState.current,
        // Account blocks read individual synced settings (pinned usage meters,
        // collapse state) through `useSetting`; project them off the same state
        // the `useSettings` mock returns so the two can never disagree.
        useSetting,
        // Account blocks persist collapse state through `useSettingMutable`; the
        // testkit owns that boundary's read/write pairing.
        useSettingMutable: createUseSettingMutableMock(useSetting),
        useLocalSetting: createUseLocalSettingMock(),
    };
});
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));
vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        candidates: [],
        pickerRows: [],
        state: { kind: 'unselected', candidates: [] },
        selectedTarget: administrationTargetState.current?.target ?? null,
        canExecute: administrationTargetState.current !== null,
        selectTarget: () => {},
        clearTarget: () => {},
        resolveExecutionTarget: () => administrationTargetState.current,
    }),
}));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));
function currentRegistryEntry() {
    const github = routeState.serviceId === 'github'
        || routeState.pluginId === 'happier.scm.forge.github';
    const bitbucket = routeState.serviceId === 'bitbucket'
        || routeState.pluginId === 'happier.scm.forge.bitbucket';
    const codex = routeState.serviceId === 'openai-codex'
        || routeState.pluginId === 'happier.agent.codex';
    if (codex) {
        return {
            serviceId: 'openai-codex',
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            projectedTitle: 'Codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            supportsToken: false,
            executable: true,
        };
    }
    if (bitbucket) {
        return {
            serviceId: 'bitbucket',
            service: {
                pluginId: 'happier.scm.forge.bitbucket',
                localId: 'bitbucket-account',
            },
            legacyServiceId: 'bitbucket',
            projectedTitle: 'Bitbucket',
            connectCommand: 'happier connect bitbucket',
            supportsOauth: false,
            supportsToken: true,
            executable: true,
        };
    }
    return github
        ? {
            serviceId: 'github',
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            legacyServiceId: 'github',
            projectedTitle: 'GitHub',
            connectCommand: 'happier connect github',
            supportsOauth: true,
            supportsToken: true,
            executable: true,
        }
        : {
            serviceId: `acme-${routeState.localId || 'work'}`,
            service: {
                pluginId: 'acme.accounts',
                localId: routeState.localId || 'work',
            },
            projectedTitle: 'Acme Work',
            connectCommand: 'happier connect acme-work',
            supportsOauth: false,
            supportsToken: true,
            executable: true,
        };
}
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-a',
        status: 'ready',
        entries: [currentRegistryEntry()],
        errorReason: null,
    }),
}));
vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/connectedAccounts/connectedAccountDaemon')>();
    return {
        ...original,
        runConnectedAccountControlCommand: async (input: Readonly<{
            command: Readonly<{
                operation: string;
                requiredOperation?: string;
                service?: {
                    pluginId: string;
                    localId: string;
                };
            }>;
        }>) => {
            if (
                input.command.operation === 'describeService'
                && input.command.requiredOperation !== 'account_list'
                && input.command.service
            ) {
                return {
                    status: 'described' as const,
                    service: input.command.service,
                    operationTransport: { kind: 'v4' as const },
                };
            }
            const result = await runControlMock(input);
            if (
                input.command.operation === 'describeService'
                && result?.status === 'described'
                && result.operationTransport === undefined
            ) {
                return {
                    ...result,
                    operationTransport: { kind: 'v4' as const },
                };
            }
            return result;
        },
        runConnectedAccountAuthenticationCommand: runAuthenticationMock,
    };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmMock,
        prompt: modalPromptMock,
        alert: modalAlertMock,
    },
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/settings/connectedServices/detail/ConnectedServiceSegmentedShell', () => ({
    ConnectedServiceSegmentedShell: (props: Readonly<{
        accountsContent: React.ReactNode;
        poolsContent: React.ReactNode;
        activeSegment: 'accounts' | 'pools';
        poolsAvailable: boolean;
    }>) => React.createElement(
        'ConnectedServiceSegmentedShell',
        props,
        props.activeSegment === 'pools' && props.poolsAvailable
            ? props.poolsContent
            : props.accountsContent,
    ),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

/**
 * Per-account affordances (reconnect / edit label / configure) are no longer
 * sibling `Item` rows: each account renders exactly ONE account block whose
 * kebab owns them, and default-ness is the block's own `isDefault` control.
 * `tree.find` returns the OUTERMOST match for a testID — the block container —
 * so its props are the reachable-affordance contract under test.
 */
type AccountBlockAction = Readonly<{
    id: string;
    disabled?: boolean;
    onPress: () => unknown;
}>;

function accountBlockActionIds(account: ReactTestInstance): readonly string[] {
    return ((account.props.actions ?? []) as ReadonlyArray<AccountBlockAction>)
        .map((entry) => entry.id);
}

async function pressAccountBlockActionAsync(
    account: ReactTestInstance,
    actionId: string,
): Promise<void> {
    const actions = (account.props.actions ?? []) as ReadonlyArray<AccountBlockAction>;
    const action = actions.find((entry) => entry.id === actionId);
    if (!action) {
        throw new Error(
            `Missing account block action "${actionId}" (present: ${actions.map((entry) => entry.id).join(', ') || 'none'})`,
        );
    }
    await act(async () => {
        await action.onPress();
    });
}

async function toggleAccountBlockDefaultAsync(account: ReactTestInstance): Promise<void> {
    const onToggleDefault = account.props.onToggleDefault as (() => unknown) | undefined;
    if (typeof onToggleDefault !== 'function') {
        throw new Error('Account block exposes no default toggle');
    }
    await act(async () => {
        await onToggleDefault();
    });
}

describe('ConnectedAccountServiceView', () => {
    beforeEach(() => {
        runControlMock.mockReset();
        runAuthenticationMock.mockReset();
        getReadyServerFeaturesMock.mockReset();
        listQualifiedGroupsV4Mock.mockReset();
        listLegacyGroupsV3Mock.mockReset();
        modalConfirmMock.mockReset();
        modalPromptMock.mockReset();
        modalAlertMock.mockReset();
        applySettingsMock.mockReset();
        Object.assign(routeState, {
            serviceId: undefined,
            pluginId: 'acme.accounts',
            localId: 'work',
            accountId: undefined,
            groupId: undefined,
            serverId: undefined,
            machineId: undefined,
        });
        machineState.current = [
            { id: 'machine-1', active: true, metadata: { displayName: 'Machine' } },
        ];
        administrationTargetState.current = {
            target: {
                serverIdentityId: 'server-identity-a',
                machineId: 'machine-1',
            },
            serverId: 'server-a',
            machine: {
                id: 'machine-1',
                active: true,
                metadata: { displayName: 'Machine' },
            },
        };
        settingsState.current = {
            connectedServicesDefaultProfileByServiceId: {},
            connectedServicesProfileLabelByKey: {},
        };
        profileState.connectedServicesV2 = [];
    });

    it('runs account operations only on the exact Administration-selected server and machine', async () => {
        administrationTargetState.current = {
            target: {
                serverIdentityId: 'server-identity-b',
                machineId: 'machine-selected',
            },
            serverId: 'server-b',
            machine: {
                id: 'machine-selected',
                active: true,
                metadata: { displayName: 'Selected' },
            },
        };
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        await renderScreen(<ConnectedAccountServiceView />);

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith(expect.objectContaining({
                serverId: 'server-b',
                machineId: 'machine-selected',
            }));
        });
    });

    it('fails closed without a fresh Administration target instead of using another online machine', async () => {
        administrationTargetState.current = null;

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await act(async () => undefined);

        expect(runControlMock).not.toHaveBeenCalled();
        expect(rendered.tree.findByType('MachineAdministrationTargetSelector' as never)).toBeTruthy();
    });

    it('uses advertised V4 and opens only the exact qualified group from route focus', async () => {
        Object.assign(routeState, {
            groupId: 'team',
        });
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });
        getReadyServerFeaturesMock.mockResolvedValueOnce(
            createRootLayoutFeaturesResponse({
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                        qualifiedAccounts: { protocolVersion: 4 },
                    },
                },
            }),
        );
        listQualifiedGroupsV4Mock.mockResolvedValueOnce({
            groups: [{
                v: 1,
                ref: { service, groupId: 'team' },
                incarnation: 'qualified-group-row-team',
                displayName: 'Team',
                policy: {
                    v: 1,
                    strategy: 'least_limited',
                    autoSwitch: false,
                    switchOn: {
                        usageLimit: true,
                        authExpired: true,
                        accountChanged: true,
                        refreshFailure: false,
                    },
                    cooldownMs: 30_000,
                    honorProviderResetsAt: true,
                    autoRestorePrimaryWhenReset: false,
                    maxSwitchesPerTurn: 1,
                    maxSwitchesPerSessionHour: 3,
                    softSwitchRemainingPercent: 15,
                    probeIfSnapshotOlderThanMs: 300_000,
                    preTurnProbeMode: 'when_stale',
                    preTurnProbeOrder: 'current_first_then_candidates',
                    recoveryMode: 'switch_or_wait',
                    resumePromptMode: 'standard',
                },
                activeConnectedAccountId: null,
                generation: 2,
                runtimeStateRevision: 7,
                state: {},
                createdAt: 1,
                updatedAt: 1,
                members: [],
            }],
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'describeService',
                    service,
                    requiredOperation: 'account_list',
                },
                signal: expect.any(AbortSignal),
            });
            expect(listQualifiedGroupsV4Mock).toHaveBeenCalledWith(
                expect.objectContaining({ token: 'token' }),
                { service },
            );
            // A `group` focus now renders the pool's OWN screen (the pool
            // detail), not a row inside the service detail.
            expect(rendered.tree.find(
                (node) => node.props.testID === 'connected-services-pool-detail:name'
                    && typeof node.props.subtitle === 'string',
            ).props.subtitle).toBe('Team');
        });
        // Only the focused pool is on screen: the service detail's segmented
        // shell (and therefore every other pool row) is not rendered at all.
        expect(rendered.tree.findAll(
            (node) => node.props.testID === 'connected-services-detail-shell',
        )).toHaveLength(0);
    });

    it('renders an unavailable service description once with localized retry recovery', async () => {
        Object.assign(routeState, {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        });
        const service = {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        };
        runControlMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_service_identity_unsupported',
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledOnce();
        });
        expect(listQualifiedGroupsV4Mock).not.toHaveBeenCalled();
        expect(listLegacyGroupsV3Mock).not.toHaveBeenCalled();
        expect(rendered.tree.find(
            (node) => node.props.testID === 'connected-account:error',
        ).props.title).toBe('connectedServices.errors.generic');
        expect(rendered.tree.findAllByType('Item' as never).some((item) => (
            item.props.title === 'connected_account_service_identity_unsupported'
        ))).toBe(false);

        await pressTestInstanceAsync(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:error:retry',
            ),
        );
        expect(runControlMock).toHaveBeenCalledTimes(2);
    });

    it('resolves a lost authentication reply with one exact daemon read on user retry', async () => {
        Object.assign(routeState, { pluginId: 'acme.accounts', localId: 'work' });
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const describedService = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        } as const;
        runControlMock.mockResolvedValue(describedService);
        runAuthenticationMock
            .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-1' })
            .mockRejectedValueOnce(new Error('reply lost'))
            .mockResolvedValueOnce({
                status: 'connected',
                attemptId: 'attempt-1',
                account: { service, accountId: 'account-1' },
            });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        const tree = rendered.tree;

        await pressTestInstanceAsync(
            await vi.waitFor(() => tree.find(
                (node) => node.props.testID === 'connected-account-mode:manual',
            )),
        );
        const token = await vi.waitFor(() => tree.find(
            (node) => node.props.testID === 'connected-account-manual:token',
        ));
        await act(async () => token.props.onChangeText('secret-token'));
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-manual:submit'),
        );

        const retry = await vi.waitFor(() => tree.find(
            (node) => node.props.testID === 'connected-account:error:retry',
        ));
        await pressTestInstanceAsync(retry);

        await vi.waitFor(() => {
            expect(runAuthenticationMock).toHaveBeenLastCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: { serverId: 'server-a', generation: 1 },
                command: { operation: 'read', attemptId: 'attempt-1' },
            });
        });
        expect(runAuthenticationMock).toHaveBeenCalledTimes(3);
        await vi.waitFor(() => {
            expect(tree.findAll(
                (node) => node.props.testID === 'connected-account:error',
            )).toHaveLength(0);
        });
    });

    it('keeps a lost authentication reply visible when the exact daemon read proves nothing advanced', async () => {
        Object.assign(routeState, { pluginId: 'acme.accounts', localId: 'work' });
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        runControlMock.mockResolvedValue({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });
        runAuthenticationMock
            .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-1' })
            .mockRejectedValueOnce(new Error('reply lost'))
            .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-1' });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        const tree = rendered.tree;

        await pressTestInstanceAsync(
            await vi.waitFor(() => tree.find(
                (node) => node.props.testID === 'connected-account-mode:manual',
            )),
        );
        const token = await vi.waitFor(() => tree.find(
            (node) => node.props.testID === 'connected-account-manual:token',
        ));
        await act(async () => token.props.onChangeText('secret-token'));
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-manual:submit'),
        );

        await pressTestInstanceAsync(await vi.waitFor(() => tree.find(
            (node) => node.props.testID === 'connected-account:error:retry',
        )));

        await vi.waitFor(() => {
            expect(runAuthenticationMock).toHaveBeenLastCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: { serverId: 'server-a', generation: 1 },
                command: { operation: 'read', attemptId: 'attempt-1' },
            });
        });
        // The read proves the attempt neither advanced nor settled, so the lost
        // submit's outcome is still unknown and must stay visible instead of
        // re-enabling the same effectful action.
        expect(tree.findAll(
            (node) => node.props.testID === 'connected-account:error',
        )).not.toHaveLength(0);
    });

    it('renders daemon-proven exact-old Codex accounts passively with no mutation affordance', async () => {
        Object.assign(routeState, {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        });
        const service = {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'openai-codex',
                title: 'Codex',
                authentication: {
                    defaultModeId: 'oauth',
                    modes: [{
                        id: 'oauth',
                        kind: 'oauthAuthorizationCode',
                        pkce: 'required',
                        outcomeReconciliation: 'providerCheck',
                        configuration: {
                            scope: 'account',
                            changeBehavior: 'reconnect',
                            fields: [{
                                id: 'origin',
                                title: 'Origin',
                                schema: { type: 'string', minLength: 1 },
                                required: true,
                            }],
                        },
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
            operationTransport: {
                kind: 'legacy',
                peerClass: 'exact_v0_2_1',
                serviceId: 'openai-codex',
            },
        });
        profileState.connectedServicesV2 = [{
            serviceId: 'openai-codex',
            profiles: [{
                profileId: 'account-1',
                status: 'connected',
                kind: 'oauth',
                providerEmail: 'codex@example.test',
            }],
        }];

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
        ).toBeTruthy());
        expect(runControlMock).toHaveBeenCalledOnce();
        expect(runControlMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            machineId: 'machine-1',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
            command: {
                operation: 'describeService',
                service,
                requiredOperation: 'account_list',
            },
            signal: expect.any(AbortSignal),
        });
        expect(rendered.tree.findAll((node) => (
            typeof node.props.testID === 'string'
            && (
                node.props.testID.startsWith('connected-account-mode:')
                || node.props.testID.startsWith('connected-account-revoke:')
                || node.props.testID.startsWith(
                    'connected-account-configuration-settings:',
                )
                || node.props.testID.startsWith(
                    'connected-service-configuration-settings:',
                )
                || node.props.testID.startsWith('connected-account-label:')
                || node.props.testID.startsWith('connected-account-default:')
            )
        ))).toHaveLength(0);
        // The label/default/configure affordances those rows used to carry now
        // live on the block itself, so passivity has to be proven there too: an
        // exact-old peer without `credential_write` exposes NO mutation action
        // and no default toggle. The only remaining kebab entry is the
        // read-only drill-in to the account's own detail screen.
        const passiveAccount = rendered.tree.find(
            (node) => node.props.testID === 'connected-account:account-1',
        );
        expect(accountBlockActionIds(passiveAccount)).toEqual(['open']);
        expect(passiveAccount.props.onToggleDefault).toBeUndefined();
        expect(runAuthenticationMock).not.toHaveBeenCalled();
        expect(listQualifiedGroupsV4Mock).not.toHaveBeenCalled();
        expect(listLegacyGroupsV3Mock).not.toHaveBeenCalled();
    });

    it('keeps a revisioned peer row with no stored revision entirely passive', async () => {
        Object.assign(routeState, {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        });
        const service = {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'github-account',
                title: 'GitHub',
                authentication: {
                    defaultModeId: 'oauth',
                    modes: [{
                        id: 'oauth',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }, {
                        id: 'service-account',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'credentials',
                            title: 'Credentials',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
            operationTransport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'github',
            },
        });
        profileState.connectedServicesV2 = [{
            serviceId: 'github',
            profiles: [{
                profileId: 'account-1',
                status: 'connected',
                kind: 'oauth',
            }],
        }];

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
        ).toBeTruthy());

        const account = rendered.tree.find(
            (node) => node.props.testID === 'connected-account:account-1',
        );
        // The account row press that used to start a reconnect is gone; the block
        // must offer NO credential-mutation action and no default toggle for a
        // peer whose authentication modes are all passive, so nothing mutable is
        // reachable through the account itself. The missing stored revision
        // makes this historical row passive despite its peer supporting guarded
        // operations, so only the read-only drill-in remains.
        expect(accountBlockActionIds(account)).toEqual(['open']);
        expect(account.props.onToggleDefault).toBeUndefined();
        expect(rendered.tree.findAll((node) => (
            typeof node.props.testID === 'string'
            && (
                node.props.testID.startsWith('connected-account-mode:')
                || node.props.testID.startsWith(
                    'connected-account-configuration-settings:',
                )
                || node.props.testID.startsWith(
                    'connected-service-configuration-settings:',
                )
            )
        ))).toHaveLength(0);
        // The guarded disconnect is retained ON the account it acts on, never as
        // a service-level row further down the screen.
        expect(rendered.tree.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-revoke:')
        ))).toHaveLength(0);
        expect(runAuthenticationMock).not.toHaveBeenCalled();
    });

    it('fails a revisioned Bitbucket peer closed before daemon, group, or quota effects', async () => {
        Object.assign(routeState, {
            pluginId: 'happier.scm.forge.bitbucket',
            localId: 'bitbucket-account',
        });
        runControlMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_service_identity_unsupported',
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledOnce();
        });

        expect(runAuthenticationMock).not.toHaveBeenCalled();
        expect(listQualifiedGroupsV4Mock).not.toHaveBeenCalled();
        expect(listLegacyGroupsV3Mock).not.toHaveBeenCalled();
        expect(rendered.tree.find(
            (node) => node.props.testID === 'connected-account:error',
        ).props.title).toBe('connectedServices.errors.generic');
        expect(rendered.tree.findAllByType('Item' as never).some((item) => (
            item.props.title === 'connected_account_service_identity_unsupported'
        ))).toBe(false);
    });

    it('writes labels and defaults through the qualified preference owner', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const account = {
            ref: { service, accountId: 'account-a' },
            status: 'connected',
            authenticationModeId: 'manual',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        };
        const otherAccount = {
            ...account,
            ref: { service, accountId: 'account-b' },
        };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account, otherAccount],
        });
        getReadyServerFeaturesMock.mockResolvedValueOnce(null);
        modalPromptMock.mockResolvedValueOnce(' Team ');

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledOnce());

        await pressAccountBlockActionAsync(
            rendered.tree.find((node) => (
                node.props.testID === 'connected-account:account-a'
            )),
            'label',
        );
        expect(applySettingsMock).toHaveBeenCalledWith({
            connectedServicesProfileLabelByKey: {
                'acme.accounts%2Fwork/account-a': 'Team',
            },
        });

        await toggleAccountBlockDefaultAsync(rendered.tree.find((node) => (
            node.props.testID === 'connected-account:account-b'
        )));
        expect(applySettingsMock).toHaveBeenLastCalledWith({
            connectedServicesDefaultProfileByServiceId: {
                'acme.accounts/work': 'account-b',
            },
        });
    });

    it('describes the exact service and drives manual authentication only through daemon commands', async () => {
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service: { pluginId: 'acme.accounts', localId: 'work' },
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });
        runAuthenticationMock
            .mockResolvedValueOnce({ status: 'awaitingManual', attemptId: 'attempt-1' })
            .mockResolvedValueOnce({
                status: 'connected',
                attemptId: 'attempt-1',
                account: {
                    service: { pluginId: 'acme.accounts', localId: 'work' },
                    accountId: 'account-1',
                },
            });
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service: { pluginId: 'acme.accounts', localId: 'work' },
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        const tree = rendered.tree;

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'describeService',
                    service: { pluginId: 'acme.accounts', localId: 'work' },
                    requiredOperation: 'account_list',
                },
                signal: expect.any(AbortSignal),
            });
        });
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-mode:manual'),
        );
        await vi.waitFor(() => {
            expect(runAuthenticationMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'beginConnect',
                    service: { pluginId: 'acme.accounts', localId: 'work' },
                    modeId: 'manual',
                },
            });
        });

        const token = await vi.waitFor(() => tree.find(
            (node) => node.props.testID === 'connected-account-manual:token',
        ));
        const { ItemList } = await import('@/components/ui/lists/ItemList');
        const formList = tree.findAllByType(ItemList).find((list) => (
            list.props.keyboardAware === true
        ));
        expect(formList?.props.keyboardShouldPersistTaps).toBe('handled');
        await act(async () => token.props.onChangeText('secret-token'));
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-manual:submit'),
        );

        await vi.waitFor(() => {
            expect(runAuthenticationMock).toHaveBeenLastCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'submitManual',
                    attemptId: 'attempt-1',
                    fields: { token: 'secret-token' },
                },
            });
        });
    });

    it.each([
        {
            title: 'OAuth provider check',
            mode: {
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                pkce: 'required',
                outcomeReconciliation: 'providerCheck',
            },
            expectedPendingOperation: 'reconcile',
        },
        {
            title: 'device authorization',
            mode: {
                id: 'device',
                kind: 'oauthDeviceCode',
                outcomeReconciliation: 'providerCheck',
            },
            expectedPendingOperation: 'pollDevice',
        },
    ])('continues pending $title attempts through the mode-owned operation', async ({
        mode,
        expectedPendingOperation,
    }) => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: mode.id,
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });
        runAuthenticationMock
            .mockResolvedValueOnce({
                status: 'outcomeUnknown',
                attemptId: 'attempt-1',
                diagnostic: { code: 'provider_response_lost' },
            })
            .mockResolvedValueOnce({
                status: 'pending',
                attemptId: 'attempt-1',
                retryAfterMs: 250,
            })
            .mockResolvedValueOnce({
                status: 'outcomeUnknown',
                attemptId: 'attempt-1',
                diagnostic: { code: 'provider_check_pending' },
            });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledOnce());
        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID === `connected-account-mode:${mode.id}`
        )));
        await vi.waitFor(() => expect(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:reconcile',
            ),
        ).toBeTruthy());
        await pressTestInstanceAsync(rendered.tree.find(
            (node) => node.props.testID === 'connected-account:reconcile',
        ));

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
        });
        expect(runAuthenticationMock).toHaveBeenCalledTimes(3);
        expect(runAuthenticationMock).toHaveBeenNthCalledWith(3, {
            serverId: 'server-a',
            machineId: 'machine-1',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
            command: {
                operation: expectedPendingOperation,
                attemptId: 'attempt-1',
            },
        });
    });

    it('drops an in-flight authentication controller when the qualified route changes', async () => {
        const serviceA = { pluginId: 'acme.accounts', localId: 'work' };
        const serviceB = { pluginId: 'acme.accounts', localId: 'other' };
        const manualMode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        };
        runControlMock
            .mockResolvedValueOnce({
                status: 'described',
                service: serviceA,
                descriptor: {
                    id: 'work',
                    title: 'Acme A',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [manualMode],
                    },
                },
                generation: 'generation-a',
                immutableGenerationId: 'artifact-a',
                accounts: [],
            })
            .mockResolvedValueOnce({
                status: 'described',
                service: serviceB,
                descriptor: {
                    id: 'other',
                    title: 'Acme B',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [manualMode],
                    },
                },
                generation: 'generation-b',
                immutableGenerationId: 'artifact-b',
                accounts: [],
            });
        let settleAuthentication!: (
            response: Readonly<{
                status: 'awaitingManual';
                attemptId: string;
            }>,
        ) => void;
        runAuthenticationMock.mockReturnValueOnce(new Promise((resolve) => {
            settleAuthentication = resolve;
        }));

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledOnce());
        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID === 'connected-account-mode:manual'
        )));
        await vi.waitFor(() => expect(runAuthenticationMock).toHaveBeenCalledOnce());

        Object.assign(routeState, { localId: 'other' });
        await rendered.update(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));
        await act(async () => {
            settleAuthentication({
                status: 'awaitingManual',
                attemptId: 'attempt-a',
            });
        });

        expect(rendered.tree.findAll((node) => (
            node.props.testID === 'connected-account-manual:submit'
        ))).toHaveLength(0);
        expect(rendered.tree.findAll((node) => (
            node.props.testID === 'connected-account-mode:manual'
        )).length).toBeGreaterThan(0);
        expect(runAuthenticationMock).toHaveBeenCalledOnce();
    });

    it('drops an in-flight authentication controller when the Administration target changes', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const manualMode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        };
        runControlMock
            .mockResolvedValueOnce({
                status: 'described',
                service,
                descriptor: {
                    id: 'work',
                    title: 'Acme A',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [manualMode],
                    },
                },
                generation: 'generation-a',
                immutableGenerationId: 'artifact-a',
                accounts: [],
            })
            .mockResolvedValueOnce({
                status: 'described',
                service,
                descriptor: {
                    id: 'work',
                    title: 'Acme B',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [manualMode],
                    },
                },
                generation: 'generation-b',
                immutableGenerationId: 'artifact-b',
                accounts: [],
            });
        let settleAuthentication!: (
            response: Readonly<{
                status: 'awaitingManual';
                attemptId: string;
            }>,
        ) => void;
        runAuthenticationMock.mockReturnValueOnce(new Promise((resolve) => {
            settleAuthentication = resolve;
        }));

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledOnce());
        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID === 'connected-account-mode:manual'
        )));
        await vi.waitFor(() => expect(runAuthenticationMock).toHaveBeenCalledOnce());

        administrationTargetState.current = {
            target: { serverIdentityId: 'server-identity-b', machineId: 'machine-2' },
            serverId: 'server-b',
            machine: { id: 'machine-2', active: true, metadata: { displayName: 'Machine B' } },
        };
        await rendered.update(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));
        await act(async () => {
            settleAuthentication({
                status: 'awaitingManual',
                attemptId: 'attempt-a',
            });
        });

        expect(rendered.tree.findAll((node) => (
            node.props.testID === 'connected-account-manual:submit'
        ))).toHaveLength(0);
        expect(rendered.tree.findAll((node) => (
            node.props.testID === 'connected-account-mode:manual'
        )).length).toBeGreaterThan(0);
        expect(runAuthenticationMock).toHaveBeenCalledOnce();
    });

    it('leaves scalar built-in URL translation to the compatibility route', async () => {
        Object.assign(routeState, {
            serviceId: 'github',
            pluginId: '',
            localId: '',
        });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        expect(runControlMock).not.toHaveBeenCalled();
        expect(rendered.tree.findByType('Item' as never).props.title).toBe(
            'connectedServices.detail.unknownService',
        );
    });

    it.each([
        {
            serviceId: undefined,
            pluginId: 'foreign.accounts',
            localId: 'work',
        },
        {
            serviceId: undefined,
            pluginId: 'ACME invalid',
            localId: 'work',
        },
        {
            serviceId: 'github',
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        },
    ])('rejects malformed, foreign, or mixed qualified route params %#', async (route) => {
        Object.assign(routeState, route);

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        expect(runControlMock).not.toHaveBeenCalled();
        expect(rendered.tree.findAllByType('Item' as never)).toEqual([
            expect.objectContaining({
                props: expect.objectContaining({
                    title: 'connectedServices.detail.unknownService',
                }),
            }),
        ]);
    });

    it('revokes only the selected exact account and cleans group references only after explicit confirmation', async () => {
        Object.assign(routeState, {
            serviceId: undefined,
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        });
        settingsState.current = {
            connectedServicesDefaultProfileByServiceId: {
                github: 'account-1',
                openai: 'voice-account',
            },
            connectedServicesProfileLabelByKey: {
                'github/account-1': 'Work',
                'github/account-2': 'Personal',
                'openai/voice-account': 'Voice',
            },
        };
        const service = {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        };
        const account = {
            ref: { service, accountId: 'account-1' },
            status: 'connected',
            authenticationModeId: 'manual',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        };
        const otherAccount = {
            ...account,
            ref: { service, accountId: 'account-2' },
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account, otherAccount],
        };
        runControlMock
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'conflict',
                code: 'connect_credential_referenced_by_group',
            })
            .mockResolvedValueOnce({
                status: 'revoked',
                account: account.ref,
                remoteStatus: 'remoteUnsupported',
            })
            .mockResolvedValueOnce({
                ...described,
                accounts: [otherAccount],
            });
        modalConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(1));
        await pressAccountBlockActionAsync(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
            'disconnect',
        );

        await vi.waitFor(() => {
            const revocations = runControlMock.mock.calls
                .map(([input]) => input)
                .filter((input) => input.command.operation === 'revokeAccount');
            expect(revocations).toEqual([
                {
                    serverId: 'server-a',
                    machineId: 'machine-1',
                    expectedActiveServer: {
                        serverId: 'server-a',
                        generation: 1,
                    },
                    command: {
                        operation: 'revokeAccount',
                        account: account.ref,
                        cleanupGroupReferences: false,
                    },
                },
                {
                    serverId: 'server-a',
                    machineId: 'machine-1',
                    expectedActiveServer: {
                        serverId: 'server-a',
                        generation: 1,
                    },
                    command: {
                        operation: 'revokeAccount',
                        account: account.ref,
                        cleanupGroupReferences: true,
                    },
                },
            ]);
        });
        expect(runControlMock.mock.calls.some(([input]) => (
            input.command.operation === 'revokeAccount'
            && input.command.account.accountId === otherAccount.ref.accountId
        ))).toBe(false);
        expect(modalConfirmMock).toHaveBeenCalledTimes(2);
        expect(applySettingsMock).toHaveBeenCalledWith({
            connectedServicesDefaultProfileByServiceId: {
                openai: 'voice-account',
            },
            connectedServicesProfileLabelByKey: {
                'github/account-2': 'Personal',
                'openai/voice-account': 'Voice',
            },
        });
    });

    it('explains a typed revoke conflict with the localized owner copy instead of a bare error', async () => {
        Object.assign(routeState, {
            serviceId: undefined,
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        });
        const service = {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        };
        const account = {
            ref: { service, accountId: 'account-1' },
            status: 'connected',
            authenticationModeId: 'manual',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account],
        };
        // The cleanup retry conflicts too: the user is left with the failure, so
        // it has to say what happened rather than "error".
        runControlMock
            .mockResolvedValueOnce(described)
            .mockRejectedValueOnce(Object.assign(new Error('conflict'), {
                code: 'connect_credential_referenced_by_group',
            }))
            .mockResolvedValueOnce({
                status: 'conflict',
                code: 'connect_credential_referenced_by_group',
            });
        modalConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(1));
        await pressAccountBlockActionAsync(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
            'disconnect',
        );

        await vi.waitFor(() => {
            expect(rendered.tree.find(
                (node) => node.props.testID === 'connected-account:error',
            ).props.title).toBe(
                'connectedServices.errors.credentialReferencedByGroup',
            );
        });
        expect(modalConfirmMock).toHaveBeenCalledTimes(2);
    });

    it('keeps reconnect configuration and continuation bound to the exact qualified account', async () => {
        const service = {
            pluginId: 'acme.accounts',
            localId: 'work',
        };
        const account = {
            ref: { service, accountId: 'account-1' },
            status: 'needs_reauth',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: false,
            configurationRevision: 'config-1',
            displayName: 'Work account',
            scopes: [],
        };
        const mode = {
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: 'providerCheck',
            configuration: {
                scope: 'account',
                changeBehavior: 'reconnect',
                fields: [{
                    id: 'endpoint',
                    title: 'Endpoint',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    semantic: 'connectedAccountOrigin',
                }],
            },
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'oauth',
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account],
        };
        const target = {
            kind: 'account',
            account: account.ref,
            modeId: 'oauth',
        };
        const configuration = {
            status: 'configurationRequired',
            revision: 'config-1',
            values: { endpoint: 'https://old.example' },
            configuredSecretFieldIds: [],
            missingFieldIds: [],
        };
        runControlMock
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration,
            })
            .mockResolvedValueOnce({
                status: 'configurationCommitted',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    ...configuration,
                    status: 'ready',
                    revision: 'config-2',
                    values: { endpoint: 'https://new.example' },
                },
            })
            .mockResolvedValueOnce({
                ...described,
                accounts: [{
                    ...account,
                    status: 'connected',
                    configurationReady: true,
                    configurationRevision: 'config-2',
                }],
            });
        runAuthenticationMock
            .mockResolvedValueOnce({
                status: 'configurationRequired',
                attemptId: 'attempt-1',
                target,
                missingFieldIds: [],
            })
            .mockResolvedValueOnce({
                status: 'connected',
                attemptId: 'attempt-1',
                account: account.ref,
            });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);

        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(1));
        await pressAccountBlockActionAsync(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
            'reconnect',
        );

        await vi.waitFor(() => {
            expect(runAuthenticationMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'beginReconnect',
                    account: account.ref,
                },
            });
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'readConfiguration',
                    target: {
                        kind: 'account',
                        account: account.ref,
                    },
                },
            });
        });

        const endpoint = await vi.waitFor(() => rendered.tree.find(
            (node) => node.props.testID === 'connected-account-configuration:endpoint',
        ));
        await act(async () => endpoint.props.onChangeText('https://new.example'));
        await pressTestInstanceAsync(rendered.tree.find(
            (node) => node.props.testID === 'connected-account-configuration:save',
        ));

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'replaceConfiguration',
                    target: {
                        kind: 'account',
                        account: account.ref,
                    },
                    expectedRevision: 'config-1',
                    values: { endpoint: 'https://new.example' },
                    secretValues: {},
                },
            });
            expect(runAuthenticationMock).toHaveBeenLastCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'continueConnect',
                    attemptId: 'attempt-1',
                    expectedConfigurationRevision: 'config-2',
                },
            });
        });
    });

    it('edits established account configuration without reconnect inference or secret disclosure', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const account = {
            ref: { service, accountId: 'account-1' },
            status: 'connected',
            authenticationModeId: 'manual',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true,
            configurationRevision: 'config-1',
            scopes: [],
        };
        const mode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
            configuration: {
                scope: 'account',
                changeBehavior: 'refresh',
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    semantic: 'connectedAccountOrigin',
                }, {
                    id: 'apiKey',
                    title: 'API key',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    secret: true,
                }],
            },
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account],
        };
        const target = {
            kind: 'account',
            account: account.ref,
            modeId: 'manual',
        };
        const currentConfiguration = {
            status: 'ready',
            revision: 'config-1',
            values: { origin: 'https://old.example' },
            configuredSecretFieldIds: ['apiKey'],
            missingFieldIds: [],
        };
        runControlMock
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: currentConfiguration,
            })
            .mockResolvedValueOnce({
                status: 'configurationCommitted',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    ...currentConfiguration,
                    revision: 'config-2',
                    values: { origin: 'https://new.example' },
                },
            })
            .mockResolvedValueOnce({
                ...described,
                accounts: [{
                    ...account,
                    configurationRevision: 'config-2',
                }],
            });
        runAuthenticationMock.mockResolvedValueOnce({
            status: 'connected',
            attemptId: 'terminal-attempt',
            account: account.ref,
        });
        getReadyServerFeaturesMock.mockResolvedValueOnce(
            createRootLayoutFeaturesResponse({
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                        qualifiedAccounts: { protocolVersion: 4 },
                    },
                },
            }),
        );
        listQualifiedGroupsV4Mock.mockResolvedValueOnce({ groups: [] });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(1));
        await pressTestInstanceAsync(rendered.tree.find(
            (node) => node.props.testID === 'connected-account-mode:manual',
        ));
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));
        await pressAccountBlockActionAsync(
            rendered.tree.find(
                (node) => node.props.testID === 'connected-account:account-1',
            ),
            'configure',
        );

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'readConfiguration',
                    target: {
                        kind: 'account',
                        account: account.ref,
                    },
                },
            });
        });
        expect(runAuthenticationMock).toHaveBeenCalledTimes(1);

        const origin = rendered.tree.find(
            (node) => node.props.testID === 'connected-account-configuration:origin',
        );
        const apiKey = rendered.tree.find(
            (node) => node.props.testID === 'connected-account-configuration:apiKey',
        );
        expect(origin.props.value).toBe('https://old.example');
        expect(apiKey.props.value).toBe('');
        expect(apiKey.props.secureTextEntry).toBe(true);
        await act(async () => {
            origin.props.onChangeText('https://new.example');
            apiKey.props.onChangeText('replacement-secret');
        });
        await pressTestInstanceAsync(rendered.tree.find(
            (node) => node.props.testID === 'connected-account-configuration:save',
        ));

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'replaceConfiguration',
                    target: {
                        kind: 'account',
                        account: account.ref,
                    },
                    expectedRevision: 'config-1',
                    values: { origin: 'https://new.example' },
                    secretValues: { apiKey: 'replacement-secret' },
                },
            });
            expect(modalAlertMock).toHaveBeenCalledWith(
                'connectedServices.account.configurationUpdatedTitle',
                'connectedServices.account.configurationRefreshApplied',
            );
        });
        expect(runAuthenticationMock).toHaveBeenCalledTimes(1);
    });

    it('edits service-scoped configuration with zero accounts through the exact service target', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const mode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
            configuration: {
                scope: 'service',
                changeBehavior: 'reconnect',
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    semantic: 'connectedAccountOrigin',
                }],
            },
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        };
        const target = {
            kind: 'service',
            service,
            modeId: 'manual',
        };
        const configuration = {
            status: 'ready',
            revision: 'config-1',
            values: { origin: 'https://old.example' },
            configuredSecretFieldIds: [],
            missingFieldIds: [],
        };
        runControlMock
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration,
            })
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration,
            })
            .mockResolvedValueOnce({
                status: 'configurationCommitted',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    ...configuration,
                    revision: 'config-2',
                    values: { origin: 'https://new.example' },
                },
            })
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    ...configuration,
                    revision: 'config-2',
                    values: { origin: 'https://new.example' },
                },
            });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));

        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )));
        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'readConfiguration',
                    target,
                },
            });
        });

        const origin = rendered.tree.find((node) => (
            node.props.testID === 'connected-account-configuration:origin'
        ));
        await act(async () => origin.props.onChangeText('https://new.example'));
        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID === 'connected-account-configuration:save'
        )));

        await vi.waitFor(() => {
            expect(runControlMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                machineId: 'machine-1',
                expectedActiveServer: {
                    serverId: 'server-a',
                    generation: 1,
                },
                command: {
                    operation: 'replaceConfiguration',
                    target,
                    expectedRevision: 'config-1',
                    values: { origin: 'https://new.example' },
                    secretValues: {},
                },
            });
            expect(modalAlertMock).toHaveBeenCalledWith(
                'connectedServices.account.configurationUpdatedTitle',
                'connectedServices.account.configurationReconnectApplied',
            );
        });
        expect(runAuthenticationMock).not.toHaveBeenCalled();
    });

    it('fails service-scoped account readiness closed while keeping the exact configuration action', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const mode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
            configuration: {
                scope: 'service',
                changeBehavior: 'reconnect',
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    semantic: 'connectedAccountOrigin',
                }],
            },
        };
        const account = {
            ref: { service, accountId: 'account-1' },
            status: 'connected',
            authenticationModeId: 'manual',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: false,
            configurationRevision: null,
            displayName: 'Work account',
            scopes: [],
        };
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [account],
        }).mockResolvedValueOnce({
            status: 'configuration',
            target: {
                kind: 'service',
                service,
                modeId: 'manual',
            },
            mode,
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            configuration: {
                status: 'configurationRequired',
                revision: null,
                values: {},
                configuredSecretFieldIds: [],
                missingFieldIds: ['origin'],
            },
        });

        const { ConnectedAccountServiceView } = await import(
            './ConnectedAccountServiceView'
        );
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));

        expect(runControlMock).toHaveBeenLastCalledWith({
            serverId: 'server-a',
            machineId: 'machine-1',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
            command: {
                operation: 'readConfiguration',
                target: {
                    kind: 'service',
                    service,
                    modeId: 'manual',
                },
            },
            signal: expect.any(AbortSignal),
        });

        // The blocked marker rides the block's identity line now (the account row
        // subtitle it used to share is gone with the row).
        expect(rendered.tree.find((node) => (
            node.props.testID === 'connected-account:account-1'
        )).props.identityLabel).toContain('common.blocked');
        expect(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )).props.detail).toContain('common.blocked');
    });

    it('shows a typed invalid-configuration failure without claiming a successful reconnect', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'work' };
        const mode = {
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
            configuration: {
                scope: 'service',
                changeBehavior: 'reconnect',
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                    semantic: 'connectedAccountOrigin',
                }],
            },
        };
        const described = {
            status: 'described',
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [mode],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        };
        const target = {
            kind: 'service',
            service,
            modeId: 'manual',
        };
        runControlMock
            .mockResolvedValueOnce(described)
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    status: 'ready',
                    revision: 'config-1',
                    values: { origin: 'https://old.example' },
                    configuredSecretFieldIds: [],
                    missingFieldIds: [],
                },
            })
            .mockResolvedValueOnce({
                status: 'configuration',
                target,
                mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                configuration: {
                    status: 'ready',
                    revision: 'config-1',
                    values: { origin: 'https://old.example' },
                    configuredSecretFieldIds: [],
                    missingFieldIds: [],
                },
            })
            .mockResolvedValueOnce({
                status: 'unavailable',
                code: 'connected_account_configuration_invalid',
            });

        const { ConnectedAccountServiceView } = await import('./ConnectedAccountServiceView');
        const rendered = await renderScreen(<ConnectedAccountServiceView />);
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(2));

        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )));
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(3));
        const origin = rendered.tree.find((node) => (
            node.props.testID === 'connected-account-configuration:origin'
        ));
        await act(async () => origin.props.onChangeText('not-an-origin'));
        await pressTestInstanceAsync(rendered.tree.find((node) => (
            node.props.testID === 'connected-account-configuration:save'
        )));

        await vi.waitFor(() => {
            expect(rendered.tree.find(
                (node) => node.props.testID === 'connected-account:error',
            ).props.title).toBe(
                'connectedServices.account.configurationInvalid',
            );
        });
        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(runAuthenticationMock).not.toHaveBeenCalled();
        expect(runControlMock).toHaveBeenCalledTimes(4);
    });
});
