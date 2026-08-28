import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

const syncSpies = vi.hoisted(() => ({
    fetchAutomationRuns: vi.fn(async () => {}),
    getAutomationRunDetailInspection: vi.fn<(automationId: string, runId: string) => Promise<unknown>>(),
    cancelAutomationRun: vi.fn(async () => null),
    retryAutomationReplyHandoff: vi.fn(async () => null),
}));
const routeParamsState = vi.hoisted(() => ({ id: 'a1', runId: 'run-1' }));
const routerPushSpy = vi.hoisted(() => vi.fn());
const runDetailMachinesState = vi.hoisted(() => ({ list: [] as Array<{ id: string; metadata?: { displayName?: string } }> }));
const runsState = vi.hoisted(() => ({
    list: [] as any[],
}));
const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'server-1',
}));
const accountScopeState = vi.hoisted(() => ({
    profileScope: { serverId: 'server-1', accountId: 'account-a' } as null | { serverId: string; accountId: string },
}));

function inspectRunDetail(detail: Record<string, unknown>, privateContent: Record<string, unknown> = {
    recipe: { kind: 'absent' },
    result: { kind: 'absent' },
}) {
    return {
        detail: {
            // The direct detail response always carries these; the schema owner
            // makes them required, so a fixture must not silently omit them.
            executionNativeRunId: null,
            executionNativeCallId: null,
            executionNativeSidechainId: null,
            events: [],
            ...detail,
        },
        privateContent: {
            failureDetail: { kind: 'absent' },
            ...privateContent,
        },
    };
}

installAutomationScreensCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            params: () => ({ id: routeParamsState.id, runId: routeParamsState.runId }),
            router: { push: routerPushSpy },
        });
        return {
            ...expoRouterMock.module,
            Stack: {
                Screen: (props: any) => React.createElement('StackScreen', props),
            },
        };
    },
    text: {
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'runs.runLabel') return `run ${String(params?.runId ?? '')}`;
            if (key === 'automations.detail.runMeta.scheduled') return `Scheduled: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.occurred') return `Occurred: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.invoked') return `Invoked: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.admitted') return `Admitted: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.causeTitle') return 'Cause';
            if (key === 'automations.detail.runMeta.cause.pluginEvent') return 'Event';
            if (key === 'automations.detail.runMeta.cause.schedule') return 'Scheduled';
            if (key === 'automations.detail.runMeta.cause.manual') return 'Manual';
            if (key === 'automations.detail.runMeta.cause.conversation') return 'Conversation';
            if (key === 'automations.detail.runMeta.cause.sessionLifecycle') return 'Session turn completed';
            if (key === 'automations.list.event') return `Event: ${String(params?.eventId ?? '')}`;
            if (key === 'automations.detail.runMeta.triggerIdentityTitle') return 'Trigger identity';
            if (key === 'automations.detail.runMeta.triggerIdentity') return `${String(params?.id ?? '')} · revision ${String(params?.revision ?? '')}`;
            if (key === 'automations.detail.runMeta.triggerRetired') return 'Trigger retired';
            if (key === 'automations.detail.runMeta.triggerRetiredSubtitle') return 'The immutable cause remains available.';
            if (key === 'automations.detail.trigger.sourceSession') return 'Source session';
            if (key === 'automations.detail.trigger.sourceTurn') return 'Exact source turn';
            if (key === 'automations.detail.runMeta.occurrenceTitle') return 'Occurrence';
            if (key === 'automations.detail.runMeta.sourceTitle') return 'Observation source';
            if (key === 'automations.detail.runMeta.eventReferenceTitle') return 'Event reference';
            if (key === 'automations.detail.runMeta.updated') return `Updated: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.error') return `Error: ${String(params?.message ?? '')}`;
            if (key === 'automations.detail.runMeta.attemptTitle') return 'Attempt';
            if (key === 'automations.detail.runMeta.attempt') return `Attempt ${String(params?.attempt ?? '')}`;
            if (key === 'automations.detail.runMeta.claimedByTitle') return 'Claimed by';
            if (key === 'automations.detail.runMeta.claimedAt') return `Claimed: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.leaseExpires') return `Claim lease expires: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.dispatchTitle') return 'Execution dispatch';
            if (key === 'automations.detail.runMeta.dispatchAttempt') return `Dispatch attempt ${String(params?.attempt ?? '')}`;
            if (key === 'automations.detail.runMeta.dispatchState.retryWaiting') return 'Waiting to retry';
            if (key === 'automations.detail.runMeta.dispatchState.outcomeUnknown') return 'Outcome unknown';
            if (key === 'automations.detail.runMeta.dispatchState.settled') return 'Settled';
            if (key === 'automations.detail.runMeta.replyHandoffTitle') return 'Reply handoff';
            if (key === 'automations.detail.runMeta.replyHandoffAttempt') return `Handoff attempt ${String(params?.attempt ?? '')}`;
            if (key === 'automations.detail.runMeta.replyHandoffDue') return `Next handoff attempt: ${String(params?.time ?? '')}`;
            if (key === 'automations.detail.runMeta.replyHandoffState.awaitingResult') return 'Awaiting result';
            if (key === 'automations.detail.runMeta.state.queued') return 'Queued';
            if (key === 'automations.detail.runMeta.state.claimed') return 'Claimed';
            if (key === 'automations.detail.runMeta.state.running') return 'Running';
            if (key === 'automations.detail.runMeta.state.succeeded') return 'Succeeded';
            if (key === 'automations.detail.runMeta.state.failed') return 'Failed';
            if (key === 'automations.detail.runMeta.state.cancelled') return 'Cancelled';
            if (key === 'automations.detail.runMeta.state.expired') return 'Expired';
            if (key === 'automations.detail.runMeta.state.dispatch_failed') return 'Dispatch failed';
            if (key === 'automations.detail.runMeta.state.skipped') return 'Skipped';
            if (key === 'automations.detail.runMeta.state.missed') return 'Missed';
            if (key === 'automations.detail.runMeta.state.outcome_uncertain') return 'Outcome uncertain';
            if (key === 'automations.detail.runDetail.title') return 'Admitted details';
            if (key === 'automations.detail.runDetail.recipe') return 'Admitted recipe';
            if (key === 'automations.detail.runDetail.templateVersion') return 'Template version';
            if (key === 'automations.detail.runDetail.event') return 'Event';
            if (key === 'automations.detail.runDetail.sourceInstance') return 'Source instance';
            if (key === 'automations.detail.runDetail.filter') return 'Filter';
            if (key === 'automations.detail.runDetail.filterMatched') return 'Matched';
            if (key === 'automations.detail.runDetail.payload') return 'Payload';
            if (key === 'automations.detail.runDetail.target') return 'Frozen target';
            if (key === 'automations.detail.runDetail.existingSession') return `Existing session: ${String(params?.sessionId ?? '')}`;
            if (key === 'automations.detail.runDetail.prompt') return 'Frozen prompt';
            if (key === 'automations.detail.runDetail.result') return 'Final result';
            if (key === 'automations.detail.runDetail.resultAbsent') return 'No final result was recorded.';
            if (key === 'automations.detail.runDetail.failureDetail') return 'Failure detail';
            if (key === 'automations.detail.runDetail.failureDetailAbsent') return 'No private failure detail was recorded.';
            if (key === 'automations.detail.runDetail.currentnessUnavailable') return 'Private Run detail is temporarily unavailable while account encryption changes.';
            if (key === 'automations.detail.runDetail.materialUnavailable') return 'This device does not have the current Account encryption key.';
            if (key === 'automations.detail.runDetail.modeMismatch') return 'Retained private detail uses a different Account encryption mode.';
            if (key === 'automations.detail.runDetail.contentInvalid') return 'Retained private detail is invalid.';
            if (key === 'automations.detail.runDetail.invalidTemplate') return 'The admitted template was invalid. This Run will not dispatch or retry.';
            if (key === 'executionRuns.details.timestamps.started') return 'Started';
            if (key === 'executionRuns.details.timestamps.finished') return 'Finished';
            if (key === 'runs.openSession') return 'Open session';
            if (key === 'automations.detail.runDetail.outcomeUnknown') return 'Dispatch outcome is unknown. Happier will not dispatch the frozen target again.';
            if (key === 'automations.detail.runMeta.nativeExecutionTitle') return 'Native execution';
            if (key === 'automations.detail.runMeta.nativeExecutionCall') return `Call ${String(params?.callId ?? '')}`;
            if (key === 'automations.detail.runMeta.nativeExecutionSidechain') return `Sidechain ${String(params?.sidechainId ?? '')}`;
            if (key === 'automations.detail.runMeta.historyTitle') return 'What happened';
            if (key === 'automations.detail.runMeta.historyEvent.run_started') return 'Started running';
            if (key === 'automations.detail.runMeta.historyEvent.run_outcome_uncertain') return 'Outcome became uncertain';
            if (key === 'automations.detail.runMeta.historyEvent.unknown') return 'Lifecycle change';
            if (key === 'automations.detail.runMeta.historyReason.cancelled_after_dispatch_permitted') {
                return 'Cancelled after the external execution had already been permitted';
            }
            return key;
        },
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAutomationRuns: () => runsState.list,
            useAllMachines: () => runDetailMachinesState.list,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#777',
                    text: '#111',
                },
            },
        });
    },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/state/storageStateReaderBridge', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storageStateReaderBridge')>(),
    readRegisteredStorageState: () => accountScopeState,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Item',
        props,
        React.createElement('Text', null, props.title),
        props.subtitle ? React.createElement('Text', null, props.subtitle) : null,
    ),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

