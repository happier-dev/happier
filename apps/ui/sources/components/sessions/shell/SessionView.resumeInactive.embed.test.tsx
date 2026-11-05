// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.happier.dev/embed/session/s1" }

import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, evaluateApiTokenGrantV1, type ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { buildEmbedParentGrantV1 } from '@happier-dev/protocol/embed';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { installBrowserStorageLockBoundary } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { readComposerText } from '@/dev/testkit/readComposerText';

// The immutable frame context is read by static fixture imports as well as the
// shell. Install its physical web platform before either graph is evaluated.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const modalState = vi.hoisted(() => ({ current: null as ReturnType<typeof createModalModuleMock> | null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(), useFocusEffect: () => {}, useIsFocused: () => true,
}));
installSessionShellCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }),
    modal: async () => {
        modalState.current = (await import('@/dev/testkit/mocks/modal')).createModalModuleMock();
        return modalState.current.module;
    },
});
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
// Physical presentation boundaries only; scoped hydration, draft and Actions stay real.
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: React.PropsWithChildren<{ input?: React.ReactNode }>) => React.createElement('AgentContentView', props, props.input),
}));
vi.mock('@/components/sessions/shell/view/SessionPaneHeader', () => ({ SessionPaneHeader: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => null }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({ Deferred: (props: React.PropsWithChildren) => props.children }));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({ VoiceSurface: () => null }));
vi.mock('@/voice/session/voiceSession', () => ({ useVoiceSessionSnapshot: () => ({ status: 'disconnected' }), voiceSessionManager: {} }));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Readonly<Record<string, unknown>>) => React.createElement('AgentInput', props),
}));

const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { sync } = await import('@/sync/sync');
const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
const actions: Array<{ path: string; body: unknown }> = [];
let refuseResume = false;
let reconnectRequired = false;
let revoked = false;
let admittedGrant: ApiTokenGrantV1 = API_TOKEN_FULL_GRANT_V1;
const endpointUrl = 'https://session-pane.test';
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/sync/http/client');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
const { resolveAdmittedEmbedServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const sourceSession = createSessionFixture({ id: 's1', serverId: endpointUrl,
    active: false, presence: 0, activeAt: 100, seq: 0,
    metadata: { flavor: 'codex', codexSessionId: 'private-native-context',
        machineId: 'private-machine', path: '/private/session', homeDir: '/private', host: 'test', version: '999.0.0' },
});
const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        if (path === '/v2/sessions/s1') return Response.json(createPlainSessionByIdResponseFixture(sourceSession));
        if (path === '/v1/sessions/s1/turns') return Response.json(buildSessionTurnsProjectionV1({ sessionId: 's1', updatedAt: 1, turns: [] }));
        if (path === '/v1/sessions/s1/messages') return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        if (path === '/v2/sessions/s1/pending') return Response.json({ pending: [] });
        if (init?.method !== 'POST' || !path.startsWith('/v1/actions/')) throw new Error(`Unexpected frame request: ${path}`);
        actions.push({ path, body: JSON.parse(String(init.body)) });
        const actionId = path.slice('/v1/actions/'.length);
        // The frame's unrelated discussion reader has no grant in this fixture.
        if (actionId === 'discussion.list') return Response.json({ v: 1, actionId,
            execution: { ok: false, errorCode: 'forbidden', error: 'forbidden' } });
        // HTTP/authentication is the system boundary; grant membership and target
        // admission use the same real evaluator as the server.
        if (revoked) {
            const error = projectExternalActionHttpError('invalid_token');
            return Response.json(error.payload, { status: error.statusCode });
        }
        if (!evaluateApiTokenGrantV1({ grant: admittedGrant, actionId,
            target: { kind: 'session', sessionId: 's1' } }).ok) {
            const error = projectExternalActionHttpError('credential_scope_denied');
            return Response.json(error.payload, { status: error.statusCode });
        }
        if (actionId === 'session.open') return Response.json({ v: 1, actionId, execution: reconnectRequired
            ? { ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', error: 'Private validation detail', details: {
                errorDetail: { kind: 'connected_service_ux_diagnostic', uxDiagnostic: {
                    code: 'connected_service_credential_reconnect_required', failurePhase: 'materialization',
                    source: 'spawn_resume', retryable: false, suggestedActions: ['reconnect_profile'],
                } },
            } }
            : refuseResume
            ? { ok: false, errorCode: 'vendor_resume_id_missing', error: 'Native context is unavailable' }
            : { ok: true, result: { status: 'opened', sessionId: 's1' } } });
        if (actionId === 'session.message.send') return Response.json({ v: 1, actionId, execution: {
            ok: true, result: { status: 'accepted', localId: 'frame-input' },
        } });
        throw new Error(`Unexpected frame Action: ${actionId}`);
};
const { SessionView } = await import('./SessionView');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { isEmbedWindowContext } = await import('@/embed/isEmbedWindowContext');
const restoreBrowserStorageLock = installBrowserStorageLockBoundary();
afterAll(restoreBrowserStorageLock);
const resumeAndSendActions = () => actions.filter(action => action.path === '/v1/actions/session.open'
    || action.path === '/v1/actions/session.message.send');

