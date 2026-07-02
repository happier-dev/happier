import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: {
        rootStep: {
            sections: ReadonlyArray<{
                title?: string;
                options: ReadonlyArray<{ id: string; content?: React.ReactNode; label: string; subtitle?: string }>;
            }>;
            emptyStateLabel?: string;
        };
        testID?: string;
    }) => React.createElement(
        View,
        { testID: props.testID },
        props.rootStep.sections.length === 0 && props.rootStep.emptyStateLabel
            ? React.createElement('Text', null, props.rootStep.emptyStateLabel)
            : null,
        props.rootStep.sections.map((section, sectionIndex) => React.createElement(
            View,
            { key: `section-${sectionIndex}` },
            section.title ? React.createElement('Text', null, section.title.toUpperCase()) : null,
            section.options.map((option) => React.createElement(
                View,
                { key: option.id },
                option.content ?? React.createElement('Text', null, option.label),
            )),
        )),
    ),
    resolvePopoverSelectionListHeightBehavior: () => 'content',
}));

// Mock the CommandMenuSurface to avoid needing the full Popover browser stack.
// This isolates CommandMenu's rendering logic (item->section mapping, empty state,
// group dividers) from the Popover positioning/portal code.
vi.mock('../CommandMenuSurface', () => ({
    CommandMenuSurface: React.memo((props: { open: boolean; children: React.ReactNode; testID?: string }) => {
        if (!props.open) return null;
        return React.createElement(View, { testID: props.testID }, props.children);
    }),
}));

function makeItem(overrides: Partial<CommandMenuItem> & { id: string; label: string }): CommandMenuItem {
    return { ...overrides };
}

const ITEMS: readonly CommandMenuItem[] = [
    makeItem({ id: 'heading1', label: 'Heading 1', description: 'Large heading', group: 'Format' }),
    makeItem({ id: 'heading2', label: 'Heading 2', description: 'Medium heading', group: 'Format' }),
    makeItem({ id: 'bullet', label: 'Bullet list', group: 'Lists' }),
    makeItem({ id: 'code', label: 'Code block' }),
];

function defaultProps(overrides: Partial<CommandMenuProps> = {}): CommandMenuProps {
    return {
        open: true,
        anchor: { kind: 'view', ref: React.createRef() },
        query: '',
        items: ITEMS,
        selectedIndex: 0,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        testID: 'cmd-menu',
        ...overrides,
    };
}

describe('CommandMenu', () => {
    it('renders rows from items', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps()} />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Heading 1');
        expect(text).toContain('Heading 2');
        expect(text).toContain('Bullet list');
        expect(text).toContain('Code block');
    });

    it('renders nothing when open is false', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ open: false })} />,
        );
        // When closed, the surface and list should not be in the tree
        const surfaceNodes = screen.findAll((node) =>
            typeof node.props?.testID === 'string' && node.props.testID === 'cmd-menu:surface',
        );
        const listNodes = screen.findAll((node) =>
            typeof node.props?.testID === 'string' && node.props.testID === 'cmd-menu:list',
        );
        expect(surfaceNodes).toHaveLength(0);
        expect(listNodes).toHaveLength(0);
    });

    it('renders group section titles (uppercase per SelectionList)', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps()} />,
        );
        const text = screen.getTextContent();
        // SelectionList uppercases section titles
        expect(text).toContain('FORMAT');
        expect(text).toContain('LISTS');
    });

    it('renders emptyStateLabel when items is empty', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ items: [], emptyStateLabel: 'No commands found' })} />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('No commands found');
    });

    it('uses the command menu default empty translation when no label is provided', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ items: [] })} />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('commandMenu.empty');
        expect(text).not.toContain('selectionList.emptyMatch');
    });

    it('does not render empty state when items are present', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ emptyStateLabel: 'No commands found' })} />,
        );
        const emptyNodes = screen.findAll((node) =>
            typeof node.props?.testID === 'string' && node.props.testID === 'cmd-menu:empty',
        );
        expect(emptyNodes).toHaveLength(0);
    });

    it('renders item descriptions', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps()} />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Large heading');
        expect(text).toContain('Medium heading');
    });

    it('renders the surface container when open', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps()} />,
        );
        expect(screen.findByTestId('cmd-menu:surface')).toBeTruthy();
    });

    it('renders the selection list when items exist', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps()} />,
        );
        // SelectionList has testID cmd-menu:list
        expect(screen.findByTestId('cmd-menu:list')).toBeTruthy();
    });
});
