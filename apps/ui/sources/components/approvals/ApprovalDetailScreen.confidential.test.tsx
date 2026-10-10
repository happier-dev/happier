import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateRequestSchema, AccountSettingsV2UpdateResponseSchema, ApprovalRequestV2Schema, CurrentCursorResponseSchema,
    FeaturesResponseSchema, SavedSecretResourceMaterialsResponseV1Schema, buildApprovalRequestArtifactHeaderV1,
} from '@happier-dev/protocol';
import { PrivateSecretContinuationV1Schema } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { ComputerSecretFillRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createSessionListRenderableSessionFixture, createTestSessionTranscriptSource, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { normalizeAccountSettingsForLocalStorage } from '@/sync/domains/settings/accountSettingsNormalization';
import { applyAccountSettingsSavedSecretMutation } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

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
let rememberedSettings: Readonly<Record<string, unknown>> | null = null;

async function enterOnceValue(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')?.props.editable).toBe(true));
    await act(async () => { screen.changeTextByTestId('approvals.secret-value', 'one-time-value'); });
}

async function continueChoice(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-continue')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('approvals.secret-continue');
    await vi.waitFor(() => expect(['filled', 'refused', 'unknown', 'canceled'].some(status =>
        screen.getTextContent().includes(`approvals.confidential.${status}`))).toBe(true));
}

installDisconnectedServerSocketBoundary(socket => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event, payload: unknown) => {
        if (!payload || typeof payload !== 'object') throw new Error('invalid_network_request');
        const method = Reflect.get(payload, 'method');
        if (method !== `machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`) throw new Error('unexpected_network_method');
        const continuation = PrivateSecretContinuationV1Schema.parse(Reflect.get(payload, 'params'));
        deliveries.push(JSON.parse(JSON.stringify(continuation)));
        await holdPrivateReply;
        if (uncertain) throw new Error('one-time-value network error must not be shown');
        if (refusal) return { ok: true, result: { status: 'refused', code: refusal } };
        if (submitUnknown) return { ok: true, result: { status: 'filled', code: 'filled', submit: { status: 'unknown', code: 'submit_unknown' } } };
        return { ok: true, result: { status: 'filled', code: 'filled' } };
    });
});

