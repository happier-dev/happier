import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createActionApprovalContinuation, type ActionApprovalContinuation } from './actionApprovalContinuation';
import type { SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

// Keep real Sync/Account custody; only the external Socket transport stays disconnected.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

/**
 * The shared result-custody owner, over the real approval lifecycle.
 *
 * Every approval here is one the product writes: a present-user Team rename
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
const { createIdentityAdministrationClient } = await import('@/components/settings/teams/identity/identityAdministrationClient');
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { createUsageCoachController } = await import('@/components/settings/usage/widgets/usageCoachController');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
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
    await harness.requireUiApproval(serverId, 'teams.update');
    return serverId;
}

async function openRenameApproval(serverId: string, requestId: string, name = 'Renamed'): Promise<string> {
    return await createUiApprovalRequest({
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

    it('releases a mounted observers native abort subscription without aborting an externally owned signal or its durable approval', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'external-interest');
        const controller = new AbortController();
        const added = vi.spyOn(controller.signal, 'addEventListener');
        const removed = vi.spyOn(controller.signal, 'removeEventListener');
        const hook = await renderContinuation(serverId);
        await act(async () => hook.getCurrent().requestApproval(createActionApprovalContinuation({ artifactId,
            actionId: 'teams.update', scope: { serverId, accountId: ACCOUNT_ID }, signal: controller.signal,
            expectedInput: { v: 1, teamId: 'team-1', name: 'Renamed' }, onSucceeded: vi.fn() })));
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

    it.each([
        { kind: 'visibility' as const, loseTerminalWrite: false },
        { kind: 'widget_size' as const, loseTerminalWrite: false },
        { kind: 'visibility' as const, loseTerminalWrite: true },
    ])('retains the shared Home layout operation for $kind until its durable approval produces the actual layout receipt (terminal write lost: $loseTerminalWrite)', async ({ kind, loseTerminalWrite }) => {
        const serverId = await addApprovalHome();
        await harness.requireUiApproval(serverId, kind === 'visibility' ? 'home.hub.layout.update' : 'widgets.item.size.set');
        const { useHomeHubArtifactLayout, useHomeHubLayoutWritePending } = await import('@/components/hub/layout/useHomeHubArtifactLayout');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const profile = (await import('@/sync/domains/server/serverProfiles')).getServerProfileById(serverId)!;
        const credentials = (await TokenStorage.getCredentialsForServerUrl(profile.serverUrl))!;
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
        function AccountShell({ children }: React.PropsWithChildren) {
            return <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={projection}>{children}</AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
        }
        function ContentProbe() { content = useHomeHubLayout(); contentRenders++; return null; }
        function Probe() {
            layout = useHomeHubArtifactLayout();
            isWriting = useHomeHubLayoutWritePending();
            return kind === 'visibility' ? <HomeLayoutEditor /> : null;
        }
        const screen = await renderScreen(<AccountShell><Probe /><ContentProbe /></AccountShell>);
        let originMounted = true;
        let retained: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let settled = false;
        let operation!: Promise<void>;
        try {
            await waitForHomeGovernance(() => expect(layout!.status).toBe('ready'));
            const beforeContent = content;
            const beforeRenders = contentRenders;
            await act(async () => {
                operation = layout!.dispatch(kind === 'visibility' ? { kind: 'visibility', sectionId: 'setup', hidden: true }
                    : { kind: 'widget_size', instanceId: 'checks', size: 'wide' }, { rethrow: true });
                void operation.then(() => { settled = true; }, () => { settled = true; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(kind === 'visibility' ? 1 : 2));
            expect(settled).toBe(false);
            expect(contentRenders).toBe(beforeRenders);
            expect(content).toBe(beforeContent);
            expect(isWriting).toBe(true);
            expect(layout!.failedIntent).toBeUndefined();
            expect(layout!.layout.hidden).not.toContain('setup');
            const artifactId = harness.artifacts(serverId).list().find(artifact => harness.artifacts(serverId).readPlainBody(artifact.id)?.includes('"actionId"'))!.id;
            if (kind === 'visibility') {
                const path = `/v1/artifacts/${artifactId}`;
                harness.answer(serverId, `GET ${path}`, { dispatchThenFail: true });
                const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                await act(async () => { publishHomeAccountChange(serverId, [artifactId]); storage.setState({ endpointStatus: 'offline' }); });
                expect(screen.findByTestId('home-unreachable')).not.toBeNull();
                expect(settled).toBe(false);
                expect(layout!.failedIntent).toBeUndefined();
                harness.answer(serverId, `GET ${path}`, { select: async () => {
                    const pendingResponse = harness.artifacts(serverId).handle(path, { method: 'GET' });
                    if (!pendingResponse) throw new Error('Approval Artifact read route unavailable');
                    const response = await pendingResponse;
                    return { status: response.status, body: await response.json() };
                } });
                await act(async () => { storage.setState({ endpointStatus: 'online' }); });
                retained = await renderScreen(<AccountShell><Probe /></AccountShell>);
                await screen.unmount();
                originMounted = false;
                expect(settled).toBe(false);
            }
            if (loseTerminalWrite) {
                const path = `/v1/artifacts/${artifactId}`;
                const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
                harness.answer(serverId, `POST ${path}`, { select: async input => {
                    const wire = input && typeof input === 'object' && 'body' in input ? input.body : null;
                    const content = typeof wire === 'string' ? decodePlainArtifactStoredContent(wire) : null;
                    const body = content && typeof content === 'object' && 'body' in content ? content.body : null;
                    const request = ApprovalRequestV2Schema.safeParse(typeof body === 'string' ? JSON.parse(body) : null);
                    if (request.success && request.data.status === 'executed') return { dispatchThenFail: true };
                    const pendingResponse = harness.artifacts(serverId).handle(path, { method: 'POST', body: JSON.stringify(input) });
                    if (!pendingResponse) throw new Error('Approval Artifact update route unavailable');
                    const response = await pendingResponse;
                    return { status: response.status, body: await response.json() };
                } });
            }
            const decision = await decideApprovalAsInbox(serverId, artifactId, 'approve');
            if (loseTerminalWrite) {
                expect(decision).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
                expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executing"');
                const account = await captureLazyActionAccountContext(serverId);
                try {
                    const { createHomeHubArtifactPortV1, buildHomeHubArtifactIdV1 } = await import('@happier-dev/protocol/home');
                    expect((await createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId: ACCOUNT_ID }).read()).hidden).toEqual(['setup']);
                    const homeId = buildHomeHubArtifactIdV1(ACCOUNT_ID);
                    const beforeWrites = harness.requestsFor(`/v1/artifacts/${homeId}`).filter(request => request.input !== null).length;
                    const beforeApprovals = harness.artifacts(serverId).list().length;
                    await act(async () => { await layout!.retry(); });
                    expect(harness.requestsFor(`/v1/artifacts/${homeId}`).filter(request => request.input !== null)).toHaveLength(beforeWrites);
                    expect(harness.artifacts(serverId).list()).toHaveLength(beforeApprovals);
                } finally { account.dispose(); }
                expect(settled).toBe(false);
                expect(isWriting).toBe(true);
                expect(layout!.failedIntent).toBeUndefined();
                return;
            }
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
            await act(async () => { await operation; });
            expect(settled).toBe(true);
            expect(isWriting).toBe(false);
            expect(layout!.status).toBe('ready');
            if (kind === 'visibility') expect(layout!.layout.hidden).toEqual(['setup']);
            else expect(layout!.layout.items).toEqual(expect.arrayContaining([{ kind: 'widget',
                instance: expect.objectContaining({ id: 'checks' }), size: 'wide' }]));
            expect(layout!.failedIntent).toBeUndefined();
        } finally {
            if (originMounted) await screen.unmount();
            await retained?.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('keeps an issued approval decision disabled while its Home is unreachable and consumes the later receipt', async () => {
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
        const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} serverId={serverId} />);
        let decision!: Promise<void>;
        try {
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(ApprovalDecisionBar)).toHaveLength(1);
                expect(screen.findAllByType(ApprovalDecisionBar)[0]?.props.approve?.disabled).toBe(false);
            });
            await act(async () => { decision = screen.pressByTestIdAsync('approvals.approve'); });
            await waitForHomeGovernance(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(screen.findByTestId('approvals.home-unavailable')).not.toBeNull();
            const bar = screen.findAllByType(ApprovalDecisionBar)[0];
            if (bar) {
                expect(bar.props.busy).toBe(false);
                expect(bar.props.approve.disabled).toBe(true);
                expect(bar.props.reject.disabled).toBe(true);
                expect(bar.props.dismiss.disabled).toBe(true);
            }
            await act(async () => { respond(); await decision; });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executed"'));
            expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        } finally {
            respond();
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
        let profileAccountId = ACCOUNT_ID;
        harness.answer(serverId, '/v1/account/profile', { select: () => ({ body: AccountProfileSchema.parse({ id: profileAccountId,
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
        const screen = await renderScreen(<Editor />);
        const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const save = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'price.save')!;
        const field = (name: 'amount' | 'currency') => screen.findAllByType(FieldTextInput).find(node => node.props.testID === `price.${name}`)!;
        const edit = async (amount: string, currency: string) => {
            await act(async () => { field('amount').props.onChangeText(amount); field('currency').props.onChangeText(currency); });
        };
        let release = () => {};
        try {
            expect(screen.findByTestId('price.amount')).toBeNull();
            await screen.pressByTestIdAsync('price-header');
            expect(save().props.disabled).toBe(true);
            await edit('-1', 'EUR');
            expect(save().props.disabled).toBe(true);
            await edit('17', 'eur');
            expect(save().props.disabled).toBe(false);
            // The rendered entry point runs the real front door; UI custody is deferred despite required-result metadata.
            await screen.pressByTestIdAsync('price.save');
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            expect(save().props.disabled).toBe(true);
            expect(record.entries).toEqual([]);
            const rejectedId = harness.artifacts(serverId).list().at(-1)!.id;
            await expect(decideApprovalAsInbox(serverId, rejectedId, 'reject')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(save().props.disabled).toBe(false));
            expect(screen.findAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(0);
            await screen.pressByTestIdAsync('price.save');
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
            const acceptedId = harness.artifacts(serverId).list().at(-1)!.id;
            const accepted = await decideApprovalAsInbox(serverId, acceptedId, 'approve');
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, result: { status: 'executed' } });
            await waitForHomeGovernance(() => expect(save().props.disabled).toBe(false));
            expect(refreshed).toHaveBeenCalledTimes(1);
            expect(record.entries).toMatchObject([{ subject: { kind: 'account', account }, subscriptionMonthlyPrice: { amount: 17, currency: 'EUR' } }]);
            await screen.pressByTestIdAsync('price.clear');
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(3));
            const clearedId = harness.artifacts(serverId).list().at(-1)!.id;
            await expect(decideApprovalAsInbox(serverId, clearedId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
            await waitForHomeGovernance(() => expect(refreshed).toHaveBeenCalledTimes(2));
            expect(record.entries).toEqual([]);
            const reply = new Promise<void>(resolve => { release = resolve; });
            let committed = false;
            harness.answer(serverId, `POST ${path}`, { select: raw => {
                const mutation = ConnectedPresentationRowMutationV1Schema.parse(raw);
                if (mutation.content?.t !== 'plain') throw new Error('Expected keyless price metadata');
                record = mutation.content.v; revision += 1; committed = true;
                return { body: { status: 'updated', revision, cursor: revision }, respondAfter: reply };
            } });
            await edit('17', 'EUR');
            await screen.pressByTestIdAsync('price.save');
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(4));
            const oldAccountId = harness.artifacts(serverId).list().at(-1)!.id;
            // Keep the genuine HTTP reply open without keeping React's async act scope open around it.
            const deciding = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null }).execute(
                'approval.request.decide', { artifactId: oldAccountId, decision: 'approve' }, { surface: 'ui', serverId });
            await waitForHomeGovernance(() => expect(committed).toBe(true));
            await harness.switchAccount(serverId, 'account-b');
            await harness.requireUiApproval(serverId, 'connectedServices.subscription.price.set');
            profileAccountId = 'account-b';
            act(() => storage.setState({ profileScope: { serverId, accountId: 'account-b' }, profile: AccountProfileSchema.parse({ id: 'account-b' }) }));
            expect(field('amount').props.value).toBe('');
            expect(field('currency').props.value).toBe('');
            release();
            await act(async () => { await deciding; });
            // The old Account committed its own write; its late reply must not refresh the new editor.
            expect(refreshed).toHaveBeenCalledTimes(2);
            // The same mounted editor is immediately usable under its new Account, not stuck pending.
            record = { v: 1, entries: [] }; revision = 1;
            const previousApprovals = harness.artifacts(serverId).list().length;
            await edit('23', 'USD');
            expect(save().props.disabled).toBe(false);
            await screen.pressByTestIdAsync('price.save');
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(previousApprovals + 1));
            expect(save().props.disabled).toBe(true);
            const newAccountApprovalId = harness.artifacts(serverId).list().at(-1)!.id;
            await expect(decideApprovalAsInbox(serverId, newAccountApprovalId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
            await waitForHomeGovernance(() => expect(refreshed).toHaveBeenCalledTimes(3));
            expect(save().props.disabled).toBe(false);
            expect(record.entries).toMatchObject([{ subject: { kind: 'account', account }, subscriptionMonthlyPrice: { amount: 23, currency: 'USD' } }]);
        } finally {
            release();
            await act(async () => screen.unmount());
            storage.setState({ profileScope: previous.profileScope, profile: previous.profile });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('restores Coach digest retry after Inbox rejection and consumes its approved Automation receipt', async () => {
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
        const hook = await renderContinuation(serverId);
        const controller = createUsageCoachController({ lifetime: account.accountLifetime,
            executor: createDefaultActionExecutor({ resolveServerIdForSessionId: () => null }),
            onApproval: hook.getCurrent().requestApproval });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        const suggestion = resolveUsagePageAggregation({ queries: [query] }).results[0]!.coach!.digestSuggestion!;
        const project = { machineId: 'machine-a', directory: '/repo' };
        const trigger = { kind: 'schedule' as const, enabled: true,
            schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
        try {
            expect(rows.size).toBe(0);
            await act(async () => { await controller.createDigest(suggestion, project, trigger); });
            const rejectedId = controller.getSnapshot().approval!.request.artifactId;
            expect(hook.getCurrent().approvalId).toBe(rejectedId);
            expect(rows.size).toBe(0);
            await expect(decideApprovalAsInbox(serverId, rejectedId, 'reject')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(controller.getSnapshot()).toMatchObject({
                pending: [], approval: null, digest: null, error: { failure: { errorCode: 'approval_rejected' } } }));
            expect(rows.size).toBe(0);
            await act(async () => { await controller.createDigest(suggestion, project, trigger); });
            const approvedId = controller.getSnapshot().approval!.request.artifactId;
            expect(approvedId).not.toBe(rejectedId);
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(approvedId));
            await expect(decideApprovalAsInbox(serverId, approvedId, 'approve')).resolves.toMatchObject({
                ok: true, result: { status: 'executed' } });
            await waitForHomeGovernance(() => expect(controller.getSnapshot()).toMatchObject({
                pending: [], approval: null, error: null, digest: { queryKey: suggestion.queryKey } }));
            const receipt = controller.getSnapshot().digest!;
            expect(rows.get(receipt.result.set.automationId)).toMatchObject({ enabled: true,
                assignments: [{ machineId: project.machineId }], triggers: [{ kind: 'schedule', enabled: true }] });
        } finally { controller.dispose(); account.dispose(); await hook.unmount(); }
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
        const artifactId = await openRenameApproval(serverId, 'caller-owned-completion');
        const refresh = vi.fn();
        const hook = await renderContinuation(serverId, refresh);
        const received: unknown[] = [];
        const scope = createServerAccountScope(serverId, ACCOUNT_ID);
        if (!scope) throw new Error('Expected the originating Home scope');
        const continuation = createActionApprovalContinuation({
            artifactId,
            actionId: 'teams.update',
            scope,
            expectedInput: { v: 1, teamId: 'team-1', name: 'Renamed' },
            refreshAfterExecution: false,
            onSucceeded: (value: unknown) => { received.push(value); },
        });

        act(() => hook.getCurrent().requestApproval(continuation));
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await waitForHomeGovernance(() => expect(received).toHaveLength(1));

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
        await harness.requireUiApproval(serverId, 'teams.identity.connections.list');
        harness.answer(serverId, '/v1/teams/identity/connections/list', {
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
        const scope = createServerAccountScope(serverId, ACCOUNT_ID)!;
        const client = createIdentityAdministrationClient(scope, { onApprovalPending: hook.getCurrent().requestApproval });
        const firstResult = vi.fn();
        const secondResult = vi.fn();
        await act(async () => { await client.execute('teams.identity.connections.list', { v: 1, teamId: 'team-1' }, { onApprovalSucceeded: firstResult }); });
        await harness.requireUiApproval(serverId, 'teams.directory.sources.list');
        await act(async () => { await client.executeDirectory('teams.directory.sources.list', { v: 1, teamId: 'team-1' }, { onApprovalSucceeded: secondResult }); });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        const artifactIdFor = (actionId: string) => harness.artifacts(serverId).list().find((row) => {
            const body = harness.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestV2Schema.parse(JSON.parse(body)).actionId === actionId;
        })!.id;
        const firstId = artifactIdFor('teams.identity.connections.list');
        const secondId = artifactIdFor('teams.directory.sources.list');
        await expect(decideApprovalAsInbox(serverId, secondId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await expect(decideApprovalAsInbox(serverId, firstId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

        await waitForHomeGovernance(() => {
            expect(firstResult).toHaveBeenCalledOnce();
            expect(secondResult).toHaveBeenCalledOnce();
        });
        expect(firstResult).toHaveBeenCalledWith(expect.objectContaining({ items: [], eligibleProviders: [] }));
        expect(secondResult).toHaveBeenCalledWith({ items: [], nextCursor: null });
        expect(hook.getCurrent().approvalId).toBeNull();
        expect(harness.requestsFor('/v1/teams/identity/connections/list')).toHaveLength(1);
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
            expect(onTerminal.mock.calls[0]?.[0]).toBe('rejected');
            expect(hook.getCurrent().approvalPending).toBe(false);
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
