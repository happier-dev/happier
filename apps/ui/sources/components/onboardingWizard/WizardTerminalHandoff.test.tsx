import * as React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({
    CodeBlockView: (props: Record<string, unknown>) => React.createElement('CodeBlockView', props),
}));

function flattenStyle(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    return flattened && typeof flattened === 'object' ? flattened as Record<string, unknown> : {};
}

describe('WizardTerminalHandoff', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the title, subtitle, and command body tightly stacked', async () => {
        const { WizardTerminalHandoff } = await import('./WizardTerminalHandoff');

        const screen = await renderScreen(
            <WizardTerminalHandoff
                testID="handoff"
                steps={[
                    {
                        title: 'Install the CLI',
                        subtitle: 'Run this once on the machine you want to connect.',
                        code: 'happier auth login',
                        scrollTestIDSuffix: 'cli',
                    },
                ]}
            />,
        );

        const step = screen.findByTestId('handoff-step-cli');
        if (!step) {
            throw new Error('Expected WizardTerminalHandoff step to render.');
        }

        const root = screen.findByTestId('handoff');
        const rootFlattened = flattenStyle(root?.props.style as unknown);
        expect(rootFlattened.gap).toBe(12);

        const flattened = flattenStyle(step.props.style as unknown);
        expect(flattened.gap).toBe(4);

        const codeBlock = screen.findByType('CodeBlockView' as never) as unknown as {
            props: {
                showHeaderRow?: boolean;
                showCopyButton?: boolean;
                wrap?: boolean;
                scrollTestID?: string;
            };
        };
        expect(codeBlock.props.showHeaderRow).toBe(false);
        expect(codeBlock.props.showCopyButton).toBe(true);
        expect(codeBlock.props.wrap).toBe(false);
        expect(codeBlock.props.scrollTestID).toBe('handoff-cli');
    });
});
