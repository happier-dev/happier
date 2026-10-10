import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';

const push = vi.hoisted(() => vi.fn());
// The exact-run read is the HTTP boundary; it must not be reached for a run this device knows.
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/sync/engine/workflows/refreshWorkflowRun', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/engine/workflows/refreshWorkflowRun')>()),
    refreshWorkflowRunById: refresh,
}));
// The Account lifetime is the auth/session boundary the exact-run read is fenced by.
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeLifetime: () => ({
        scope: { serverId: 'home-a', accountId: 'account-a' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    }),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/step', router: { push } }).module;
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SessionStepWork, readSessionWorkflowStepRunId } = await import('./SessionStepWork');
afterEach(async () => { await standardCleanup(); push.mockReset(); refresh.mockClear(); });

describe('SessionStepWork (lab session-F)', () => {
    it('reads the step run only from a run_step origin', () => {
        expect(readSessionWorkflowStepRunId({ origin: { kind: 'run_step', runId: 'run-7' } })).toBe('run-7');
        expect(readSessionWorkflowStepRunId({ origin: { kind: 'user' } as never })).toBeNull();
        expect(readSessionWorkflowStepRunId({ origin: undefined })).toBeNull();
    });

    it('names the run it is part of with its progress and machine, opens it, and says why nothing is set here', async () => {
        const previous = storage.getState();
        try {
            act(() => {
                storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
                storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                    createWorkflowRunSummaryFixture({ id: 'run-release', stepProgress: { completed: 2, total: 6 } }),
                    { kind: 'available', value: { title: 'Prepare the 0.3 release' } },
                )]);
            });
            const screen = await renderScreen(<SessionStepWork runId="run-release" serverId="home-a" machineName="MacBook Pro" />);
            expect(screen.findByTestId('session-work-step-run')?.props.children).toBe('Prepare the 0.3 release');
            expect(screen.findByTestId('session-work-step-facts')?.props.children)
                .toBe(`${t('workflows.list.stepsProgress', { completed: 2, total: 6 })} · MacBook Pro`);
            expect(screen.getTextContent()).toContain(t('sessionWork.step.checkedByWorkflow'));
            expect(screen.findByTestId('session-work-step-nothing')).not.toBeNull();
            expect(refresh).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('session-work-step-open-run');
            expect(push).toHaveBeenCalledWith({ pathname: '/workflows/runs/[runId]', params: { runId: 'run-release' } });
        } finally { act(() => storage.setState(previous)); }
    });

    it('lists the step\'s own work instead of the empty line, and reads an unknown run once in its own Home only', async () => {
        const previous = storage.getState();
        try {
            act(() => storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } }));
            const screen = await renderScreen(<SessionStepWork runId="run-unknown" serverId="home-a" machineName={null}>
                <React.Fragment><></></React.Fragment>
            </SessionStepWork>);
            expect(screen.findByTestId('session-work-step-nothing')).toBeNull();
            expect(screen.findByTestId('session-work-step-run')?.props.children).toBe(t('workflows.run.untitled'));
            expect(refresh).toHaveBeenCalledTimes(1);
            await screen.unmount();
            await renderScreen(<SessionStepWork runId="run-unknown" serverId="home-b" machineName={null} />);
            expect(refresh).toHaveBeenCalledTimes(1);
        } finally { act(() => storage.setState(previous)); }
    });
});
