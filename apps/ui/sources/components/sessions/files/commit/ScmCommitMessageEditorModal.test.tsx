import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'ios', select: (spec: any) => spec?.ios ?? spec?.default ?? spec?.web ?? spec?.android },
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: { create: (v: any) => v },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

describe('ScmCommitMessageEditorModal', () => {
    it('fills the message when Generate succeeds', async () => {
        const { ScmCommitMessageEditorModal } = await import('./ScmCommitMessageEditorModal');
        const onResolve = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitMessageEditorModal
                    title="Create commit"
                    initialMessage=""
                    canGenerate={true}
                    onGenerate={async () => ({ ok: true, message: 'feat: generated' })}
                    onResolve={onResolve}
                    onClose={vi.fn()}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const generateButton = pressables.find((node) => {
            const texts = node.findAllByType?.('Text' as any) ?? [];
            return texts.some((t: any) => String(t.props?.children ?? '') === 'Generate');
        });
        expect(generateButton).toBeTruthy();

        await act(async () => {
            await generateButton!.props.onPress?.();
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        expect(inputs.length).toBe(1);
        expect(String(inputs[0].props.value)).toBe('feat: generated');
    });

    it('preserves typed message when Generate fails', async () => {
        const { ScmCommitMessageEditorModal } = await import('./ScmCommitMessageEditorModal');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitMessageEditorModal
                    title="Create commit"
                    initialMessage="chore: typed"
                    canGenerate={true}
                    onGenerate={async () => ({ ok: false, error: 'nope' })}
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const generateButton = pressables.find((node) => {
            const texts = node.findAllByType?.('Text' as any) ?? [];
            return texts.some((t: any) => String(t.props?.children ?? '') === 'Generate');
        });
        expect(generateButton).toBeTruthy();

        await act(async () => {
            await generateButton!.props.onPress?.();
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        expect(String(inputs[0].props.value)).toBe('chore: typed');
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitMessageEditorModal
                    title="Create commit"
                    initialMessage="chore: start"
                    canGenerate={true}
                    onGenerate={onGenerate}
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />
            );
        });

        const findButton = (label: string) => {
            const pressables = tree!.root.findAllByType('Pressable' as any);
            return pressables.find((node) => {
                const texts = node.findAllByType?.('Text' as any) ?? [];
                return texts.some((t: any) => String(t.props?.children ?? '') === label);
            });
        };

        const generateButton = findButton('Generate');
        expect(generateButton).toBeTruthy();

        // Start generation (promise pending).
        await act(async () => {
            // Do not await the handler; it intentionally blocks on the in-flight onGenerate promise.
            void generateButton!.props.onPress?.();
        });

        // User edits while generation is running.
        const input = tree!.root.findAllByType('TextInput' as any)[0];
        await act(async () => {
            input.props.onChangeText?.('feat: user typed');
        });

        // Resolve generation after user edits.
        await act(async () => {
            resolveGenerate?.({ ok: true, message: 'feat: generated' });
            await Promise.resolve();
        });

        // Message should remain the user's edit.
        const inputsAfter = tree!.root.findAllByType('TextInput' as any);
        expect(String(inputsAfter[0].props.value)).toBe('feat: user typed');

        // A suggestion should be available to apply explicitly.
        const applyButton = findButton('Apply suggestion');
        expect(applyButton).toBeTruthy();
    });
});
