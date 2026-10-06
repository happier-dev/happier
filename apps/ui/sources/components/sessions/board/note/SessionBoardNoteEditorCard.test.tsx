import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { dispatchEscapeToLayerStack } from '@/keyboard/escape';
import type { CodeEditorHandle, CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';
import { unavailableSessionBoardActions } from '@/sync/domains/session/board/sessionBoardActionsPort';
import { createSessionSurfaceNoteDocumentV1, readSessionSurfaceNoteTextV1, SessionBoardMutationV1Schema, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { realBoardActions } from '../sessionBoardActionsTestkit';

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

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ navigation: { dispatch: navigationHarness.dispatch } }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, onPreventRemove) => {
            navigationHarness.enabled = enabled;
            navigationHarness.onPreventRemove = onPreventRemove;
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ navigation: { dispatch: navigationHarness.dispatch } }).module;
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({ spies: {
        alert: (_title, _message, buttons) => {
            alertRequested();
            buttons?.find((button) => button.style === 'destructive')?.onPress?.();
        },
    } }).module;
});

// The embedded CodeMirror platform surface cannot mount in react-test-renderer;
// keep MarkdownCodeEditorField and its ref forwarding/mode decisions real.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef<CodeEditorHandle, CodeEditorProps>(function MockCodeEditor(props, ref) {
        React.useImperativeHandle(ref, () => ({
            flushPendingChange: editorHarness.flushPendingChange,
            getValue: () => editorHarness.value,
            focus: editorHarness.focus,
        }), []);
        return React.createElement('MockCodeEditor', props);
    }),
}));

const actions = unavailableSessionBoardActions;
const revision1 = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const revision2 = 'ssr1.AAAACHN5c3JlY18yAAAAAg';

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
        act(() => { screen.tree.root.findByType('MockCodeEditor').props.onChange('changed'); });
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
        const submitted: Array<ReturnType<typeof SessionBoardMutationV1Schema.parse>> = [];
        const savingActions = realBoardActions(async (_path, init) => {
            if (init?.method !== 'PUT') return Response.json({ record: null });
            submitted.push(SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body))));
            return Response.json({ operation: 'upsert_item', itemId: 'note-1', outcome: 'created', itemRevision: revision1, layoutRevision: revision1 });
        }, undefined, { serverId: 'home-1', sessionId: 'session-1' });
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                placement={{ tabId: 'overview', tabTitle: 'Overview', width: 'medium' }}
                initialTitle="Release"
                initialBody="Body"
                reachable
                actions={savingActions}
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
        await vi.waitFor(() => expect(submitted).toHaveLength(1));
        const mutation = submitted[0];
        const item = mutation?.operation === 'upsert_item' && mutation.itemContent.t === 'plain'
            ? SessionSurfaceItemV1Schema.parse(mutation.itemContent.v) : null;
        expect(item?.source.kind).toBe('declarative');
        expect(item?.source.kind === 'declarative'
            ? readSessionSurfaceNoteTextV1(item.source.document)
            : null).toBe('Body with final keystroke');
    });

    it('keeps the draft visible and explains when Save is awaiting approval', async () => {
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
        const approvalActions = realBoardActions(async () => {
            throw new Error('Approval must precede the Board mutation');
        }, approvalsCreate, { serverId: 'home-1', sessionId: 'session-1' });
        const screen = await renderScreen(
            <SessionBoardNoteEditorCard
                sessionId="session-1"
                itemId="note-1"
                expectedItemRevision={null}
                placement={{ tabId: 'overview', tabTitle: 'Overview', width: 'medium' }}
                initialTitle="Release"
                initialBody="Body"
                reachable
                actions={approvalActions}
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

        await vi.waitFor(async () => {
            await act(async () => {});
            expect(approvalsCreate).toHaveBeenCalledOnce();
            expect(screen.findHostByTestId('session-board-note-editor-notice')).not.toBeNull();
            expect(screen.findByTestId('session-board-note-editor-save')?.props.disabled).toBe(true);
        });
        expect(approvalsCreate).toHaveBeenCalledOnce();
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
                expectedItemRevision={revision1}
                initialTitle="Release"
                initialBody="Body"
                latestRevision={null}
                latestBody={null}
                reachable
                actions={realBoardActions(async (_path, init) => {
                    if (init?.method === 'PUT') throw new Error('Stale editor must not write');
                    return Response.json({ record: {
                        id: 'note-row',
                        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note-1' },
                        content: { t: 'plain', v: {
                            v: 1, title: 'Release', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('New body') },
                        } },
                        revision: revision2,
                        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
                    } });
                }, undefined, { serverId: 'home-1', sessionId: 'session-1' })}
                requestRecoveryRefresh={requestRecoveryRefresh}
                onCancel={vi.fn()}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-note-editor-save')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        await vi.waitFor(async () => {
            await act(async () => {});
            expect(requestRecoveryRefresh).toHaveBeenCalledOnce();
        });
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
            expect(dispatchEscapeToLayerStack({ key: 'Escape', target: { tagName: 'textarea' } })).toBe(true);
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
