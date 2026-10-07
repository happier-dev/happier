import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CodeEditorHandle, CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';
import { unavailableSessionBoardActions } from '@/sync/domains/session/board/sessionBoardActionsPort';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board';
import { realBoardActions } from '../sessionBoardActionsTestkit';

import { SessionBoardHostedHtmlEditorCard } from './SessionBoardHostedHtmlEditorCard';

const editorHarness = vi.hoisted(() => ({
    values: new Map<string, string>(),
    renderedValues: new Map<string, Readonly<{ value: string; readOnly: boolean }>>(),
    flushPendingChange: vi.fn(async () => undefined),
}));
const decisionHarness = vi.hoisted(() => ({
    decision: 'keepEditing' as 'keepEditing' | 'discard',
    request: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ navigation: { dispatch: vi.fn() } }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit');
    return createReactNavigationNativeMock();
});

// The embedded CodeMirror platform surface cannot mount in react-test-renderer;
// retain the real card, draft owner, save path and navigation guard underneath.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef<CodeEditorHandle, CodeEditorProps>(function MockCodeEditor(props, ref) {
        const testID = props.testID ?? 'code-editor';
        editorHarness.renderedValues.set(testID, {
            value: props.value,
            readOnly: props.readOnly === true,
        });
        React.useImperativeHandle(ref, () => ({
            getValue: () => editorHarness.values.get(testID) ?? props.value,
            flushPendingChange: editorHarness.flushPendingChange,
        }), [props.value, testID]);
        return React.createElement('MockCodeEditor', props);
    }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({ spies: {
        alert: (_title, _message, buttons) => {
            decisionHarness.request();
            const style = decisionHarness.decision === 'discard' ? 'destructive' : 'cancel';
            buttons?.find((button) => button.style === style)?.onPress?.();
        },
    } }).module;
});

const baseActions = unavailableSessionBoardActions;
const revision2 = 'ssr1.AAAACHN5c3JlY18yAAAAAg';
const revision3 = 'ssr1.AAAACHN5c3JlY18zAAAAAw';
const revision4 = 'ssr1.AAAACHN5c3JlY180AAAABA';

describe('SessionBoardHostedHtmlEditorCard', () => {
    afterEach(() => standardCleanup());

    beforeEach(() => {
        editorHarness.values.clear();
        editorHarness.renderedValues.clear();
        editorHarness.flushPendingChange.mockClear();
        decisionHarness.decision = 'keepEditing';
        decisionHarness.request.mockClear();
    });

    it('closes without a discard prompt when the final embedded edit undid every change', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision="rev-2"
                initialTitle="Dashboard"
                initialHtml="<main>base</main>"
                reachable
                actions={baseActions}
                onCancel={onCancel}
                onSaved={vi.fn()}
            />,
        );
        act(() => {
            screen.findByTestId('session-board-hosted-html-editor-source')?.props.onChange('<main>changed</main>');
        });
        // Undo is still behind the embedded editor's debounce when Cancel is pressed.
        editorHarness.values.set('session-board-hosted-html-editor-source', '<main>base</main>');
        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-cancel')?.props.onPress();
        });
        expect(onCancel).toHaveBeenCalledOnce();
        expect(decisionHarness.request).not.toHaveBeenCalled();
    });

    it('shows the authoritative HTML only after review and then applies the retained local draft', async () => {
        const upserts: Array<ReturnType<typeof SessionBoardMutationV1Schema.parse>> = [];
        let attempt = 0;
        const actions = realBoardActions(async (_path, init) => {
            if (init?.method !== 'PUT') return Response.json({ record: {
                id: 'html-row',
                address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'interactive-1' },
                content: { t: 'plain', v: {
                    v: 1, title: 'Dashboard', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'hostedHtml', source: { kind: 'html', html: attempt ? '<main>theirs</main>' : '<main>mine</main>' } },
                } },
                revision: attempt ? revision3 : revision2,
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
            } });
            upserts.push(SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body))));
            attempt += 1;
            if (attempt === 1) {
                return Response.json({ error: 'session_board_revision_conflict', currentItemRevision: revision3 }, { status: 409 });
            }
            return Response.json({ operation: 'upsert_item', itemId: 'interactive-1', outcome: 'updated', itemRevision: revision4 });
        }, undefined, { serverId: 'home-1', sessionId: 'session-1' });
        const onCancel = vi.fn();
        const onSaved = vi.fn();
        const requestRecoveryRefresh = vi.fn();
        const screen = await renderScreen(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision={revision2}
                latestRevision={revision2}
                latestHtml="<main>mine</main>"
                initialTitle="Dashboard"
                initialHtml="<main>mine</main>"
                reachable
                actions={actions}
                requestRecoveryRefresh={requestRecoveryRefresh}
                onCancel={onCancel}
                onSaved={onSaved}
            />,
        );
        editorHarness.values.set('session-board-hosted-html-editor-source', '<main>mine final</main>');

        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-save')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        await vi.waitFor(async () => {
            await act(async () => {});
            expect(requestRecoveryRefresh).toHaveBeenCalledOnce();
        });
        expect(screen.findByTestId('session-board-hosted-html-editor-review-latest')).not.toBeNull();
        expect(screen.findByTestId('session-board-hosted-html-editor-latest-source')).toBeNull();
        expect(screen.findByTestId('session-board-hosted-html-editor-source')?.props.value).toBe('<main>mine final</main>');
        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();

        await screen.update(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision={revision2}
                latestRevision={revision3}
                latestHtml="<main>theirs</main>"
                initialTitle="Dashboard"
                initialHtml="<main>mine</main>"
                reachable
                actions={actions}
                requestRecoveryRefresh={requestRecoveryRefresh}
                onCancel={onCancel}
                onSaved={onSaved}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-review-latest')?.props.onPress();
        });

        expect(editorHarness.renderedValues.get('session-board-hosted-html-editor-latest-source')).toEqual({
            value: '<main>theirs</main>',
            readOnly: true,
        });
        expect(editorHarness.renderedValues.get('session-board-hosted-html-editor-source')?.value).toBe('<main>mine final</main>');

        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-save')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
        expect(upserts[1]).toMatchObject({
            expectedItemRevision: revision3,
            itemContent: { t: 'plain', v: { source: { kind: 'hostedHtml', source: { html: '<main>mine final</main>' } } } },
        });
    });

    it('uses the incumbent unsaved-change decision before closing a changed draft', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision="rev-2"
                initialTitle="Dashboard"
                initialHtml="<main>base</main>"
                reachable
                actions={baseActions}
                onCancel={onCancel}
                onSaved={vi.fn()}
            />,
        );
        editorHarness.values.set('session-board-hosted-html-editor-source', '<main>unsaved final</main>');

        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-cancel')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(decisionHarness.request).toHaveBeenCalledOnce();
        expect(onCancel).not.toHaveBeenCalled();

        decisionHarness.decision = 'discard';
        await act(async () => {
            screen.findByTestId('session-board-hosted-html-editor-cancel')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(onCancel).toHaveBeenCalledOnce();
    });
});
