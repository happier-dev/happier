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

const theme = {
    colors: {
        border: { default: '#444' },
        button: { primary: { tint: '#fff' } },
        state: { success: { foreground: '#0a0' } },
        surface: { base: '#111', inset: '#222' },
        text: { primary: '#fff', secondary: '#aaa', link: '#8ab4ff' },
    },
};

describe('ScmCommitComposerCard', () => {
    it('renders a generate button when wired and applies the suggestion', async () => {
        const onDraftMessageChange = vi.fn();
        const onGenerate = vi.fn(async () => ({ ok: true as const, message: 'feat: improve UX' }));
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
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

    it('normalizes JSON fenced generated commit message suggestions before applying them', async () => {
        const onDraftMessageChange = vi.fn();
        const onGenerate = vi.fn(async () => ({
            ok: true as const,
            message: [
                '```json',
                '{',
                '  "title": "fix(scm): refresh after commit",',
                '  "body": "Keep the repository snapshot current.",',
                '  "message": "fix(scm): refresh after commit\\n\\nKeep the repository snapshot current.",',
                '  "confidence": 0.8',
                '}',
                '```',
            ].join('\n'),
        }));
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
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

        await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' }));

        expect(onDraftMessageChange).toHaveBeenCalledWith('fix(scm): refresh after commit\n\nKeep the repository snapshot current.');
    });

    it('shows commit progress inside the submit button instead of rendering status text while busy', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit"
                draftMessage="fix: refresh"
                onDraftMessageChange={() => {}}
                busy
                status="Refreshing repository status..."
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
            />
        )).tree;

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(1);
        expect(screen.findAllByProps({ children: 'Refreshing repository status...' })).toHaveLength(0);
    });

    it('renders a commit-adjacent push button when the shared push shortcut is available', async () => {
        const onPush = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit"
                draftMessage="feat: add remote"
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                pushShortcut={{
                    label: 'Push to origin/main',
                    disabled: false,
                    busy: false,
                    onPress: onPush,
                }}
            />
        )).tree;

        const pushButton = screen.findByProps({ testID: 'scm-commit-adjacent-push' });
        expect(pushButton).toBeTruthy();

        await pressTestInstanceAsync(pushButton);
        expect(onPush).toHaveBeenCalledTimes(1);
    });

    it('does not render a generate button when the generator is disabled', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
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
                theme={theme}
                commitActionLabel="Commit"
                draftMessage=""
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                commitSelectionAvailable
                selectionModeActive
                selectionCount={2}
                onClearSelection={onClear}
                onSelectAllSelection={onSelectAll}
                variant="railFooter"
            />
        )).tree;

        expect(screen.findByProps({ testID: 'scm-commit-selection-summary' })).toBeTruthy();
        const allButton = screen.findByProps({ accessibilityLabel: 'common.all' });
        expect(allButton).toBeTruthy();
        const clearButton = screen.findByProps({ accessibilityLabel: 'files.fileActions.clearSelection' });
        expect(clearButton).toBeTruthy();

        await pressTestInstanceAsync(allButton);
        expect(onSelectAll).toHaveBeenCalledTimes(1);
    });

    it('shows a "Select files to commit" entry button and enters selection mode on press', async () => {
        const onEnter = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit"
                draftMessage=""
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                commitSelectionAvailable
                onEnterSelectionMode={onEnter}
                variant="railFooter"
            />
        )).tree;

        const enterButton = screen.findByProps({ testID: 'scm-commit-enter-selection' });
        expect(enterButton).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'scm-commit-selection-summary' })).toHaveLength(0);

        await pressTestInstanceAsync(enterButton);
        expect(onEnter).toHaveBeenCalledTimes(1);
    });

    it('hides the entry button and exits selection mode via Done when nothing is selected', async () => {
        const onExit = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit"
                draftMessage=""
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                commitSelectionAvailable
                selectionModeActive
                selectionCount={0}
                onExitSelectionMode={onExit}
                variant="railFooter"
            />
        )).tree;

        expect(screen.findAllByProps({ testID: 'scm-commit-enter-selection' })).toHaveLength(0);
        const doneButton = screen.findByProps({ testID: 'scm-commit-exit-selection' });
        await pressTestInstanceAsync(doneButton);
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('does not render selection affordances when commit selection is unavailable', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = (await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit"
                draftMessage=""
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                variant="railFooter"
            />
        )).tree;

        expect(screen.findAllByProps({ testID: 'scm-commit-enter-selection' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'scm-commit-selection-summary' })).toHaveLength(0);
    });
});
