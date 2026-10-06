import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findAllHostTestInstances, renderScreen } from '@/dev/testkit/render/renderScreen';
import { createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AutomationTriggerIdSchema, AutomationV3RunDetailSchema, createCanonicalJsonSigningInput, deriveAutomationOccurrenceKeyV1, sealAutomationRunResultStoredEnvelopeV1, sealAutomationRunFailureDetailStoredEnvelopeV1, serializeAutomationRunExecutionRecipeV1, type AutomationV3RunDetail, type AutomationV3RunListItem } from '@happier-dev/protocol';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

const routeParamsState = vi.hoisted(() => ({ id: 'a1', runId: 'run-1' }));
const routerPushSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const DETAIL_PATH = '/v3/automations/a1/runs/run-1';
const LIST_PATH = '/v3/automations/a1/runs?limit=20';

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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: modalConfirmSpy,
                prompt: vi.fn(),
            },
        }).module;
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
            if (key === 'automations.pluralEditor.lifecycleEvent.parentTurnCompleted') return 'Turn completed successfully';
            if (key === 'automations.pluralEditor.lifecyclePolicy.currentTurn') return 'Current turn only';
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
            if (key === 'automations.detail.runMeta.historyReason.cancelled_while_running') {
                return 'Cancelled while the assigned machine could still have been executing';
            }
            if (key === 'automations.detail.cancelRunConfirmTitle') return 'Cancel Run?';
            if (key === 'automations.detail.cancelRunConfirmMessage') return 'This stops the Run when possible.';
            if (key === 'automations.detail.cancelRunConfirmButton') return 'Cancel Run';
            return key;
        },
    },
    storage: async (importOriginal) => await importOriginal(),
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
        props.rightElement ?? null,
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


function run(overrides: Partial<AutomationV3RunListItem> = {}) {
    return createAutomationRunFixture({ automationId: 'a1', state: 'failed', attempt: 1,
        errorCode: 'executor_unavailable', executionDispatchState: 'settled', executionAttempt: 1,
        createdAt: 10, updatedAt: 11, ...overrides });
}

function detail(row: AutomationV3RunListItem, overrides: Partial<AutomationV3RunDetail> = {}) {
    return AutomationV3RunDetailSchema.parse({ ...row, triggerEvidenceEnvelope: null,
        executionInputEnvelope: null, resultEnvelope: null, errorDetailEnvelope: null,
        legacySummaryCiphertext: null, executionNativeRunId: null, executionNativeCallId: null,
        executionNativeSidechainId: null, events: [], ...overrides });
}

/** Producer-owned codecs create stored bytes; the screen opens them through real Sync. */
function privateDetail(row = run(), prefix = 'The admitted issue') {
    const evidence = { v: 1 as const, kind: 'pluginEvent' as const,
        eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
        sourceSelectorId: '11111111-1111-4111-8111-111111111111', occurrenceId: 'occurrence-1',
        occurredAt: 10, payload: { issue: { number: 42 } }, sourceInstanceId: 'repository-acme-example',
        sourceContractVersion: 1, observationReceivedAt: 11, filter: { version: 1 as const, result: 'matched' as const } };
    const triggerId = AutomationTriggerIdSchema.parse('trigger-1');
    const cause = { kind: 'trigger' as const, triggerId, triggerRevision: 3,
        triggerKind: 'pluginEvent' as const, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }),
        occurredAt: 10, evidence: { eventRef: evidence.eventRef, sourceSelectorId: evidence.sourceSelectorId } };
    const recipe = serializeAutomationRunExecutionRecipeV1({ v: 1, templateVersion: 4,
        template: { t: 'plain', v: { v: 1, prompt: prefix + ' private recipe' } },
        triggerEvidence: { t: 'plain', v: evidence },
        target: { kind: 'existingSession', sessionId: 'session-private-target' }, assignmentMachineIds: [] });
    if (recipe.kind !== 'available') throw new Error('Invalid producer recipe fixture');
    return detail({ ...row, triggerId, cause }, {
        executionInputEnvelope: recipe.serialized,
        triggerEvidenceEnvelope: createCanonicalJsonSigningInput({ t: 'plain', v: evidence }),
        resultEnvelope: JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({ mode: 'plain',
            correspondence: { accountId: 'account-a', automationId: row.automationId, runId: row.id },
            result: { v: 1, kind: 'text', text: prefix + ' private result' } })),
        errorDetailEnvelope: JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({ mode: 'plain',
            correspondence: { automationId: row.automationId, runId: row.id }, detail: prefix + ' private failure' })),
    });
}

