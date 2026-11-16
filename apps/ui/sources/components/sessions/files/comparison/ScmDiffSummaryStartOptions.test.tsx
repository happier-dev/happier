import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen } from '@/dev/testkit';

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

const { ScmDiffSummaryStartOptions, useSummaryModelChoice, scmDiffSummaryPrerequisiteOf } = await import('./ScmDiffSummaryStartOptions');
const { SPECIMEN_START_FAILURES } = await import('@/components/dev/changes/walkthroughSpecimenFixture');

describe('ScmDiffSummaryStartOptions', () => {
    it('names the one cause a start cannot run, instead of one sentence for every cause', () => {
        const ready = { machineReachability: 'reachable', canSend: true, launch: { canLaunchExecutionRuns: true, launchUnavailableReason: null } } satisfies Parameters<typeof scmDiffSummaryPrerequisiteOf>[0];
        expect(scmDiffSummaryPrerequisiteOf(ready)).toBeNull();
        const causes = [
            scmDiffSummaryPrerequisiteOf({ ...ready, machineReachability: 'unreachable', launch: { canLaunchExecutionRuns: false, launchUnavailableReason: 'machineOffline' } }),
            scmDiffSummaryPrerequisiteOf({ ...ready, launch: { canLaunchExecutionRuns: false, launchUnavailableReason: 'sessionInactive' } }),
        ];
        // A model is never a prerequisite: Auto is resolved on the executing machine, which refuses with a typed reason.
        expect(causes).toEqual(['walkthroughStart.machineOffline', 'sessionAgentActivity.roster.unavailable.sessionInactive']);
        // The Machine being away outranks what the Session would need once it is back.
        expect(scmDiffSummaryPrerequisiteOf({ ...ready, machineReachability: 'unreachable', launch: { canLaunchExecutionRuns: false, launchUnavailableReason: 'sessionInactive' } }))
            .toBe('walkthroughStart.machineOffline');
        expect(scmDiffSummaryPrerequisiteOf({ ...ready, machineReachability: 'unknown',
            canSend: false, launch: { canLaunchExecutionRuns: false, launchUnavailableReason: 'machineOffline' } })).toBe('walkthroughStart.unavailable');
    });

    it('says one localized sentence and the next step for a refusal, never its code', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.outdated} message="invalid_action_output" />);
        const text = screen.getTextContent();
        expect(text).toContain('walkthrough.generationFailure.invalidRequest');
        expect(text).toContain('walkthrough.generationFailure.reviewRequest');
        // A typed refusal replaces any incidental message, so no raw code can sit beside it.
        expect(text).not.toContain('invalid_action_output');
    });

    it('offers choosing another model when the model is the refusal', async () => {
        const onChooseModel = vi.fn();
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.model} message={null} onChooseModel={onChooseModel} />);
        await screen.pressByTestIdAsync('start-options-choose-model');
        expect(onChooseModel).toHaveBeenCalledTimes(1);
    });

    it('lets the model choice already on screen be the next step, instead of a second control for it', async () => {
        const onChooseModel = vi.fn();
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.model} message={null}
            model={{ value: { v: 1, mode: 'auto' }, onChange: vi.fn(), testID: 'start-options-model' }} onChooseModel={onChooseModel} />);
        expect(screen.findByTestId('start-options-model')).not.toBeNull();
        expect(screen.getTextContent()).toContain('walkthrough.generationFailure.modelUnavailable');
        expect(screen.findByTestId('start-options-choose-model')).toBeNull();
    });

    it('leaves an action nobody can press out of the refusal, instead of a dangling clause', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.model} message={null} />);
        expect(screen.getTextContent()).toBe('walkthrough.generationFailure.modelUnavailable');
    });

    it('puts the model choice on screen when the person is sent to it, from every surface that shows a result', async () => {
        const hook = await renderHook(() => useSummaryModelChoice());
        expect(hook.getCurrent().choosing).toBe(false);
        await act(async () => { hook.getCurrent().choose(); });
        expect(hook.getCurrent().choosing).toBe(true);
        await hook.unmount();
    });

    it('keeps native diagnostic strings out of the typed failure sentence', async () => {
        const generic = { reason: 'generationFailed', messageKey: 'walkthrough.notice.failedGeneric', nextAction: 'retry', nextActionKey: 'walkthrough.notice.tryAgain',
            message: 'CLI_START_FAILED: the runner could not start' } as const;
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={generic} message={null} />);
        expect(screen.getTextContent()).toBe('walkthrough.notice.failedGeneric');
    });

    it('keeps the refusal room when nothing was refused, so a refusal never moves the state', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={null} message={null} />);
        expect(screen.findByTestId('start-options-refusal')).toBeTruthy();
        expect(screen.getTextContent()).toBe('');
    });
});