describe('inactive Session in the admitted frame realm', () => {
    let previous: ReturnType<typeof storage.getState>;
    beforeEach(async () => {
        previous = storage.getState();
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        setRuntimeFetch(request);
        actions.length = 0;
        refuseResume = false;
        reconnectRequired = false;
        revoked = false;
        modalState.current?.spies.alert.mockReset();
        storage.setState({ machines: {}, machineListByServerId: {} });
    });
    afterEach(() => { resetRuntimeFetch(); storage.setState(previous, true); });
    it.each(['allowed', 'refused', 'reconnect', 'send-only', 'view-only', 'resume-only', 'other-session', 'revoked'] as const)(
        'shows the inactive composer under Send and retains the draft on typed refusal (%s)', async controls => {
        expect(isEmbedWindowContext()).toBe(true);
        const encryption = await createEmbedEncryption();
        const credentials = { token: `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}` };
        const canSubmit = ['allowed', 'refused', 'reconnect', 'send-only', 'revoked'].includes(controls);
        const parentGrant = buildEmbedParentGrantV1({ send: controls !== 'view-only', approve: false,
            changeModel: false, models: null, permissionModes: null, sites: [], create: null }, {
            v: 1, ui: { attachments: false }, newChat: null,
            organization: { folderId: null, tagIds: [] }, style: null,
        });
        const grant: ApiTokenGrantV1 = { ...parentGrant,
            actions: { families: controls === 'resume-only' ? [] : parentGrant.actions!.families.filter(family => family !== 'session_targeting'),
                ids: controls === 'send-only' || controls === 'view-only' ? parentGrant.actions!.ids
                    : [...parentGrant.actions!.ids, 'session.open'] },
            targets: { sessions: [controls === 'other-session' ? 's2' : 's1'], machines: [] },
        };
        admittedGrant = grant;
        refuseResume = controls === 'refused';
        reconnectRequired = controls === 'reconnect';
        const refusalCode = controls === 'send-only' ? 'credential_scope_denied'
            : controls === 'revoked' ? 'invalid_token' : reconnectRequired ? 'SPAWN_VALIDATION_FAILED'
                : refuseResume ? 'vendor_resume_id_missing' : null;
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await sync.create(credentials, encryption.encryption, undefined, {
                scope: { kind: 'embedSession', sessionId: 's1' }, endpointUrl: 'https://session-pane.test',
                accountId: 'account-a', accountMode: 'plain', approvalGranted: false,
                composerOptionsInput: {}, composerOptionsGrant: grant, isCurrent: () => true,
            });
            expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)).toBeNull();
            const navigation = { push: vi.fn(), pushRetainingCurrent: vi.fn(), replace: vi.fn(), back: vi.fn() };
            const binding = resolveAdmittedEmbedServerCredentialAccountScope(endpointUrl);
            if (binding.kind !== 'bound' || !binding.lifetime) throw new Error('Frame admission has no current lifetime');
            const lifetime = binding.lifetime;
            const Wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>
                <SessionViewerSourceAccountScopeProvider accountLifetime={lifetime}>
                    <AppPaneProvider>{children}</AppPaneProvider>
                </SessionViewerSourceAccountScopeProvider>
            </InjectedAuthProvider>;
            screen = await renderScreen(<DestinationInstanceHost tabId="frame-session" ref={{ kind: 'session', params: { id: 's1' } }}
                pathname="/session/s1" focused visible navigation={navigation}>
                <SessionView id="s1" routeServerId="https://session-pane.test" presentation={{ kind: 'embedded', composer: 'auto', attachments: false, navigation: 'none' }} />
            </DestinationInstanceHost>, { wrapper: Wrapper });
            await flushHookEffects();
            const inputs = () => screen!.tree.findAllByType('AgentInput' as never);
            expect(inputs()).toHaveLength(canSubmit ? 1 : 0);
            if (!canSubmit) {
                expect(resumeAndSendActions()).toHaveLength(0);
                return;
            }
            // Send retains its composer independently of Open. Only a frame
            // credential granted Open may offer the status line's Resume.
            if (controls === 'send-only') expect(inputs()[0]!.props.connectionStatus?.action).toBeUndefined();
            else expect(inputs()[0]!.props.connectionStatus?.action).toMatchObject({
                label: 'session.pendingActivation.actions.resume', onPress: expect.any(Function),
            });
            expect(storage.getState().machines).toEqual({});
            await act(async () => { inputs()[0]!.props.onChangeText('Continue this conversation'); });
            expect(readComposerText(inputs()[0]!)).toBe('Continue this conversation');
            // Revocation can happen after the last admitted capability projection.
            revoked = controls === 'revoked';
            await act(async () => {
                if (reconnectRequired) await inputs()[0]!.props.connectionStatus.action.onPress();
                else inputs()[0]!.props.onSend();
            });
            await vi.waitFor(() => expect(resumeAndSendActions().map(action => action.path)).toEqual(refusalCode
                ? ['/v1/actions/session.open'] : ['/v1/actions/session.open', '/v1/actions/session.message.send']));
            await vi.waitFor(() => expect(inputs()[0]!.props.isSending).toBe(false));
            expect(resumeAndSendActions()[0]?.body).toMatchObject({ target: { kind: 'session', sessionId: 's1' }, input: { sessionId: 's1', intent: 'resume' } });
            expect(readComposerText(inputs()[0]!)).toBe(refusalCode ? 'Continue this conversation' : '');
            if (reconnectRequired) {
                const modal = modalState.current?.spies.alert.mock.calls.at(-1);
                expect(modal?.[0]).toBe('connectedServices.diagnostics.title.connected_service_credential_reconnect_required');
                expect(modal?.[1]).not.toContain('Private validation detail');
                const reconnect = modal?.[2]?.find(button => button.text === 'connectedServices.detail.actions.reconnect');
                expect(reconnect?.onPress).toBeTypeOf('function');
                await act(async () => { reconnect?.onPress?.(); });
                expect(navigation.push).toHaveBeenCalledWith('/(app)/settings/connected-services');
                expect(resumeAndSendActions()).toHaveLength(1);
            } else if (refusalCode) {
                const buttons = modalState.current?.spies.alert.mock.calls.at(-1)?.[2];
                expect(buttons?.[0]?.onPress).toBeTypeOf('function');
                await act(async () => { buttons?.[0]?.onPress?.(); });
                const details = modalState.current?.spies.alert.mock.calls.at(-1)?.[1];
                expect(JSON.parse(String(details))).toMatchObject({ code: refusalCode, phase: 'session.open' });
                expect(resumeAndSendActions()).toHaveLength(1);
            } else expect(modalState.current?.spies.alert).not.toHaveBeenCalled();
            expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)).toBeNull();
        } finally {
            await screen?.unmount();
            sync.disposeEmbedSession();
            encryption.dispose();
        }
    });
});
