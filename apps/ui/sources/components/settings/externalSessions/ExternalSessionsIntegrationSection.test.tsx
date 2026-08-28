import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createDeferred,
    createModalModuleMock,
    renderSettingsView,
} from '@/dev/testkit';
import type {
    ExternalSessionsIntegrationDescriptor,
} from './externalSessionsIntegrationModel';

const modalMock = createModalModuleMock({ confirmResult: true });

vi.mock('@/modal', () => modalMock.module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'externalSessions.settingsAgentAutoLinkTitle') {
                return `Automatically add new ${String(params?.agent ?? '')} sessions`;
            }
            if (key === 'externalSessions.settingsAgentBrowseTitle') {
                return `Browse ${String(params?.agent ?? '')} external sessions`;
            }
            if (key === 'externalSessions.settingsIntegrationReviewBody') {
                return `Preview:\n${String(params?.entries ?? '')}`;
            }
            return key;
        },
    });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

// The platform accessibility adapter (native AccessibilityInfo / a web live region).
const announceAccessibilityMessageSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (message: string) => announceAccessibilityMessageSpy(message),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => React.createElement('VirtualizedList', props),
}));

const thirdPartyAgent = {
    pluginId: 'acme.external-sessions',
    localId: 'reviewer',
} as const;

const otherAgent = {
    pluginId: 'happier.bundled',
    localId: 'reviewer',
} as const;

type IntegrationState =
    | 'not_installed'
    | 'installed_enabled'
    | 'installed_disabled'
    | 'needs_attention'
    | 'unsupported'
    | 'unavailable';

type IntegrationOverrides = Readonly<{
    machineId?: string;
    agent?: typeof thirdPartyAgent | typeof otherAgent;
    agentTitle?: string;
    detail?: string;
    installPreview?: ReturnType<typeof installPreview>;
    installationId?: string | null;
    diagnosticCode?: string;
}>;

function installPreview(id = 'a') {
    return {
        previewId: `hook-install-preview:v1:${id.repeat(64)}` as const,
        targets: [{
            targetId: 'settings',
            absolutePath: '/Users/alice/.agent/settings.json',
            changes: [{
                kind: 'append_json_array_entry' as const,
                collectionId: 'hooks',
                eventId: 'session-start',
                nativeEventName: 'SessionStart',
                entry: {
                    matcher: null,
                    hooks: [{
                        type: 'command' as const,
                        command: 'happier hook --event session-start',
                        timeout: 500,
                    }] as const,
                },
            }],
        }],
    };
}

function integration(
    key: string,
    state: IntegrationState,
    overrides: IntegrationOverrides = {},
): ExternalSessionsIntegrationDescriptor {
    const {
        installPreview: previewOverride,
        installationId,
        diagnosticCode,
        ...descriptorOverrides
    } = overrides;
    const base = {
        key,
        machineId: 'machine-1',
        agent: thirdPartyAgent,
        agentTitle: 'Acme Reviewer',
        ...descriptorOverrides,
    } as const;

    if (state === 'not_installed') {
        return {
            ...base,
            state,
            installPreview: previewOverride ?? installPreview(),
        } as const;
    }
    if (state === 'installed_enabled' || state === 'installed_disabled') {
        return {
            ...base,
            state,
            installationId: installationId ?? `installation-${key}`,
        } as const;
    }
    if (state === 'unsupported') {
        return {
            ...base,
            state,
            reason: 'installation_unsupported' as const,
        };
    }
    if (state === 'unavailable') {
        return {
            ...base,
            state,
            installationId: installationId ?? `installation-${key}`,
        } as const;
    }
    return {
        ...base,
        state,
        ...(installationId === null
            ? {}
            : { installationId: installationId ?? `installation-${key}` }),
        diagnostic: {
            code: diagnosticCode
                ?? 'agent.hooks.configuration_attention',
            severity: 'warning',
            message: 'Approve this Agent hook configuration, then check again.',
            remediation: { kind: 'retry' },
        },
    } as const;
}

