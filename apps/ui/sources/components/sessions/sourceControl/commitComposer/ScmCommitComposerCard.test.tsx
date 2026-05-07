import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

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

        const screen = (await renderScreen(
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
        )).tree;

        const generateButton = screen.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' });
        expect(generateButton).toBeTruthy();

        await pressTestInstanceAsync(generateButton);

        expect(onGenerate).toHaveBeenCalledTimes(1);
        expect(onDraftMessageChange).toHaveBeenCalledWith('feat: improve UX');
    });

    it('normalizes fenced JSON commit message suggestions before applying them', async () => {
        const onDraftMessageChange = vi.fn();
        const onGenerate = vi.fn(async () => ({
            ok: true as const,
            message: [
                '```json',
                '{',
                '  "title": "fix(ui): keep commit scope stable",',
                '  "body": "Render selected files as an explicit filter.",',
                '  "message": "fix(ui): keep commit scope stable\\n\\nRender selected files as an explicit filter.",',
                '  "confidence": 0.82',
                '}',
                '```',
            ].join('\n'),
        }));
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
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
        )).tree;

        const generateButton = screen.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' });
        await pressTestInstanceAsync(generateButton);

        expect(onDraftMessageChange).toHaveBeenCalledWith(
            'fix(ui): keep commit scope stable\n\nRender selected files as an explicit filter.'
        );
    });

    it('does not render a generate button when the generator is disabled', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
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
        )).tree;

        const generateButtons = screen.findAllByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' });
        expect(generateButtons).toHaveLength(0);
    });

    it('renders an All button alongside Clear selection in the footer selection row', async () => {
        const onSelectAll = vi.fn();
        const onClear = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
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
        )).tree;

        const allButton = screen.findByProps({ accessibilityLabel: 'common.all' });
        expect(allButton).toBeTruthy();
        const clearButton = screen.findByProps({ accessibilityLabel: 'files.fileActions.clearSelection' });
        expect(clearButton).toBeTruthy();

        await pressTestInstanceAsync(allButton);
        expect(onSelectAll).toHaveBeenCalledTimes(1);
    });

    it('shows commit progress inside the submit button instead of rendering a separate status line', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={{ colors: { divider: '#444', surface: '#111', surfaceHigh: '#222', text: '#fff', textSecondary: '#aaa', success: '#0a0' } }}
                commitActionLabel="Commit staged"
                draftMessage="feat: test"
                onDraftMessageChange={() => {}}
                busy={true}
                status="Refreshing repository status..."
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                variant="railFooter"
            />
        )).tree;

        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(screen.findAll((node) => node.props?.children === 'Refreshing repository status...')).toHaveLength(0);
    });

    it('renders an optional commit-adjacent push button and invokes it', async () => {
        const onPush = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={{ colors: { divider: '#444', surface: '#111', surfaceHigh: '#222', text: '#fff', textSecondary: '#aaa', success: '#0a0' } }}
                commitActionLabel="Commit"
                draftMessage="feat: test"
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                pushAction={{
                    visible: true,
                    disabled: false,
                    busy: false,
                    accessibilityLabel: 'Push to origin/main',
                    onPress: onPush,
                }}
            />
        )).tree;

        const pushButton = screen.findByProps({ testID: 'scm-commit-adjacent-push' });
        expect(pushButton).toBeTruthy();

        await pressTestInstanceAsync(pushButton);

        expect(onPush).toHaveBeenCalledTimes(1);
    });
});
