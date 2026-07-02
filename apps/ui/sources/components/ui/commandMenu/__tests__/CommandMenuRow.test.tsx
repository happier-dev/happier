import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenuRow } from '../CommandMenuRow';
import { View } from 'react-native';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
}));

describe('CommandMenuRow', () => {
    it('renders label text', async () => {
        const screen = await renderScreen(
            <CommandMenuRow label="Heading 1" testID="row" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Heading 1');
    });

    it('renders description when provided', async () => {
        const screen = await renderScreen(
            <CommandMenuRow label="Heading 1" description="Large heading" testID="row" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Large heading');
    });

    it('renders icon container when icon is provided', async () => {
        const screen = await renderScreen(
            <CommandMenuRow
                label="Heading 1"
                icon={<View testID="my-icon" />}
                testID="row"
            />,
        );
        expect(screen.findByTestId('row:icon')).toBeTruthy();
    });

    it('does not render icon container when icon is not provided', async () => {
        const screen = await renderScreen(
            <CommandMenuRow label="Heading 1" testID="row" />,
        );
        const hasIcon = screen.findAll((node) =>
            typeof node.props?.testID === 'string' && node.props.testID === 'row:icon',
        );
        expect(hasIcon).toHaveLength(0);
    });

    it('renders without description', async () => {
        const screen = await renderScreen(
            <CommandMenuRow label="Code block" testID="row" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Code block');
        // No description provided; only label text should be present
        expect(text).not.toContain('undefined');
    });
});
