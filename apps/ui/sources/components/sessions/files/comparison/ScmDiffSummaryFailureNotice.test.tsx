import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

const { ScmDiffSummaryFailureNotice } = await import('./ScmDiffSummaryFailureNotice');
const { SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, SCM_DIFF_SUMMARY_GENERIC_FAILURE } = await import('@/sync/domains/scm/diffSummary/state');
const { applyScmDiffSummaryEvent, createInitialScmDiffSummaryState, selectScmDiffSummaryViewModel } = await import('@/sync/domains/scm/diffSummary/state');

const MODEL_UNAVAILABLE = { reason: 'modelUnavailable', messageKey: 'walkthrough.generationFailure.modelUnavailable',
    nextAction: 'chooseModel', nextActionKey: 'walkthrough.notice.chooseModel' } as const;
const RECONNECT = { reason: 'machineUnavailable', messageKey: 'walkthrough.generationFailure.machineUnavailable',
    nextAction: 'reconnectMachine', nextActionKey: 'walkthrough.generationFailure.reconnectMachine' } as const;

describe('ScmDiffSummaryFailureNotice', () => {
    it('shows Choose model for a typed Start model refusal and opens the existing picker action', async () => {
        const onChooseModel = vi.fn();
        const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'MODEL_UNAVAILABLE',
            error: 'Diff-summary model is unavailable', nextAction: 'chooseModel',
            outputs: { walkthrough: { state: 'failed', reasonCode: 'MODEL_UNAVAILABLE', reason: 'Diff-summary model is unavailable' } } });
        const state = applyScmDiffSummaryEvent(createInitialScmDiffSummaryState(), { type: 'request_started',
            key: 'model-refused', sessionId: 'session', actionId: 'scm.diffSummary.generate',
            input: { cwd: '/repo', source: { kind: 'workingTree' }, outputs: ['walkthrough'] },
            structuredOutput: output, runId: null, requestedAtMs: 1, intent: 'generate' });
        const view = selectScmDiffSummaryViewModel(state, 'model-refused', 'walkthrough');
        expect(view).toMatchObject({ status: 'failed', executionRunId: null, error: { nextAction: 'chooseModel' } });
        if (!view.error) throw new Error('Expected the typed unavailable model');
        const screen = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={view.error} onChooseModel={onChooseModel} />);
        expect(screen.findByTestId('proposal-choose-model')).not.toBeNull();
        screen.findByTestId('proposal-choose-model')?.props.onPress();
        expect(onChooseModel).toHaveBeenCalledTimes(1);
        // The action is the button, not also a clause of the sentence.
        expect(screen.getTextContent().split('walkthrough.notice.chooseModel')).toHaveLength(2);
    });

    it('never leaves an action the person cannot press as an unfinished clause', async () => {
        const unpressable = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={MODEL_UNAVAILABLE} />);
        expect(unpressable.findByTestId('proposal-choose-model')).toBeNull();
        expect(unpressable.getTextContent()).toBe('walkthrough.generationFailure.modelUnavailable');
        // A step with nothing to press stays part of the sentence.
        const sentence = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={RECONNECT} />);
        expect(sentence.getTextContent()).toContain('walkthrough.generationFailure.reconnectMachine');
    });

    it('uses only the typed failure and recovery instead of raw diagnostics or a model action', async () => {
        const failure = { ...SCM_DIFF_SUMMARY_GENERIC_FAILURE, message: 'MODEL_UNAVAILABLE: no model could start' };
        const screen = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={failure}
            onChooseModel={() => {}} onRetry={() => {}} />);
        expect(screen.getTextContent()).toContain('walkthrough.notice.failedGeneric');
        expect(screen.getTextContent()).not.toContain(failure.message);
        expect(screen.findByTestId('proposal-notice-failed-reason')).toBeNull();
        expect(screen.findByTestId('proposal-choose-model')).toBeNull();
        expect(screen.findByTestId('proposal-retry')).not.toBeNull();
    });

    it('leads with the fact of where writing stopped, and adds the cause only when it is typed', async () => {
        const unclassified = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" lead="stopped after 3" failure={SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE} onRetry={() => {}} />);
        expect(unclassified.getTextContent()).toContain('stopped after 3');
        expect(unclassified.getTextContent()).not.toContain('walkthrough.notice.endedPartway');
        const typed = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" lead="stopped after 3" failure={MODEL_UNAVAILABLE} onChooseModel={() => {}} />);
        expect(typed.getTextContent()).toContain('stopped after 3');
        // The lead and its cause read as two clauses of one line, not one run-on sentence.
        expect(typed.getTextContent()).toContain('stopped after 3 ·');
        expect(unclassified.getTextContent()).not.toContain('stopped after 3 ·');
        expect(typed.getTextContent()).toContain('walkthrough.generationFailure.modelUnavailable');
        expect(typed.findByTestId('proposal-choose-model')).not.toBeNull();
    });


    it('names a change too large for the runtime without offering a retry or a model that cannot fix it', async () => {
        const tooLarge = { reason: 'inputTooLarge', messageKey: 'walkthrough.generationFailure.inputTooLarge',
            nextAction: 'narrowChange', nextActionKey: 'walkthrough.generationFailure.narrowChange' } as const;
        const screen = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" lead="stopped after 3" failure={tooLarge}
            onChooseModel={() => {}} onRetry={() => {}} />);
        expect(screen.getTextContent()).toContain('walkthrough.generationFailure.inputTooLarge');
        expect(screen.getTextContent()).toContain('walkthrough.generationFailure.narrowChange');
        expect(screen.findByTestId('proposal-choose-model')).toBeNull();
        expect(screen.findByTestId('proposal-retry')).toBeNull();
    });

});
