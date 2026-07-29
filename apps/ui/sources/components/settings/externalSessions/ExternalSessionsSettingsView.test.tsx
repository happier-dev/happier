import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred, createModalModuleMock, flushHookEffects } from '@/dev/testkit';
import { readExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import type { Machine, Metadata, Session } from '@/sync/domains/state/storageTypes';

const modalMock = createModalModuleMock();

vi.mock('@/modal', () => modalMock.module);

const effectBoundary = vi.hoisted(() => ({
    followPolicySet: vi.fn(),
    machineRpc: vi.fn(),
    applySessionMetadataLocally: vi.fn(),
    setExternalSessionsSettings: vi.fn(),
    mutateAccountSettings: vi.fn(),
    machines: [] as Machine[],
    sessions: [] as Session[],
    accountSettings: {} as Record<string, unknown>,
    daemonProjection: {
        phase: 'ready' as 'ready' | 'loading' | 'error',
        inputs: null as Record<string, unknown> | null,
    },
    settings: {
        v: 1 as const,
        keepPassivelyFollowingAfterRestart: false,
    } as unknown,
    contextSelections: null as {
        v: 1;
        selectionsByKey: Record<string, {
            machineId?: string | null;
            workspacePath?: string | null;
        }>;
    } | null,
    setContextSelections: vi.fn(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllSessions: () => effectBoundary.sessions,
        useAllMachines: () => effectBoundary.machines,
        useSettings: () => ({
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
        }),
        useSetting: (name: string) => (
            name === 'externalSessionsSettingsV1' ? effectBoundary.settings : null
        ),
        useSettingMutable: (name: string) => {
            if (name === 'contextSelectionsV1') {
                return [effectBoundary.contextSelections, effectBoundary.setContextSelections];
            }
            if (name === 'externalSessionsSettingsV1') {
                return [effectBoundary.settings, effectBoundary.setExternalSessionsSettings];
            }
            return [null, vi.fn()];
        },
    });
});

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionFollowPolicySet: effectBoundary.followPolicySet,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySessionMetadataLocally: effectBoundary.applySessionMetadataLocally,
        mutateAccountSettings: effectBoundary.mutateAccountSettings,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: effectBoundary.machineRpc,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => effectBoundary.daemonProjection,
}));

function createExternalSession(params: Readonly<{
    id: string;
    policy: 'attached_only' | 'background_follow';
    status?: 'disabled' | 'paused' | 'reacquiring' | 'active' | 'error';
    reason?: string;
    machineId?: string;
    title?: string;
}>): Session {
    return {
        id: params.id,
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: {
            path: '/tmp/project',
            host: 'machine-1',
            summary: {
                text: params.title ?? `Session ${params.id}`,
                updatedAt: 2,
            },
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: params.machineId ?? 'machine-1',
                remoteSessionId: `remote-${params.id}`,
                source: {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude',
                },
                followPolicyV1: {
                    v: 1,
                    policy: params.policy,
                    updatedAtMs: 10,
                },
                ...(params.status ? {
                    followStatusV1: {
                        v: 1,
                        status: params.status,
                        ...(params.reason ? { reason: params.reason } : {}),
                        updatedAtMs: 11,
                    },
                } : {}),
            },
        },
    };
}

