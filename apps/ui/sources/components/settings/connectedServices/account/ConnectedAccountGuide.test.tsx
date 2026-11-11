import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';

import { ConnectedAccountGuide } from './ConnectedAccountGuide';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

/** The words a node renders, its nested text runs joined. */
function textOf(node: { children: readonly unknown[] }): string {
    return node.children.map((child) => typeof child === 'string' ? child
        : child && typeof child === 'object' && 'children' in child ? textOf(child as { children: readonly unknown[] }) : '').join('');
}

describe('ConnectedAccountGuide', () => {
    // Owner 2026-11-11 (OWNER-1357-CONNECT): only the destination is the link, never the whole sentence.
    it('links only the destination the first step marks, and reads the rest as the sentence', async () => {
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://cursor.example/dashboard',
            steps: ['Create a key in [Cursor Dashboard → API Keys]. Admin keys are not supported.', 'Paste it here.'] }} />);
        const links = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:open-console' && typeof node.type === 'string');
        expect(links.length).toBeGreaterThan(0);
        expect(textOf(links[0]!).replace(/\u00a0/g, '').trim()).toBe('Cursor Dashboard → API Keys');
        const step = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:step:0' && typeof node.type === 'string')[0]!;
        // The link keeps its leaving-the-app glyph on the destination's last word with a no-break space.
        expect(textOf(step).replace(/\u00a0/g, '')).toContain('Create a key in Cursor Dashboard → API Keys. Admin keys are not supported.');
        expect(textOf(step)).not.toContain('[');
    });

    it('links only the marked destination when the one step is also the console title, and never shows the marks', async () => {
        const step = 'Create a key in the [Anthropic console]';
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://anthropic.example/keys',
            createKeyTitle: step, steps: [step] }} />);
        const link = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:open-console' && typeof node.type === 'string')[0]!;
        expect(textOf(link).replace(/\u00a0/g, '').trim()).toBe('Anthropic console');
        const line = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:step:0' && typeof node.type === 'string')[0]!;
        expect(textOf(line).replace(/\u00a0/g, '')).toContain('Create a key in the Anthropic console');
        expect(textOf(line)).not.toMatch(/[[\]]/);
    });

    it('drops the marks from a console title offered as the short link', async () => {
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://acme.example/keys',
            createKeyTitle: 'Open [Acme keys]', steps: ['Create a key in the Acme console.', 'Paste it here.'] }} />);
        const link = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:open-console' && typeof node.type === 'string')[0]!;
        expect(textOf(link).replace(/\u00a0/g, '').trim()).toBe('Open Acme keys');
    });

    it('keeps an unmarked first step plain and offers the console as a short link after it', async () => {
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://acme.example/keys',
            createKeyTitle: 'Open Acme keys', steps: ['Create a key in the Acme console.', 'Paste it here.'] }} />);
        const link = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:open-console' && typeof node.type === 'string')[0]!;
        expect(textOf(link).replace(/\u00a0/g, '').trim()).toBe('Open Acme keys');
        const step = screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:step:0' && typeof node.type === 'string')[0]!;
        expect(textOf(step)).toContain('Create a key in the Acme console.');
    });

    it('offers a value the steps ask for with its own copy button', async () => {
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://provider.example/clients',
            steps: ['Register a client', 'Add the redirect URL below.'],
            copyValue: { label: 'Redirect URL', value: 'https://app.example/callback' } }} />);
        expect(screen.tree.findAllByType(CopyIconButton).map((node) => node.props.text)).toEqual(['https://app.example/callback']);
    });
});
