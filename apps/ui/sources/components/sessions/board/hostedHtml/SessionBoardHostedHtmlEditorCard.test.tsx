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

vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    useNavigation: () => ({ dispatch: vi.fn() }),
    usePreventRemove: () => undefined,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef(function MockCodeEditor(props: Readonly<{
        testID?: string;
        value: string;
        readOnly?: boolean;
    }>, ref: React.ForwardedRef<Readonly<{
        getValue: () => string;
        flushPendingChange: () => Promise<void>;
    }>>) {
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
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: (_title, _message, buttons) => {
            decisionHarness.request();
            const style = decisionHarness.decision === 'discard' ? 'destructive' : 'cancel';
            buttons?.find((button) => button.style === style)?.onPress?.();
        },
    } }).module;
});

const baseActions: SessionBoardActionsPort = {
    upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
};

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
        const upserts: SessionBoardItemUpsertInput[] = [];
        let attempt = 0;
        const upsertItem = vi.fn(async (
            input: SessionBoardItemUpsertInput,
        ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
            upserts.push(input);
            attempt += 1;
            if (attempt === 1) {
                return { status: 'refused' as const, error: { error: 'session_board_revision_conflict' as const } };
            }
            return {
                status: 'ok' as const,
                value: {
                    v: 1 as const,
                    serverId: 'home-1',
                    sessionId: 'session-1',
                    result: {
                        operation: 'upsert_item' as const,
                        itemId: 'interactive-1',
                        outcome: 'updated' as const,
                        itemRevision: 'rev-4',
                    },
                    destination: null,
                },
            };
        });
        const onCancel = vi.fn();
        const onSaved = vi.fn();
        const requestRecoveryRefresh = vi.fn();
        const screen = await renderScreen(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision="rev-2"
                latestRevision="rev-2"
                latestHtml="<main>mine</main>"
                initialTitle="Dashboard"
                initialHtml="<main>mine</main>"
                reachable
                actions={{ ...baseActions, upsertItem }}
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

        expect(screen.findByTestId('session-board-hosted-html-editor-review-latest')).not.toBeNull();
        expect(screen.findByTestId('session-board-hosted-html-editor-latest-source')).toBeNull();
        expect(screen.findByTestId('session-board-hosted-html-editor-source')?.props.value).toBe('<main>mine final</main>');
        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();

        await screen.update(
            <SessionBoardHostedHtmlEditorCard
                sessionId="session-1"
                itemId="interactive-1"
                expectedItemRevision="rev-2"
                latestRevision="rev-3"
                latestHtml="<main>theirs</main>"
                initialTitle="Dashboard"
                initialHtml="<main>mine</main>"
                reachable
                actions={{ ...baseActions, upsertItem }}
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

        expect(upserts[1]).toMatchObject({
            expectedItemRevision: 'rev-3',
            item: { source: { kind: 'hostedHtml', source: { html: '<main>mine final</main>' } } },
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
