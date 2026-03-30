import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    changeTextTestInstance,
    findTestInstanceByTypeContainingText,
    pressTestInstance,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal';
import type { ScmCommitMessageEditorModalProps } from './ScmCommitMessageEditorModal';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'ios',
                        select: (spec: any) => spec?.ios ?? spec?.default ?? spec?.web ?? spec?.android,
                    },
                    useWindowDimensions: () => ({ width: 1200, height: 760 }),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                textLink: '#66f',
                input: { background: '#222', placeholder: '#777' },
                shadow: { color: '#000' },
                danger: '#f00',
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

async function renderScmCommitMessageEditorModal(
    Component: React.ComponentType<ScmCommitMessageEditorModalProps>,
    props: Omit<ScmCommitMessageEditorModalProps, 'setChrome'>,
) {
    const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');

    const Harness = (p: typeof props) => {
        const [chrome, setChrome] = React.useState<CustomModalChromeConfig | null>(null);
        const handleSetChrome = React.useCallback((next: CustomModalChromeConfig | null) => {
            setChrome(next);
        }, []);
        const card = chrome?.kind === 'card' ? chrome : null;

        return (
            <ModalCardFrame
                title={card?.title}
                footer={card?.footer}
                layout={card?.layout ?? 'fit'}
                dimensions={card?.dimensions}
            >
                <Component {...p} setChrome={handleSetChrome} />
            </ModalCardFrame>
        );
    };

    return await renderScreen(<Harness {...props} />);
}

describe('ScmCommitMessageEditorModal', () => {
    it('fills the message when Generate succeeds', async () => {
        const { ScmCommitMessageEditorModal } = await import('./ScmCommitMessageEditorModal');
        const onResolve = vi.fn();

        const screen = await renderScmCommitMessageEditorModal(ScmCommitMessageEditorModal, {
            initialMessage: '',
            canGenerate: true,
            onGenerate: async () => ({ ok: true, message: 'feat: generated' }),
            onResolve,
            onClose: vi.fn(),
        });

        const generateButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Generate');
        expect(generateButton).toBeTruthy();

        await pressTestInstanceAsync(generateButton, 'Generate');

        const input = screen.findByType('TextInput');
        expect(String(input.props.value)).toBe('feat: generated');
    });

    it('preserves typed message when Generate fails', async () => {
        const { ScmCommitMessageEditorModal } = await import('./ScmCommitMessageEditorModal');

        const screen = await renderScmCommitMessageEditorModal(ScmCommitMessageEditorModal, {
            initialMessage: 'chore: typed',
            canGenerate: true,
            onGenerate: async () => ({ ok: false, error: 'nope' }),
            onResolve: vi.fn(),
            onClose: vi.fn(),
        });

        const generateButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Generate');
        expect(generateButton).toBeTruthy();

        await pressTestInstanceAsync(generateButton, 'Generate');

        const input = screen.findByType('TextInput');
        expect(String(input.props.value)).toBe('chore: typed');
    });

    it('does not clobber user edits made while Generate is running (suggestion must be applied explicitly)', async () => {
        const { ScmCommitMessageEditorModal } = await import('./ScmCommitMessageEditorModal');

        let resolveGenerate: ((value: any) => void) | null = null;
        const onGenerate = vi.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveGenerate = resolve;
                }),
        );

        const screen = await renderScmCommitMessageEditorModal(ScmCommitMessageEditorModal, {
            initialMessage: 'chore: start',
            canGenerate: true,
            onGenerate,
            onResolve: vi.fn(),
            onClose: vi.fn(),
        });

        const generateButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Generate');
        expect(generateButton).toBeTruthy();

        await act(async () => {
            pressTestInstance(generateButton, 'Generate');
        });

        // User edits while generation is running.
        const input = screen.findByType('TextInput');
        await act(async () => {
            changeTextTestInstance(input, 'feat: user typed', 'commit message input');
        });

        // Resolve generation after user edits.
        await act(async () => {
            resolveGenerate?.({ ok: true, message: 'feat: generated' });
        });

        // Message should remain the user's edit.
        expect(String(screen.findByType('TextInput').props.value)).toBe('feat: user typed');

        // A suggestion should be available to apply explicitly.
        const applyButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Apply suggestion');
        expect(applyButton).toBeTruthy();
    });
});
