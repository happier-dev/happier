import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import type {
    ExternalSessionsAutoLinkSourceDescriptor,
    ExternalSessionsIntegrationDescriptor,
    ExternalSessionsIntegrationOperations,
} from './externalSessionsIntegrationModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityPlatform = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());
const actionFocusMock = vi.hoisted(() => vi.fn());
const sectionFocusFallbackMock = vi.hoisted(() => vi.fn());
const nativeFocusMock = vi.hoisted(() => vi.fn());

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const {
            createFocusablePressableMock,
            createReactNativeWebMock,
        } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock();
        const FocusableSectionFallbackView = React.forwardRef<
            { focus: () => void },
            Record<string, unknown>
        >(function FocusableSectionFallbackView(props, ref) {
            const focus = props.testID === 'settings-external-sessions-focus-fallback'
                ? sectionFocusFallbackMock
                : () => {};
            React.useImperativeHandle(ref, () => ({ focus }), [focus]);
            return React.createElement('View', props);
        });
        return {
            ...base,
            Pressable: createFocusablePressableMock(actionFocusMock),
            View: FocusableSectionFallbackView,
            findNodeHandle: (target: unknown) => {
                if (
                    typeof target === 'object'
                    && target !== null
                    && 'focus' in target
                    && target.focus === actionFocusMock
                ) {
                    return 101;
                }
                if (
                    typeof target === 'object'
                    && target !== null
                    && 'focus' in target
                    && target.focus === sectionFocusFallbackMock
                ) {
                    return 202;
                }
                return null;
            },
            AccessibilityInfo: {
                ...base.AccessibilityInfo,
                announceForAccessibility: announceForAccessibilityMock,
                setAccessibilityFocus: nativeFocusMock,
            },
            Platform: {
                ...base.Platform,
                get OS() {
                    return accessibilityPlatform.os;
                },
            },
        };
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'single',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : 'comfortable',
}));

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: any) => React.createElement('VirtualizedList', props),
}));

vi.mock('@/components/settings/plugins/diagnostics/PluginDiagnosticsSection', () => ({
    PluginDiagnosticsSection: (props: any) => React.createElement('PluginDiagnosticsSection', props),
}));

function findHostNodeByTestID(
    nodes: readonly ReactTestInstance[],
): ReactTestInstance | undefined {
    return nodes.find((node) => typeof node.type === 'string');
}

function integration(
    key: string,
    state: 'installed_enabled' | 'installed_disabled',
): ExternalSessionsIntegrationDescriptor {
    return {
        key,
        machineId: 'machine-1',
        agent: {
            pluginId: 'acme.external-sessions',
            localId: 'reviewer',
        },
        agentTitle: 'Acme Reviewer',
        state,
        installationId: 'installation-1',
    };
}

function autoLinkSource(
    setEnabled: (enabled: boolean) => Promise<void>,
): ExternalSessionsAutoLinkSourceDescriptor {
    return {
        machineId: 'machine-1',
        agent: {
            pluginId: 'acme.external-sessions',
            localId: 'reviewer',
        },
        agentTitle: 'Acme Reviewer',
        sourcePolicyId: 'source-policy-1',
        enabled: true,
        canChange: true,
        setEnabled,
    };
}

