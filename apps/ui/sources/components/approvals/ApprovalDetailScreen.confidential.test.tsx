import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AccountSettingsV2GetResponseSchema, ApprovalRequestV2Schema, CurrentCursorResponseSchema,
    FeaturesResponseSchema, SavedSecretResourceMaterialsResponseV1Schema, buildApprovalRequestArtifactHeaderV1,
    createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import {
    SHARED_SAVED_SECRET_ACTION_PATHS_V1,
    SharedSavedSecretCreateInputV1Schema,
    type SharedSavedSecretCreateInputV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { PrivateConfidentialContinuationV1Schema, PrivateSecretContinuationV1Schema } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { ComputerSecretFillRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createSessionListRenderableSessionFixture, createTestSessionTranscriptSource, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { normalizeAccountSettingsForLocalStorage } from '@/sync/domains/settings/accountSettingsNormalization';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxItems } from '@/components/inbox/inboxItems';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Only platform/navigation adapters and the actual network are substituted. The
// approval reader, confidential operation, catalog, Account lifetime and CAS stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(), useIsFocused: () => true,
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const personal: SavedSecret[] = [{ id: 'secret-1', name: 'Existing password', kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, value: 'stored-value-must-not-be-delivered' }, createdAt: 1, updatedAt: 1 }];
const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let deliveries: unknown[] = [];
let writes: string[] = [];
let uncertain = false;
let submitUnknown = false;
let refusal: string | null = null;
let rememberSucceeds = false;
let rememberOutcomeUnknown = false;
let holdPrivateReply: Promise<void> | null = null;
let rememberedResource: SharedSavedSecretCreateInputV1 | null = null;
let savedResourceForChoice = false;
const savedResourceRef = formatSharedSavedSecretRefV1('secret-1');
let sessionInventory: ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>[] = [];

async function enterOnceValue(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.editable).toBe(true), { timeout: 5_000 });
    await act(async () => { screen.changeTextByTestId('approvals.secret-value', 'one-time-value'); });
}

async function continueChoice(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('approvals.secret-continue');
    await vi.waitFor(() => expect(['filled', 'refused', 'unknown', 'canceled'].some(status =>
        screen.getTextContent().includes(`approvals.confidential.${status}`))).toBe(true));
}

installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object') throw new Error('invalid_network_request');
        const method = Reflect.get(payload, 'method');
        if (method !== `machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`) throw new Error('unexpected_network_method');
        const continuation = PrivateConfidentialContinuationV1Schema.parse(Reflect.get(payload, 'params'));
        deliveries.push(JSON.parse(JSON.stringify(continuation)));
        await holdPrivateReply;
        // A consuming Action answers with its ordinary, value-free execution result.
        if ('kind' in continuation) return { ok: true, result: { ok: true, result: { ok: true } } };
        if (uncertain) throw new Error('one-time-value network error must not be shown');
        if (refusal) return { ok: true, result: { status: 'refused', code: refusal } };
        if (submitUnknown) return { ok: true, result: { status: 'filled', code: 'filled', submit: { status: 'unknown', code: 'submit_unknown' } } };
        return { ok: true, result: { status: 'filled', code: 'filled' } };
    });
});