describe('ExternalSessionsIntegrationSection', () => {
    beforeEach(() => {
        modalMock.spies.confirm.mockClear();
        modalMock.spies.alertAsync.mockClear();
    });

    it('derives the same machine and qualified-Agent rows for global and Agent-detail surfaces', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const integrations = [
            integration('selected', 'installed_enabled'),
            integration('other-machine', 'installed_disabled', { machineId: 'machine-2' }),
            integration('other-agent', 'not_installed', { agent: otherAgent }),
        ];
        const autoLinkSources = [
            {
                machineId: 'machine-1',
                agent: thirdPartyAgent,
                agentTitle: 'Acme Reviewer',
                sourcePolicyId: 'es-source-policy:v1:selected',
                sourceDisplayLabel: 'Selected source',
                enabled: true,
                canChange: true,
                setEnabled: vi.fn(async () => {}),
            },
            {
                machineId: 'machine-2',
                agent: thirdPartyAgent,
                agentTitle: 'Acme Reviewer',
                sourcePolicyId: 'es-source-policy:v1:other-machine',
                sourceDisplayLabel: 'Other machine source',
                enabled: true,
                canChange: true,
                setEnabled: vi.fn(async () => {}),
            },
            {
                machineId: 'machine-1',
                agent: otherAgent,
                agentTitle: 'Other Reviewer',
                sourcePolicyId: 'es-source-policy:v1:other-agent',
                sourceDisplayLabel: 'Other Agent source',
                enabled: true,
                canChange: true,
                setEnabled: vi.fn(async () => {}),
            },
        ];

        const global = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={integrations}
                autoLinkSources={autoLinkSources}
                machineId="machine-1"
                agent={null}
            />,
        );
        const detail = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={integrations}
                autoLinkSources={autoLinkSources}
                machineId="machine-1"
                agent={thirdPartyAgent}
            />,
        );

        expect(global.findRow('settings-external-sessions-integration-selected')).toBeTruthy();
        expect(detail.findRow('settings-external-sessions-integration-selected')).toBeTruthy();
        expect(global.findAllByProps({ testID: 'settings-external-sessions-integration-other-machine' })).toHaveLength(0);
        expect(detail.findAllByProps({ testID: 'settings-external-sessions-integration-other-agent' })).toHaveLength(0);
        expect(global.findAllByType('Item' as never)
            .filter((row) => row.props.testID === 'settings-external-sessions-auto-link-source')
            .map((row) => row.props.subtitle))
            .toEqual([
                'Selected source · externalSessions.settingsAutoLinkSubtitle',
                'Other Agent source · externalSessions.settingsAutoLinkSubtitle',
            ]);
        expect(detail.findAllByType('Item' as never)
            .filter((row) => row.props.testID === 'settings-external-sessions-auto-link-source')
            .map((row) => row.props.subtitle))
            .toEqual([
                'Selected source · externalSessions.settingsAutoLinkSubtitle',
            ]);
    });

    it('renders generic needs-attention diagnostics without a trust state or Agent-specific branch', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[integration('detailed', 'needs_attention', {
                    detail: 'Approval pending on this machine',
                })]}
                machineId="machine-1"
                agent={null}
            />,
        );

        expect(screen.findRow('settings-external-sessions-integration-detailed')?.props.subtitle)
            .toBe('externalSessions.settingsIntegrationStatusNeedsAttention · Approval pending on this machine');
        const diagnosticRow = screen.findRow(
            'settings-external-sessions-integration-detailed.diagnostic.agent.hooks.configuration_attention.0',
        );
        expect(diagnosticRow).toBeTruthy();
        expect(diagnosticRow?.props.subtitle.props.children).toContain(
            'Approve this Agent hook configuration, then check again. externalSessions.settingsIntegrationRemediationRetry',
        );
        expect(screen.findRow('settings-external-sessions-integration-detailed')?.props.title)
            .toBe('Acme Reviewer · externalSessions.settingsIntegrationTitle');
        expect(screen.findAllByProps({
            testID: 'settings-external-sessions-trust-detailed',
        })).toHaveLength(0);
    });

    it.each([
        ['not_installed', { installPreview: installPreview() }, ['review_install']],
        ['not_installed', {}, ['review_install']],
        ['installed_enabled', {}, ['disable', 'uninstall', 'check_again']],
        ['installed_disabled', {}, ['enable', 'uninstall', 'check_again']],
        ['needs_attention', {}, ['uninstall']],
        ['needs_attention', { installationId: null }, ['review_install']],
        ['unsupported', {}, []],
        ['unavailable', {}, ['uninstall']],
    ] as const)('renders only state-valid actions for %s', async (state, overrides, expectedActions) => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };

        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[integration('row', state, overrides)]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        const actions = screen.findAllByType('Item' as never)
            .map((item) => String(item.props.subtitleTestID ?? ''))
            .filter((testID) => testID.startsWith('settings-external-sessions-action-row-'))
            .map((testID) => testID.replace('settings-external-sessions-action-row-', ''));
        expect(actions).toEqual(expectedActions);
    });

    it('offers Review and Install for passive not-installed truth without a preview', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const passiveRow = {
            key: 'passive-not-installed',
            machineId: 'machine-1',
            agent: thirdPartyAgent,
            agentTitle: 'Acme Reviewer',
            state: 'not_installed',
        } as ExternalSessionsIntegrationDescriptor;

        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[passiveRow]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        expect(screen.findByTestId(
            'settings-external-sessions-action-passive-not-installed-review_install',
        )).toBeTruthy();
    });

    it('is passive on mount and reconnect, then reviews install and rejects duplicate presses', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const deferred = createDeferred<void>();
        const operations = {
            reviewAndInstall: vi.fn(async (
                _integration: ExternalSessionsIntegrationDescriptor,
                confirm: (
                    preview: ReturnType<typeof installPreview>,
                ) => Promise<boolean>,
            ) => {
                await confirm(installPreview());
                await deferred.promise;
            }),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };

        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[integration('install', 'not_installed', {
                    installPreview: installPreview(),
                })]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );
        await screen.update(
            <ExternalSessionsIntegrationSection
                key="reconnect"
                integrations={[integration('install', 'not_installed', {
                    installPreview: installPreview(),
                })]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        expect(operations.reviewAndInstall).not.toHaveBeenCalled();
        expect(operations.checkAgain).not.toHaveBeenCalled();

        const installAction = screen.findByTestId('settings-external-sessions-action-install-review_install');
        expect(installAction).not.toBeNull();
        await act(async () => {
            const first = installAction!.props.onPress();
            const duplicate = installAction!.props.onPress();
            await Promise.resolve();
            expect(operations.reviewAndInstall).toHaveBeenCalledTimes(1);
            deferred.resolve();
            await first;
            await duplicate;
        });
        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(modalMock.spies.confirm).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('/Users/alice/.agent/settings.json'),
            expect.any(Object),
        );
        expect(modalMock.spies.confirm.mock.calls[0]?.[1]).toContain(
            'happier hook --event session-start',
        );
    });

    it('keeps the refreshed Review and Install action authoritative after a replaced preview', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {
                throw new Error('installation_replaced');
            }),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const firstPreview = installPreview();
        const refreshedPreview = {
            ...firstPreview,
            previewId: `hook-install-preview:v1:${'b'.repeat(64)}` as const,
        };
        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[integration('install', 'not_installed', {
                    installPreview: firstPreview,
                })]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        await screen.pressByTestIdAsync(
            'settings-external-sessions-action-install-review_install',
        );
        await screen.update(
            <ExternalSessionsIntegrationSection
                integrations={[integration('install', 'not_installed', {
                    installPreview: refreshedPreview,
                })]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        expect(screen.findByTestId(
            'settings-external-sessions-action-install-review_install',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'settings-external-sessions-action-install-check_again',
        )).toBeNull();
    });

    it('keeps installation and source-policy controls distinct and supports a source with no hook contribution', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const setAutoLinkEnabled = vi.fn(async () => {});
        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[
                    integration('attention', 'needs_attention'),
                ]}
                autoLinkSources={[{
                    machineId: 'machine-1',
                    agent: thirdPartyAgent,
                    agentTitle: 'Acme Reviewer',
                    sourcePolicyId: 'es-source-policy:v1:opaque',
                    sourceDisplayLabel: 'Default source',
                    enabled: false,
                    canChange: true,
                    setEnabled: setAutoLinkEnabled,
                }]}
                machineId="machine-1"
                agent={thirdPartyAgent}
                agentTitle="Acme Reviewer"
            />,
        );

        const autoLinkRows = screen.findAllByType('Item' as never)
            .filter((row) => row.props.testID === 'settings-external-sessions-auto-link-source');
        expect(autoLinkRows).toHaveLength(1);
        expect(autoLinkRows[0]?.props.title).toBe('Automatically add new Acme Reviewer sessions');
        expect(setAutoLinkEnabled).not.toHaveBeenCalled();

        const toggle = autoLinkRows[0]?.props.rightElement;
        await act(async () => {
            await toggle.props.onValueChange(true);
        });
        expect(setAutoLinkEnabled).toHaveBeenCalledWith(true);

        const nativeSource = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[{
                    machineId: 'machine-1',
                    agent: thirdPartyAgent,
                    agentTitle: 'Acme Reviewer',
                    sourcePolicyId: 'es-source-policy:v1:native',
                    enabled: false,
                    canChange: false,
                    setEnabled: vi.fn(async () => {}),
                }]}
                machineId="machine-1"
                agent={thirdPartyAgent}
                agentTitle="Acme Reviewer"
            />,
        );
        expect(nativeSource.findAllByType('Item' as never)
            .filter((row) => row.props.testID === 'settings-external-sessions-integration-native'))
            .toHaveLength(0);
        expect(nativeSource.findAllByType('Item' as never)
            .filter((row) => row.props.testID === 'settings-external-sessions-auto-link-source'))
            .toHaveLength(1);
    });

    it('rejects repeated source-policy changes in flight and restores the action after an error', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const deferred = createDeferred<void>();
        const setEnabled = vi.fn()
            .mockImplementationOnce(() => deferred.promise)
            .mockResolvedValue(undefined);
        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[{
                    machineId: 'machine-1',
                    agent: thirdPartyAgent,
                    agentTitle: 'Acme Reviewer',
                    sourcePolicyId: 'es-source-policy:v1:rejected',
                    enabled: true,
                    canChange: true,
                    setEnabled,
                }]}
                machineId="machine-1"
                agent={thirdPartyAgent}
            />,
        );
        const row = screen.findRow('settings-external-sessions-auto-link-source');

        await act(async () => {
            row?.props.onPress?.();
            row?.props.onPress?.();
            await Promise.resolve();
        });
        expect(setEnabled).toHaveBeenCalledTimes(1);
        expect(setEnabled).toHaveBeenLastCalledWith(false);

        await act(async () => {
            deferred.reject(new Error('account_settings_unavailable'));
            await Promise.resolve();
        });
        expect(modalMock.spies.alertAsync).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.settingsAutoLinkUpdateFailed',
        );

        await act(async () => {
            row?.props.onPress?.();
            await Promise.resolve();
        });
        expect(setEnabled).toHaveBeenCalledTimes(2);
    });

    it('distinguishes absent producers from a loaded empty integration result without inventing an automatic-link scope', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const absent = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={null}
                autoLinkSources={null}
                machineId="machine-1"
                agent={null}
            />,
        );
        expect(absent.findAllByProps({
            testID: 'settings-external-sessions-integrations-unavailable',
        })).toHaveLength(0);
        expect(absent.findAllByProps({
            testID: 'settings-external-sessions-auto-link-source',
        })).toHaveLength(0);
        expect(absent.findRow('settings-external-sessions-integration-privacy')).toBeTruthy();

        const loadedEmpty = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
            />,
        );
        expect(loadedEmpty.findRow('settings-external-sessions-integrations-unavailable')).toBeTruthy();
        expect(loadedEmpty.findRow('settings-external-sessions-auto-link-unavailable')).toBeNull();
        expect(loadedEmpty.findAllByProps({
            testID: 'settings-external-sessions-auto-link-source',
        })).toHaveLength(0);
    });

    it.each(['idle', 'loading', 'partial', 'error'] as const)(
        'does not present a definitive empty inventory while the authoritative inventory is %s',
        async (status) => {
            const {
                ExternalSessionsIntegrationSection,
            } = await import('./ExternalSessionsIntegrationSection');

            for (const virtualized of [false, true]) {
                const screen = await renderSettingsView(
                    <ExternalSessionsIntegrationSection
                        integrations={[]}
                        autoLinkSources={[]}
                        machineId="machine-1"
                        agent={null}
                        inventoryState={{ status, diagnosticCodes: ['inventory_incomplete'] }}
                        onRetryInventory={async () => {}}
                        virtualized={virtualized}
                    />,
                );

                if (virtualized) {
                    const list = screen.findByTestId('settings-external-sessions-virtualized-list');
                    expect(list?.props.data).not.toEqual(expect.arrayContaining([
                        expect.objectContaining({ kind: 'integrations_empty' }),
                    ]));
                } else {
                    expect(Boolean(screen.findRow('settings-external-sessions-inventory-status')))
                        .toBe(status !== 'idle');
                    expect(screen.findRow(
                        'settings-external-sessions-integrations-unavailable',
                    )).toBeNull();
                }
            }
        },
    );

    it('surfaces incomplete inventory diagnostics with retry while preserving state-valid row actions', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const retryInventory = vi.fn(async () => {});
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[integration('stale', 'installed_enabled')]}
                machineId="machine-1"
                agent={null}
                operations={operations}
                inventoryState={{
                    status: 'partial',
                    diagnosticCodes: ['installation_record_read_failed'],
                }}
                onRetryInventory={retryInventory}
            />,
        );

        const status = screen.findRow('settings-external-sessions-inventory-status');
        expect(status?.props.subtitle).not.toContain('installation_record_read_failed');
        expect(screen.findRow(
            'settings-external-sessions-action-stale-disable',
        )).toBeTruthy();
        expect(screen.findRow(
            'settings-external-sessions-action-stale-uninstall',
        )).toBeTruthy();

        await screen.pressByTestIdAsync('settings-external-sessions-inventory-status');
        expect(retryInventory).toHaveBeenCalledOnce();
    });

    it('announces the new stable status when a successful action removes the pressed control', async () => {
        announceAccessibilityMessageSpy.mockClear();
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const enabledRow = integration('installation-1', 'installed_enabled', {
            installationId: 'installation-1',
        });

        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[enabledRow]}
                machineId="machine-1"
                agent={null}
                operations={operations}
                inventoryState={{ status: 'ready', diagnosticCodes: [] }}
            />,
        );

        const disableAction = screen.findByTestId(
            'settings-external-sessions-action-installation-1-disable',
        );
        expect(disableAction).toBeTruthy();
        await act(async () => {
            await disableAction!.props.onPress();
        });

        // Nothing has changed yet, so there is nothing to announce.
        expect(announceAccessibilityMessageSpy).not.toHaveBeenCalled();

        // The mutation lands: the pressed Disable row is replaced by Enable, so the
        // control the user was on disappears with no spoken result.
        const disabledRow = integration('installation-1', 'installed_disabled', {
            installationId: 'installation-1',
        });
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[disabledRow]}
                    machineId="machine-1"
                    agent={null}
                    operations={operations}
                    inventoryState={{ status: 'ready', diagnosticCodes: [] }}
                />,
            );
        });

        expect(announceAccessibilityMessageSpy).toHaveBeenCalledWith(
            'Acme Reviewer · externalSessions.settingsIntegrationStatusDisabled',
        );
    });

    it('does not announce anything when an action leaves the row unchanged', async () => {
        announceAccessibilityMessageSpy.mockClear();
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const row = integration('installation-1', 'installed_enabled', {
            installationId: 'installation-1',
        });

        const screen = await renderSettingsView(
            <ExternalSessionsIntegrationSection
                integrations={[row]}
                machineId="machine-1"
                agent={null}
                operations={operations}
                inventoryState={{ status: 'ready', diagnosticCodes: [] }}
            />,
        );

        await act(async () => {
            await screen.findByTestId(
                'settings-external-sessions-action-installation-1-check_again',
            )!.props.onPress();
        });
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[integration('installation-1', 'installed_enabled', {
                        installationId: 'installation-1',
                    })]}
                    machineId="machine-1"
                    agent={null}
                    operations={operations}
                    inventoryState={{ status: 'ready', diagnosticCodes: [] }}
                />,
            );
        });

        expect(announceAccessibilityMessageSpy).not.toHaveBeenCalled();
    });

    it('keeps action rows mounted but disabled while Check again refreshes inventory', async () => {
        const {
            ExternalSessionsIntegrationSection,
        } = await import('./ExternalSessionsIntegrationSection');
        const operations = {
            reviewAndInstall: vi.fn(async () => {}),
            disable: vi.fn(async () => {}),
            enable: vi.fn(async () => {}),
            uninstall: vi.fn(async () => {}),
            checkAgain: vi.fn(async () => {}),
        };
        const render = (status: 'partial' | 'loading') => (
            <ExternalSessionsIntegrationSection
                integrations={[integration('stale', 'installed_enabled')]}
                machineId="machine-1"
                agent={null}
                operations={operations}
                inventoryState={{
                    status,
                    diagnosticCodes: status === 'partial'
                        ? ['installation_record_read_failed']
                        : [],
                }}
                onRetryInventory={async () => {}}
            />
        );
        const screen = await renderSettingsView(render('partial'));
        const actionTestID = 'settings-external-sessions-action-stale-disable';
        expect(screen.findRow(actionTestID)?.props.disabled).toBe(false);

        await screen.update(render('loading'));

        expect(screen.findRow(actionTestID)).toBeTruthy();
        expect(screen.findRow(actionTestID)?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync(actionTestID);
        expect(operations.disable).not.toHaveBeenCalled();
    });
});

