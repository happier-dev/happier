import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const StrictView = (props: { children?: React.ReactNode }) => {
        const children = React.Children.toArray(props.children);
        if (children.some((child) => typeof child === 'string' || typeof child === 'number')) {
            throw new Error('Text strings must be rendered within a <Text>');
        }
        return React.createElement('View', props, props.children);
    };
    return createReactNativeWebMock({
        View: StrictView,
        Pressable: 'Pressable',
        ScrollView: 'ScrollView',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            borderRadius: { modalCard: 14 },
            colors: {
                text: '#111',
                textSecondary: '#666',
                textTertiary: '#999',
                surface: '#fff',
                surfaceHigh: '#f9f9f9',
                surfacePressed: '#f2f2f2',
                surfacePressedOverlay: '#fafafa',
                surfaceSelected: '#f8f8f8',
                divider: '#ddd',
                accent: { blue: '#007aff' },
                success: '#34c759',
                warningCritical: '#ff3b30',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/code/blocks/CodeBlockViewFrame', () => ({
    CodeBlockViewFrame: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('CodeBlockViewFrame', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

afterEach(() => {
    standardCleanup();
});

function createItem(overrides: Partial<import('./types').PlanChecklistItem> = {}): import('./types').PlanChecklistItem {
    return {
        id: 'install_cli',
        title: 'Install Happier CLI',
        subtitle: 'Install the command line tool',
        satisfied: false,
        disabled: false,
        defaultSelected: true,
        badge: 'Recommended',
        renderDetails: () => React.createElement('Text', { testID: 'details-text' }, 'CLI details'),
        ...overrides,
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    return ReactNativeStyleSheet.flatten(style as never) as Record<string, unknown>;
}

function flattenPressableStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    return flattenStyle(style);
}

describe('PlanChecklistCard', () => {
    it('renders selectable rows, expands details, and forwards copy diagnostics actions', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');
        const copyDiagnostics = vi.fn(async () => true);
        const toggleItem = vi.fn();
        const toggleExpanded = vi.fn();

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [createItem()],
                selectedIds: ['install_cli'],
                expandedIds: ['install_cli'],
                onToggleItem: toggleItem,
                onToggleExpanded: toggleExpanded,
                onCopyDiagnostics: copyDiagnostics,
            }),
        );

        expect(screen.findByTestId('plan-checklist')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-install_cli')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-install_cli-details')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-install_cli-details-copy-diagnostics')).toBeTruthy();

        await screen.pressByTestIdAsync('plan-checklist-row-install_cli');
        expect(toggleItem).toHaveBeenCalledWith('install_cli');

        await screen.pressByTestIdAsync('plan-checklist-row-install_cli-details-toggle');
        expect(toggleExpanded).toHaveBeenCalledWith('install_cli');

        await screen.pressByTestIdAsync('plan-checklist-row-install_cli-details-copy-diagnostics');
        expect(copyDiagnostics).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plan-checklist-row-install_cli-details-copy-diagnostics-feedback')).toBeTruthy();
    });

    it('shows already satisfied items as done during selection', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        satisfied: true,
                        disabled: true,
                    }),
                ],
                selectedIds: ['install_cli'],
            }),
        );

        const icons = screen.findAllByType('Ionicons' as never);
        expect(icons.some((icon) => icon.props.name === 'checkmark-circle')).toBe(true);
    });

    it('does not force satisfied items to render as done when they remain selectable', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        satisfied: true,
                        disabled: false,
                    }),
                ],
                selectedIds: [],
            }),
        );

        const icons = screen.findAllByType('Ionicons' as never);
        expect(icons.some((icon) => icon.props.name === 'checkmark-circle')).toBe(false);
        expect(icons.some((icon) => icon.props.name === 'ellipse-outline')).toBe(true);
    });

    it('renders satisfied selected items as done even when the row remains selectable', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        satisfied: true,
                        disabled: false,
                    }),
                ],
                selectedIds: ['install_cli'],
            }),
        );

        const icons = screen.findAllByType('Ionicons' as never);
        expect(icons.some((icon) => icon.props.name === 'checkmark-circle')).toBe(true);
    });

    it('renders execution status and row-scoped logs without changing the container', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                items: [
                    createItem({ id: 'install_cli', title: 'Install CLI' }),
                    createItem({ id: 'install_daemon', title: 'Install daemon' }),
                ],
                selectedIds: ['install_cli', 'install_daemon'],
                executionById: {
                    install_cli: {
                        status: 'running',
                        logs: [
                            { ts: 10, level: 'info', message: 'Installing CLI' },
                            { ts: 20, level: 'warn', message: 'Retrying download' },
                        ],
                    },
                    install_daemon: {
                        status: 'error',
                        logs: [
                            { ts: 30, level: 'error', message: 'launchctl failed' },
                        ],
                        error: {
                            title: 'Install failed',
                            message: 'launchctl error',
                        },
                    },
                },
                expandedIds: ['install_cli', 'install_daemon'],
            }),
        );

        expect(screen.findByTestId('plan-checklist')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-install_cli-details')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-install_daemon-details')).toBeTruthy();

        expect(screen.getTextContent()).toContain('common.running');
        expect(screen.getTextContent()).toContain('common.error');

        const logBlocks = screen.findAllByType('CodeBlockViewFrame' as never);
        expect(logBlocks).toHaveLength(2);
        expect(logBlocks[0].props.code).toContain('Installing CLI');
        expect(logBlocks[1].props.code).toContain('launchctl failed');

        expect(screen.getTextContent()).toContain('Install failed');
        expect(screen.getTextContent()).toContain('launchctl error');
    });

    it('allows expanding rows during execution by pressing the row', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');
        const toggleExpanded = vi.fn();

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                items: [
                    createItem({ id: 'install_cli', title: 'Install CLI' }),
                ],
                selectedIds: ['install_cli'],
                executionById: {
                    install_cli: {
                        status: 'running',
                        logs: [{ ts: 10, level: 'info', message: 'Installing CLI' }],
                    },
                },
                expandedIds: [],
                onToggleExpanded: toggleExpanded,
            }),
        );

        expect(screen.findByTestId('plan-checklist-row-install_cli-status-slot')).toBeTruthy();

        await screen.pressByTestIdAsync('plan-checklist-row-install_cli');
        expect(toggleExpanded).toHaveBeenCalledWith('install_cli');
    });

    it('supports legacy alias props for expandedId and details content', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        renderDetails: undefined,
                        details: 'This is what the step will do.',
                    }),
                ],
                selectedIds: ['install_cli'],
                expandedId: 'install_cli',
            }),
        );

        expect(screen.findByTestId('plan-checklist-row-install_cli-details')).toBeTruthy();
        expect(screen.getTextContent()).toContain('This is what the step will do.');
    });

    it('renders expanded stage rows with nested substeps', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                items: [
                    {
                        id: 'register_computer',
                        kind: 'stage',
                        title: 'Register this computer',
                        subtitle: 'Connect this device to your account',
                        satisfied: false,
                        disabled: true,
                        children: [
                            createItem({
                                id: 'setup.thisComputer.checkAuth',
                                title: 'Check sign-in',
                                subtitle: 'Verify the current account',
                                satisfied: true,
                                disabled: true,
                            }),
                            createItem({
                                id: 'setup.thisComputer.configureRelay',
                                title: 'Connect to relay',
                                subtitle: 'Use the selected relay',
                                satisfied: false,
                                disabled: true,
                            }),
                        ],
                    },
                ],
                selectedIds: ['setup.thisComputer.checkAuth', 'setup.thisComputer.configureRelay'],
                expandedIds: ['register_computer'],
                executionById: {
                    'setup.thisComputer.checkAuth': { status: 'done', logs: [] },
                    'setup.thisComputer.configureRelay': { status: 'running', logs: [] },
                },
            }),
        );

        expect(screen.findByTestId('plan-checklist-row-register_computer')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-register_computer-children')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-register_computer-children-row-setup.thisComputer.checkAuth')).toBeTruthy();
        expect(screen.findByTestId('plan-checklist-row-register_computer-children-row-setup.thisComputer.configureRelay')).toBeTruthy();
    });

    it('keeps one trailing status owner when execution state already communicates done', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        satisfied: true,
                        disabled: true,
                        badge: 'common.done',
                    }),
                ],
                selectedIds: ['install_cli'],
                executionById: {
                    install_cli: {
                        status: 'done',
                        logs: [],
                    },
                },
            }),
        );

        const doneMatches = screen.getTextContent().match(/common\.done/g) ?? [];
        expect(doneMatches).toHaveLength(1);
    });

    it('suppresses repeated details when the details body only repeats the subtitle', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        subtitle: 'Repeated detail text',
                        renderDetails: undefined,
                        details: 'Repeated detail text',
                    }),
                ],
                selectedIds: ['install_cli'],
                expandedId: 'install_cli',
            }),
        );

        expect(screen.findByTestId('plan-checklist-row-install_cli-details')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('common.details');
    });

    it('supports the onboarding visual variant with numbered timeline nodes', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                variant: 'onboarding',
                items: [createItem()],
                selectedIds: ['install_cli'],
            }),
        );

        const statusSlot = screen.findByTestId('plan-checklist-row-install_cli-status-slot');
        if (!statusSlot) {
            throw new Error('Expected onboarding status slot');
        }
        const flattenedStyle = Array.isArray(statusSlot.props.style)
            ? Object.assign({}, ...statusSlot.props.style.filter(Boolean))
            : statusSlot.props.style;
        expect(flattenedStyle.borderWidth).toBe(1);
        expect(flattenedStyle.width).toBeGreaterThan(26);
        expect(flattenedStyle.height).toBeGreaterThan(26);
        expect(statusSlot.findAll((node) => node.children.includes('1'))).toHaveLength(1);
    });

    it('does not expose an expandable panel when a row only has copy diagnostics and no content', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                        subtitle: undefined,
                        renderDetails: undefined,
                        details: undefined,
                        children: undefined,
                    }),
                ],
                selectedIds: ['install_cli'],
                onCopyDiagnostics: () => undefined,
            }),
        );

        expect(screen.findByTestId('plan-checklist-row-install_cli-details-toggle')).toBeNull();
    });

    it('renders nested onboarding substeps with compact density and without a generic details heading', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'select',
                variant: 'onboarding',
                items: [
                    createItem({
                        id: 'install_tools',
                        kind: 'stage',
                        title: 'Install Happier tools',
                        subtitle: 'Install the runtime used by local setup.',
                        details: 'Top-level details',
                        children: [
                            {
                                id: 'ensure_cli',
                                kind: 'substep',
                                title: 'Install local Happier command-line tools',
                                details: 'The managed Happier runtime is available and the matching terminal command is synced.',
                                satisfied: false,
                                disabled: true,
                                defaultSelected: true,
                            },
                        ],
                    }),
                ],
                selectedIds: ['ensure_cli'],
                expandedIds: ['install_tools', 'ensure_cli'],
                onCopyDiagnostics: () => undefined,
            }),
        );

        const outerRow = screen.findByTestId('plan-checklist-row-install_tools');
        const childRow = screen.findByTestId('plan-checklist-row-install_tools-children-row-ensure_cli');
        const outerTitle = screen.findByTestId('plan-checklist-row-install_tools-title');
        const childTitle = screen.findByTestId('plan-checklist-row-install_tools-children-row-ensure_cli-title');

        if (!outerRow || !childRow || !outerTitle || !childTitle) {
            throw new Error('Expected nested onboarding rows');
        }

        const outerRowStyle = flattenPressableStyle(outerRow.props.style);
        const childRowStyle = flattenPressableStyle(childRow.props.style);
        const outerTitleStyle = flattenStyle(outerTitle.props.style);
        const childTitleStyle = flattenStyle(childTitle.props.style);

        expect(childRowStyle.paddingVertical).toBeLessThan(Number(outerRowStyle.paddingVertical ?? 0));
        expect(childTitleStyle.fontSize).toBeLessThan(Number(outerTitleStyle.fontSize ?? 0));
        expect(screen.getTextContent()).not.toContain('common.details');
        expect(screen.getTextContent()).toContain('The managed Happier runtime is available and the matching terminal command is synced.');
    });

    it('aggregates child logs and errors onto the expanded parent row', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                variant: 'onboarding',
                items: [
                    createItem({
                        id: 'background_service',
                        kind: 'stage',
                        title: 'Background service',
                        subtitle: 'Keep Happier ready in the background.',
                        children: [
                            {
                                id: 'install_service',
                                kind: 'substep',
                                title: 'Installing background service',
                                details: 'Install the local background service.',
                                satisfied: false,
                                disabled: true,
                                defaultSelected: true,
                            },
                        ],
                    }),
                ],
                selectedIds: ['install_service'],
                expandedIds: ['background_service'],
                executionById: {
                    install_service: {
                        status: 'error',
                        logs: [{ ts: 20, level: 'info', message: 'install-service-log-line' }],
                        error: {
                            title: 'cli_command_failed',
                            message: 'install-service-error-message',
                        },
                    },
                },
            }),
        );

        expect(screen.getTextContent()).toContain('install-service-log-line');
        expect(screen.getTextContent()).toContain('cli_command_failed');
        expect(screen.getTextContent()).toContain('install-service-error-message');
    });

    it('renders structured log details with relative timestamps', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');

        const screen = await renderScreen(
            React.createElement(PlanChecklistCard, {
                testID: 'plan-checklist',
                phase: 'execute',
                items: [
                    createItem({
                        id: 'install_cli',
                        title: 'Install CLI',
                    }),
                ],
                selectedIds: ['install_cli'],
                expandedIds: ['install_cli'],
                executionById: {
                    install_cli: {
                        status: 'running',
                        logs: [
                            {
                                ts: 1_776_005_265_915,
                                level: 'info',
                                message: 'Installing background service',
                                details: '$ happier service install --json\nTarget relay: https://relay.example.test',
                            },
                            {
                                ts: 1_776_005_266_025,
                                level: 'warn',
                                message: 'Waiting for daemon readiness',
                                details: '$ happier daemon status --json',
                            },
                        ],
                    },
                },
            }),
        );

        const text = screen.getTextContent();
        expect(text).toContain('+0ms [info] Installing background service');
        expect(text).toContain('$ happier service install --json');
        expect(text).toContain('Target relay: https://relay.example.test');
        expect(text).toContain('+110ms [warn] Waiting for daemon readiness');
        expect(text).not.toContain('1776005265915ms');
    });
});
