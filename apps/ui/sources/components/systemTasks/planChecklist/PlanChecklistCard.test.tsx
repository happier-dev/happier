import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
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

describe('PlanChecklistCard', () => {
    it('renders selectable rows, expands details, and forwards copy diagnostics actions', async () => {
        const { PlanChecklistCard } = await import('./PlanChecklistCard');
        const copyDiagnostics = vi.fn();
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
        expect(icons.some((icon) => icon.props.name === 'checkbox-outline')).toBe(true);
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
});
