import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

describe('ScmCommitComposerCard', () => {
    it('renders a generate button when wired and applies the suggestion', async () => {
        const onDraftMessageChange = vi.fn();
        const onGenerate = vi.fn(async () => ({ ok: true as const, message: 'feat: improve UX' }));
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitComposerCard
                    theme={{ colors: { divider: '#444', surface: '#111', surfaceHigh: '#222', text: '#fff', textSecondary: '#aaa', success: '#0a0' } }}
                    commitActionLabel="Commit"
                    draftMessage=""
                    onDraftMessageChange={onDraftMessageChange}
                    busy={false}
                    status={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled
                    onGenerateCommitMessageSuggestion={onGenerate}
                />
            );
        });

        const pressables = (tree! as any).root.findAllByType('Pressable');
        const generateButton = pressables.find((node: any) => node.props.accessibilityLabel === 'files.commitMessageEditor.generate');
        expect(generateButton).toBeTruthy();

        await act(async () => {
            await generateButton.props.onPress();
        });

        expect(onGenerate).toHaveBeenCalledTimes(1);
        expect(onDraftMessageChange).toHaveBeenCalledWith('feat: improve UX');
    });

    it('does not render a generate button when the generator is disabled', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitComposerCard
                    theme={{ colors: { divider: '#444', surface: '#111', surfaceHigh: '#222', text: '#fff', textSecondary: '#aaa', success: '#0a0' } }}
                    commitActionLabel="Commit"
                    draftMessage=""
                    onDraftMessageChange={() => {}}
                    busy={false}
                    status={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true as const, message: 'ok' })}
                />
            );
        });

        const pressables = (tree! as any).root.findAllByType('Pressable');
        const generateButton = pressables.find((node: any) => node.props.accessibilityLabel === 'files.commitMessageEditor.generate');
        expect(generateButton).toBeFalsy();
    });

    it('renders an All button alongside Clear selection in the footer selection row', async () => {
        const onSelectAll = vi.fn();
        const onClear = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ScmCommitComposerCard
                    theme={{ colors: { divider: '#444', surface: '#111', surfaceHigh: '#222', text: '#fff', textSecondary: '#aaa', success: '#0a0' } }}
                    commitActionLabel="Commit"
                    draftMessage=""
                    onDraftMessageChange={() => {}}
                    busy={false}
                    status={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    onCommitFromMessage={() => {}}
                    selectionCount={2}
                    onClearSelection={onClear}
                    onSelectAllSelection={onSelectAll}
                    variant="railFooter"
                />
            );
        });

        const pressables = (tree! as any).root.findAllByType('Pressable');
        const allButton = pressables.find((node: any) => node.props.onPress === onSelectAll);
        expect(allButton).toBeTruthy();
        const clearButton = pressables.find((node: any) => node.props.onPress === onClear);
        expect(clearButton).toBeTruthy();

        await act(async () => {
            allButton.props.onPress();
        });
        expect(onSelectAll).toHaveBeenCalledTimes(1);
    });
});
