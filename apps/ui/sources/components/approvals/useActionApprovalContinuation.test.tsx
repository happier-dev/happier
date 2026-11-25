// @vitest-environment jsdom

import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAgentApprovalRequest, createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createActionApprovalContinuation, type ActionApprovalContinuation } from './actionApprovalContinuation';
import type { SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

// Keep real Sync/Account custody; only the external Socket transport stays disconnected.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

/**
 * The shared result-custody owner, over the real approval lifecycle.
 *
 * Every approval here is one the product writes: an agent's explicit Team rename proposal
 * creates it through the shared Action front door, the Inbox decides it through
 * the generic executor, and the hook observes the outcome through the real
 * `useApprovalArtifact` reading the Home's stateful Artifact store. Only the
 * network and the device credential store are replaced; no terminal record is
 * assembled by the test.
 */

const harness = createHomeGovernanceHarness();
// Native rendering remains outside the deterministic Action/Artifact owners.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
installHomeGovernanceBoundaries(harness);
const { useActionApprovalContinuation } = await import('./useActionApprovalContinuation');
const { SplitCanvasHost } = await import('@/components/appShell/splitCanvas/components/SplitCanvasHost');
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { createUsageCoachController } = await import('@/components/settings/usage/widgets/usageCoachController');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { normalizeUsageQuery } = await import('@happier-dev/protocol/inputs/usageQuery');
const { resolveUsagePageAggregation } = await import('@happier-dev/protocol/usage/resolveUsagePageAggregation');
const { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
const { UsageSubscriptionPriceEditor } = await import('@/components/settings/usage/widgets/plans/UsagePlanActions');
const { projectUsagePlans } = await import('@/components/settings/usage/widgets/plans/usagePlansModel');
const { ConnectedServiceQuotaGetResultV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
const { buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol/connect/account-usage-primitives');
const { ConnectedPresentationRowMutationV1Schema, readConnectedSubscriptionMonthlyPriceV1 } = await import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1');
const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
const { storage } = await import('@/sync/domains/state/storage');
const { HomeLayoutEditor } = await import('@/components/hub/layout/HomeLayoutEditor');
const { useHomeHubLayout } = await import('@/components/hub/layout/useHomeHubLayout');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

const ACCOUNT_ID = 'account-a';
const TEAM_UPDATE_PATH = '/v1/teams/update';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

/** One Home whose Account explicitly requires approval for a Team rename. */
async function addApprovalHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://approval-continuation.example',
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    const home = harness.findByServerUrl('https://approval-continuation.example');
    if (!home?.token) throw new Error('Expected the saved Home credential');
    // Account restoration performs these real bootstrap reads. A missing list
    // is a Home-health error, not a healthy baseline for the later offline step.
    for (const path of ['/v2/sessions/active', '/v2/sessions', '/v2/session-organization']) {
        harness.answer(serverId, `GET ${path}`, { select: async () => {
            const response = createEmptyAccountBootstrapHttpResponse(path);
            if (!response) throw new Error(`Missing approval bootstrap fixture: ${path}`);
            return { status: response.status, body: await response.json() };
        } });
    }
    harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [] });
    connection = await restoreServerAccountForTest({
        serverUrl: home.serverUrl,
        accountId: ACCOUNT_ID,
        credentials: { token: home.token },
        request: harness.request,
    });
    installHomeGovernanceBoundaries(harness);
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(storage.getState().settingsScope).toEqual({ serverId, accountId: ACCOUNT_ID }));
    return serverId;
}

async function openRenameApproval(serverId: string, requestId: string, name = 'Renamed'): Promise<string> {
    return await createAgentApprovalRequest({
        serverId,
        actionId: 'teams.update',
        actionInput: { v: 1, teamId: 'team-1', name },
        actionRequestId: requestId,
    });
}

