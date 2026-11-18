import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { workflowRunRowFromSummary, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const push = vi.hoisted(() => vi.fn());
// Only network, device credentials/socket and Metro module loading are substituted.
// Exact-run refresh, Action admission, parsing and Account publication remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/step', router: { push } }).module;
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SessionStepWork, readSessionWorkflowStepRunId } = await import('./SessionStepWork');
const { storage } = await import('@/sync/domains/state/storageStore');
const runStoragePath = '/v3/automations/runs/workflow-storage';
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await standardCleanup(); push.mockReset(); await homes.reset(); });

describe('SessionStepWork (lab session-F)', () => {
    it('reads the step run only from a run_step origin', () => {
        expect(readSessionWorkflowStepRunId({ origin: { kind: 'run_step', runId: 'run-7' } })).toBe('run-7');
        expect(readSessionWorkflowStepRunId({ origin: { kind: 'user' } as never })).toBeNull();
        expect(readSessionWorkflowStepRunId({ origin: undefined })).toBeNull();
    });

    it('names the run it is part of with its progress and machine, opens it, and says why nothing is set here', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        try {
            const home = await homes.addHome({ name: 'Home A', serverUrl: 'https://a.test', accountId: 'account-a' });
            act(() => {
                publishAppliedActiveServerSnapshot({ serverId: home, serverUrl: 'https://a.test', generation: 1 });
                storage.setState({ profileScope: { serverId: home, accountId: 'account-a' } });
                storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                    createWorkflowRunSummaryFixture({ id: 'run-release', stepProgress: { completed: 2, total: 6 } }),
                    { kind: 'available', value: { title: 'Prepare the 0.3 release' } },
                )]);
            });
            const screen = await renderScreen(<SessionStepWork runId="run-release" serverId={home} machineName="MacBook Pro" />);
            expect(screen.findByTestId('session-work-step-run')?.props.children).toBe('Prepare the 0.3 release');
            expect(screen.findByTestId('session-work-step-facts')?.props.children)
                .toBe(`${t('workflows.list.stepsProgress', { completed: 2, total: 6 })} ·\u00A0MacBook Pro`);
            expect(screen.getTextContent()).toContain(t('sessionWork.step.checkedByWorkflow'));
            expect(screen.findByTestId('session-work-step-nothing')).not.toBeNull();
            expect(homes.requestsFor(runStoragePath)).toEqual([]);
            await screen.pressByTestIdAsync('session-work-step-open-run');
            expect(push).toHaveBeenCalledWith(`/workflows/runs/run-release?serverId=${home}`);
            await screen.unmount();
        } finally { act(() => { storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); }); }
    });

    it('lists the step\'s own work instead of the empty line, and reads an unknown run once in its own Home only', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        try {
            const home = await homes.addHome({ name: 'Home A', serverUrl: 'https://a.test', accountId: 'account-a' });
            homes.answer(home, runStoragePath, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
            const runId = '00000000-0000-4000-8000-000000000013';
            act(() => {
                publishAppliedActiveServerSnapshot({ serverId: home, serverUrl: 'https://a.test', generation: 1 });
                storage.setState({ profileScope: { serverId: home, accountId: 'account-a' } });
            });
            const screen = await renderScreen(<SessionStepWork runId={runId} serverId={home} machineName={null}>
                <React.Fragment><></></React.Fragment>
            </SessionStepWork>);
            expect(screen.findByTestId('session-work-step-nothing')).toBeNull();
            expect(screen.findByTestId('session-work-step-run')?.props.children).toBe(t('workflows.run.untitled'));
            await vi.waitFor(() => expect(homes.requestsFor(runStoragePath)).toHaveLength(1));
            await screen.unmount();
            const other = await renderScreen(<SessionStepWork runId={runId} serverId="home-b" machineName={null} />);
            expect(homes.requestsFor(runStoragePath)).toHaveLength(1);
            await other.pressByTestIdAsync('session-work-step-open-run');
            expect(push).toHaveBeenCalledWith(`/workflows/runs/${runId}?serverId=home-b`);
            await other.unmount();
        } finally { act(() => { storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); }); }
    });

    it('renews a pending exact run read after same-Account retirement', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const runId = '00000000-0000-4000-8000-000000000014';
        try {
            const home = await homes.addHome({ name: 'Home A', serverUrl: 'https://a.test', accountId: 'account-a' });
            homes.answer(home, runStoragePath, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} }, respondAfter: pending });
            homes.answer(home, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            act(() => {
                publishAppliedActiveServerSnapshot({ serverId: home, serverUrl: 'https://a.test', generation: 1 });
                storage.setState({ profileScope: { serverId: home, accountId: 'account-a' }, workflowRunsById: {} });
            });
            const screen = await renderScreen(<SessionStepWork runId={runId} serverId={home} machineName={null} />);
            await vi.waitFor(() => expect(homes.requestsFor(runStoragePath)).toHaveLength(1));
            homes.answer(home, runStoragePath, { body: { runs: [createWorkflowRunSummaryFixture({ id: runId,
                ownerAccountId: 'account-a', state: 'paused' })], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
            await act(async () => retireActiveServerAccountScopeLifetime());
            await vi.waitFor(() => expect(homes.requestsFor(runStoragePath)).toHaveLength(2));
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(storage.getState().workflowRunsById[workflowRunStoreKey(runId)]?.summary?.state).toBe('paused');
            });
            expect(screen.findByTestId('session-work-step-run')?.props.children).toBe(t('workflows.contentUnavailable'));
            await act(async () => { release?.(); });
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(runId)]?.summary?.state).toBe('paused');
            await screen.unmount();
        } finally { release?.(); act(() => { storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); }); }
    });
});
