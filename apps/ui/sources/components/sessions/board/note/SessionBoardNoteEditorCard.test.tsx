import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type {
    SessionBoardActionOutcome,
    SessionBoardActionsPort,
    SessionBoardItemUpsertInput,
    SessionBoardMutationResult,
} from '@/sync/domains/session/board';
import { readSessionSurfaceNoteTextV1 } from '@happier-dev/protocol/sessions/board';

import { SessionBoardNoteEditorCard } from './SessionBoardNoteEditorCard';

const navigationHarness = vi.hoisted(() => ({
    dispatch: vi.fn(),
    enabled: false,
    onPreventRemove: null as null | ((event: { data: { action: unknown } }) => void),
}));

const editorHarness = vi.hoisted(() => ({
    value: '',
    flushPendingChange: vi.fn(async () => undefined),
    focus: vi.fn(),
}));
const alertRequested = vi.hoisted(() => vi.fn());

const escapeHarness = vi.hoisted(() => ({
    options: null as null | Readonly<{ onEscape: (event: unknown) => boolean | void }>,
}));

vi.mock('@/keyboard/escape', () => ({
    ESCAPE_LAYER_PRIORITIES: { draftClear: 20 },
    useEscapeLayer: (options: Readonly<{ onEscape: (event: unknown) => boolean | void }>) => {
        escapeHarness.options = options;
    },
}));

vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    useNavigation: () => ({ dispatch: navigationHarness.dispatch }),
    usePreventRemove: (
        enabled: boolean,
        onPreventRemove: (event: { data: { action: unknown } }) => void,
    ) => {
        navigationHarness.enabled = enabled;
        navigationHarness.onPreventRemove = onPreventRemove;
    },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ navigation: { dispatch: navigationHarness.dispatch } }).module;
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: (_title, _message, buttons) => {
            alertRequested();
            buttons?.find((button) => button.style === 'destructive')?.onPress?.();
        },
    } }).module;
});

vi.mock('@/components/ui/markdown/editor/MarkdownCodeEditorField', () => ({
    MarkdownCodeEditorField: (props: Readonly<{
        editorRef?: { current: unknown };
        testID?: string;
    }>) => {
        if (props.editorRef) {
            props.editorRef.current = {
                flushPendingChange: editorHarness.flushPendingChange,
                getValue: () => editorHarness.value,
                focus: editorHarness.focus,
            };
        }
        return React.createElement('MockMarkdownCodeEditor', props);
    },
}));

const actions: SessionBoardActionsPort = {
    upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
};

