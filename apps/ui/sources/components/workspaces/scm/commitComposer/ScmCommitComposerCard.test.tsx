import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

// Loaded at the assertion, not at the top: an eager import would evaluate the spinner's module
// graph before this file's mocks and per-test setup have run.
const loadActivitySpinner = async () => (await import('@/components/ui/feedback/ActivitySpinner')).ActivitySpinner;

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
        translate: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
    });
});

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
    it('does not apply an observation retired by the authenticated host scope', async () => {
        const onDraftMessageChange = vi.fn();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');
        const screen = await renderScreen(<ScmCommitComposerCard theme={theme} commitActionLabel="Commit"
            draftMessage="My draft" onDraftMessageChange={onDraftMessageChange} busy={false} status={null}
            commitAllowed commitBlockedMessage={null} onCommitFromMessage={() => {}}
            commitMessageGeneratorEnabled
            onGenerateCommitMessageSuggestion={async () => ({ ok: false, error: 'Unavailable', errorCode: 'SCM_COMMIT_MESSAGE_SCOPE_RETIRED' })} />);
        await pressTestInstanceAsync(screen.tree.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' }));
        expect(onDraftMessageChange).not.toHaveBeenCalled();
        expect(screen.tree.findAllByProps({ testID: 'scm-commit-suggestion-status' })).toHaveLength(0);
        expect(Modal.alert).not.toHaveBeenCalled();
    });
    it('retains a pending suggestion as an observation with explicit cancellation, without changing the draft', async () => {
        const onDraftMessageChange = vi.fn();
        const onCancel = vi.fn(async () => ({ ok: true as const, result: { acknowledged: true } }));
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');
        const screen = await renderScreen(<ScmCommitComposerCard theme={theme} commitActionLabel="Commit"
            draftMessage="My draft" onDraftMessageChange={onDraftMessageChange} busy={false} status={null}
            commitAllowed commitBlockedMessage={null} onCommitFromMessage={() => {}}
            commitMessageGeneratorEnabled onCancelCommitMessageSuggestion={onCancel}
            onGenerateCommitMessageSuggestion={async () => ({ ok: false, error: 'Still running', runId: 'run_1', outcome: 'pending' })} />);
        await pressTestInstanceAsync(screen.tree.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' }));
        expect(onDraftMessageChange).not.toHaveBeenCalled();
        expect(screen.tree.findByProps({ testID: 'scm-commit-suggestion-status' }).props.children).toBe('Still running');
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'scm-commit-suggestion-cancel' }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(screen.tree.findByProps({ testID: 'scm-commit-suggestion-status' })).toBeTruthy();
    });
    it.each(['draft', 'workspace'])('keeps the current editable draft when the %s changes during generation', async (change) => {
        let finish!: (value: { ok: true; message: string }) => void;
        const pending = new Promise<{ ok: true; message: string }>((resolve) => { finish = resolve; });
        const onDraftMessageChange = vi.fn();
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');
        const props = {
            theme, commitActionLabel: 'Commit', draftMessage: 'My draft', suggestionContextKey: 'home:machine:/repo',
            onDraftMessageChange, busy: false, status: null, commitAllowed: true, commitBlockedMessage: null,
            onCommitFromMessage: () => {}, commitMessageGeneratorEnabled: true,
            onGenerateCommitMessageSuggestion: async () => await pending,
        };
        const screen = await renderScreen(<ScmCommitComposerCard {...props} />);
        const { act } = await import('react-test-renderer');
        await act(async () => { void screen.tree.findByProps({ accessibilityLabel: 'files.commitMessageEditor.generate' }).props.onPress(); });
        await act(async () => {
            screen.tree.update(<ScmCommitComposerCard {...props}
                draftMessage={change === 'draft' ? 'My revised draft' : props.draftMessage}
                suggestionContextKey={change === 'workspace' ? 'other-home:machine:/repo' : props.suggestionContextKey} />);
        });
        await act(async () => { finish({ ok: true, message: 'feat: generated' }); await pending; });
        expect(onDraftMessageChange).not.toHaveBeenCalled();
    });
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

        expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(1);
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

    // Session-tabs lab G1: the commit card sums what is checked beside its one primary.
    it('sums the selected files and lines beside the commit action', async () => {
        const { ScmCommitComposerCard } = await import('./ScmCommitComposerCard');

        const screen = await renderScreen(
            <ScmCommitComposerCard
                theme={theme}
                commitActionLabel="Commit to v0.3"
                draftMessage="Key the settings modal by route"
                onDraftMessageChange={() => {}}
                busy={false}
                status={null}
                commitAllowed
                commitBlockedMessage={null}
                onCommitFromMessage={() => {}}
                selectionSummary={{ fileCount: 3, linesAdded: 63, linesRemoved: 2 }}
            />,
        );

        const summary = screen.findByTestId('scm-commit-selection-lines');
        expect(summary).toBeTruthy();
        const text = String(summary?.props.children);
        expect(text).toContain('"count":3');
        expect(text).toContain('"added":63');
        expect(text).toContain('"removed":2');
    });
});