describe('ExternalSessionsAgentSettingsSection', () => {
    it('provides Agent-scoped browse and global-management destinations without copying the model', async () => {
        const {
            ExternalSessionsAgentSettingsSection,
        } = await import('./ExternalSessionsAgentSettingsSection');
        const onBrowse = vi.fn();
        const onManageAll = vi.fn();
        const screen = await renderSettingsView(
            <ExternalSessionsAgentSettingsSection
                machineId="machine-1"
                agent={thirdPartyAgent}
                agentTitle="Acme Reviewer"
                integrations={[integration('selected', 'not_installed')]}
                autoLinkSources={[]}
                onBrowse={onBrowse}
                onManageAll={onManageAll}
            />,
        );

        await screen.pressByTestIdAsync('settings-external-sessions-agent-browse');
        await screen.pressByTestIdAsync('settings-external-sessions-manage-all');

        expect(screen.findRow('settings-external-sessions-integration-selected')).toBeTruthy();
        expect(onBrowse).toHaveBeenCalledTimes(1);
        expect(onManageAll).toHaveBeenCalledTimes(1);
    });

    it('keeps Agent-detail continuation behind an explicit accessible user action', async () => {
        const {
            ExternalSessionsAgentSettingsSection,
        } = await import('./ExternalSessionsAgentSettingsSection');
        const onLoadMoreInventory = vi.fn(async () => {});
        const screen = await renderSettingsView(
            <ExternalSessionsAgentSettingsSection
                machineId="machine-1"
                agent={thirdPartyAgent}
                agentTitle="Acme Reviewer"
                integrations={[integration('selected', 'installed_enabled')]}
                autoLinkSources={[]}
                hasMoreInventory
                loadingMoreInventory={false}
                onLoadMoreInventory={onLoadMoreInventory}
                onBrowse={null}
                onManageAll={() => {}}
            />,
        );

        const continuation = screen.findRow('settings-external-sessions-inventory-continuation');
        expect(continuation?.props.mode).toBe('interactive');
        expect(continuation?.props.title).toBe('externalSessions.browseLoadMore');
        await screen.pressByTestIdAsync('settings-external-sessions-inventory-continuation');
        expect(onLoadMoreInventory).toHaveBeenCalledOnce();
    });
});