describe('ExternalSessionsIntegrationSection Item boundary', () => {
    beforeEach(() => {
        standardCleanup();
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();
        actionFocusMock.mockClear();
        sectionFocusFallbackMock.mockClear();
        nativeFocusMock.mockClear();
    });

    it.each(['web', 'ios'] as const)(
        'returns user-initiated Disable focus to its surviving Enable replacement on %s',
        async (platformOS) => {
            accessibilityPlatform.os = platformOS;
            const { ExternalSessionsIntegrationSection } = await import(
                './ExternalSessionsIntegrationSection'
            );
            function ActionReplacementHarness() {
                const [integrations, setIntegrations] = React.useState<readonly ExternalSessionsIntegrationDescriptor[]>([
                    integration('enabled', 'installed_enabled'),
                ]);
                const operations = React.useMemo<ExternalSessionsIntegrationOperations>(() => ({
                    reviewAndInstall: async () => {},
                    disable: async () => {
                        setIntegrations([integration('disabled', 'installed_disabled')]);
                    },
                    enable: async () => {},
                    uninstall: async () => {},
                    checkAgain: async () => {},
                }), []);

                return (
                    <ExternalSessionsIntegrationSection
                        integrations={integrations}
                        autoLinkSources={[]}
                        machineId="machine-1"
                        agent={null}
                        operations={operations}
                    />
                );
            }

            const screen = await renderScreen(<ActionReplacementHarness />);
            const disable = findHostNodeByTestID(
                screen.findAllByTestId('settings-external-sessions-action-enabled-disable'),
            );

            await act(async () => {
                disable?.props.onPress();
                await Promise.resolve();
            });

            expect(screen.findByTestId('settings-external-sessions-action-disabled-enable')).toBeTruthy();
            if (platformOS === 'web') {
                expect(actionFocusMock).toHaveBeenCalledOnce();
                expect(sectionFocusFallbackMock).not.toHaveBeenCalled();
            } else {
                expect(nativeFocusMock).toHaveBeenCalledOnce();
                expect(nativeFocusMock).toHaveBeenLastCalledWith(101);
            }
        },
    );

    it.each(['web', 'ios'] as const)(
        'returns a disappearing user-updated auto-link policy to the section fallback on %s',
        async (platformOS) => {
            accessibilityPlatform.os = platformOS;
            const { ExternalSessionsIntegrationSection } = await import(
                './ExternalSessionsIntegrationSection'
            );
            function AutoLinkFallbackHarness() {
                const [sources, setSources] = React.useState<
                    readonly ExternalSessionsAutoLinkSourceDescriptor[]
                >([]);
                const source = React.useMemo(
                    () => autoLinkSource(async () => {
                        setSources([]);
                    }),
                    [],
                );

                React.useEffect(() => {
                    setSources([source]);
                }, [source]);

                return (
                    <ExternalSessionsIntegrationSection
                        integrations={[]}
                        autoLinkSources={sources}
                        machineId="machine-1"
                        agent={null}
                    />
                );
            }

            const screen = await renderScreen(<AutoLinkFallbackHarness />);
            const source = findHostNodeByTestID(
                screen.findAllByTestId('settings-external-sessions-auto-link-source'),
            );

            await act(async () => {
                source?.props.onPress();
                await Promise.resolve();
            });

            expect(screen.findAllByTestId('settings-external-sessions-auto-link-source')).toHaveLength(0);
            if (platformOS === 'web') {
                expect(sectionFocusFallbackMock).toHaveBeenCalledOnce();
                expect(actionFocusMock).not.toHaveBeenCalled();
            } else {
                expect(nativeFocusMock).toHaveBeenCalledOnce();
                expect(nativeFocusMock).toHaveBeenLastCalledWith(202);
            }
        },
    );

    it('does not move focus when Check Again leaves its action in place', async () => {
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const operations: ExternalSessionsIntegrationOperations = {
            reviewAndInstall: async () => {},
            disable: async () => {},
            enable: async () => {},
            uninstall: async () => {},
            checkAgain: async () => {},
        };
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[integration('enabled', 'installed_enabled')]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );
        const checkAgain = findHostNodeByTestID(
            screen.findAllByTestId('settings-external-sessions-action-enabled-check_again'),
        );

        await act(async () => {
            checkAgain?.props.onPress();
            await Promise.resolve();
        });

        expect(screen.findByTestId('settings-external-sessions-action-enabled-check_again')).toBeTruthy();
        expect(actionFocusMock).not.toHaveBeenCalled();
        expect(sectionFocusFallbackMock).not.toHaveBeenCalled();
        expect(nativeFocusMock).not.toHaveBeenCalled();
    });

    it('does not move focus when a passive inventory update replaces an action', async () => {
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const operations: ExternalSessionsIntegrationOperations = {
            reviewAndInstall: async () => {},
            disable: async () => {},
            enable: async () => {},
            uninstall: async () => {},
            checkAgain: async () => {},
        };
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[integration('enabled', 'installed_enabled')]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                operations={operations}
            />,
        );

        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[integration('disabled', 'installed_disabled')]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    operations={operations}
                />,
            );
        });

        expect(screen.findByTestId('settings-external-sessions-action-disabled-enable')).toBeTruthy();
        expect(actionFocusMock).not.toHaveBeenCalled();
        expect(sectionFocusFallbackMock).not.toHaveBeenCalled();
        expect(nativeFocusMock).not.toHaveBeenCalled();
    });

    it('renders the retry status as an accessible keyboard-focusable press target', async () => {
        const retryInventory = vi.fn(async () => {});
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                inventoryState={{
                    status: 'error',
                    diagnosticCodes: ['operation_failed'],
                }}
                onRetryInventory={retryInventory}
            />,
        );

        const retry = findHostNodeByTestID(
            screen.findAllByTestId('settings-external-sessions-inventory-status'),
        );
        expect(retry?.type).toBe('Pressable');
        expect(retry?.props.role).toBe('button');
        expect(retry?.props.tabIndex).toBe(0);
        expect(retry?.props['aria-label']).toBeTruthy();

        await act(async () => {
            retry?.props.onPress();
            await Promise.resolve();
        });

        expect(retryInventory).toHaveBeenCalledOnce();
    });

    it('uses one polite loading status that becomes one assertive inventory alert', async () => {
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                inventoryState={{
                    status: 'loading',
                    diagnosticCodes: [],
                }}
            />,
        );

        const loading = screen.findByTestId('settings-external-sessions-inventory-announcement');
        expect(loading?.props.accessibilityLiveRegion).toBe('polite');
        expect(loading?.props.role).toBe('status');
        expect(loading?.props['aria-live']).toBe('polite');
        expect(screen.tree.root.findAll((node) => (
            typeof node.type === 'string'
            && node.props.accessibilityLiveRegion === 'polite'
        ))).toHaveLength(1);

        accessibilityPlatform.os = 'ios';
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'error',
                        diagnosticCodes: ['operation_failed'],
                    }}
                    onRetryInventory={async () => {}}
                />,
            );
        });

        const error = screen.findByTestId('settings-external-sessions-inventory-announcement');
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(error?.props.accessibilityLiveRegion).toBe('assertive');
        expect(error?.props.role).toBe('alert');
        expect(error?.props['aria-live']).toBe('assertive');
        expect(screen.tree.root.findAll((node) => (
            typeof node.type === 'string'
            && node.props.accessibilityLiveRegion === 'assertive'
        ))).toHaveLength(1);
        expect(announceForAccessibilityMock).toHaveBeenCalledOnce();
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'externalSessions.settingsIntegrationInventoryErrorTitle. externalSessions.settingsIntegrationInventoryErrorSubtitle',
        );
        expect(announceForAccessibilityMock).not.toHaveBeenCalledWith(
            expect.stringContaining('operation_failed'),
        );

        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'ready',
                        diagnosticCodes: [],
                    }}
                />,
            );
        });
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'error',
                        diagnosticCodes: ['operation_failed'],
                    }}
                    onRetryInventory={async () => {}}
                />,
            );
        });

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
    });
});