describe('AutomationRunDetailScreen', () => {
    beforeEach(() => {
        retireActiveServerAccountScopeLifetime();
        activeServerSnapshot.serverId = 'server-1';
        accountScopeState.profileScope = { serverId: 'server-1', accountId: 'account-a' };
        routeParamsState.id = 'a1';
        routeParamsState.runId = 'run-1';
        runsState.list = [{
            id: 'run-1',
            automationId: 'a1',
            revision: 1,
            triggerId: 'trigger-1',
            triggerRetired: false,
            state: 'failed',
            cause: {
                kind: 'trigger',
                triggerId: 'trigger-1',
                triggerRevision: 3,
                triggerKind: 'pluginEvent',
                occurrenceKey: 'occurrence-1',
                occurredAt: 10,
                evidence: {
                    eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
                    sourceSelectorId: 'selector-1',
                },
            },
            dueAt: 10,
            claimedAt: null,
            startedAt: null,
            finishedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 1,
            errorCode: 'executor_unavailable',
            producedSessionId: null,
            executionDispatchState: 'settled',
            executionAttempt: 1,
            replyHandoffState: 'none',
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            createdAt: 10,
            updatedAt: 11,
        }];
        syncSpies.fetchAutomationRuns.mockReset();
        syncSpies.fetchAutomationRuns.mockResolvedValue(undefined);
        syncSpies.getAutomationRunDetailInspection.mockReset();
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        syncSpies.cancelAutomationRun.mockReset();
        syncSpies.cancelAutomationRun.mockResolvedValue({
            ...runsState.list[0],
            state: 'cancelled',
            finishedAt: 12,
            updatedAt: 12,
        });
        syncSpies.retryAutomationReplyHandoff.mockReset();
        syncSpies.retryAutomationReplyHandoff.mockResolvedValue({
            ...runsState.list[0],
            replyHandoffState: 'ready',
            replyHandoffDueAt: 12,
            updatedAt: 12,
        });
    });

    it('surfaces the Run lifecycle times and keeps the produced Session reachable', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'succeeded',
            startedAt: 20,
            finishedAt: 30,
            errorCode: null,
            producedSessionId: 'session-produced-1',
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        const text = screen.getTextContent();
        expect(text).toContain('Started');
        expect(text).toContain('Finished');
        expect(text).toContain('session-produced-1');

        const producedSession = screen.findAllByProps({ testID: 'automation-run-detail-produced-session' })[0];
        expect(producedSession).toBeTruthy();
        producedSession?.props.onPress?.();
        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-produced-1');
    });

    it('uses the built-in run cache before attempting a root-page refresh', async () => {
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        expect(screen.getTextContent()).toContain('Failed');
        expect(screen.getTextContent()).toContain('Error: executor_unavailable');
        expect(screen.getTextContent()).toContain('Occurred:');
        expect(screen.getTextContent()).toContain('Admitted:');
        expect(screen.getTextContent()).toContain('Occurrence');
        expect(screen.getTextContent()).toContain('occurrence-1');
        expect(screen.getTextContent()).toContain('Observation source');
        expect(screen.getTextContent()).toContain('selector-1');
        expect(screen.getTextContent()).toContain('happier.scm.github/pull-request-opened-v1');
        const cause = screen.findAllByType('Item' as any).find((item: any) => item.props.title === 'Cause');
        expect(cause?.props.detail).toBe('Event: pull-request-opened-v1');
        expect(screen.getTextContent()).toContain('trigger-1 · revision 3');
        expect(syncSpies.fetchAutomationRuns).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });
    });

    it('renders retired exact-turn history entirely from the immutable cause projection', async () => {
        runsState.list = [{
            ...runsState.list[0],
            triggerId: 'turn-trigger-retired',
            triggerRetired: true,
            cause: {
                kind: 'trigger',
                triggerId: 'turn-trigger-retired',
                triggerRevision: 7,
                triggerKind: 'sessionLifecycle',
                occurrenceKey: 'turn:session-source:turn-exact',
                occurredAt: 10,
                evidence: {
                    event: 'parentTurnCompleted',
                    sourceSessionId: 'session-source',
                    sourceTurnId: 'turn-exact',
                },
            },
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        expect(screen.getTextContent()).toContain('Session turn completed');
        expect(screen.getTextContent()).toContain('turn-trigger-retired · revision 7');
        expect(screen.getTextContent()).toContain('Trigger retired');
        expect(screen.getTextContent()).toContain('session-source');
        expect(screen.getTextContent()).toContain('turn-exact');
    });

    it('keeps the bounded Run cache visible when its private detail read fails', async () => {
        syncSpies.getAutomationRunDetailInspection.mockRejectedValueOnce(new Error('detail unavailable'));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        expect(screen.getTextContent()).toContain('Failed');
        expect(screen.findAllByProps({ testID: 'automation-run-detail-load-error' })).toHaveLength(0);
    });

    it('marks a cached Run stale and offers retry when its refresh fails', async () => {
        syncSpies.getAutomationRunDetailInspection.mockRejectedValueOnce(new Error('detail unavailable'));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(screen.findByTestId('automation-run-detail-stale-refresh-error')).toBeTruthy();
        });

        // The cached projection stays on screen, but it must not be presented
        // as current: a silent failure leaves the reader believing a finished
        // Run is still running.
        expect(screen.getTextContent()).toContain('Failed');
        const staleNotice = screen.findByProps({ testID: 'automation-run-detail-stale-refresh-error' });
        expect(staleNotice.props.accessibilityRole).toBe('alert');
        expect(staleNotice.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findAllByProps({ testID: 'automation-run-detail-load-error' })).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('automation-run-detail-stale-refresh-retry');
            await Promise.resolve();
        });
        expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledTimes(2);
    });

    it('uses fresher direct status while rendering the typed route-local unavailable state', async () => {
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            updatedAt: 12,
            errorCode: 'direct-status-error',
            triggerEvidenceEnvelope: 'sealed-trigger-evidence',
            executionInputEnvelope: 'sealed-execution-recipe',
            resultEnvelope: 'sealed-result',
            legacySummaryCiphertext: null,
        }, {
            recipe: { kind: 'unavailable', reason: 'currentnessUnavailable' },
            result: { kind: 'unavailable', reason: 'currentnessUnavailable' },
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Error: direct-status-error');
        });
        expect(screen.getTextContent()).toContain('Private Run detail is temporarily unavailable while account encryption changes.');

        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).not.toContain('sealed-trigger-evidence');
        expect(rendered).not.toContain('sealed-execution-recipe');
        expect(rendered).not.toContain('sealed-result');
    });

    it('renders only the canonically opened admitted content and never sealed Run envelopes', async () => {
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue({
            detail: {
                ...runsState.list[0],
                updatedAt: 12,
                triggerEvidenceEnvelope: 'sealed-trigger-evidence',
                executionInputEnvelope: 'sealed-execution-recipe',
                resultEnvelope: 'sealed-result',
                legacySummaryCiphertext: null,
                executionNativeRunId: null,
                executionNativeCallId: null,
                executionNativeSidechainId: null,
                events: [],
            },
            privateContent: {
                recipe: {
                    kind: 'available',
                    templateVersion: 4,
                    evidence: {
                        v: 1,
                        kind: 'pluginEvent',
                        eventRef: { pluginId: 'com.example.github', localId: 'issue-opened' },
                        sourceSelectorId: 'selector-1',
                        occurrenceId: 'occurrence-1',
                        occurredAt: 10,
                        payload: { issue: { number: 42 } },
                        sourceInstanceId: 'repository-acme-example',
                        sourceContractVersion: 1,
                        observationReceivedAt: 11,
                        filter: { version: 1, result: 'matched' },
                    },
                    target: {
                        kind: 'existingSession',
                        sessionId: 'session-1',
                        prompt: 'Review the admitted issue.',
                    },
                },
                result: {
                    kind: 'available',
                    correspondence: {
                        accountId: 'account-1',
                        automationId: 'a1',
                        runId: 'run-1',
                    },
                    result: { v: 1, kind: 'text', text: 'The admitted issue was reviewed.' },
                },
                failureDetail: {
                    kind: 'available',
                    correspondence: { automationId: 'a1', runId: 'run-1' },
                    detail: 'The worker could not open /private/project.',
                },
            },
        });
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        expect(screen.findAllByType('ItemGroup' as any).find((group: any) => (
            group.props.title === 'Admitted details'
        ))).toBeTruthy();
        expect(screen.getTextContent()).toContain('Template version');
        expect(screen.getTextContent()).toContain('Review the admitted issue.');
        expect(screen.getTextContent()).toContain('The admitted issue was reviewed.');
        expect(screen.getTextContent()).toContain('Failure detail');
        expect(screen.getTextContent()).toContain('The worker could not open /private/project.');
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).not.toContain('sealed-trigger-evidence');
        expect(rendered).not.toContain('sealed-execution-recipe');
        expect(rendered).not.toContain('sealed-result');
    });

    it('retires Account A direct detail when the same route switches to Account B and B reads fail', async () => {
        const accountAInspection = inspectRunDetail({
            ...runsState.list[0],
            state: 'running',
            updatedAt: 12,
            errorCode: 'account-a-direct-status',
            triggerEvidenceEnvelope: 'sealed-trigger-evidence',
            executionInputEnvelope: 'sealed-execution-recipe',
            resultEnvelope: 'sealed-result',
            legacySummaryCiphertext: null,
        }, {
            recipe: {
                kind: 'available',
                templateVersion: 4,
                evidence: {
                    v: 1,
                    kind: 'pluginEvent',
                    eventRef: { pluginId: 'com.example.github', localId: 'issue-opened' },
                    sourceSelectorId: 'account-a-selector',
                    occurrenceId: 'account-a-occurrence',
                    occurredAt: 10,
                    payload: { issue: { title: 'Account A private evidence' } },
                    sourceInstanceId: 'account-a-private-source',
                    sourceContractVersion: 1,
                    observationReceivedAt: 11,
                    filter: { version: 1, result: 'matched' },
                },
                target: {
                    kind: 'existingSession',
                    sessionId: 'account-a-private-target',
                    prompt: 'Account A private recipe',
                },
            },
            result: {
                kind: 'available',
                correspondence: {
                    accountId: 'account-a',
                    automationId: 'a1',
                    runId: 'run-1',
                },
                result: { v: 1, kind: 'text', text: 'Account A private result' },
            },
        });
        syncSpies.getAutomationRunDetailInspection
            .mockResolvedValueOnce(accountAInspection)
            .mockRejectedValueOnce(new Error('account-b detail unavailable'));
        syncSpies.fetchAutomationRuns.mockRejectedValueOnce(new Error('account-b list unavailable'));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Account A private result');
        });
        expect(screen.getTextContent()).toContain('Error: account-a-direct-status');

        accountScopeState.profileScope = { serverId: 'server-1', accountId: 'account-b' };
        runsState.list = [];
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            await Promise.resolve();
        });
        await screen.update(React.createElement(AutomationRunDetailScreen));

        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledTimes(2);
            expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(1);
        });
        expect(screen.findByTestId('automation-run-detail-load-error')).toBeTruthy();
        const rendered = screen.getTextContent();
        expect(rendered).not.toContain('Running');
        expect(rendered).not.toContain('account-a-direct-status');
        expect(rendered).not.toContain('Account A private evidence');
        expect(rendered).not.toContain('account-a-private-source');
        expect(rendered).not.toContain('account-a-private-target');
        expect(rendered).not.toContain('Account A private recipe');
        expect(rendered).not.toContain('Account A private result');
    });

    it('keeps invalid templates, uncertain dispatch, and retained-content failures distinct', async () => {
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            updatedAt: 12,
            errorCode: 'invalid_template',
            executionDispatchState: 'outcomeUnknown',
            triggerEvidenceEnvelope: 'sealed-trigger-evidence',
            executionInputEnvelope: 'sealed-execution-recipe',
            resultEnvelope: 'sealed-result',
            legacySummaryCiphertext: null,
        }, {
            recipe: { kind: 'invalid', reason: 'contentInvalid' },
            result: { kind: 'invalid', reason: 'modeMismatch' },
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('The admitted template was invalid. This Run will not dispatch or retry.');
        });
        expect(screen.getTextContent()).toContain('Dispatch outcome is unknown. Happier will not dispatch the frozen target again.');
        expect(screen.getTextContent()).toContain('Retained private detail is invalid.');
        expect(screen.getTextContent()).toContain('Retained private detail uses a different Account encryption mode.');
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).not.toContain('sealed-trigger-evidence');
        expect(rendered).not.toContain('sealed-execution-recipe');
        expect(rendered).not.toContain('sealed-result');
    });

    it('names every Run state in product language instead of painting the raw state token', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'outcome_uncertain',
            errorCode: 'execution_run_cancelled_outcome_unknown',
            executionDispatchState: 'outcomeUnknown',
            finishedAt: 12,
            updatedAt: 12,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        const rendered = screen.getTextContent();
        expect(rendered).toContain('Outcome uncertain');
        expect(rendered).not.toContain('OUTCOME_UNCERTAIN');
        expect(rendered).not.toContain('outcome_uncertain');
        // The ratified uncertain-outcome sentence stays the only explanation of this state.
        expect(rendered).toContain('Dispatch outcome is unknown. Happier will not dispatch the frozen target again.');
    });

    it('surfaces the assignment, attempt, dispatch and reply-handoff facts the Run already carries', async () => {
        runDetailMachinesState.list = [{ id: 'machine-1', metadata: { displayName: 'Build box' } }];
        runsState.list = [{
            ...runsState.list[0],
            state: 'running',
            errorCode: null,
            attempt: 2,
            claimedAt: 20,
            claimedByMachineId: 'machine-1',
            leaseExpiresAt: 30,
            startedAt: 21,
            executionDispatchState: 'retryWaiting',
            executionAttempt: 3,
            replyHandoffState: 'awaitingResult',
            replyHandoffAttempt: 1,
            replyHandoffDueAt: 40,
            updatedAt: 22,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        const rendered = screen.getTextContent();
        expect(rendered).toContain('Attempt');
        expect(rendered).toContain('Claimed by');
        expect(rendered).toContain('Claim lease expires:');
        expect(rendered).toContain('Execution dispatch');
        expect(rendered).toContain('Dispatch attempt 3');
        expect(rendered).toContain('Reply handoff');
        expect(rendered).toContain('Handoff attempt 1');
        expect(rendered).toContain('Next handoff attempt:');
        // Values ride the row `detail`, which the text projection does not read.
        const tree = JSON.stringify(screen.tree.toJSON());
        expect(tree).toContain('Attempt 2');
        expect(tree).toContain('Build box');
        expect(tree).toContain('Waiting to retry');
        expect(tree).toContain('Awaiting result');
        // Raw enum tokens are never painted at the user.
        expect(tree).not.toContain('retryWaiting');
        expect(tree).not.toContain('awaitingResult');
    });

    it('names the native execution and its ordered transition history for an uncertain Run', async () => {
        runDetailMachinesState.list = [];
        runsState.list = [{
            ...runsState.list[0],
            state: 'outcome_uncertain',
            executionDispatchState: 'outcomeUnknown',
            errorCode: null,
            updatedAt: 22,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
            executionNativeRunId: 'native-run-9',
            executionNativeCallId: 'native-call-9',
            executionNativeSidechainId: 'native-sidechain-9',
            events: [
                { at: 10, type: 'run_started', machineId: 'machine-1', errorCode: null, executionAttempt: null, outcome: null, reason: null },
                {
                    at: 20,
                    type: 'run_outcome_uncertain',
                    machineId: null,
                    errorCode: null,
                    executionAttempt: null,
                    outcome: null,
                    reason: 'cancelled_after_dispatch_permitted',
                },
            ],
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        const rendered = screen.getTextContent();
        // Without the native identity an uncertain Run gives the user nothing
        // to inspect or stop.
        expect(rendered).toContain('Native execution');
        expect(rendered).toContain('native-run-9');
        expect(rendered).toContain('Call native-call-9');
        expect(rendered).toContain('Sidechain native-sidechain-9');
        expect(screen.findAllByType('ItemGroup' as any).find((group: any) => (
            group.props.title === 'What happened'
        ))).toBeTruthy();
        expect(rendered).toContain('Started running');
        expect(rendered).toContain('Cancelled after the external execution had already been permitted');
        // Raw persisted transition tokens are never painted at the user.
        const tree = JSON.stringify(screen.tree.toJSON());
        expect(tree).not.toContain('run_started');
        expect(tree).not.toContain('cancelled_after_dispatch_permitted');
    });

    it('omits the assignment and handoff rows a Run has no fact for', async () => {
        runDetailMachinesState.list = [];
        runsState.list = [{
            ...runsState.list[0],
            attempt: 1,
            claimedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            replyHandoffState: 'none',
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });

        const rendered = screen.getTextContent();
        expect(rendered).not.toContain('Claimed by');
        expect(rendered).not.toContain('Claim lease expires:');
        expect(rendered).not.toContain('Reply handoff');
        expect(rendered).not.toContain('Next handoff attempt:');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Attempt 1');
    });

    it('does not let an older direct response regress the bounded Run projection', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'cancelled',
            errorCode: null,
            finishedAt: 20,
            updatedAt: 20,
        }];
        const staleDetail = {
            ...runsState.list[0],
            state: 'running',
            errorCode: 'stale-direct-status',
            updatedAt: 11,
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        };
        const staleInspection = inspectRunDetail(staleDetail, {
            recipe: {
                kind: 'available',
                templateVersion: 4,
                evidence: null,
                target: {
                    kind: 'existingSession',
                    sessionId: 'stale-session',
                    prompt: 'stale private prompt',
                },
            },
            result: { kind: 'absent' },
        });
        let resolveDirect: (value: typeof staleInspection) => void = () => {
            throw new Error('Direct Run detail test promise did not initialize');
        };
        const pendingDirect = new Promise<typeof staleInspection>((resolve) => {
            resolveDirect = resolve;
        });
        syncSpies.getAutomationRunDetailInspection.mockReturnValue(pendingDirect);
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledWith('a1', 'run-1');
        });
        await act(async () => {
            resolveDirect(staleInspection);
            await pendingDirect;
        });

        expect(screen.getTextContent()).toContain('Cancelled');
        expect(screen.getTextContent()).not.toContain('stale-direct-status');
        expect(screen.getTextContent()).not.toContain('stale private prompt');
        expect(screen.findAllByType('Item' as any).find((item: any) => item.props.title === 'common.cancel')).toBeUndefined();
    });

    it('offers cancellation only through the incumbent Run owner for a cancellable state', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'queued',
            errorCode: null,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        const cancel = screen.findAllByType('Item' as any).find((item: any) => item.props.title === 'common.cancel');
        expect(cancel).toBeTruthy();
        if (!cancel) {
            throw new Error('Expected a cancellable Run action');
        }

        await act(async () => {
            await cancel.props.onPress();
        });

        expect(syncSpies.cancelAutomationRun).toHaveBeenCalledWith('run-1');
    });

    it('offers blocked reply handoff recovery through the incumbent Run owner', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'succeeded',
            replyHandoffState: 'blocked',
            replyHandoffAttempt: 2,
        }];
        syncSpies.getAutomationRunDetailInspection.mockResolvedValue(inspectRunDetail({
            ...runsState.list[0],
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        }));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        const retry = screen.findByProps({ testID: 'automation-run-retry-reply-handoff' });

        await act(async () => {
            await retry.props.onPress();
        });

        expect(syncSpies.retryAutomationReplyHandoff).toHaveBeenCalledWith('run-1');
    });

    it('does not let a pre-cancel direct read reclaim the route after cancellation commits', async () => {
        runsState.list = [{
            ...runsState.list[0],
            state: 'queued',
            errorCode: null,
            updatedAt: 11,
        }];
        const cancelledRun = {
            ...runsState.list[0],
            state: 'cancelled' as const,
            finishedAt: 12,
            updatedAt: 12,
        };
        const staleDirect = {
            ...runsState.list[0],
            state: 'running' as const,
            errorCode: 'stale-direct-after-cancel',
            updatedAt: 12,
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        };
        const staleInspection = inspectRunDetail(staleDirect);
        const cancelledInspection = inspectRunDetail({
            ...cancelledRun,
            triggerEvidenceEnvelope: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            legacySummaryCiphertext: null,
        });
        let resolveInitialDirect: ((value: typeof staleInspection) => void) | null = null;
        const initialDirect = new Promise<typeof staleInspection>((resolve) => {
            resolveInitialDirect = resolve;
        });
        syncSpies.getAutomationRunDetailInspection
            .mockImplementationOnce(() => initialDirect)
            .mockResolvedValueOnce(cancelledInspection);
        syncSpies.cancelAutomationRun.mockImplementationOnce(async () => {
            runsState.list = [cancelledRun];
            return cancelledRun;
        });
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledTimes(1);
        });

        const cancel = screen.findAllByType('Item' as any).find((item: any) => item.props.title === 'common.cancel');
        expect(cancel).toBeTruthy();
        if (!cancel) {
            throw new Error('Expected a cancellable Run action');
        }
        await act(async () => {
            await cancel.props.onPress();
        });
        await vi.waitFor(() => {
            expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledTimes(2);
        });

        await act(async () => {
            resolveInitialDirect?.(staleInspection);
            await initialDirect;
        });

        expect(screen.getTextContent()).toContain('Cancelled');
        expect(screen.getTextContent()).not.toContain('stale-direct-after-cancel');
        expect(screen.findAllByType('Item' as any).find((item: any) => item.props.title === 'common.cancel')).toBeUndefined();
    });

    it('keeps an uncached reused run detail loading while its own request is pending', async () => {
        let resolveFetch: (() => void) | null = null;
        const pendingFetch = new Promise<void>((resolve) => {
            resolveFetch = resolve;
        });
        syncSpies.fetchAutomationRuns.mockImplementationOnce(() => pendingFetch);
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));

        routeParamsState.id = 'a2';
        routeParamsState.runId = 'run-2';
        runsState.list = [];
        await screen.update(React.createElement(AutomationRunDetailScreen));

        expect(screen.findAllByType('ActivitySpinner' as any)).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('runs.runDetails.failedToLoad');

        await act(async () => {
            resolveFetch?.();
            await pendingFetch;
        });
    });

    it('offers an announced retry when a cold direct Run read and root-page refresh both fail', async () => {
        runsState.list = [];
        syncSpies.getAutomationRunDetailInspection.mockRejectedValueOnce(new Error('detail unavailable'));
        syncSpies.fetchAutomationRuns.mockRejectedValueOnce(new Error('list unavailable'));
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationRunDetailScreen));
        await vi.waitFor(() => {
            expect(screen.findByTestId('automation-run-detail-load-error')).toBeTruthy();
        });

        const errorState = screen.findByTestId('automation-run-detail-load-error');
        expect(errorState?.props.role).toBe('alert');
        expect(errorState?.props['aria-live']).toBe('assertive');

        await act(async () => {
            screen.pressByTestId('automation-run-detail-load-error-action');
            await Promise.resolve();
        });
        expect(syncSpies.getAutomationRunDetailInspection).toHaveBeenCalledTimes(2);
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(2);
    });
});
