import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

// Locale is an environment boundary; these contracts exercise routes/commands, not translation loading.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
import { WizardTerminalHandoff } from './WizardTerminalHandoff';

afterEach(standardCleanup);

describe('WizardTerminalHandoff', () => {
    it('keeps a single command readable without offering unrelated OS choices', async () => {
        const screen = await renderScreen(
            <WizardTerminalHandoff testID="handoff" steps={[
                { title: 'Authenticate', code: 'happier auth login', scrollTestIDSuffix: 'auth' },
            ]} />,
        );
        expect(screen.getTextContent()).toContain('happier auth login');
        expect(screen.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(0);
    });

    it('offers mutually exclusive accessible OS choices and selects the Windows command', async () => {
        const screen = await renderScreen(
            <WizardTerminalHandoff testID="handoff" steps={[
                {
                    title: 'Install',
                    commands: { macos: 'install-posix', linux: 'install-posix', windows: 'install-windows' },
                    scrollTestIDSuffix: 'cli',
                },
            ]} />,
        );
        const radios = screen.findAllByProps({ accessibilityRole: 'radio' })
            .filter((node) => typeof node.type === 'string');
        expect(radios).toHaveLength(3);
        expect(radios.filter((radio) => radio.props.accessibilityState?.checked)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('install-posix');

        await screen.pressByTestIdAsync('handoff-cli.os:windows');
        expect(screen.getTextContent()).toContain('install-windows');
        expect(screen.getTextContent()).not.toContain('install-posix');
        expect(screen.findByTestId('handoff-cli.os:windows')?.props.accessibilityState.checked).toBe(true);

        await screen.pressByTestIdAsync('handoff-cli.os:linux');
        expect(screen.getTextContent()).toContain('install-posix');
        expect(screen.findByTestId('handoff-cli.os:windows')?.props.accessibilityState.checked).toBe(false);
    });
});