async function cache(rows: AutomationV3RunListItem[]) {
    const { storage } = await import('@/sync/domains/state/storage');
    await act(async () => { await storage.getState().setAutomationRuns('a1', rows, null); });
}
async function open(row: AutomationV3RunListItem | null = run()) {
    await cache(row ? [row] : []);
    const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
    return renderScreen(<AutomationRunDetailScreen />);
}
async function respond(row: AutomationV3RunListItem, overrides: Partial<AutomationV3RunDetail> = {}) {
    harness.answer(serverId, DETAIL_PATH, { body: detail(row, overrides) });
    const screen = await open(row);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Admitted details'));
    return screen;
}

async function connectAccount(accountId: string) {
    connection = await restoreServerAccountForTest({ serverUrl: 'https://run-detail.test', accountId });
    const { storage } = await import('@/sync/domains/state/storage');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    storage.setState({ profileScope: { serverId, accountId }, profile: { ...profileDefaults, id: accountId } });
}

describe('AutomationRunDetailScreen', () => {
    beforeEach(async () => {
        await harness.reset();
        await loadSyncSingletonForTests();
        serverId = await harness.addHome({ name: 'Run detail', serverUrl: 'https://run-detail.test', accountId: 'account-a' });
        await connectAccount('account-a');
        routeParamsState.id = 'a1';
        routeParamsState.runId = 'run-1';
        routerPushSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(false);
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol');
        const features = createRootLayoutFeaturesResponse();
        tryWriteServerEnabledBitInPlace(features, 'automations', true);
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, DETAIL_PATH, { body: detail(run()) });
        harness.answer(serverId, LIST_PATH, { body: { runs: [], nextCursor: null } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machines: {}, machineListByServerId: {}, workflowRunsById: {}, automationRunIdsByAutomationId: {} });
    });
    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        await harness.reset();
    });

    it('surfaces lifecycle times and keeps the produced Session reachable', async () => {
        const screen = await respond(run({ state: 'succeeded', startedAt: 20, finishedAt: 30, errorCode: null, producedSessionId: 'session-produced-1' }));
        expect(screen.getTextContent()).toContain('Started');
        expect(screen.getTextContent()).toContain('Finished');
        screen.pressByTestId('automation-run-detail-produced-session');
        expect(routerPushSpy).toHaveBeenCalledWith(expect.stringContaining('/session/session-produced-1'));
    });

    it('uses the built-in exact Run cache without refreshing the root page', async () => {
        const row = privateDetail().cause;
        const screen = await respond(run({ triggerId: AutomationTriggerIdSchema.parse('trigger-1'), cause: row }));
        expect(screen.getTextContent()).toContain('Failed');
        expect(screen.getTextContent()).toContain('Error: executor_unavailable');
        expect(screen.getTextContent()).toContain('trigger-1 · revision 3');
        expect(screen.getTextContent()).toContain('Observation source');
        expect(screen.getTextContent()).toContain('happier.scm.github/pull-request-opened-v1');
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(0);
        expect(harness.requestsFor(DETAIL_PATH)).toHaveLength(1);
    });

    it('renders retired exact-turn history from the immutable cause', async () => {
        const triggerId = AutomationTriggerIdSchema.parse('turn-trigger-retired');
        const screen = await respond(run({ triggerId, triggerRetired: true, cause: {
            kind: 'trigger', triggerId, triggerRevision: 7, triggerKind: 'sessionLifecycle',
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: {
                v: 1, kind: 'sessionLifecycle', event: 'parentTurnCompleted', occurredAt: 10,
                sourceSessionId: 'session-source', sourceTurnId: 'turn-exact',
            } }), occurredAt: 10,
            evidence: { event: 'parentTurnCompleted', sourceSessionId: 'session-source', sourceTurnId: 'turn-exact', policy: { kind: 'currentTurn' } },
        } }));
        expect(screen.getTextContent()).toContain('Trigger retired');
        expect(screen.findByProps({ title: 'Cause', detail: 'Turn completed successfully · Current turn only' })).toBeTruthy();
        expect(screen.findByProps({ title: 'Source session' }).props.copy).toBe('session-source');
        expect(screen.findByProps({ title: 'Exact source turn' }).props.copy).toBe('turn-exact');
    });

    it('retains cached status, announces failed refresh, and retries the direct read', async () => {
        harness.answer(serverId, DETAIL_PATH, { status: 503, body: { error: 'unavailable' } });
        const screen = await open();
        await waitForHomeGovernance(() => expect(screen.findByTestId('automation-run-detail-stale-refresh-error')).toBeTruthy());
        expect(screen.getTextContent()).toContain('Failed');
        const notice = findAllHostTestInstances(screen.root, node => node.type === 'Item'
            && node.props.testID === 'automation-run-detail-stale-refresh-error')[0];
        expect(notice?.props.accessibilityRole).toBe('alert');
        expect(notice?.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findAllByProps({ testID: 'automation-run-detail-load-error' })).toHaveLength(0);
        harness.answer(serverId, DETAIL_PATH, { body: detail(run({ state: 'succeeded', updatedAt: 12 })) });
        await screen.pressByTestIdAsync('automation-run-detail-stale-refresh-retry');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Succeeded'));
        expect(harness.requestsFor(DETAIL_PATH)).toHaveLength(2);
    });

    it('keeps fresher direct status when Account currentness is unavailable and never paints retained bytes', async () => {
        const sealed = privateDetail(run({ updatedAt: 12, errorCode: 'direct-status-error' }));
        harness.answer(serverId, DETAIL_PATH, { body: sealed });
        harness.answer(serverId, '/v1/account/encryption/currentness', { status: 503, body: { error: 'unavailable' } });
        const screen = await open();
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Error: direct-status-error'));
        expect(screen.getTextContent()).toContain('Private Run detail is temporarily unavailable while account encryption changes.');
        expect(screen.getTextContent()).not.toContain('The admitted issue private');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(sealed.executionInputEnvelope);
    });

    it('opens admitted recipe, evidence, result and failure through canonical codecs and keeps them route-local', async () => {
        const sealed = privateDetail(run({ updatedAt: 12 }));
        harness.answer(serverId, DETAIL_PATH, { body: sealed });
        const screen = await open();
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('The admitted issue private result'));
        for (const [title, value] of [
            ['Source instance', 'repository-acme-example'], ['Payload', '{"issue":{"number":42}}'],
            ['Frozen prompt', 'The admitted issue private recipe'], ['Final result', 'The admitted issue private result'],
            ['Failure detail', 'The admitted issue private failure'],
        ]) {
            const row = screen.findByProps({ title });
            expect(row.props.copy).toBe(value);
            expect(row.props.subtitleLines).toBe(0);
            expect(row.props.mode).not.toBe('info');
        }
        const { storage } = await import('@/sync/domains/state/storage');
        expect(JSON.stringify(storage.getState().workflowRunsById)).not.toContain('The admitted issue private');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(sealed.executionInputEnvelope);
    });

    it('retires Account A private detail when the same route switches to Account B and B reads fail', async () => {
        harness.answer(serverId, DETAIL_PATH, { body: privateDetail(run({ state: 'running', updatedAt: 12, errorCode: 'account-a-direct-status' }), 'Account A') });
        const screen = await open();
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Account A private result'));
        harness.answer(serverId, DETAIL_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        await act(async () => {
            await harness.switchAccount(serverId, 'account-b');
            await connection?.dispose();
            await connectAccount('account-b');
        });
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        await screen.update(<AutomationRunDetailScreen />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('automation-run-detail-load-error')).toBeTruthy());
        expect(screen.getTextContent()).not.toContain('Account A');
        expect(screen.getTextContent()).not.toContain('account-a-direct-status');
        expect(screen.getTextContent()).not.toContain('Running');
    });

    it('distinguishes invalid templates, uncertain dispatch and retained mode mismatch', async () => {
        const screen = await respond(run({ updatedAt: 12, errorCode: 'invalid_template', executionDispatchState: 'outcomeUnknown' }), {
            executionInputEnvelope: 'invalid-recipe', resultEnvelope: JSON.stringify({ t: 'encrypted', c: 'sealed-private-result' }),
        });
        expect(screen.getTextContent()).toContain('The admitted template was invalid. This Run will not dispatch or retry.');
        expect(screen.getTextContent()).toContain('Dispatch outcome is unknown. Happier will not dispatch the frozen target again.');
        expect(screen.getTextContent()).toContain('Retained private detail is invalid.');
        expect(screen.getTextContent()).toContain('Retained private detail uses a different Account encryption mode.');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('sealed-private-result');
    });

    it('names uncertain state, native identity, and ordered transition history in product language', async () => {
        const screen = await respond(run({ state: 'outcome_uncertain', executionDispatchState: 'outcomeUnknown', errorCode: null }), {
            executionNativeRunId: 'native-run-9', executionNativeCallId: 'native-call-9', executionNativeSidechainId: 'native-sidechain-9',
            events: [ { at: 10, type: 'run_started', machineId: 'machine-1', errorCode: null, executionAttempt: null, outcome: null, reason: null },
                { at: 20, type: 'run_outcome_uncertain', machineId: null, errorCode: null, executionAttempt: null, outcome: null, reason: 'cancelled_after_dispatch_permitted' } ],
        });
        const text = screen.getTextContent();
        for (const value of ['Outcome uncertain', 'native-run-9', 'Call native-call-9', 'Sidechain native-sidechain-9', 'Started running', 'Cancelled after the external execution had already been permitted']) expect(text).toContain(value);
        expect(text.indexOf('Started running')).toBeLessThan(text.indexOf('Cancelled after'));
        expect(text).not.toContain('outcome_uncertain');
        expect(text).not.toContain('run_started');
        expect(text).not.toContain('cancelled_after_dispatch_permitted');
    });

    it('explains cancellation while the assigned machine could still be executing', async () => {
        const screen = await respond(run({ state: 'outcome_uncertain' }), { events: [{ at: 20, type: 'run_outcome_uncertain', machineId: null, errorCode: null, executionAttempt: null, outcome: null, reason: 'cancelled_while_running' }] });
        expect(screen.getTextContent()).toContain('Cancelled while the assigned machine could still have been executing');
        expect(screen.getTextContent()).not.toContain('cancelled_while_running');
    });

    it('surfaces assignment, attempt, dispatch and reply handoff facts without raw tokens', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', metadata: { displayName: 'Build box', host: 'build', platform: 'linux', happyCliVersion: '0.3', happyHomeDir: '/home/test', homeDir: '/home/test' } })]);
        const screen = await respond(run({ state: 'running', errorCode: null, attempt: 2, claimedAt: 20, claimedByMachineId: 'machine-1', leaseExpiresAt: 30, startedAt: 21, executionDispatchState: 'retryWaiting', executionAttempt: 3, replyHandoffState: 'awaitingResult', replyHandoffAttempt: 1, replyHandoffDueAt: 40 }));
        const tree = JSON.stringify(screen.tree.toJSON());
        for (const value of ['Attempt 2', 'Build box', 'Waiting to retry', 'Dispatch attempt 3', 'Awaiting result', 'Handoff attempt 1', 'Next handoff attempt:']) expect(tree).toContain(value);
        expect(tree).not.toContain('retryWaiting');
        expect(tree).not.toContain('awaitingResult');
    });

    it('omits assignment and handoff rows without facts', async () => {
        const screen = await respond(run());
        for (const value of ['Claimed by', 'Claim lease expires:', 'Reply handoff', 'Next handoff attempt:']) expect(screen.getTextContent()).not.toContain(value);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Attempt 1');
    });

    it('does not let an older direct response regress cached status or reveal its private recipe', async () => {
        const pending = createDeferred<void>();
        const stale = privateDetail(run({ state: 'running', updatedAt: 11, errorCode: 'stale-direct-status' }), 'Stale');
        harness.answer(serverId, DETAIL_PATH, { body: stale, respondAfter: pending.promise });
        const screen = await open(run({ state: 'cancelled', updatedAt: 20, finishedAt: 20, errorCode: null }));
        await waitForHomeGovernance(() => expect(harness.requestsFor(DETAIL_PATH)).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/account/encryption/currentness')).toHaveLength(1));
        expect(screen.getTextContent()).toContain('Cancelled');
        expect(screen.getTextContent()).not.toContain('stale-direct-status');
        expect(screen.getTextContent()).not.toContain('Stale private');
        expect(screen.findAllByProps({ title: 'common.cancel' })).toHaveLength(0);
    });

    it('cancels through the Run owner only after confirmation and fences the pre-cancel direct response', async () => {
        const pending = createDeferred<void>();
        harness.answer(serverId, DETAIL_PATH, { body: detail(run({ state: 'running', updatedAt: 12, errorCode: 'stale-direct-after-cancel' })), respondAfter: pending.promise });
        const cancelPath = '/v3/automations/runs/run-1/cancel';
        harness.answer(serverId, 'POST ' + cancelPath, { body: { run: run({ state: 'cancelled', revision: 2, finishedAt: 12, updatedAt: 12, errorCode: null }) } });
        const screen = await open(run({ state: 'queued', errorCode: null }));
        await waitForHomeGovernance(() => expect(harness.requestsFor(DETAIL_PATH)).toHaveLength(1));
        const cancel = screen.findByProps({ title: 'common.cancel' });
        await act(async () => cancel.props.onPress());
        expect(harness.requestsFor(cancelPath)).toHaveLength(0);
        expect(modalConfirmSpy).toHaveBeenCalledWith('Cancel Run?', 'This stops the Run when possible.', { cancelText: 'common.keepEditing', confirmText: 'Cancel Run', destructive: true });
        modalConfirmSpy.mockResolvedValueOnce(true);
        await act(async () => cancel.props.onPress());
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Cancelled'));
        await act(async () => pending.resolve());
        expect(screen.getTextContent()).not.toContain('stale-direct-after-cancel');
        expect(screen.findAllByProps({ title: 'common.cancel' })).toHaveLength(0);
        expect(harness.requestsFor(cancelPath)).toHaveLength(1);
    });

    it('recovers blocked reply handoff through the Run owner', async () => {
        const retryPath = '/v3/automations/runs/run-1/retry-reply-handoff';
        const row = run({ state: 'succeeded', replyHandoffState: 'blocked', replyHandoffAttempt: 2 });
        harness.answer(serverId, 'POST ' + retryPath, { body: { run: { ...row, revision: 2, replyHandoffState: 'ready', updatedAt: 12 } } });
        const screen = await respond(row);
        await screen.pressByTestIdAsync('automation-run-retry-reply-handoff');
        expect(harness.requestsFor(retryPath)).toHaveLength(1);
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().workflowRunsById['run-1'].automation?.replyHandoffState).toBe('ready');
    });

    it('does not offer recovery that the server cannot dispatch', async () => {
        const screen = await respond(run({ state: 'succeeded', replyHandoffState: 'blocked' }), { replyHandoffRecoverable: false });
        expect(screen.findAllByProps({ testID: 'automation-run-retry-reply-handoff' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'automation-run-reply-handoff-unrecoverable' })).toBeTruthy();
        expect(harness.requestsFor('/v3/automations/runs/run-1/retry-reply-handoff')).toHaveLength(0);
    });

    it('delivers accepted custody again only after confirmation and sends the exact displayed revision', async () => {
        const row = run({ state: 'succeeded', replyHandoffState: 'accepted', revision: 7 });
        const path = '/v3/automations/runs/run-1/deliver-result-again';
        harness.answer(serverId, 'POST ' + path, { body: { run: { ...row, revision: 8, updatedAt: 12, replyHandoffState: 'ready' } } });
        const screen = await respond(row);
        expect(screen.findAllByProps({ testID: 'automation-run-retry-reply-handoff' })).toHaveLength(0);
        await screen.pressByTestIdAsync('automation-run-deliver-result-again');
        expect(harness.requestsFor(path)).toHaveLength(0);
        modalConfirmSpy.mockResolvedValueOnce(true);
        await screen.pressByTestIdAsync('automation-run-deliver-result-again');
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(harness.requestsFor(path)[0].input).toEqual({ expectedRevision: 7 });
    });

    it('keeps a reused uncached route loading until its own request settles', async () => {
        const screen = await respond(run());
        const pending = createDeferred<void>();
        const nextPath = '/v3/automations/a2/runs/run-2';
        harness.answer(serverId, nextPath, { body: detail(run({ id: 'run-2', automationId: 'a2' })), respondAfter: pending.promise });
        harness.answer(serverId, '/v3/automations/a2/runs?limit=20', { body: { runs: [], nextCursor: null }, respondAfter: pending.promise });
        routeParamsState.id = 'a2';
        routeParamsState.runId = 'run-2';
        const { AutomationRunDetailScreen } = await import('./AutomationRunDetailScreen');
        await screen.update(<AutomationRunDetailScreen />);
        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('runs.runDetails.failedToLoad');
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('run run-2'));
    });

    it('announces retry when a cold direct read and root-page refresh fail, then recovers', async () => {
        harness.answer(serverId, DETAIL_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        const screen = await open(null);
        await waitForHomeGovernance(() => expect(screen.findByTestId('automation-run-detail-load-error')).toBeTruthy());
        const error = screen.findByTestId('automation-run-detail-load-error');
        if (!error) throw new Error('Expected the cold-read load error notice');
        expect(error.props.role).toBe('alert');
        expect(error.props['aria-live']).toBe('assertive');
        harness.answer(serverId, DETAIL_PATH, { body: detail(run({ state: 'succeeded', errorCode: null })) });
        harness.answer(serverId, LIST_PATH, { body: { runs: [], nextCursor: null } });
        await screen.pressByTestIdAsync('automation-run-detail-load-error-action');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Succeeded'));
        expect(harness.requestsFor(DETAIL_PATH)).toHaveLength(2);
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(2);
    });
});