describe('confidential approval human continuation', () => {
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        savedResourceForChoice = false;
        sessionInventory = [];
        deliveries = []; writes = []; uncertain = false; submitUnknown = false; refusal = null; rememberSucceeds = false; rememberOutcomeUnknown = false; rememberedResource = null; holdPrivateReply = null;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://confidential-approval.example.test',
            serverIdentityId: 'srv_confidential-home', accountId: 'account-a', request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === 'machine-1' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
                if (sessionInventory.length > 0 && (init?.method ?? 'GET') === 'GET' && (path === '/v2/sessions' || path === '/v2/sessions/active')) {
                    return Response.json(V2SessionListResponseSchema.parse({
                        sessions: path === '/v2/sessions/active' ? sessionInventory.filter(session => session.active) : sessionInventory, nextCursor: null,
                        hasNext: false, attentionNextCursor: null, attentionHasNext: false }));
                }
                const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrap) return bootstrap;
                if (init?.method && init.method !== 'GET') {
                    writes.push(path);
                    if (rememberSucceeds && path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']) {
                        rememberedResource = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init.body)));
                        if (rememberOutcomeUnknown) throw new TypeError('Saved Secret receipt was lost');
                        return Response.json({ resourceId: rememberedResource.resourceId, revision: 1 });
                    }
                    return new Response('{}', { status: 503 });
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' })]);
                if (path === '/v1/machines/machine-1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) });
                if (path === '/v1/artifacts/approval-1') {
                    const artifact = storage.getState().artifacts['approval-1'];
                    if (!artifact?.isDecrypted || typeof artifact.body !== 'string') return new Response('{}', { status: 404 });
                    return Response.json({ ...artifact, encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }) });
                }
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                    content: { t: 'plain', v: { secrets: savedResourceForChoice ? [] : personal,
                        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'secrets.shared.create': ['ui'] } } } }, version: 1,
                }));
                if (path === '/v1/account/saved-secrets/resources/materials' && rememberOutcomeUnknown && rememberedResource) return new Response('{}', { status: 503 });
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: rememberedResource ? [{
                    resourceId: rememberedResource.resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                    entry: { ref: formatSharedSavedSecretRefV1(rememberedResource.resourceId), source: 'shared_resource', relationship: 'owner',
                        name: rememberedResource.displayName, kind: rememberedResource.kind, encryptionMode: 'plain', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    storedContent: rememberedResource.storedContent,
                }] : savedResourceForChoice ? [{
                    resourceId: 'secret-1', encryptionMode: 'plain', recipientEnvelope: null,
                    entry: { ref: savedResourceRef, source: 'shared_resource', relationship: 'owner',
                        name: personal[0].name, kind: personal[0].kind, encryptionMode: 'plain', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    storedContent: { t: 'plain', v: { v: 1, name: personal[0].name, kind: personal[0].kind, value: personal[0].encryptedValue.value } },
                }] : [] }));
                return new Response('{}', { status: 404 });
            }) });
        const { sync } = await import('@/sync/sync');
        await sync.refreshProfile();
        const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
        await vi.waitFor(() => {
            expect(storage.getState().profile.id).toBe('account-a');
            expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-a' });
        });
        const keySet = await resolveSettingsSecretsKeySet({ credentials: connection.credentials,
            scope: { serverId, accountId: 'account-a' } });
        const local = normalizeAccountSettingsForLocalStorage({ raw: { secrets: personal }, mode: 'plain',
            settingsSecretsKey: keySet?.writeKey ?? null });
        storage.getState().applySettingsLocal({ secrets: local.secrets });
        storage.setState({ settingsVersion: 1 });
        storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain' })], true, { sourceServerId: serverId });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system', sessionId: 'session-1' }, requestedSurface: 'ui',
            actionId: 'browser.automation.secret.fill', summary: 'Sign in',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId, serverIdentityId: 'srv_confidential-home', sessionId: 'session-1', machineId: 'machine-1',
                target: { kind: 'session', sessionId: 'session-1' }, actionId: 'browser.automation.secret.fill', requestId: 'approval-operation-1' },
            actionArgs: { serverId, sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
                browserSessionId: 'browser-1', viewId: 'view-1', tabId: 'tab-1', frameId: 'frame-1',
                documentId: 'document-1', navigationGeneration: 1, origin: 'https://example.com',
                field: { fieldId: 'password', focusId: 'focus-1', locator: '#password' } },
        });
        storage.getState().applyArtifacts([{ id: 'approval-1', title: 'Sign in', header: buildApprovalRequestArtifactHeaderV1(request),
            body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            isDecrypted: true, storageMode: 'plain', ownerAccountId: 'account-a', access: 'owner' }]);
    });
    afterEach(async () => { await standardCleanup(); await connection?.dispose(); connection = undefined; });

    it('answers a consuming Action\'s declared secret input in the same prompt, privately, never by plain Approve', async () => {
        const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
        const actionArgs = { channelId: 'webhook-release-alerts' };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            actionId: 'notifications.webhooks.signingSecret.set', summary: 'Set the webhook signing secret', actionArgs,
            preview: { actionId: 'notifications.webhooks.signingSecret.set', actionArgs, confidentialInputs: { kind: 'action_inputs', paths: ['secret'] } },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'agent', caller: { kind: 'host' },
                serverId, serverIdentityId: 'srv_confidential-home', sessionId: 'session-1', machineId: 'machine-1',
                target: { kind: 'session', sessionId: 'session-1' }, actionId: 'notifications.webhooks.signingSecret.set',
                requestId: 'approval-operation-inputs' } });
        storage.getState().applyArtifacts([{ id: 'approval-1', title: 'Set the webhook signing secret', header: buildApprovalRequestArtifactHeaderV1(request),
            body: JSON.stringify(request), headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2,
            isDecrypted: true, storageMode: 'plain', ownerAccountId: 'account-a', access: 'owner' }]);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        // The declared field is asked for by its own name, masked; the generic Approve cannot answer it.
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.secureTextEntry).toBe(true));
        expect(screen.findByTestId('approvals.secret-value')?.props.accessibilityLabel).toBe('Signing secret');
        expect(Boolean(screen.findByTestId('approvals.approve'))).toBe(false);
        await enterOnceValue(screen);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('approvals.secret-continue');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('approvals.confidential.inputsDone'));
        expect(deliveries).toEqual([expect.objectContaining({ kind: 'action_inputs', artifactId: 'approval-1',
            requestId: 'approval-operation-inputs', actionId: 'notifications.webhooks.signingSecret.set', request: actionArgs,
            machineId: 'machine-1', accountEncryptionMode: 'plain',
            choices: [{ path: 'secret', choice: { kind: 'once', value: 'one-time-value' } }] })]);
        expect(writes).toEqual([]);
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
    });
    it('masks the one-time choice, keeps Remember off, privately delivers once and clears the human input', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        expect(Boolean(screen.findByTestId('approvals.approve'))).toBe(false);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.secureTextEntry).toBe(true));
        expect(screen.findByTestId('approvals.secret-remember')?.props.value).toBe(false);
        await enterOnceValue(screen);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(false));
        await continueChoice(screen);
        expect(deliveries).toEqual([expect.objectContaining({ artifactId: 'approval-1', requestId: 'approval-operation-1',
            accountEncryptionMode: 'plain', choice: { kind: 'once', value: 'one-time-value' }, submit: false })]);
        expect(writes).toEqual([]);
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled ?? true).toBe(true);
    });

    it.each(['ordinary', 'bot'] as const)('opens the same confidential choice from the actual %s Session approval control without an ordinary approval hop', async kind => {
        const { ApprovalPromptCard } = await import('@/components/tools/shell/approvals/ApprovalPromptCard');
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const metadata = { path: '/project', host: 'tester.local', ...(kind === 'bot' ? { bot: { kind: 'bot' as const } } : {}) };
        const session = createSessionListRenderableSessionFixture({ id: 'session-1', metadata });
        sessionInventory = [createPlainSessionCurrentProjectionRecordFixture({ id: session.id, metadata,
            active: session.active, activeAt: session.activeAt })];
        storage.getState().applyServerScopedSessionListRows(connection!.home.id, [session], { source: 'ordinary', mode: 'replace' });
        const destinations: string[] = [];
        function SessionApprovalHost() {
            const [destination, setDestination] = React.useState<string | null>(null);
            const source = React.useMemo(() => createTestSessionTranscriptSource({
                sessionId: 'session-1', serverId: connection!.home.id,
                interaction: { canSendMessages: true, canApprovePermissions: true },
                actions: { respondToPermission: async () => {}, answerUserAction: async () => {},
                    abort: async () => {}, submitMessage: async () => {} },
                navigate: href => { destinations.push(href); setDestination(href); },
            }), []);
            return destination
                ? <ApprovalDetailScreen artifactId="approval-1" serverId={new URL(destination, 'https://app.example.test').searchParams.get('serverId') ?? undefined} />
                : <SessionTranscriptSourceProvider source={source}>
                    <ApprovalPromptCard artifact={artifact} approval={approval} sessionId="session-1" metadata={metadata} />
                </SessionTranscriptSourceProvider>;
        }
        const screen = await renderScreen(<SessionApprovalHost />);
        await screen.pressByTestIdAsync('approval-prompt-approve');
        expect(destinations).toEqual([`/inbox/approvals/approval-1?serverId=${encodeURIComponent('srv_confidential-home')}`]);
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.secureTextEntry).toBe(true));
        await enterOnceValue(screen);
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(writes).toEqual([]);
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        expect(JSON.stringify(storage.getState().sessionListRowsByServerId)).not.toContain('one-time-value');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
    });

    it('opens the confidential choice from the actual Inbox card in its exact Home and delivers only after the choice', async () => {
        const { InboxContent } = await import('@/components/inbox/InboxContent');
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const artifact = storage.getState().artifacts['approval-1'];
        if (!artifact?.isDecrypted) throw new Error('missing_test_approval');
        // The Inbox's public presentation input is a fixture; its card and
        // workspace navigation remain real, as do the destination's owners.
        const sessionPresentation = { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] };
        const workGroups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [], automationRuns: [],
            automationServerId: null, openApprovals: [artifact], stalledSessions: [], landings: [], snoozed: [],
            resolveSession: () => null, resolveOriginRunId: () => null });
        const model: InboxModel = {
            source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
                ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
            openApprovals: [artifact], openUsageNotices: [], friendRequests: [],
            ...createInboxAttentionFixture(),
            sessionPresentation,
            items: buildInboxItems({ workGroups, sessionPresentation, workflowServerId: null,
                accountServerId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), notices: [] }),
            targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
            markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false,
            workGroups,
            spansHomes: false,
            markRead: async () => {}, dismissUsageNotice: async () => {}, resolveActionOperation: () => {}, settle: async () => {}, setReminder: async () => {},
        };
        const destinations: string[] = [];
        function InboxApprovalHost() {
            const [route, setRoute] = React.useState('/inbox');
            const navigation = React.useMemo<DestinationNavigation>(() => ({
                push: href => { destinations.push(String(href)); setRoute(String(href)); },
                replace: href => setRoute(String(href)), back: () => setRoute('/inbox'),
            }), []);
            return <DestinationInstanceHost tabId="confidential-inbox" ref={{ kind: 'inbox', params: {} }} pathname={route} focused visible navigation={navigation}>
                {route === '/inbox' ? <InboxContent model={model} />
                    : <ApprovalDetailScreen artifactId="approval-1" serverId={new URL(route, 'https://app.example.test').searchParams.get('serverId') ?? undefined} />}
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<InboxApprovalHost />);
        await screen.pressByTestIdAsync('inbox.approval.approval-1');
        expect(destinations).toEqual([`/inbox/approvals/approval-1?serverId=${encodeURIComponent('srv_confidential-home')}`]);
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.secureTextEntry).toBe(true));
        await enterOnceValue(screen);
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(writes).toEqual([]);
    });

    it('passes a Saved Secret reference and fingerprint, never the hydrated catalog value', async () => {
        savedResourceForChoice = true;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        // One value input: a Saved Secret is picked from the same prompt, not a separate mode.
        expect(screen.findByTestId(`saved-secret:${savedResourceRef}`)).toBeFalsy();
        await screen.pressByTestIdAsync('approvals.secret-saved.header');
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${savedResourceRef}`)).toBeTruthy());
        await act(async () => { screen.pressByTestId(`saved-secret:${savedResourceRef}`); });
        // Picking it replaces the typed value; there is nothing new to save.
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-remember')).toBeFalsy();
        await continueChoice(screen);
        expect(deliveries).toEqual([expect.objectContaining({ choice: { kind: 'saved', ref: savedResourceRef, fingerprint: `shared:${savedResourceRef}:1`, revision: 1 } })]);
        expect(JSON.stringify(deliveries)).not.toContain(personal[0].encryptedValue.value);
        expect(writes).toEqual([]);
    });

    it('does not replay an issued uncertain delivery and clears its value without exposing the network error', async () => {
        uncertain = true;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled ?? true).toBe(true);
        expect(screen.getTextContent()).not.toContain('one-time-value');
    });

    it('awaits an admitted private delivery beyond the transport setup budget while its caller remains current', async () => {
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: 'approval-1',
            requestId: 'approval-operation-1', actionId: approval.actionId, request: approval.actionArgs,
            accountEncryptionMode: 'plain', choice: { kind: 'once', value: 'one-time-value' }, submit: false });
        let release!: () => void;
        holdPrivateReply = new Promise<void>(resolve => { release = resolve; });
        const { continueConfidentialSecretFill } = await import('@/sync/ops/actions/confidentialSecretContinuation');
        let settled = false;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = continueConfidentialSecretFill({ continuation,
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'account-a' },
            expectedServerIdentityId: 'srv_confidential-home', isCurrent: () => true,
        }).then(result => { settled = true; return result; });
        try {
            await vi.waitFor(() => expect(deliveries).toHaveLength(1));
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
            expect(settled).toBe(false);
            release();
            await expect(pending).resolves.toEqual({ fill: { status: 'filled', code: 'filled' }, remember: 'not_requested' });
            expect(continuation.choice.kind === 'once' ? continuation.choice.value : null).toBe('');
        } finally {
            release();
            await pending;
            // Retire the fixture's real Sync owner and settle its scheduled
            // callbacks before restoring the boundary clock.
            await connection?.dispose();
            connection = undefined;
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it('keeps a failed explicit Remember separate from the completed physical fill', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(writes).toContain(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']);
        expect(writes).not.toContain('/v2/account/settings');
        expect(screen.getTextContent()).toContain('approvals.confidential.filled');
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberFailed');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled ?? true).toBe(true);
    });

    it('preserves the immutable approved request across portable Home resolution', async () => {
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const request = ApprovalRequestV2Schema.parse({ ...original,
            executionOriginV1: { ...original.executionOriginV1, serverId: 'origin-device-profile' },
            actionArgs: { ...BrowserAutomationSecretFillRequestV1Schema.parse(original.actionArgs), serverId: 'origin-device-profile' },
        });
        storage.getState().applyArtifacts([{ ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await continueChoice(screen);
        expect(deliveries).toEqual([expect.objectContaining({ request: request.actionArgs })]);
        expect(writes).toEqual([]);
    });

    it('refuses private delivery when the captured Home identity differs even if the local alias matches', async () => {
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: 'approval-1',
            requestId: 'approval-operation-1', actionId: approval.actionId, request: approval.actionArgs,
            accountEncryptionMode: 'plain', choice: { kind: 'once', value: 'one-time-value' }, submit: false });
        const { continueConfidentialSecretFill } = await import('@/sync/ops/actions/confidentialSecretContinuation');
        const result = await continueConfidentialSecretFill({ continuation,
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'account-a' }, isCurrent: () => true,
            expectedServerIdentityId: 'srv_other-home' });
        expect(result.fill).toEqual({ status: 'refused', code: 'approval_changed' });
        expect(deliveries).toEqual([]);
        expect(continuation.choice.kind === 'once' ? continuation.choice.value : null).toBe('');
    });

    it('refuses private delivery when the reviewed Account mode no longer matches persisted Account mode', async () => {
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: 'approval-1',
            requestId: 'approval-operation-1', actionId: approval.actionId, request: approval.actionArgs,
            accountEncryptionMode: 'e2ee', choice: { kind: 'once', value: 'one-time-value' }, submit: false });
        const { continueConfidentialSecretFill } = await import('@/sync/ops/actions/confidentialSecretContinuation');
        const result = await continueConfidentialSecretFill({ continuation,
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'account-a' }, isCurrent: () => true,
            expectedServerIdentityId: 'srv_confidential-home' });
        expect(result.fill).toEqual({ status: 'refused', code: 'approval_changed' });
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
        expect(continuation.choice.kind === 'once' ? continuation.choice.value : null).toBe('');
    });

    it('refuses an E2EE deciding Account credential before serializing it to an authenticated Plain shared Machine', async () => {
        const token = connection!.credentials.token;
        await connection!.dispose();
        connection = undefined;
        const access = AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'plain-custodian', displayName: 'Custodian' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' });
        const machine = createMachineFixture({ storageMode: 'plain' });
        const publishedMachine = MachinePublishedRowV1Schema.parse({ ...machine, access,
            metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: null });
        const secret = new Uint8Array(32).fill(9);
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://confidential-approval.example.test',
            serverIdentityId: 'srv_confidential-home', accountId: 'account-a',
            credentials: { token, secret: Buffer.from(secret).toString('base64') }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === publishedMachine.id ? publishedMachine : null);
                const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrap) return bootstrap;
                if (init?.method && init.method !== 'GET') { writes.push(path); return new Response('{}', { status: 503 }); }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
                if (path === '/v1/machines/machine-1') return Response.json({ machine: publishedMachine });
                return new Response('{}', { status: 404 });
            }) });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(connection.home.id);
        const serverId = account.serverId;
        try {
            const encryption = await account.resolveAccountEncryption();
            expect(encryption.accountMode).toBe('e2ee');
            expect(encryption.encryption).not.toBeNull();
        } finally { account.dispose(); }
        writes = []; deliveries = [];
        const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: 'approval-1',
            requestId: 'approval-operation-1', actionId: 'browser.automation.secret.fill',
            request: { serverId, sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
                browserSessionId: 'browser-1', viewId: 'view-1', tabId: 'tab-1', frameId: 'frame-1', documentId: 'document-1',
                navigationGeneration: 1, origin: 'https://example.com', field: { fieldId: 'password', focusId: 'focus-1', locator: '#password' } },
            accountEncryptionMode: 'e2ee', choice: { kind: 'once', value: 'one-time-value' }, submit: false });
        const { continueConfidentialSecretFill } = await import('@/sync/ops/actions/confidentialSecretContinuation');
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { resolveProductionMachineRpcDirectRoute } = await import('@/sync/domains/machines/peer/mediation/rpc/productionRoute');
        const route = await resolveProductionMachineRpcDirectRoute({ machineId: 'machine-1',
            serverId: connection.home.id, accountId: 'account-a', method: RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE });
        expect(route.kind).toBe('fallback');
        const unguarded = await machineRpcWithServerScope<unknown, typeof continuation>({ machineId: 'machine-1',
            serverId: connection.home.id, accountId: 'account-a', method: RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
            payload: PrivateSecretContinuationV1Schema.parse(continuation) });
        expect(unguarded).toEqual({ status: 'filled', code: 'filled' });
        expect(deliveries).toHaveLength(1);
        deliveries = [];
        const current = await captureLazyActionAccountContext(connection.home.id);
        try {
            expect(current.accountId).toBe('account-a');
            expect(current.serverIdentityId).toBe('srv_confidential-home');
            expect((await current.resolveAccountEncryption()).accountMode).toBe('e2ee');
            current.assertCurrent();
        } finally { current.dispose(); }
        expect(continuation.choice.kind === 'once' ? continuation.choice.value : null).toBe('one-time-value');
        const result = await continueConfidentialSecretFill({ continuation,
            scope: { serverId, accountId: 'account-a' }, isCurrent: () => true,
            expectedServerIdentityId: 'srv_confidential-home' });
        expect(result.fill).toEqual({ status: 'refused', code: 'target_unavailable' });
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
        expect(continuation.choice.kind === 'once' ? continuation.choice.value : null).toBe('');
    });

    it('requires an explicit separate choice for the reviewed submit control', async () => {
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const request = ApprovalRequestV2Schema.parse({ ...original, actionArgs: { ...BrowserAutomationSecretFillRequestV1Schema.parse(original.actionArgs),
            submit: { controlId: 'sign-in', locator: '#sign-in', label: 'Sign in', consequence: 'Signs in to the reviewed account' },
        } });
        storage.getState().applyArtifacts([{ ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        expect(screen.findByTestId('approvals.secret-submit')?.props.value).toBe(false);
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-submit')?.props.onValueChange(true); });
        await continueChoice(screen);
        expect(deliveries).toEqual([expect.objectContaining({ submit: true, request: request.actionArgs })]);
    });

    it('saves only an explicitly requested Remember through the strict Saved Secret Resource Action and reloads it', async () => {
        rememberSucceeds = true;
        const logged: unknown[][] = [];
        const logSpies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); }));
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        // Save for next time names the secret after the reviewed site; the person may rename it.
        expect(screen.findByTestId('approvals.secret-name')?.props.value).toBe('example.com');
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberSaved');
        expect(writes.filter(path => path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'])).toHaveLength(1);
        expect(writes.filter(path => path === '/v2/account/settings')).toEqual([]);
        const produced = SharedSavedSecretCreateInputV1Schema.parse(rememberedResource);
        expect(openSavedSecretResourceStoredContentV1({ resourceId: produced.resourceId, mode: 'plain', storedContent: produced.storedContent }))
            .toMatchObject({ name: 'example.com', kind: 'apiKey', value: 'one-time-value' });
        expect(JSON.stringify(logged)).not.toContain('one-time-value');
        for (const spy of logSpies) spy.mockRestore();
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
    });

    it('does not claim Remember succeeded when the Saved Secret Resource Action is unavailable', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(writes).toContain(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']);
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberFailed');
        expect(screen.getTextContent()).not.toContain('approvals.confidential.rememberSaved');
    });

    it.each(['browser.automation.secret.fill', 'computer.secret.fill'] as const)('explains unsupported entry through the reviewed %s route without replay', async actionId => {
        refusal = 'field_verification_unsupported';
        if (actionId === 'computer.secret.fill') {
            const artifact = storage.getState().artifacts['approval-1'];
            if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
            const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
            const request = ApprovalRequestV2Schema.parse({ ...original, actionId,
                executionOriginV1: { ...original.executionOriginV1, actionId },
                actionArgs: ComputerSecretFillRequestV1Schema.parse({
                    serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
                    sourceId: 'native-window', target: { kind: 'window', displayId: 'primary', pid: 123, windowId: 456 },
                    captureId: 'capture', geometry: { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
                        originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } },
                    field: { fieldId: 'password', focusId: 'focus' },
                }),
            });
            storage.getState().applyArtifacts([{ ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]);
        }
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await enterOnceValue(screen);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('approvals.secret-continue');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('approvals.confidential.fieldUnsupported'));
        expect(screen.getTextContent()).toContain('approvals.confidential.fieldUnsupportedBody');
        // One cause, said once: not the generic refusal beside it.
        expect(screen.getTextContent()).not.toContain('approvals.confidential.refused');
        expect(deliveries).toHaveLength(1);
        expect(PrivateSecretContinuationV1Schema.parse(deliveries[0]).actionId).toBe(actionId);
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        await screen.pressByTestIdAsync('approvals.secret-continue');
        expect(deliveries).toHaveLength(1);
        expect(writes).toEqual([]);
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
    });

    it('shows known fill, unknown submit and successful Remember independently without replay', async () => {
        submitUnknown = true; rememberSucceeds = true;
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const request = ApprovalRequestV2Schema.parse({ ...original, actionArgs: { ...BrowserAutomationSecretFillRequestV1Schema.parse(original.actionArgs),
            submit: { controlId: 'sign-in', locator: '#sign-in', label: 'Sign in', consequence: 'Signs in to the reviewed account' },
        } });
        storage.getState().applyArtifacts([{ ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]);
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => {
            screen.findByTestId('approvals.secret-submit')?.props.onValueChange(true);
            screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true);
        });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(screen.getTextContent()).toContain('approvals.confidential.filled');
        expect(screen.getTextContent()).toContain('approvals.confidential.submitUnknown');
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberSaved');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled ?? true).toBe(true);
    });

    it('keeps an issued uncertain Remember distinct from both physical fill and a known save failure', async () => {
        rememberSucceeds = true; rememberOutcomeUnknown = true;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(writes.filter(path => path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'])).toHaveLength(1);
        expect(writes.filter(path => path === '/v2/account/settings')).toEqual([]);
        expect(screen.getTextContent()).toContain('approvals.confidential.filled');
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberUnknown');
        expect(screen.getTextContent()).not.toContain('approvals.confidential.rememberFailed');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled ?? true).toBe(true);
    });

    it('finishes the same private continuation and Remember across executing and executed approval lifecycle updates', async () => {
        rememberSucceeds = true;
        let releaseReply!: () => void;
        holdPrivateReply = new Promise<void>(resolve => { releaseReply = resolve; });
        try {
            const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
            const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
            await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
            await enterOnceValue(screen);
            await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
            await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
            await act(async () => {
                screen.findByTestId('approvals.secret-continue')?.props.onPress();
                await vi.waitFor(() => expect(deliveries).toHaveLength(1));
            });
            const artifact = storage.getState().artifacts['approval-1'];
            if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
            const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
            const executing = ApprovalRequestV2Schema.parse({ ...original, status: 'executing', updatedAtMs: 2,
                decision: { kind: 'approve', decidedAtMs: 2 } });
            await act(async () => { storage.getState().applyArtifacts([{ ...artifact, bodyVersion: 2, updatedAt: 2,
                header: buildApprovalRequestArtifactHeaderV1(executing), body: JSON.stringify(executing) }]); });
            const executed = ApprovalRequestV2Schema.parse({ ...executing, status: 'executed', updatedAtMs: 3,
                execution: { executedAtMs: 3, ok: true, result: { status: 'filled', code: 'filled' } } });
            await act(async () => { storage.getState().applyArtifacts([{ ...artifact, bodyVersion: 3, updatedAt: 3,
                header: buildApprovalRequestArtifactHeaderV1(executed), body: JSON.stringify(executed) }]); });
            expect(writes).toEqual([]);
            await act(async () => { releaseReply(); });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('approvals.confidential.rememberSaved'));
            expect(deliveries).toHaveLength(1);
            expect(writes.filter(path => path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'])).toHaveLength(1);
            expect(writes.filter(path => path === '/v2/account/settings')).toEqual([]);
            expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        } finally { releaseReply(); }
    });

    it('discards a draft credential when the reviewed target changes before approval', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        const artifact = storage.getState().artifacts['approval-1'];
        if (typeof artifact?.body !== 'string') throw new Error('missing_test_approval');
        const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
        const request = ApprovalRequestV2Schema.parse({ ...original, actionArgs: { ...BrowserAutomationSecretFillRequestV1Schema.parse(original.actionArgs), documentId: 'document-2' } });
        await act(async () => { storage.getState().applyArtifacts([{ ...artifact, bodyVersion: 2, updatedAt: 2,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]); });
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(true);
        expect(deliveries).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('discards an unsubmitted credential when the person withdraws the approval', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await screen.pressByTestIdAsync('approvals.cancel');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
        expect(deliveries).toEqual([]);
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
    });
});
