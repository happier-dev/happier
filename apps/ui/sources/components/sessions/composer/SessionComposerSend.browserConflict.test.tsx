import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V3 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/' }).module);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: { frame: { x: 0, y: 0, width: 0, height: 0 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({ ...createReactNavigationNativeMock(), useFocusEffect: () => {}, useIsFocused: () => true }));
// The native input and unrelated transcript are presentation boundaries. The mounted
// Session controller, draft repository, admission coordinator and submit owners are real.
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: { input?: React.ReactNode; content?: React.ReactNode; placeholder?: React.ReactNode }) =>
        React.createElement('AgentContentView', props, props.content, props.placeholder, props.input),
}));
vi.mock('@/components/sessions/shell/view/SessionPaneHeader', () => ({ SessionPaneHeader: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => null }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({ Deferred: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({ VoiceSurface: () => null }));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({ AttachmentFilePicker: () => null }));
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => React.createElement('AgentInput', props),
}));

const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const admitted = createDeferred<void>();
const submitted: Array<Readonly<{ localId: string; content: ReturnType<typeof SessionStoredMessageContentSchema.parse> }>> = [];
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => {
        const features = createRootLayoutFeaturesResponse();
        features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 };
        return features;
    },
    rpc: async () => { throw new RpcError('Daemon method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE); },
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const machine = createPlainMachineReadHttpResponseFixture(path, init, 'account-a');
        if (machine) return machine;
        if (path !== '/v2/sessions/s1/pending') return null;
        if ((init?.method ?? 'GET') === 'GET') return Response.json({ pending: [] });
        if (init?.method !== 'POST') throw new Error('Unexpected Pending write method');
        const body: unknown = JSON.parse(String(init.body));
        if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string'
            || !('content' in body) || !('requestedAction' in body)) throw new Error('Expected the real Pending submission envelope');
        const message = { localId: body.localId, content: SessionStoredMessageContentSchema.parse(body.content),
            requestedAction: PendingRequestedActionV1Schema.parse(body.requestedAction) };
        submitted.push(message);
        await admitted.promise;
        return Response.json({ localId: message.localId, requestedAction: message.requestedAction,
            pending: { ...message, messageRole: 'user', status: 'queued', createdAt: 1, updatedAt: 1, position: 1 } });
    },
});
const { storage } = await import('@/sync/domains/state/storage');
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { SessionView } = await import('../shell/SessionView');
const records = await import('@/sync/domains/state/browserRecordStorage');
const { createSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { createSessionDraftRepository, flushSessionDraftLocally, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');

describe('mounted ordinary composer Send with a browser draft conflict', () => {
    it('admits the current local message while preserving the other tab draft', async () => {
        const scope = runtime.accountScope;
        if (!scope) throw new Error('Expected the restored Account');
        const ref = { kind: 'session', sessionId: 's1' } as const;
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true,
            pendingVersion: 1, pendingCount: 0, agentState: { controlledByUser: true },
            metadata: { machineId: 'm1', host: 'test-home', flavor: 'codex', path: '/tmp', homeDir: '/tmp',
                version: MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } })]);
        storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now(),
            access: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }).access })], true, { sourceServerId: runtime.serverId });
        await publishMachineInventoryForTest(scope, [storage.getState().machines.m1!]);
        expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
            serverId: runtime.serverId, forceRefresh: true, hydrateMessages: false,
        })).kind).toBe('available');
        const screen = await renderScreen(<SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride />, { wrapper: runtime.Wrapper });
        const input = () => screen.tree.findAllByType('AgentInput' as React.ElementType).at(-1)!;
        const text = () => {
            const value = input().props.value;
            return typeof value === 'string' ? value : value.getPrompt();
        };
        try {
            await act(async () => { input().props.onChangeText('shared browser baseline'); });
            await flushSessionDraftLocally({ scope });
            const otherStorage = createSessionDraftPersistenceStorage({
                legacy: { getAllKeys: () => [], getString: () => undefined, delete: () => {} },
                records: { list: () => records.listBrowserRecords('session-drafts-repository-v1:'),
                    read: records.readBrowserRecord, updateMany: records.updateBrowserRecords },
            });
            await otherStorage.prepare();
            const otherTab = createSessionDraftRepository({ storage: otherStorage, syncEnabled: false, cipher: {
                seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
                open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
            } });
            otherTab.getSessionDraftSnapshot(scope, ref);
            otherTab.writeExistingSessionDraft({ scope, sessionId: 's1', patch: { text: 'other tab saved text' } });
            await otherTab.flushSessionDraftLocally({ scope });
            const unsaved = 'send this current local text';
            await act(async () => { input().props.onChangeText(unsaved); });
            await expect(flushSessionDraftLocally({ scope })).rejects.toThrow('This draft changed in another tab');
            expect(getSessionDraftSnapshot(scope, ref)?.status).toBe('error');
            expect(text()).toBe(unsaved);

            let send: Promise<unknown> | undefined;
            await act(async () => { send = input().props.onSend(); });
            await vi.waitFor(() => expect(submitted).toHaveLength(1));
            expect(submitted[0]).toMatchObject({ content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: unsaved } } } });
            expect(text()).toBe(unsaved);
            admitted.resolve();
            await act(async () => { await send; });
            await vi.waitFor(() => expect(text()).toBe(''));
            const saved = [...(await records.listBrowserRecords('session-drafts-repository-v1:')).values()];
            expect(saved.some(value => value.includes('other tab saved text'))).toBe(true);
        } finally {
            admitted.resolve();
            await screen.unmount();
        }
    });
});
