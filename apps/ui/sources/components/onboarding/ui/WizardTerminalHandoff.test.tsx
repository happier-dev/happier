import * as React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({
    CodeBlockView: (props: Record<string, unknown>) => React.createElement(
        React.Fragment,
        null,
        React.createElement('CodeBlockView', props),
        // Render headerLeft so the platform toggle can be interacted with in tests.
        (props as { headerLeft?: React.ReactNode }).headerLeft ?? null,
    ),
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
        expect(flattened.gap).toBe(8);

        const codeBlock = screen.findByType('CodeBlockView' as never) as unknown as {
            props: {
                showHeaderRow?: boolean;
                showCopyButton?: boolean;
                wrap?: boolean;
                scrollTestID?: string;
                containerStyle?: unknown;
            };
        };
        expect(codeBlock.props.showHeaderRow).toBe(false);
        expect(codeBlock.props.showCopyButton).toBe(true);
        // Spec §2 / F-W13-1: the full command must be readable — the row wraps
        // to multiple lines instead of overflowing behind a horizontal fade.
        expect(codeBlock.props.wrap).toBe(true);
        expect(codeBlock.props.scrollTestID).toBe('handoff-cli');
        expect(flattenStyle(codeBlock.props.containerStyle).backgroundColor).toBeTruthy();
    });

    it('renders a platform toggle when a Windows variant is provided', async () => {
        const { WizardTerminalHandoff } = await import('./WizardTerminalHandoff');

        const screen = await renderScreen(
            <WizardTerminalHandoff
                testID="handoff"
                steps={[
                    {
                        title: 'Install the CLI',
                        code: 'curl -fsSL https://happier.dev/install | bash',
                        windowsCode: '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1)))',
                        windowsLanguage: 'powershell',
                        scrollTestIDSuffix: 'cli',
                    },
                ]}
            />,
        );

        expect(screen.findByTestId('handoff-cli-platform:macos')).toBeTruthy();
        expect(screen.findByTestId('handoff-cli-platform:linux')).toBeTruthy();
        expect(screen.findByTestId('handoff-cli-platform:windows')).toBeTruthy();

        const initialCodeBlock = screen.findByType('CodeBlockView' as never) as unknown as { props: { code: string } };
        expect(initialCodeBlock.props.code).toBe('curl -fsSL https://happier.dev/install | bash');

        await screen.pressByTestIdAsync('handoff-cli-platform:windows');

        const updatedCodeBlock = screen.findByType('CodeBlockView' as never) as unknown as { props: { code: string; language?: string } };
        expect(updatedCodeBlock.props.code).toBe('& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1)))');
        expect(updatedCodeBlock.props.language).toBe('powershell');
    });
});
