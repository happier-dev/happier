import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useSessionManagedWorkflowRuns, type SessionManagedWorkflowRunsState } from '@/components/sessions/workState/useSessionManagedWorkflowRuns';
import { projectWork, resolveWorkReadPresentation } from '@/components/sessions/work/workProjection';

import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Inbox model groups by work root over the real classifier and the real workflow window.
 * Boundaries: the Run-list Action (network) and the Action front door (host executor).
 */
const listRuns = vi.hoisted(() => vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>());
const executed = vi.hoisted(() => [] as Array<{ actionId: string; input: unknown }>);
const automationBoundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(), serverFetch: automationBoundary.request,
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown) => {
        if (actionId === 'workflow.run.list') return { ok: true, result: await listRuns(input as { filter?: Record<string, unknown> }) };
        executed.push({ actionId, input });
        return { ok: true, result: {} };
    },
}));
vi.mock('@/hooks/server/useFriendsEnabled', () => ({ useFriendsEnabled: () => false }));
vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({ useFriendsIdentityReadiness: () => ({ isReady: false }) }));

function page(runs: ReturnType<typeof createWorkflowRunSummaryFixture>[]): WorkflowRunListPage {
    return { runs, metadataByRunId: {}, nextCursor: undefined };
}

let model: InboxModel | null = null;
function Probe(): null {
    model = useInboxModel();
    return null;
}

async function renderModel() {
    const screen = await renderScreen(<InboxModelProvider><Probe /></InboxModelProvider>);
    await act(async () => {});
    return screen;
}

describe('useInboxModel work groups (ORC R-10)', () => {
    beforeEach(async () => {
        const runtime = await import('@/sync/domains/server/serverRuntime');
        appliedSnapshot = runtime.getActiveServerSnapshot;
        await runtime.upsertAndActivateServer({ serverUrl: 'http://inbox-home.test', name: 'Inbox Home' });
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        model = null;
        executed.length = 0;
        listRuns.mockReset();
        automationBoundary.request.mockReset();
        automationBoundary.request.mockImplementation(async () => new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const base = createRootLayoutFeaturesResponse();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            ...base, features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true } },
        }) } });
        storage.setState({
            settings: { ...storage.getState().settings, experiments: true, featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            profileScope: { serverId: runtime.getActiveServerSnapshot().serverId, accountId: 'account-a' },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
            sessionOrganizationAttentionStandingsBySessionKey: {},
        } as never);
    });

    afterEach(async () => {
        standardCleanup();
        deleteServerFeaturesSnapshot();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    });

    it('retries an initially unreadable Work window through the same Action and distinguishes proven empty work', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([]));
        let workRead: SessionManagedWorkflowRunsState | null = null;
        const projection = projectWork({
            sessionId: 'session-1', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [], managedRuns: [],
            ownTriggerRunIds: new Set(), describeAgentStatus: (entry) => entry.status,
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        function WorkProbe() {
            workRead = useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: appliedSnapshot().serverId });
            return null;
        }
        function currentRead(): SessionManagedWorkflowRunsState | null { return workRead; }
        await renderScreen(<WorkProbe />);
        await act(async () => {});
        const read = () => resolveWorkReadPresentation({ projection, managedRuns: workRead, transcriptLoaded: true });
        expect(read()).toEqual({ nothingYet: false, managedLoading: false, managedUnavailable: true });
        await act(async () => { currentRead()?.retry(); });
        expect(read()).toEqual({ nothingYet: true, managedLoading: false, managedUnavailable: false });
    });

    it('exposes a pre-session Automation failure with its exact Run route and removes it on the Account wake', async () => {
        listRuns.mockResolvedValue(page([]));
        automationBoundary.request.mockResolvedValueOnce(new Response(JSON.stringify({
            runs: [createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' })], nextCursor: null,
        }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        await renderModel();
        expect(model?.automationAttentionItems).toEqual([expect.objectContaining({
            key: 'automation-run:pre-session', run: expect.objectContaining({ producedSessionId: null }),
            route: { pathname: '/automations/[id]/runs/[runId]', params: { id: 'automation-1', runId: 'pre-session' } },
        })]);
        expect(model?.hasPrimaryAttention).toBe(true);
        await act(async () => { publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']); });
        expect(model?.automationAttentionItems).toEqual([]);
        expect(model?.showCaughtUp).toBe(true);
        expect(automationBoundary.request).toHaveBeenCalledTimes(2);
    });

    it('lists an off-page hold once as its own work root, and lets it recede when it leaves the window', async () => {
        listRuns
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockResolvedValueOnce(page([]));

        await renderModel();

        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
        expect(model?.workGroups[0]?.items.map((item) => item.key)).toEqual(['run:run-held']);
        expect(model?.hasPrimaryAttention).toBe(true);

        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(model?.workGroups).toEqual([]);
    });

    it('settles through the one attention Action and the read-state Action, in that order', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.settle({ id: 'session-1', serverId: 'home-a' } as Session);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', standing: false } },
            { actionId: 'session.read_state.set', input: { sessionId: 'session-1', state: 'read' } },
        ]);
    });

    it('does not claim caught up after an initial workflow failure, and retries into grouped attention', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('failed');
        expect(model?.isLoading).toBe(false);
        expect(model?.showCaughtUp).toBe(false);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.phase).toBe('loaded');
        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
    });

    it('waits for the first workflow read rather than showing caught up', async () => {
        listRuns.mockImplementation(() => new Promise(() => {}));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('loading');
        expect(model?.isLoading).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
    });

    it('keeps known groups during a failed workflow refresh and recovers on retry', async () => {
        listRuns.mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
        await renderModel();
        const knownGroups = model?.workGroups;

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.workGroups).toBe(knownGroups);
        expect(model?.showCaughtUp).toBe(false);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(false);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('does not treat a failed refresh of a previously empty workflow list as caught up', async () => {
        listRuns.mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error('offline'));
        await renderModel();
        expect(model?.showCaughtUp).toBe(true);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
    });

    it('snoozes with remindAt and clears it with null through the same Action', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.setReminder({ id: 'session-1', serverId: 'home-a' } as Session, 9_000);
            await model?.setReminder({ id: 'session-1', serverId: 'home-a' } as Session, null);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: 9_000 } },
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: null } },
        ]);
    });
});
