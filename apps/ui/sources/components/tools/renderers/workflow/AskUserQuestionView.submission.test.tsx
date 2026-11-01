import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture, makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

const { sessionRPC } = vi.hoisted(() => ({ sessionRPC: vi.fn() }));

// Only the socket transport is replaced: permission dispatch and CLI ACK validation stay real.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { sessionRPC } }));

installWorkflowRendererCommonModuleMocks({ storage: (importOriginal) => importOriginal() });

const initialStorageState = storage.getState();

async function renderQuestion() {
    storage.getState().applySessions([createSessionFixture({
        id: 's1',
        metadata: null,
        agentState: {
            requests: { toolu_1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 } },
        },
    })]);
    const { AskUserQuestionView } = await import('./AskUserQuestionView');
    const tool = makeToolCall({
        name: 'AskUserQuestion',
        state: 'running',
        completedAt: null,
        permission: { id: 'toolu_1', status: 'pending' },
        input: {
            questions: [
                { header: 'Choice', question: 'Pick one', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
                { header: 'Details', question: 'What else?', multiSelect: false, options: [] },
            ],
        },
    });
    const screen = await renderScreen(
        <AppPaneProvider>
            <AskUserQuestionView {...makeToolViewProps(tool, { sessionId: 's1' })} />
        </AppPaneProvider>,
    );
    await screen.pressByTestIdAsync('ask-user-question.option:0:0');
    await act(async () => {
        screen.changeTextByTestId('ask-user-question.freeform:1', 'Keep this answer');
    });
    return screen;
}

async function startSubmission(screen: Awaited<ReturnType<typeof renderQuestion>>) {
    let submission: Promise<void>;
    await act(async () => {
        submission = screen.findByTestId('ask-user-question.submit')!.props.onPress();
    });
    return { finish: () => act(async () => { await submission; }) };
}

function expectPending(screen: Awaited<ReturnType<typeof renderQuestion>>) {
    expect(screen.findByTestId('ask-user-question.submit')?.props.disabled).toBe(true);
    expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
    expect(screen.findByTestId('ask-user-question.option:0:0')?.props.disabled).toBe(true);
    expect(screen.findByTestId('ask-user-question.option:0:1')?.props.disabled).toBe(true);
    expect(screen.findByTestId('ask-user-question.freeform:1')?.props.editable).toBe(false);
}

describe('AskUserQuestionView submission acknowledgment', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        storage.setState(initialStorageState, true);
    });

    it('keeps answers visible and locked while pending, then shows submitted answers after CLI acceptance', async () => {
        const acknowledgment = createDeferred<unknown>();
        sessionRPC.mockReturnValueOnce(acknowledgment.promise);
        const screen = await renderQuestion();
        const submission = await startSubmission(screen);

        expectPending(screen);
        await act(async () => {
            screen.pressByTestId('ask-user-question.option:0:1');
            screen.changeTextByTestId('ask-user-question.freeform:1', 'An ignored edit');
        });
        expect(screen.findByTestId('ask-user-question.option:0:0')?.props.accessibilityState.selected).toBe(true);
        expect(screen.findByTestId('ask-user-question.freeform:1')?.props.value).toBe('Keep this answer');
        expect(sessionRPC).toHaveBeenCalledWith('s1', 'permission', {
            id: 'toolu_1', approved: true, answers: { 'Pick one': 'A', 'What else?': 'Keep this answer' },
        }, expect.any(Object));

        acknowledgment.resolve({ ok: true });
        await submission.finish();
        expect(screen.findByTestId('ask-user-question.submit')).toBeNull();
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Keep this answer');
    });

    it('preserves selections and freeform answers after a rejected CLI ACK and allows an explicit retry', async () => {
        const acknowledgment = createDeferred<unknown>();
        sessionRPC.mockReturnValueOnce(acknowledgment.promise);
        const screen = await renderQuestion();
        const submission = await startSubmission(screen);

        expectPending(screen);
        acknowledgment.resolve({ ok: false, errorCode: 'permission_request_not_found' });
        await submission.finish();

        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findByTestId('ask-user-question.submit')?.props.disabled).toBe(false);
        expect(screen.findByTestId('ask-user-question.option:0:0')?.props.accessibilityState.selected).toBe(true);
        expect(screen.findByTestId('ask-user-question.option:0:1')?.props.disabled).toBe(false);
        expect(screen.findByTestId('ask-user-question.freeform:1')?.props).toMatchObject({ editable: true, value: 'Keep this answer' });

        const retryAcknowledgment = createDeferred<unknown>();
        sessionRPC.mockReturnValueOnce(retryAcknowledgment.promise);
        const retry = await startSubmission(screen);
        expectPending(screen);
        retryAcknowledgment.resolve({ ok: true });
        await retry.finish();
        expect(screen.findByTestId('ask-user-question.submit')).toBeNull();
        expect(sessionRPC).toHaveBeenLastCalledWith('s1', 'permission', {
            id: 'toolu_1', approved: true, answers: { 'Pick one': 'A', 'What else?': 'Keep this answer' },
        }, expect.any(Object));
    });
});
