import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { buildPromptPickerRows, type PromptPickerRow } from '../promptPickerRows';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const { PromptPickerFooter, PromptPickerPreview } = await import('../PromptPickerParts');
afterEach(standardCleanup);

const history: UserMessageHistoryEntriesSnapshot = {
    entries: [], coverage: 'partial', hasMore: false, isLoading: false, error: false,
    progress: { pagesLoaded: 1, sessionsSearched: 1, totalSessions: 1 },
    loadMore: async () => {}, retry: async () => {}, stop: () => {},
};

describe('picker coverage and preview read admission', () => {
    it.each([false, true])('retains partial history coverage after known paging ends (hardware=%s)', async (hardwareKeyboard) => {
        const screen = await renderScreen(<PromptPickerFooter history={history} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findAllByType(KeyHint).map((hint) => hint.props.label)).toEqual(hardwareKeyboard
            ? ['↑↓', '↵', 'Ctrl+Enter', 'Ctrl+D'] : []);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.partialHistory');
        await screen.update(<PromptPickerFooter history={{ ...history, coverage: 'loaded', hasMore: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.loadedHistory');
        expect(screen.findByTestId('prompt-picker-history-more')).not.toBeNull();
        await screen.update(<PromptPickerFooter history={{ ...history, isLoading: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-history-stop');
        await screen.update(<PromptPickerFooter history={{ ...history, error: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.historyError');
    });

    it('reads a preview once across filtering, then refreshes on selection or content revision', async () => {
        const documents = [
            { artifactId: 'one', title: 'Run tests', tags: [], folderId: null, favorite: false, updatedAtMs: 1 },
            { artifactId: 'two', title: 'Other tests', tags: [], folderId: null, favorite: false, updatedAtMs: 1 },
        ];
        const rows = (query: string) => buildPromptPickerRows({ documents, invocations: [], builtIns: [], history: [], sessionId: null, query });
        const read = vi.fn(async (row: PromptPickerRow) => `${row.id} body`);
        const preview = (query: string, index = 0) => <PromptPickerPreview row={rows(query)[index]} read={read} nowMs={0} folderNames={new Map()} sessionNames={new Map()} />;
        const screen = await renderScreen(preview(''));
        await act(async () => {});
        expect(screen.getTextContent()).toContain('doc:one body');
        await screen.update(preview('Run'));
        expect(read).toHaveBeenCalledTimes(1);
        await screen.update(preview('', 1));
        expect(read).toHaveBeenCalledTimes(2);
        documents[1] = { ...documents[1], updatedAtMs: 2 };
        await screen.update(preview('', 1));
        expect(read).toHaveBeenCalledTimes(3);
    });
});