describe('SessionBoardNoteEditorCard', () => {
    afterEach(() => standardCleanup());

    beforeEach(() => {
        navigationHarness.dispatch.mockReset();
        navigationHarness.enabled = false;
        navigationHarness.onPreventRemove = null;
        editorHarness.value = '';
        editorHarness.flushPendingChange.mockClear();
        editorHarness.focus.mockClear();
        alertRequested.mockClear();
        escapeHarness.options = null;
    });

    it('does not prompt to discard when the final embedded edit restored the saved Note', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision="rev-1"
                initialTitle="Plan"
                initialBody="base"
                reachable
                actions={actions}
                onCancel={onCancel}
            />,
        );
        act(() => { screen.findByTestId('session-board-note-editor-body')?.props.onChange('changed'); });
        editorHarness.value = 'base';
        await act(async () => { screen.findByTestId('session-board-note-editor-cancel')?.props.onPress(); });
        expect(onCancel).toHaveBeenCalledOnce();
        expect(alertRequested).not.toHaveBeenCalled();
    });

    it('moves focus from the title into the incumbent markdown body on Enter', async () => {
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                initialTitle=""
                initialBody=""
                reachable
                actions={actions}
                onCancel={vi.fn()}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-note-editor-title')?.props.onSubmitEditing();
        });

        expect(editorHarness.focus).toHaveBeenCalledOnce();
    });

    it('uses the same flushed save for Cmd/Ctrl+Enter', async () => {
        const submitted: SessionBoardItemUpsertInput[] = [];
        const upsertItem = vi.fn(async (
            input: SessionBoardItemUpsertInput,
        ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
            submitted.push(input);
            return {
            status: 'ok' as const,
            value: {
                v: 1 as const,
                serverId: 'home-1',
                sessionId: 'session-1',
                result: {
                    operation: 'upsert_item' as const,
                    itemId: 'note-1',
                    outcome: 'created' as const,
                    itemRevision: 'rev-1',
                    layoutRevision: 'layout-1',
                },
                destination: { tabId: 'overview', width: 'medium' as const },
            },
            };
        });
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                placement={{ tabId: 'overview', tabTitle: 'Overview', width: 'medium' }}
                initialTitle="Release"
                initialBody="Body"
                reachable
                actions={{ ...actions, upsertItem }}
                onCancel={vi.fn()}
            />,
        );
        editorHarness.value = 'Body with final keystroke';
        const preventDefault = vi.fn();

        await act(async () => {
            screen.findByTestId('session-board-note-editor-title')?.props.onKeyPress({
                nativeEvent: { key: 'Enter', metaKey: true },
                preventDefault,
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(upsertItem).toHaveBeenCalledOnce();
        const item = submitted[0]?.item;
        expect(item?.source.kind).toBe('declarative');
        expect(item?.source.kind === 'declarative'
            ? readSessionSurfaceNoteTextV1(item.source.document)
            : null).toBe('Body with final keystroke');
    });

    it('keeps the draft visible and explains when Save is awaiting approval', async () => {
        const upsertItem: SessionBoardActionsPort['upsertItem'] = vi.fn(async (
            _input: SessionBoardItemUpsertInput,
        ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => ({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-1',
                actionId: 'session.board.item.upsert',
            },
        }));
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                placement={{ tabId: 'overview', tabTitle: 'Overview', width: 'medium' }}
                initialTitle="Release"
                initialBody="Body"
                reachable
                actions={{ ...actions, upsertItem }}
                requestApprovalContinuation={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-note-editor-title')?.props.onChangeText('Release plan');
            screen.findByTestId('session-board-note-editor-save')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(upsertItem).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-board-note-editor-title')?.props.value).toBe('Release plan');
        expect(screen.findHostByTestId('session-board-note-editor-notice')).not.toBeNull();
        expect(screen.findByTestId('session-board-note-editor-save')?.props.disabled).toBe(true);
    });

    it('does not offer review or render an empty latest note before the conflict refresh settles', async () => {
        const requestRecoveryRefresh = vi.fn();
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision="rev-1"
                initialTitle="Release"
                initialBody="Body"
                latestRevision={null}
                latestBody={null}
                reachable
                actions={{
                    ...actions,
                    upsertItem: async () => ({
                        status: 'refused',
                        error: {
                            error: 'session_board_revision_conflict',
                            currentItemRevision: 'rev-2',
                        },
                    }),
                }}
                requestRecoveryRefresh={requestRecoveryRefresh}
                onCancel={vi.fn()}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-note-editor-save')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-board-note-editor-review-latest')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-board-note-editor-review')).toBeNull();
    });

    it('routes Escape from an editable body through the same unsaved guard', async () => {
        const onCancel = vi.fn();
        await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                initialTitle=""
                initialBody=""
                reachable
                actions={actions}
                onCancel={onCancel}
            />,
        );
        editorHarness.value = 'unsaved body';

        await act(async () => {
            escapeHarness.options?.onEscape({ key: 'Escape' });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(editorHarness.flushPendingChange).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('continues the exact blocked navigation after discarding an unsaved note', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                initialTitle="Draft"
                initialBody=""
                reachable
                actions={actions}
                onCancel={onCancel}
                guardNavigation
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-note-editor-title')?.props.onChangeText('Changed');
        });
        expect(navigationHarness.enabled).toBe(true);

        const action = { type: 'GO_BACK', source: 'board-details' };
        await act(async () => {
            navigationHarness.onPreventRemove?.({ data: { action } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(onCancel).toHaveBeenCalledOnce();
        expect(navigationHarness.dispatch).toHaveBeenCalledWith(action);
    });

    it('flushes a final debounced body edit before deciding whether navigation may remove the editor', async () => {
        const onCancel = vi.fn();
        await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                initialTitle=""
                initialBody=""
                reachable
                actions={actions}
                onCancel={onCancel}
                guardNavigation
            />,
        );

        // The embedded editor has the person's final keystroke, but its debounced
        // onChange has not published it into the React draft yet.
        editorHarness.value = 'final character';
        const action = { type: 'GO_BACK', source: 'board-details' };
        await act(async () => {
            navigationHarness.onPreventRemove?.({ data: { action } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(editorHarness.flushPendingChange).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
        expect(navigationHarness.dispatch).toHaveBeenCalledWith(action);
    });
});