describe('ExternalSessionsSettingsView passive shell', () => {
    beforeEach(() => {
        effectBoundary.machines = [];
        effectBoundary.machineRpc.mockReset();
        effectBoundary.daemonProjection = {
            phase: 'ready',
            inputs: null,
        };
        effectBoundary.contextSelections = null;
        effectBoundary.setContextSelections.mockReset();
        effectBoundary.setContextSelections.mockImplementation((next) => {
            effectBoundary.contextSelections = next;
        });
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
        };
        effectBoundary.mutateAccountSettings.mockReset();
        effectBoundary.mutateAccountSettings.mockImplementation(async (
            mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        ) => {
            effectBoundary.accountSettings = mutate(effectBoundary.accountSettings);
        });
    });

    it('loads the selected machine integration inventory once without an Agent filter', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.removed-agent',
                    localId: 'removed',
                },
                status: {
                    state: 'unavailable',
                    installationId: 'installation-removed',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />,
        );
        await flushHookEffects();

        expect(screen.findRow(
            'settings-external-sessions-integration-machine-1\u0000com.example.removed-agent\u0000removed\u0000installation:installation-removed',
        )).toBeTruthy();
        expect(effectBoundary.machineRpc).toHaveBeenCalledOnce();
        expect(effectBoundary.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: undefined,
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'machine-1',
                intent: 'passive_inventory',
                limit: 50,
            },
        });

        await screen.unmount();
    });

    it('uses the incoming machine context instead of the global hub stored selection', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [
            createMachineFixture({
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
            }),
            createMachineFixture({
                id: 'machine-2',
                active: true,
                activeAt: Date.now(),
            }),
        ];
        effectBoundary.contextSelections = {
            v: 1,
            selectionsByKey: {
                externalSessionsSettings: {
                    machineId: 'machine-1',
                    workspacePath: null,
                },
            },
        };
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView
                initialMachineId="machine-2"
                integrationInventoryEnabled={true}
            />,
        );
        await flushHookEffects();

        expect(effectBoundary.machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-2',
            payload: expect.objectContaining({
                machineId: 'machine-2',
            }),
        }));
        expect(effectBoundary.machineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
        }));

        await screen.unmount();
    });

    it('uses the canonical projected Agent title for live global inventory rows', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.daemonProjection = {
            phase: 'ready',
            inputs: {
                mergedProviderProjectionById: {
                    'acme-agent': {
                        agentId: 'acme-agent',
                        title: 'Acme Projected Agent',
                        iconAgentId: 'codex',
                        channel: 'plugin',
                        isBuiltIn: false,
                    },
                },
                mergedBackendProjectionById: {},
                pluginProjectionV2: {
                    generation: 4,
                    agentsById: {
                        'acme-agent': {
                            id: 'acme-agent',
                            externalSessions: {
                                agent: {
                                    pluginId: 'com.example.acme',
                                    localId: 'reviewer',
                                },
                                generation: 4,
                            },
                        },
                    },
                },
            },
        };
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.acme',
                    localId: 'reviewer',
                },
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-acme',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />,
        );
        await flushHookEffects();

        expect(screen.findRow(
            'settings-external-sessions-integration-machine-1\u0000com.example.acme\u0000reviewer\u0000installation:installation-acme',
        )?.props.title).toBe('Acme Projected Agent · externalSessions.settingsIntegrationTitle');

        await screen.unmount();
    });

    it('projects persisted policies without an Agent filter and removes only the selected source offline', async () => {
        const selectedPolicy = {
            machineId: 'machine-1',
            qualifiedIdentity: {
                v: 1 as const,
                agent: {
                    pluginId: 'com.example.unknown-agent',
                    localId: 'reviewer',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1 as const,
                },
            },
            sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
            enabledAtMs: 1_000,
        };
        const otherMachinePolicy = {
            ...selectedPolicy,
            machineId: 'machine-2',
            sourcePolicyId: `es-source-policy:v1:${'b'.repeat(64)}`,
        };
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: false,
            activeAt: Date.now() - (10 * 60_000),
        })];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
            autoLinkSourcePolicies: [selectedPolicy, otherMachinePolicy],
        };
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const rows = screen.findAllByType('Item' as never).filter(
            (row) => row.props.testID === 'settings-external-sessions-auto-link-source',
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.title)
            .toBe('externalSessions.settingsAgentAutoLinkTitle');

        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [selectedPolicy, otherMachinePolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        };

        await act(async () => {
            await rows[0]?.props.onPress?.();
        });

        expect(effectBoundary.mutateAccountSettings).toHaveBeenCalledTimes(1);
        expect(effectBoundary.accountSettings).toEqual({
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [otherMachinePolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        });

        await screen.unmount();
    });

    it('renders durable read-only guidance without acquiring follow or mutating Agent configuration', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'passive',
                policy: 'background_follow',
                status: 'active',
                reason: 'background_follow',
                title: 'Passive follow',
            }),
        ];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.machineRpc.mockReset();
        effectBoundary.applySessionMetadataLocally.mockReset();
        effectBoundary.setExternalSessionsSettings.mockReset();
        effectBoundary.mutateAccountSettings.mockClear();

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const guidanceRow = screen.findRowByTitle('externalSessions.settingsPassiveTitle');
        expect(guidanceRow).toBeTruthy();
        expect(guidanceRow?.props.mode).toBe('info');
        expect(guidanceRow?.props.onPress).toBeUndefined();
        expect(guidanceRow?.props.rightElement).toBeUndefined();

        await screen.update(<ExternalSessionsSettingsView key="reconnect" />);

        expect(screen.findRowByTitle('externalSessions.settingsPassiveTitle')).toBeTruthy();
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();
        expect(effectBoundary.machineRpc).not.toHaveBeenCalled();
        expect(effectBoundary.applySessionMetadataLocally).not.toHaveBeenCalled();
        expect(effectBoundary.setExternalSessionsSettings).not.toHaveBeenCalled();
        expect(effectBoundary.mutateAccountSettings).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('patches the latest account-settings CAS winner after the explicit accessible toggle', async () => {
        effectBoundary.sessions = [];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        effectBoundary.setExternalSessionsSettings.mockReset();
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
            futureRoot: { revision: 3 },
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const restoreRow = screen.findRow('settings-external-sessions-restore-item');
        const toggle = restoreRow?.props.rightElement as
            | React.ReactElement<{
                value: boolean;
                accessibilityLabel: string;
            }>
            | undefined;
        expect(toggle).toBeTruthy();
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.accessibilityLabel).toBe('externalSessions.settingsRestoreTitle');
        expect(screen.findRowByTitle('externalSessions.settingsNotificationsTitle')?.props.subtitle)
            .toBe('externalSessions.settingsNotificationsInactiveSubtitle');

        const concurrentPolicy = {
            machineId: 'machine-1',
            qualifiedIdentity: {
                v: 1 as const,
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1 as const,
                },
            },
            sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
            enabledAtMs: 1_000,
        };
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: false,
                autoLinkSourcePolicies: [concurrentPolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        };

        await screen.pressByTestIdAsync('settings-external-sessions-restore-item');

        expect(effectBoundary.mutateAccountSettings).toHaveBeenCalledTimes(1);
        expect(effectBoundary.setExternalSessionsSettings).not.toHaveBeenCalled();
        expect(effectBoundary.accountSettings).toEqual({
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [concurrentPolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        });

        await screen.unmount();
    });

    it('coalesces the restore row and Switch while pending and recovers after a rejected account mutation', async () => {
        effectBoundary.sessions = [];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        const firstMutation = createDeferred<void>();
        effectBoundary.mutateAccountSettings
            .mockReset()
            .mockImplementationOnce(() => firstMutation.promise)
            .mockResolvedValue(undefined);
        modalMock.spies.alertAsync.mockClear();

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const restoreRow = screen.findRow('settings-external-sessions-restore-item');
        const restoreToggle = restoreRow?.props.rightElement as
            | React.ReactElement<{
                disabled?: boolean;
                onValueChange?: (enabled: boolean) => void;
            }>
            | undefined;

        await act(async () => {
            restoreRow?.props.onPress?.();
            restoreToggle?.props.onValueChange?.(true);
            await Promise.resolve();
        });

        expect(effectBoundary.mutateAccountSettings).toHaveBeenCalledTimes(1);
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.loading).toBe(true);
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.disabled).toBe(true);
        const pendingToggle = screen.findRow('settings-external-sessions-restore-item')
            ?.props.rightElement as React.ReactElement<{ disabled?: boolean }> | undefined;
        expect(pendingToggle?.props.disabled).toBe(true);

        await act(async () => {
            firstMutation.reject(new Error('account_settings_unavailable'));
            await Promise.resolve();
        });

        expect(modalMock.spies.alertAsync).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.settingsRestoreUpdateFailed',
        );
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.loading).toBe(false);
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.disabled).toBe(false);
        const recoveredToggle = screen.findRow('settings-external-sessions-restore-item')
            ?.props.rightElement as React.ReactElement<{ disabled?: boolean }> | undefined;
        expect(recoveredToggle?.props.disabled).toBe(false);

        await act(async () => {
            screen.findRow('settings-external-sessions-restore-item')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(effectBoundary.mutateAccountSettings).toHaveBeenCalledTimes(2);

        await screen.unmount();
    });

    it('renders every linked session with its canonical follow status and scopes notifications to explicit background policies', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'active',
                policy: 'background_follow',
                status: 'active',
                reason: 'background_follow',
                title: 'Actively followed',
            }),
            createExternalSession({
                id: 'paused',
                policy: 'attached_only',
                status: 'paused',
                reason: 'archived',
                title: 'Paused follow',
            }),
            createExternalSession({
                id: 'unknown',
                policy: 'attached_only',
                title: 'Unknown follow',
            }),
            createExternalSession({
                id: 'disabled',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Disabled follow',
            }),
            createExternalSession({
                id: 'reacquiring',
                policy: 'attached_only',
                status: 'reacquiring',
                title: 'Reacquiring follow',
            }),
            createExternalSession({
                id: 'error',
                policy: 'attached_only',
                status: 'error',
                title: 'Errored follow',
            }),
            {
                ...createExternalSession({
                    id: 'hosted',
                    policy: 'attached_only',
                    title: 'Hosted',
                }),
                metadata: {
                    path: '/tmp/project',
                    host: 'machine-1',
                    summary: { text: 'Hosted', updatedAt: 2 },
                },
            },
        ];

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        expect(screen.findRow('settings-external-sessions-follow-item-active')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-paused')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-unknown')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-disabled')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-reacquiring')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-error')).toBeTruthy();
        expect(screen.findRowByTitle('Actively followed')?.props.subtitle).toBe('externalSessions.followStatusActive');
        expect(screen.findRowByTitle('Paused follow')?.props.subtitle).toBe('externalSessions.followStatusPaused');
        expect(screen.findRowByTitle('Unknown follow')?.props.subtitle).toBe('externalSessions.followStatusUnknown');
        expect(screen.findRowByTitle('Disabled follow')?.props.subtitle).toBe('externalSessions.followStatusDisabled');
        expect(screen.findRowByTitle('Reacquiring follow')?.props.subtitle).toBe('externalSessions.followStatusReacquiring');
        expect(screen.findRowByTitle('Errored follow')?.props.subtitle).toBe('externalSessions.followStatusError');
        expect(screen.findRowByTitle('Hosted')).toBeNull();
        expect(screen.findRowByTitle('externalSessions.settingsNotificationsTitle')?.props.subtitle)
            .toBe('externalSessions.settingsNotificationsActiveSubtitle');

        const activeToggle = screen.findRow('settings-external-sessions-follow-item-active')
            ?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        const pausedToggle = screen.findRow('settings-external-sessions-follow-item-paused')
            ?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        expect(activeToggle?.props.value).toBe(true);
        expect(pausedToggle?.props.value).toBe(false);
        expect(activeToggle?.props.accessibilityLabel).toBe('Actively followed');
        expect(pausedToggle?.props.accessibilityLabel).toBe('Paused follow');
        expect(activeToggle?.props.accessibilityHint)
            .toBe('externalSessions.settingsFollowToggleHint');

        await screen.unmount();
    });

    it('renders known-offline and typed unsupported follows truthfully without hidden work', async () => {
        effectBoundary.machines = [
            createMachineFixture({
                id: 'machine-1',
                active: false,
                activeAt: Date.now() - (10 * 60_000),
            }),
            createMachineFixture({
                id: 'machine-2',
                active: true,
                activeAt: Date.now(),
            }),
        ];
        effectBoundary.sessions = [
            createExternalSession({
                id: 'offline',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Offline follow',
            }),
            createExternalSession({
                id: 'unsupported',
                policy: 'attached_only',
                status: 'disabled',
                machineId: 'machine-2',
                title: 'Unsupported follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const offlineRow = screen.findRow('settings-external-sessions-follow-item-offline');
        expect(offlineRow?.props.subtitle).toBe('externalSessions.followStatusMachineOffline');
        expect(offlineRow?.props.disabled).toBe(true);

        await act(async () => {
            await offlineRow?.props.onPress?.();
        });
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-unsupported');

        const unsupportedRow = screen.findRow('settings-external-sessions-follow-item-unsupported');
        expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1);
        expect(unsupportedRow?.props.subtitle).toBe('externalSessions.followStatusUnsupported');
        expect(unsupportedRow?.props.disabled).toBe(true);
        expect(effectBoundary.applySessionMetadataLocally).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('starts or stops only the explicitly selected session through the canonical machine operation', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Selected follow',
            }),
            createExternalSession({
                id: 'untouched',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Untouched follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.applySessionMetadataLocally.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: true,
            enabled: true,
            leaseActive: true,
            updatedAtMs: 42,
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        let screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-selected');

        expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1);
        expect(effectBoundary.followPolicySet).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 'selected',
            agentId: 'claude',
            remoteSessionId: 'remote-selected',
            source: {
                kind: 'claudeConfig',
                configDir: '/tmp/claude',
            },
            enabled: true,
        }, {
            serverId: 'server-1',
        });
        expect(effectBoundary.applySessionMetadataLocally).toHaveBeenCalledWith(
            'selected',
            expect.any(Function),
        );

        const updater = effectBoundary.applySessionMetadataLocally.mock.calls[0]?.[1] as
            | ((metadata: Metadata) => Metadata)
            | undefined;
        const selectedMetadata = effectBoundary.sessions[0]?.metadata;
        expect(selectedMetadata).toBeTruthy();
        const updated = selectedMetadata ? updater?.(selectedMetadata) : undefined;
        expect(readExternalSessionLink(updated)?.followPolicyV1).toEqual({
            v: 1,
            policy: 'background_follow',
            updatedAtMs: 42,
        });
        expect(readExternalSessionFollowPolicy(effectBoundary.sessions[1]?.metadata))
            .toBe('attached_only');

        await screen.unmount();

        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'background_follow',
                status: 'active',
                title: 'Selected follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.applySessionMetadataLocally.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: true,
            enabled: false,
            leaseActive: false,
            updatedAtMs: 84,
        });

        screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-selected');

        expect(effectBoundary.followPolicySet).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'selected',
                enabled: false,
            }),
            { serverId: 'server-1' },
        );
        const disableUpdater = effectBoundary.applySessionMetadataLocally.mock.calls[0]?.[1] as
            | ((metadata: Metadata) => Metadata)
            | undefined;
        const enabledMetadata = effectBoundary.sessions[0]?.metadata;
        expect(enabledMetadata).toBeTruthy();
        const disabled = enabledMetadata ? disableUpdater?.(enabledMetadata) : undefined;
        expect(readExternalSessionLink(disabled)?.followPolicyV1).toEqual({
            v: 1,
            policy: 'attached_only',
            updatedAtMs: 84,
        });

        await screen.unmount();
    });

    it('coalesces repeated presses while one session follow mutation is in flight', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Selected follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.applySessionMetadataLocally.mockReset();
        let resolveFollowPolicySet: ((value: {
            ok: true;
            enabled: true;
            leaseActive: true;
            updatedAtMs: number;
        }) => void) | undefined;
        const pendingResult = new Promise<{
            ok: true;
            enabled: true;
            leaseActive: true;
            updatedAtMs: number;
        }>((resolve) => {
            resolveFollowPolicySet = resolve;
        });
        effectBoundary.followPolicySet.mockReturnValue(pendingResult);

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const row = screen.findRow('settings-external-sessions-follow-item-selected');
        expect(row).toBeTruthy();

        let firstPress: Promise<void> | undefined;
        let secondPress: Promise<void> | undefined;
        await act(async () => {
            firstPress = row?.props.onPress();
            secondPress = row?.props.onPress();
            await Promise.resolve();
        });

        expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveFollowPolicySet?.({
                ok: true,
                enabled: true,
                leaseActive: true,
                updatedAtMs: 42,
            });
            await Promise.all([firstPress, secondPress]);
        });

        expect(effectBoundary.applySessionMetadataLocally).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});
