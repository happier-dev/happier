import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { MarkdownEditModeMenu } from './MarkdownEditModeMenu';

/** Rich and Raw are two views of one document: both visible, one press, the effective one chosen. */
describe('MarkdownEditModeMenu', () => {
    it('shows Rich and Raw side by side, the effective mode selected', async () => {
        const screen = await renderScreen(<MarkdownEditModeMenu mode="rich" onChange={vi.fn()} richEligible />);
        expect(screen.findByTestId('markdown-edit-mode:rich')!.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.findByTestId('markdown-edit-mode:raw')!.props.accessibilityState).toMatchObject({ selected: false });
    });

    it('selects Raw when Rich is preferred but this document cannot open in it, and says why', async () => {
        const screen = await renderScreen(
            <MarkdownEditModeMenu mode="rich" onChange={vi.fn()} richEligible={false} richDisabledReason="footnotes" />,
        );
        const rich = screen.findByTestId('markdown-edit-mode:rich')!;
        expect(rich.props.accessibilityState).toMatchObject({ disabled: true, selected: false });
        expect(String(rich.props.accessibilityLabel ?? '') + String(rich.props.accessibilityHint ?? ''))
            .toContain('settingsSourceControl.markdownEditMode.disabledReason.footnotes');
        expect(screen.findByTestId('markdown-edit-mode:raw')!.props.accessibilityState).toMatchObject({ selected: true });
    });

    it('switches with one press', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<MarkdownEditModeMenu mode="raw" onChange={onChange} richEligible />);
        await act(async () => { screen.findByTestId('markdown-edit-mode:rich')!.props.onPress(); });
        expect(onChange).toHaveBeenCalledWith('rich');
    });
});