function answerRename(serverId: string): void {
    harness.answer(serverId, TEAM_UPDATE_PATH, {
        body: teamSummaryFixture({ name: 'Renamed', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
    });
}

async function renderContinuation(serverId: string, onExecuted: () => void = vi.fn(), wrapper?: React.ComponentType<React.PropsWithChildren>) {
    return await renderHook(({ scopeKey }: { scopeKey: string }) => useActionApprovalContinuation({
        scopeKey,
        serverId,
        onExecuted,
    }), { initialProps: { scopeKey: `${serverId}:${ACCOUNT_ID}` }, wrapper });
}

async function nativeDecisionButton(screen: Awaited<ReturnType<typeof renderScreen>>, decision: 'approve' | 'reject') {
    const testId = `actions.confirmation-review.decision-${decision}`;
    return await waitForHomeGovernance(() => {
        if (screen.findByTestId(testId)) return testId;
        const alertId = decision === 'approve' ? 'web-modal-confirm' : 'web-modal-cancel';
        expect(screen.findByTestId(alertId)).not.toBeNull();
        return alertId;
    });
}

/** The shared testkit mounts the real review card without the renderer's external DOM portal and exit frames. */
async function mountActionReviewHost() {
    const { Modal } = await import('@/modal');
    const { module } = createModalModuleMock({ renderCustomModals: true });
    let answerAlert: ((value: boolean) => void) | undefined;
    const show = vi.spyOn(Modal, 'show').mockImplementation(module.Modal.show);
    const hide = vi.spyOn(Modal, 'hide').mockImplementation(module.Modal.hide);
    const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => new Promise<boolean>(resolve => {
        answerAlert = resolve;
    }));
    return {
        Provider: module.ModalProvider,
        async decision(screen: Awaited<ReturnType<typeof renderScreen>>, approve: boolean) {
            const answer = await waitForHomeGovernance(() => {
                const testId = `actions.confirmation-review.decision-${approve ? 'approve' : 'reject'}`;
                if (screen.findByTestId(testId)) return () => act(() => screen.pressByTestId(testId));
                expect(answerAlert).toBeDefined();
                const answer = answerAlert!;
                return () => { answerAlert = undefined; answer(approve); };
            });
            return answer;
        },
        dispose() {
            answerAlert?.(false);
            show.mockRestore();
            hide.mockRestore();
            confirm.mockRestore();
        },
    };
}

describe('useActionApprovalContinuation', () => {
    beforeEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = null;
        await harness.reset();
        installDisconnectedServerSocketBoundary();
    });

    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = null;
    });

    it('answers a collection approval through the exact existing review owner and never reads a closed peek', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'collection-approval');
        const { CollectionRequestPeekBody } = await import('@/components/ui/lists/collection/CollectionRequestPeekBody');
        const { ApprovalDecisionBar } = await import('./ApprovalDecisionBar');
        const path = `/v1/artifacts/${artifactId}`;
        const priorReads = harness.requestsFor(path).length;
        const body = (open: boolean) => <CollectionRequestPeekBody request={{ kind: 'approval', serverId, artifactId }}
            open={open} onDismiss={() => {}} renderState={() => null} />;
        const screen = await renderScreen(body(false));
        expect(harness.requestsFor(path)).toHaveLength(priorReads);
        expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(0);
        await screen.update(body(true));
        await waitForHomeGovernance(() => expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(1));
        expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"open"');
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(0);
        await screen.pressByTestIdAsync('approvals.approve');
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executed"'));
        expect(harness.requestsFor(TEAM_UPDATE_PATH).map(request => request.input)).toEqual([
            { v: 1, teamId: 'team-1', name: 'Renamed' },
        ]);
        await screen.update(body(false));
        expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(0);
    });

    it('releases a mounted observers native abort subscription without aborting an externally owned signal or its durable approval', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'external-interest');
        const controller = new AbortController();
        const added = vi.spyOn(controller.signal, 'addEventListener');
        const removed = vi.spyOn(controller.signal, 'removeEventListener');
        const hook = await renderContinuation(serverId);
        await act(async () => hook.getCurrent().requestApproval(createActionApprovalContinuation({ artifactId,
            actionId: 'teams.update', scope: { serverId, accountId: ACCOUNT_ID }, signal: controller.signal,
            expectedInput: { v: 1, teamId: 'team-1', name: 'Renamed' }, onSucceeded: vi.fn(), onFailed: vi.fn() })));
        const listener = added.mock.calls.find(call => call[0] === 'abort')?.[1];
        expect(listener).toBeDefined();
        await hook.unmount();
        expect(removed).toHaveBeenCalledWith('abort', listener);
        expect(controller.signal.aborted).toBe(false);
        expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"open"');
        added.mockRestore(); removed.mockRestore();
    });

    it('continues an approved Action after both its requesting view and deciding view unmount', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'unmounted-approval');
        const request = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const requester = await renderContinuation(serverId);
        await act(async () => requester.getCurrent().requestApproval(artifactId));
        const decider = await renderHook(() => useApprovalDecisionHandler({ id: artifactId,
            header: buildApprovalRequestArtifactHeaderV1(request) }, request, '', serverId));
        let releaseApproved!: () => void;
        const approvedReply = new Promise<void>(resolve => { releaseApproved = resolve; });
        let approvedWritten = false;
        const path = `/v1/artifacts/${artifactId}`;
        // Home HTTP is the boundary: commit the real CAS, then delay only its acknowledgement.
        harness.answer(serverId, `POST ${path}`, { select: async input => {
            const wire = input && typeof input === 'object' && 'body' in input ? input.body : null;
            const content = typeof wire === 'string' ? decodePlainArtifactStoredContent(wire) : null;
            const body = content && typeof content === 'object' && 'body' in content ? content.body : null;
            const update = ApprovalRequestV2Schema.safeParse(typeof body === 'string' ? JSON.parse(body) : null);
            const pendingResponse = harness.artifacts(serverId).handle(path, { method: 'POST', body: JSON.stringify(input) });
            if (!pendingResponse) throw new Error('Approval Artifact update route unavailable');
            const response = await pendingResponse;
            const responseBody = await response.json();
            if (update.success && update.data.status === 'approved') {
                approvedWritten = true;
                await approvedReply;
            }
            return { status: response.status, body: responseBody };
        } });
        let deciding: Promise<boolean> | undefined;
        try {
            act(() => { deciding = decider.getCurrent()('approve'); });
            await waitForHomeGovernance(() => expect(approvedWritten).toBe(true));
            expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"approved"');
            await requester.unmount();
            await decider.unmount();
            releaseApproved();
            await expect(deciding).resolves.toBe(true);
            expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executed"');
            expect(harness.requestsFor(TEAM_UPDATE_PATH).map(entry => entry.input)).toContainEqual({ v: 1, teamId: 'team-1', name: 'Renamed' });
        } finally { releaseApproved(); await deciding; }
    });

    it.each(['visibility', 'widget_size'] as const)('keeps the shared Home layout write for %s pending until native review and its layout receipt', async (kind) => {
        const serverId = await addApprovalHome();
        await harness.requireUiApproval(serverId, kind === 'visibility' ? 'home.hub.layout.update' : 'widgets.item.size.set');
        const { useHomeHubArtifactLayout, useHomeHubLayoutWritePending } = await import('@/components/hub/layout/useHomeHubArtifactLayout');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { ModalProvider } = await import('@/dev/testkit/render/workflowRunBrowserModalBoundary');
        const credentials = connection!.credentials;
        const previous = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: ACCOUNT_ID }, endpointStatus: 'online',
            endpointReason: null, socketStatus: 'connected', syncError: null });
        if (kind === 'widget_size') {
            const account = await captureLazyActionAccountContext(serverId);
            try {
                const { createHomeHubArtifactPortV1 } = await import('@happier-dev/protocol/home');
                await createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId: ACCOUNT_ID }).apply({
                    kind: 'widget_add', instance: { v: 1, id: 'checks', definition: { kind: 'builtin', id: 'usage_capacity' }, bindings: {} }, size: 'medium',
                });
            } finally { account.dispose(); }
        }
        let layout: ReturnType<typeof useHomeHubArtifactLayout> | undefined;
        let isWriting = false;
        let contentRenders = 0;
        let content: ReturnType<typeof useHomeHubLayout> | undefined;
        const projection = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current' as const, interactionEnabled: true, machineId: null, serverId, platform: 'web' as const,
            accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' as const },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
        function ContentProbe() { content = useHomeHubLayout(); contentRenders++; return null; }
        function Probe() {
            layout = useHomeHubArtifactLayout();
            isWriting = useHomeHubLayoutWritePending();
            return kind === 'visibility' ? <HomeLayoutEditor /> : null;
        }
        function shell(origin: string) {
            return (
                <InjectedAuthProvider credentials={credentials}>
                    <AppShellPluginUiProjectionValueProvider value={projection}>
                        <ModalProvider><Probe key={origin} /><ContentProbe /></ModalProvider>
                    </AppShellPluginUiProjectionValueProvider>
                </InjectedAuthProvider>
            );
        }
        const screen = await renderScreen(shell('origin'));
        const portal = installReactDomPortalBoundaryForTests();
        let settled = false;
        let operation: Promise<void> | undefined;
        try {
            await waitForHomeGovernance(() => expect(layout?.status).toBe('ready'));
            const beforeContent = content;
            const beforeRenders = contentRenders;
            act(() => {
                operation = layout!.dispatch(kind === 'visibility' ? { kind: 'visibility', sectionId: 'setup', hidden: true }
                    : { kind: 'widget_size', instanceId: 'checks', size: 'wide' }, { rethrow: true });
                void operation.then(() => { settled = true; }, () => { settled = true; });
            });
            const confirm = await nativeDecisionButton(screen, 'approve');
            expect(settled).toBe(false);
            expect(contentRenders).toBe(beforeRenders);
            expect(content).toBe(beforeContent);
            expect(isWriting).toBe(true);
            expect(layout!.failedIntent).toBeUndefined();
            expect(layout!.layout.hidden).not.toContain('setup');
            if (kind === 'visibility') {
                await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
                expect(screen.findByTestId('home-unreachable')).not.toBeNull();
                expect(settled).toBe(false);
                await act(async () => { storage.setState({ endpointStatus: 'online' }); });
                await screen.update(shell('retained'));
                expect(settled).toBe(false);
                expect(isWriting).toBe(true);
            }
            act(() => screen.pressByTestId(confirm));
            await waitForHomeGovernance(() => expect(settled).toBe(true));
            await operation;
            expect(isWriting).toBe(false);
            expect(layout!.status).toBe('ready');
            if (kind === 'visibility') expect(layout!.layout.hidden).toEqual(['setup']);
            else expect(layout!.layout.items).toEqual(expect.arrayContaining([{ kind: 'widget',
                instance: expect.objectContaining({ id: 'checks' }), size: 'wide' }]));
            expect(layout!.failedIntent).toBeUndefined();
        } finally {
            try { await screen.unmount(); } finally {
                portal.restore();
                storage.setState(previous, true);
                publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
            }
        }
    });

    it('keeps an Agent layout approval pending when its terminal Artifact write is lost after the layout commits', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await createAgentApprovalRequest({ serverId, actionId: 'home.hub.layout.update',
            actionInput: { intent: { kind: 'visibility', sectionId: 'setup', hidden: true } },
            actionRequestId: 'layout-terminal-write-lost',
        });
        const refreshed = vi.fn();
        const hook = await renderContinuation(serverId, refreshed);
        act(() => hook.getCurrent().requestApproval(artifactId));
        const path = `/v1/artifacts/${artifactId}`;
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        harness.answer(serverId, `POST ${path}`, { select: async input => {
            const wire = input && typeof input === 'object' && 'body' in input ? input.body : null;
            const content = typeof wire === 'string' ? decodePlainArtifactStoredContent(wire) : null;
            const body = content && typeof content === 'object' && 'body' in content ? content.body : null;
            const request = ApprovalRequestV2Schema.safeParse(typeof body === 'string' ? JSON.parse(body) : null);
            if (request.success && request.data.status === 'executed') return { dispatchThenFail: true };
            const response = await harness.artifacts(serverId).handle(path, { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error('Approval Artifact update route unavailable');
            return { status: response.status, body: await response.json() };
        } });
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: false, errorCode: 'approval_execution_outcome_unknown',
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('executing'));
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        expect(hook.getCurrent().approvalPending).toBe(true);
        expect(refreshed).not.toHaveBeenCalled();
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const { createHomeHubArtifactPortV1 } = await import('@happier-dev/protocol/home');
            expect((await createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId: ACCOUNT_ID }).read()).hidden)
                .toEqual(['setup']);
        } finally { account.dispose(); }
    });

    it('shows an issued approval as executing while its Home is unreachable and consumes the later receipt', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'pending-home');
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        let respond!: () => void;
        const held = new Promise<void>(resolve => { respond = resolve; });
        harness.answer(serverId, TEAM_UPDATE_PATH, { respondAfter: held,
            body: teamSummaryFixture({ name: 'Renamed', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }) });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const { ApprovalDecisionBar } = await import('./ApprovalDecisionBar');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} serverId={serverId} />);
        let decision: Promise<void> | undefined;
        try {
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(1);
                expect(screen.findAllByType(ApprovalDecisionBar)[0]?.props.approve?.disabled).toBe(false);
            });
            // Start the real decision, then keep the held Home reply outside React's act scope.
            const approve = screen.findAllByType(ApprovalDecisionBar)[0].props.approve;
            act(() => { decision = Promise.resolve(approve.onPress()); });
            await waitForHomeGovernance(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            await waitForHomeGovernance(() => {
                expect(screen.getTextContent()).toContain(t('approvals.status.executing'));
                expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(0);
            });
            expect(screen.findByTestId('approvals.home-unavailable')).toBeNull();
            await act(async () => { respond(); await decision; });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executed"'));
            expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        } finally {
            respond();
            await act(async () => { await decision; });
            await screen.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });

    it('restores Plans price retry after rejection and refreshes approved entry and removal', async () => {
        const serverId = await addApprovalHome();
        await harness.requireUiApproval(serverId, 'connectedServices.subscription.price.set');
        const previous = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId, accountId: ACCOUNT_ID }, profile: AccountProfileSchema.parse({ id: ACCOUNT_ID }) });
        const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'personal' };
        harness.answer(serverId, '/v1/account/profile', { select: () => ({ body: AccountProfileSchema.parse({ id: ACCOUNT_ID,
            connectedAccountsV4: [{ ref: account, status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
                configurationRevision: null, revisionSemantics: 'legacy_unfenced', credentialRevision: null }] }) }) });
        harness.answer(serverId, '/v1/account/entity-rows/connected-metadata/acknowledgements', {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } },
        });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
        let revision = 1;
        let record: import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1').ConnectedPresentationRecordV1 = { v: 1, entries: [] };
        const path = '/v1/account/entity-rows/connected-metadata/presentation';
        harness.answer(serverId, path, { select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: record } } }) });
        harness.answer(serverId, `POST ${path}`, { select: raw => {
            const input = ConnectedPresentationRowMutationV1Schema.parse(raw);
            expect(input.expectedRevision).toBe(revision);
            if (input.content?.t !== 'plain') throw new Error('Expected keyless price metadata');
            record = input.content.v;
            revision += 1;
            return { body: { status: 'updated', revision, cursor: revision } };
        } });
        const now = Date.now();
        const recordKey = { providerId: 'openai', accountSubjectId: account.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
        const projectedAccount = () => projectUsagePlans([ConnectedServiceQuotaGetResultV1Schema.parse({
            source: { ref: account, bindingKind: 'account' },
            current: { v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey), providerId: 'openai',
                accountSubject: { kind: 'providerSubject', id: account.accountId }, observedAtMs: now, fetchedAtMs: now,
                staleAfterMs: 3_600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [],
                subscription: { status: 'unavailable', renewal: 'unknown', observedAtMs: now, staleAfterMs: 3_600_000,
                    enteredMonthlyPrice: readConnectedSubscriptionMonthlyPriceV1(record, account) } },
            pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
        })], now).accounts[0]!;
        const refreshed = vi.fn();
        function Editor() {
            const [, refresh] = React.useReducer(value => value + 1, 0);
            return <UsageSubscriptionPriceEditor account={projectedAccount()} serverId={serverId} testID="price"
                onSettled={() => { refreshed(); refresh(); }} />;
        }
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const review = await mountActionReviewHost();
        const screen = await renderMountedCurrentUiContext(<review.Provider><Editor /></review.Provider>);
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const save = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'price.save')!;
        const field = (name: 'amount' | 'currency') => screen.findAllByType(FieldTextInput).find(node => node.props.testID === `price.${name}`)!;
        const edit = async (amount: string, currency: string) => {
            await act(async () => { field('amount').props.onChangeText(amount); field('currency').props.onChangeText(currency); });
        };
        try {
            expect(screen.findByTestId('price.amount')).toBeNull();
            await screen.pressByTestIdAsync('price-header');
            expect(save().props.disabled).toBe(true);
            await edit('-1', 'EUR');
            expect(save().props.disabled).toBe(true);
            await edit('17', 'eur');
            expect(save().props.disabled).toBe(false);
            // The person's own Save is reviewed here (one confirmation, in place, 2026-10-30).
            act(() => screen.pressByTestId('price.save'));
            const reject = await review.decision(screen, false);
            expect(save().props.disabled).toBe(true);
            expect(harness.artifacts(serverId).list()).toEqual([]);
            expect(record.entries).toEqual([]);
            reject();
            await waitForHomeGovernance(() => expect(save().props.disabled).toBe(false));
            expect(screen.findByTestId('price.failed')).not.toBeNull();
            expect(record.entries).toEqual([]);
            expect(refreshed).not.toHaveBeenCalled();

            act(() => screen.pressByTestId('price.save'));
            const approve = await review.decision(screen, true);
            expect(screen.findByTestId('price.failed')).toBeNull();
            approve();
            await waitForHomeGovernance(() => expect(refreshed).toHaveBeenCalledTimes(1));
            expect(save().props.disabled).toBe(false);
            expect(record.entries).toMatchObject([{ subject: { kind: 'account', account }, subscriptionMonthlyPrice: { amount: 17, currency: 'EUR' } }]);

            act(() => screen.pressByTestId('price.clear'));
            const approveRemoval = await review.decision(screen, true);
            approveRemoval();
            await waitForHomeGovernance(() => expect(refreshed).toHaveBeenCalledTimes(2));
            expect(record.entries).toEqual([]);
            expect(harness.artifacts(serverId).list()).toEqual([]);
            expect(router.push).not.toHaveBeenCalled();

            const agentRequest = await createAgentApprovalRequest({ serverId, actionId: 'connectedServices.subscription.price.set',
                actionInput: { account, price: { amount: 29, currency: 'USD' } }, actionRequestId: 'agent-price' });
            expect(harness.artifacts(serverId).list()).toEqual([expect.objectContaining({ id: agentRequest })]);
            expect(ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(agentRequest)!)))
                .toMatchObject({ status: 'open', requestedSurface: 'agent' });
            expect(record.entries).toEqual([]);
        } finally {
            try { await screen.unmount(); } finally { review.dispose(); }
            storage.setState({ profileScope: previous.profileScope, profile: previous.profile });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('restores Coach digest retry after native review cancellation and consumes its approved Automation receipt', async () => {
        const serverId = await addApprovalHome();
        harness.answer(serverId, 'GET /v1/machines/machine-a', {
            body: { machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: ACCOUNT_ID }) },
        });
        await harness.requireUiApproval(serverId, 'workflow.trigger.add');
        const rows = new Map<string, ReturnType<typeof AutomationDefinitionDetailSchema.parse>>();
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
        harness.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        // Stateful HTTP persistence is the external Automation boundary. The actual
        // trigger owner admits, serializes and reads its own template and receipt.
        harness.answer(serverId, 'POST /v3/automations', { select: (raw) => {
            const input = AutomationDefinitionCreateRequestSchema.parse(raw);
            const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
                description: input.description ?? null, enabled: input.enabled,
                workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
                targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                assignments: (input.assignments ?? []).map((value) => ({ machineId: value.machineId,
                    enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
                triggers: input.triggers.map((value) => ({ ...value.trigger, id: value.triggerId, revision: 0,
                    createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null })),
                ...(input.executionRecipe ? { executionRecipe: input.executionRecipe } : {}) });
            rows.set(row.id, row);
            harness.answer(serverId, `/v3/automations/${row.id}`, { body: row });
            return { body: row };
        } });
        const account = await captureLazyActionAccountContext(serverId);
        const review = await mountActionReviewHost();
        const screen = await renderScreen(<review.Provider />);
        const controller = createUsageCoachController({ lifetime: account.accountLifetime,
            executor: createDefaultActionExecutor({ resolveServerIdForSessionId: () => null }) });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        const suggestion = resolveUsagePageAggregation({ queries: [query] }, bundledUsageModelPriceCatalog).results[0]!.coach!.digestSuggestion!;
        const project = { machineId: 'machine-a', directory: '/repo' };
        const trigger = { kind: 'schedule' as const, enabled: true,
            schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
        let attempt: ReturnType<typeof controller.createDigest> | undefined;
        try {
            attempt = controller.createDigest(suggestion, project, trigger);
            const cancel = await review.decision(screen, false);
            expect(rows.size).toBe(0);
            cancel();
            await waitForHomeGovernance(() => expect(controller.getSnapshot().error?.failure.errorCode).toBe('approval_canceled'));
            await expect(attempt).resolves.toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(controller.getSnapshot()).toMatchObject({
                pending: [], approval: null, digest: null, error: { failure: { errorCode: 'approval_canceled' } },
            });
            expect(rows.size).toBe(0);

            attempt = controller.createDigest(suggestion, project, trigger);
            const confirm = await review.decision(screen, true);
            expect(rows.size).toBe(0);
            confirm();
            await waitForHomeGovernance(() => expect(controller.getSnapshot().digest?.queryKey).toBe(suggestion.queryKey));
            await expect(attempt).resolves.toMatchObject({ ok: true });
            expect(controller.getSnapshot()).toMatchObject({
                pending: [], approval: null, error: null, digest: { queryKey: suggestion.queryKey },
            });
            expect(harness.artifacts(serverId).list()).toHaveLength(0);
            const receipt = controller.getSnapshot().digest!;
            expect(rows.get(receipt.result.set.automationId)).toMatchObject({ enabled: true,
                assignments: [{ machineId: project.machineId }], triggers: [{ kind: 'schedule', enabled: true }] });
        } finally {
            controller.dispose();
            account.dispose();
            try {
                await screen.unmount();
            } finally {
                review.dispose();
            }
        }
    });

    it('retains the approval in its originating flow without navigation and delivers its executed result exactly once', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'rename-executed');
        const refresh = vi.fn();
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        // A caller retaining the removed flag must still wait for a deliberate Review.
        const continuationInput = {
            scopeKey: `${serverId}:${ACCOUNT_ID}`, serverId, onExecuted: refresh, openOnRequest: true,
        };
        const hook = await renderHook(() => useActionApprovalContinuation(continuationInput));
        const deliveryObservedCustody = vi.fn();
        const onExecuted = vi.fn<ActionApprovalContinuation['onExecuted']>(async (_artifact) => {
            deliveryObservedCustody(hook.getCurrent().approvalId);
            return 'consumed' as const;
        });

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('open'));
        expect(hook.getCurrent().approvalPending).toBe(true);
        expect(hook.getCurrent().artifact?.id).toBe(artifactId);
        expect(router.push).not.toHaveBeenCalled();

        act(() => hook.getCurrent().openApproval());
        expect(router.push).toHaveBeenCalledExactlyOnceWith(
            `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`,
        );
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        expect(hook.getCurrent().approvalPending).toBe(true);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => expect(onExecuted).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledTimes(1);
        // Custody is released before the result is handed over, so a result
        // handler can never observe (or re-deliver) its own pending approval.
        expect(deliveryObservedCustody).toHaveBeenCalledWith(null);
        const delivered = onExecuted.mock.calls[0]?.[0];
        expect(delivered).toBeDefined();
        if (!delivered) throw new Error('Expected the executed approval Artifact');
        expect(delivered.id).toBe(artifactId);
        if (typeof delivered.body !== 'string') throw new Error('Expected the executed approval Artifact body');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(delivered.body))).toMatchObject({
            status: 'executed',
            execution: { ok: true },
        });

        await hook.rerender();
        expect(onExecuted).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        expect(router.push).toHaveBeenCalledTimes(1);
    });

    it('leaves projection refresh with a caller that owns completion beyond Action admission', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const actionId = 'teams.update';
        const actionInput = { v: 1, teamId: 'team-1', name: 'Renamed' };
        const artifactId = await createUiApprovalRequest({ serverId, actionId, actionInput, actionRequestId: 'caller-owned-completion' });
        const readReceipt = () => ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        expect(readReceipt()).toMatchObject({ status: 'open', actionId, requestedSurface: 'ui',
            executionOriginV1: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' }, accountId: ACCOUNT_ID },
        });
        const refresh = vi.fn();
        const hook = await renderContinuation(serverId, refresh);
        const received = vi.fn();
        const failed = vi.fn();
        const scope = createServerAccountScope(serverId, ACCOUNT_ID);
        if (!scope) throw new Error('Expected the originating Home scope');
        const continuation = createActionApprovalContinuation({
            artifactId,
            actionId,
            scope,
            expectedInput: actionInput,
            refreshAfterExecution: false,
            onSucceeded: received,
            onFailed: failed,
        });

        act(() => hook.getCurrent().requestApproval(continuation));
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });
        expect(readReceipt()).toMatchObject({ status: 'executed', execution: { ok: true } });
        await waitForHomeGovernance(() => expect(received).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ name: 'Renamed' }),
        ));
        expect(failed).not.toHaveBeenCalled();

        expect(hook.getCurrent().approvalId).toBeNull();
        expect(hook.getCurrent().approvalPending).toBe(false);
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        // The origin received its real result, but only that origin can know
        // when its remaining work is complete and its projection can refresh.
        expect(refresh).not.toHaveBeenCalled();
    });

    it('hands a chained result-bearing Action to the same owner after the first result is claimed', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const firstId = await openRenameApproval(serverId, 'rename-first');
        const secondId = await openRenameApproval(serverId, 'rename-second', 'Renamed again');
        const hook = await renderContinuation(serverId);
        const secondResult = vi.fn(async () => 'consumed' as const);
        const firstResult = vi.fn(async () => {
            hook.getCurrent().requestApproval({ artifactId: secondId, onExecuted: secondResult });
            return 'consumed' as const;
        });

        act(() => hook.getCurrent().requestApproval({ artifactId: firstId, onExecuted: firstResult }));
        await decideApprovalAsInbox(serverId, firstId, 'approve');
        await waitForHomeGovernance(() => expect(firstResult).toHaveBeenCalledOnce());
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(secondId));
        expect(secondResult).not.toHaveBeenCalled();

        await decideApprovalAsInbox(serverId, secondId, 'approve');
        await waitForHomeGovernance(() => expect(secondResult).toHaveBeenCalledOnce());
        expect(hook.getCurrent().approvalId).toBeNull();
    });

    it('delivers both concurrently registered read results even when the Inbox decides the second first', async () => {
        const serverId = await addApprovalHome();
        const identityReadPath = '/v1/teams/identity/connections/list';
        harness.answer(serverId, identityReadPath, {
            body: {
                items: [], eligibleProviders: [], memberSignInUrl: null,
                admissionModeApplicability: { v: 1, modes: {
                    invite_only: { status: 'available' },
                    provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                    jit: { status: 'unavailable', reason: 'team_connection_required' },
                } },
            },
        });
        harness.answer(serverId, 'GET /v1/teams/team-1/directory-sources', {
            body: { items: [], nextCursor: null },
        });
        const hook = await renderContinuation(serverId);
        const scope = createServerAccountScope(serverId, ACCOUNT_ID);
        if (!scope) throw new Error('Expected the originating Home scope');
        const firstResult = vi.fn();
        const secondResult = vi.fn();
        const firstFailure = vi.fn();
        const secondFailure = vi.fn();
        const reads = [
            { actionId: 'teams.identity.connections.list', onSucceeded: firstResult, onFailed: firstFailure },
            { actionId: 'teams.directory.sources.list', onSucceeded: secondResult, onFailed: secondFailure },
        ] as const;
        const actionInput = { v: 1, teamId: 'team-1' };
        await harness.requireUiApproval(serverId, reads[0].actionId);
        const { createIdentityAdministrationClient } = await import('@/components/settings/teams/identity/identityAdministrationClient');
        const review = await mountActionReviewHost();
        const screen = await renderScreen(<review.Provider />);
        const controller = new AbortController();
        try {
            const client = createIdentityAdministrationClient(scope);
            const presentRead = client.execute(reads[0].actionId, actionInput, { signal: controller.signal });
            const approve = await review.decision(screen, true);
            expect(harness.artifacts(serverId).list()).toEqual([]);
            approve();
            await expect(presentRead).resolves.toMatchObject({ ok: true, value: { items: [], eligibleProviders: [] } });
            expect(harness.artifacts(serverId).list()).toEqual([]);
            expect(harness.requestsFor(identityReadPath)).toHaveLength(1);
        } finally {
            controller.abort();
            try { await screen.unmount(); } finally { review.dispose(); }
        }

        const artifactIds: string[] = [];
        // Outstanding Agent requests have Inbox items with their original execution bindings.
        for (const read of reads) {
            const artifactId = await createAgentApprovalRequest({ serverId, actionId: read.actionId, actionInput,
                actionRequestId: read.actionId });
            const receipt = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
            expect(receipt).toMatchObject({ status: 'open', requestedSurface: 'agent' });
            expect(receipt.executionOriginV1).toBeDefined();
            artifactIds.push(artifactId);
            act(() => hook.getCurrent().requestApproval(createActionApprovalContinuation({
                ...read, artifactId, scope, expectedInput: actionInput, expectedExecutionOrigin: receipt.executionOriginV1,
            })));
        }
        const [firstId, secondId] = artifactIds;
        if (!firstId || !secondId) throw new Error('Expected both read approvals');
        expect(hook.getCurrent().approvalId).toBe(firstId);
        await expect(decideApprovalAsInbox(serverId, secondId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(firstResult).not.toHaveBeenCalled();
        await expect(decideApprovalAsInbox(serverId, firstId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

        await waitForHomeGovernance(() => {
            expect(firstResult).toHaveBeenCalledOnce();
            expect(secondResult).toHaveBeenCalledOnce();
        });
        expect(firstResult).toHaveBeenCalledWith(expect.objectContaining({ items: [], eligibleProviders: [] }));
        expect(secondResult).toHaveBeenCalledWith({ items: [], nextCursor: null });
        expect(firstFailure).not.toHaveBeenCalled();
        expect(secondFailure).not.toHaveBeenCalled();
        expect(hook.getCurrent().approvalId).toBeNull();
        expect(harness.requestsFor(identityReadPath)).toHaveLength(2);
        expect(harness.requestsFor('/v1/teams/team-1/directory-sources')).toHaveLength(1);
    });

    it.each([
        { status: 'rejected' as const, decision: 'reject' as const, homeAnswer: null },
        // The Home refuses the replayed rename, so execution settles failed.
        { status: 'failed' as const, decision: 'approve' as const, homeAnswer: { status: 409, body: { error: 'team_archived' } } },
    ])('releases $status custody with its typed body and restores retry', async ({ status, decision, homeAnswer }) => {
        const serverId = await addApprovalHome();
        if (homeAnswer) harness.answer(serverId, TEAM_UPDATE_PATH, homeAnswer);
        const artifactId = await openRenameApproval(serverId, `rename-${status}`);
        const hook = await renderContinuation(serverId);
        const onExecuted = vi.fn(async () => 'consumed' as const);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted, onTerminal }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('open'));
        await decideApprovalAsInbox(serverId, artifactId, decision);

        await waitForHomeGovernance(() => expect(onTerminal).toHaveBeenCalledOnce());
        const [terminalStatus, artifact] = onTerminal.mock.calls[0] as [string, { id: string; body: unknown }];
        expect(terminalStatus).toBe(status);
        expect(artifact.id).toBe(artifactId);
        expect(typeof artifact.body).toBe('string');
        expect(onExecuted).not.toHaveBeenCalled();
        expect(hook.getCurrent().approvalId).toBeNull();
        expect(hook.getCurrent().approvalPending).toBe(false);
    });

    it('removes Inbox decision controls as soon as a recorded approval settles failed', async () => {
        const serverId = await addApprovalHome();
        harness.answer(serverId, TEAM_UPDATE_PATH, { status: 409, body: { error: 'team_archived' } });
        const artifactId = await openRenameApproval(serverId, 'inbox-failed-effect');
        const context = await captureActionAccountContext(serverId);
        try {
            const artifact = await context.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected pending approval');
            const { ApprovalInboxCard } = await import('@/components/inbox/cards/ApprovalInboxCard');
            const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} inlineActionLabel="Review" onPress={() => {}} />);
            expect(screen.findHostByTestId(`inbox.approval.${artifactId}.allow_once`)).toBeTruthy();

            await screen.pressByTestIdAsync(`inbox.approval.${artifactId}.allow_once`);
            await waitForHomeGovernance(() => expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null'))
                .toMatchObject({ status: 'failed', decision: { kind: 'approve' },
                    execution: { ok: false, errorCode: 'team_archived' } }));
            expect(screen.findHostByTestId(`inbox.approval.${artifactId}.allow_once`)).toBeFalsy();
            expect(screen.findHostByTestId(`inbox.approval.${artifactId}.deny`)).toBeFalsy();
        } finally { context.dispose(); }
    });

    it('consumes an Inbox rejection while its retained split-canvas origin is hidden on another Home', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'unfocused-origin');
        const navigation = await import('@react-navigation/native');
        const focus = vi.spyOn(navigation, 'useIsFocused').mockReturnValue(true);
        let originShown = true;
        const root: SplitCanvasState<null>['root'] = {
            kind: 'split', id: 'approval-origin-split', axis: 'row', ratio: 0.5,
            first: { kind: 'leaf', id: 'origin', leafKind: 'test', payload: null },
            second: { kind: 'leaf', id: 'approval', leafKind: 'test', payload: null },
        };
        function RetainedOrigin(props: React.PropsWithChildren) {
            return <SplitCanvasHost state={{ root, focusedLeafId: originShown ? 'origin' : 'approval', maximizedLeafId: originShown ? null : 'approval' }}
                dispatch={() => {}} renderLeaf={({ leaf }) => leaf.id === 'origin' ? props.children : null} />;
        }
        const hook = await renderContinuation(serverId, vi.fn(), RetainedOrigin);
        const onTerminal = vi.fn();
        try {
            act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted: vi.fn(), onTerminal }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('open'));
            // Another Home is active during review: its store cannot carry this
            // origin's terminal body. Only the exact-Home reader can settle it.
            const otherHomeId = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-continuation.example', accountId: 'account-b' });
            await act(async () => {
                await storage.getState().activateSettingsScope({ serverId: otherHomeId, accountId: 'account-b' }, []);
                storage.getState().activateProfileScope({ serverId: otherHomeId, accountId: 'account-b' }, []);
            });
            focus.mockReturnValue(false);
            originShown = false;
            await hook.rerender({ scopeKey: `${serverId}:${ACCOUNT_ID}` });
            await decideApprovalAsInbox(serverId, artifactId, 'reject');
            const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
            await act(async () => { publishHomeAccountChange(serverId, [artifactId], { changeKinds: ['artifact'] }); });
            await waitForHomeGovernance(() => expect(onTerminal).toHaveBeenCalledOnce());
            expect(onTerminal).toHaveBeenCalledWith('rejected', expect.objectContaining({ id: artifactId }));

            focus.mockReturnValue(true);
            originShown = true;
            await hook.rerender({ scopeKey: `${serverId}:${ACCOUNT_ID}` });
            expect(hook.getCurrent().approvalPending).toBe(false);
            expect(onTerminal).toHaveBeenCalledOnce();
        } finally {
            focus.mockRestore();
            await hook.unmount();
        }
    });

    it('keeps custody through a transport failure so the same approval can still settle', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'rename-unreachable');
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { status: 503, body: { error: 'unavailable' } });
        const hook = await renderContinuation(serverId);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted: vi.fn(), onTerminal }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().error).toBe(true));

        expect(hook.getCurrent().invalidArtifact).toBe(false);
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        expect(hook.getCurrent().approvalPending).toBe(true);
        expect(onTerminal).not.toHaveBeenCalled();
    });

    it('clears an Artifact the Home serves whose header contradicts its approval body', async () => {
        const serverId = await addApprovalHome();
        const genuineId = await openRenameApproval(serverId, 'rename-genuine');
        const genuineBody = harness.artifacts(serverId).readPlainBody(genuineId);
        const genuine = ApprovalRequestV2Schema.parse(genuineBody === null ? null : JSON.parse(genuineBody));
        // Any client of the Home's Artifact route can store this row; the reader
        // must refuse it rather than wait on it forever.
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureActionAccountContext(serverId, new AbortController().signal);
        let contradictoryId: string;
        try {
            contradictoryId = await context.createArtifact(
                buildApprovalRequestArtifactHeaderV1({ ...genuine, actionId: 'teams.archive' }),
                JSON.stringify(genuine),
            );
        } finally {
            context.dispose();
        }
        const hook = await renderContinuation(serverId);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId: contradictoryId, onExecuted: vi.fn(), onTerminal }));

        await waitForHomeGovernance(() => expect(onTerminal).toHaveBeenCalledWith('invalid', null));
        expect(hook.getCurrent().approvalId).toBeNull();
    });

    it('discards process-local custody when the exact scope changes', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'rename-scope');
        const queuedArtifactId = await openRenameApproval(serverId, 'rename-queued-scope');
        const hook = await renderContinuation(serverId);
        const onExecuted = vi.fn(async () => 'consumed' as const);

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted }));
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        act(() => hook.getCurrent().requestApproval({ artifactId: queuedArtifactId, onExecuted }));

        await hook.rerender({ scopeKey: `${serverId}:account-b` });
        expect(hook.getCurrent().approvalId).toBeNull();
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await decideApprovalAsInbox(serverId, queuedArtifactId, 'approve');
        expect(onExecuted).not.toHaveBeenCalled();
    });

    it('releases an aborted loader without canceling its durable approval or losing the next result', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const firstId = await openRenameApproval(serverId, 'abandoned-load');
        const secondId = await openRenameApproval(serverId, 'current-load');
        const hook = await renderContinuation(serverId);
        const abandoned = new AbortController();
        const firstResult = vi.fn(async () => 'consumed' as const);
        const secondResult = vi.fn(async () => 'consumed' as const);
        act(() => {
            hook.getCurrent().requestApproval({ artifactId: firstId, onExecuted: firstResult, signal: abandoned.signal });
            hook.getCurrent().requestApproval({ artifactId: secondId, onExecuted: secondResult });
        });
        expect(hook.getCurrent().approvalId).toBe(firstId);

        act(() => abandoned.abort());
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(secondId));
        const abandonedBody = harness.artifacts(serverId).readPlainBody(firstId);
        expect(ApprovalRequestV2Schema.parse(JSON.parse(abandonedBody!)).status).toBe('open');
        await decideApprovalAsInbox(serverId, secondId, 'approve');
        await waitForHomeGovernance(() => expect(secondResult).toHaveBeenCalledOnce());
        expect(firstResult).not.toHaveBeenCalled();
    });
});