describe('confidential approval human continuation', () => {
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        deliveries = []; writes = []; uncertain = false; submitUnknown = false; refusal = null; rememberSucceeds = false; rememberOutcomeUnknown = false; rememberedSettings = null; holdPrivateReply = null;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://confidential-approval.example.test',
            serverIdentityId: 'srv_confidential-home', accountId: 'account-a', request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/plugins/availability/materializations/read' || path === '/v1/plugins/availability/intents/list' || path === '/v1/account/project-rows/list') return new Response('{}', { status: 503 });
                if (init?.method && init.method !== 'GET') {
                    writes.push(path);
                    if (rememberSucceeds && path === '/v2/account/settings') {
                        const update = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                        if (update.content?.t !== 'plain') throw new Error('expected_plain_settings');
                        rememberedSettings = update.content.v;
                        if (rememberOutcomeUnknown) throw new TypeError('Settings receipt was lost');
                        return Response.json({ success: true, version: 2 });
                    }
                    if (path === '/v2/account/settings') return Response.json(AccountSettingsV2UpdateResponseSchema.parse({
                        success: false, error: 'invalid', reason: 'tooLarge',
                    }), { status: 413 });
                    return new Response('{}', { status: 503 });
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/machines/machine-1') return Response.json({ machine: createMachineFixture({ storageMode: 'plain' }) });
                if (path === '/v1/artifacts/approval-1') {
                    const artifact = storage.getState().artifacts['approval-1'];
                    if (!artifact?.isDecrypted || typeof artifact.body !== 'string') return new Response('{}', { status: 404 });
                    return Response.json({ ...artifact, encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }) });
                }
                if (path === '/v2/account/settings' && rememberOutcomeUnknown && rememberedSettings) return new Response('{}', { status: 503 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                    content: { t: 'plain', v: rememberedSettings ?? { secrets: personal } }, version: rememberedSettings ? 2 : 1,
                }));
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }));
                return new Response('{}', { status: 404 });
            } });
        const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
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
        const model: InboxModel = {
            source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
                ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
            openApprovals: [artifact], friendRequests: [],
            sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [] },
            targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
            markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false,
            workGroups: [], spansHomes: false, workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
            automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttentionItems: [],
            markRead: async () => {}, resolveActionOperation: () => {}, settle: async () => {}, setReminder: async () => {},
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
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-source:saved')).toBeTruthy());
        await act(async () => { screen.pressByTestId('approvals.secret-source:saved'); });
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret:secret-1')).toBeTruthy());
        await act(async () => { screen.pressByTestId('saved-secret:secret-1'); });
        await continueChoice(screen);
        expect(deliveries).toEqual([expect.objectContaining({ choice: { kind: 'saved', ref: 'secret-1', fingerprint: 'personal:secret-1:1', revision: null } })]);
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

    it('keeps a failed explicit Remember separate from the completed physical fill', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(writes).toContain('/v2/account/settings');
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
        connection = await restoreServerAccountForTest({ serverUrl: 'https://confidential-approval.example.test',
            serverIdentityId: 'srv_confidential-home', accountId: 'account-a',
            credentials: { token, secret: Buffer.alloc(32, 9).toString('base64') }, request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/plugins/availability/materializations/read' || path === '/v1/plugins/availability/intents/list' || path === '/v1/account/project-rows/list') return new Response('{}', { status: 503 });
                if (init?.method && init.method !== 'GET') { writes.push(path); return new Response('{}', { status: 503 }); }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (path === '/v1/machines/machine-1') return Response.json({ machine: { ...createMachineFixture({ storageMode: 'plain' }), access } });
                return new Response('{}', { status: 404 });
            } });
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

    it('writes the Remember Saved Secret through the real captured Account settings CAS owner', async () => {
        rememberSucceeds = true;
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(connection!.home.id);
        try {
            const result = await account.mutateRawSettings(raw => ({ ...applyAccountSettingsSavedSecretMutation(raw,
                { kind: 'add', secret: { ...personal[0], id: 'writer-positive', name: 'Writer positive' } }).settings }));
            expect(result.status).toBe('applied');
            expect(writes.filter(path => path === '/v2/account/settings')).toHaveLength(1);
        } finally { account.dispose(); }
    });

    it('saves only an explicitly requested Remember through the mode-aware settings writer and reloads it', async () => {
        rememberSucceeds = true;
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        const screen = await renderScreen(<ApprovalDetailScreen artifactId="approval-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('approvals.secret-value')).toBeTruthy());
        await enterOnceValue(screen);
        await act(async () => { screen.findByTestId('approvals.secret-remember')?.props.onValueChange(true); });
        await act(async () => { screen.changeTextByTestId('approvals.secret-name', 'Remembered password'); });
        await continueChoice(screen);
        expect(deliveries).toHaveLength(1);
        expect(screen.getTextContent()).toContain('approvals.confidential.rememberSaved');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(connection!.home.id);
        try {
            const reloaded = await account.readRawSettings();
            expect(reloaded.secrets).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Remembered password',
                encryptedValue: expect.objectContaining({ value: 'one-time-value' }) })]));
        } finally { account.dispose(); }
        expect(storage.getState().artifacts['approval-1']?.body).not.toContain('one-time-value');
        expect(screen.findByTestId('approvals.secret-value')?.props.value ?? '').toBe('');
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
                    serverId: connection!.home.id, sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
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
        expect(writes.filter(path => path === '/v2/account/settings')).toHaveLength(1);
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
            expect(writes.filter(path => path === '/v2/account/settings')).toHaveLength(1);
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
