import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSessionRpcWithPreferredSessionScope } = vi.hoisted(() => ({
    mockSessionRpcWithPreferredSessionScope: vi.fn(),
}));

// The Session RPC transport is the only substituted boundary. The mounted
// controller, the React Native adapter and its subscription registry, the
// Session store, the awareness/pending-request/interaction owners and the
// permission-answer owner are all real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (...args: unknown[]) => mockSessionRpcWithPreferredSessionScope(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';

const initialStorageState = storage.getState();

const CURRENT_ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const canonicalSurface = createPluginSurfaceContextFixture({ target: { kind: 'app' } });

function mountSurface() {
    const controller = createBoundPluginSurfaceController({
        facts: {
            pluginId: 'acme.triage',
            contributionId: 'desk',
            surfaceId: 'surface_1',
            placement: 'appSurface',
            platform: 'ios',
            channel: 'internal',
            accountLifetime: CURRENT_ACCOUNT_LIFETIME,
            interactionEnabled: true,
            daemonInteractionEnabled: false,
        },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface,
        requestSurface: controller.surfaceContext,
        requestIdPrefix: 'rn-session',
        handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.hostApi.installedMethods,
    });
    const unsubscribe = controller.subscribeResourceInvalidations(
        (event) => { adapter.publishResourceSubscriptionEvent(event); },
    );
    return { controller, api: adapter.api, dispose: () => { unsubscribe(); adapter.dispose(); controller.dispose(); } };
}

// A live Session: awareness only reports what fresh runtime evidence supports.
const NOW = Date.now();

function waitingSession(overrides: Partial<Session> = {}): Session {
    return createSessionFixture({
        id: 'linked-1',
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
        activeAt: NOW,
        metadata: {
            path: '/work/repo',
            host: 'box.local',
            homeDir: '/home/me',
            machineId: 'machine-1',
            flavor: 'claude',
        } as Session['metadata'],
        agentState: {
            requests: {
                'req-1': {
                    tool: 'Bash',
                    arguments: { command: 'yarn test' },
                    createdAt: NOW - 1_000,
                    turnId: 'turn-1',
                },
            },
        } as Session['agentState'],
        ...overrides,
    });
}

describe('mounted plugin UI linked-Session state (r0.42)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
    });

    it('reads what a waiting Session wants to run, where, and which answers the viewer may give', async () => {
        storage.getState().applySessions([waitingSession()]);
        const mounted = mountSurface();

        const state = await mounted.api.readSession('linked-1');

        expect(state).toMatchObject({
            sessionId: 'linked-1',
            serverId: CURRENT_ACCOUNT_LIFETIME.scope.serverId,
            operational: 'permission_required',
            workStatus: { bucket: 'needs_you', tone: 'attention', word: expect.any(String) },
            workspace: { path: '/work/repo' },
            pendingPermissions: [{
                requestId: 'req-1',
                toolName: 'Bash',
                command: 'yarn test',
                createdAtMs: NOW - 1_000,
                answers: ['allowOnce', 'allowForSession', 'deny'],
            }],
        });
        mounted.dispose();
    });

    it('projects the shared Work classification, including outstanding reports and offline settlement', async () => {
        storage.getState().applySessions([
            waitingSession({ id: 'working', agentState: null, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress' }),
            waitingSession({ id: 'finished', agentState: null, latestTurnStatus: 'completed' }),
            waitingSession({ id: 'lead', agentState: null, latestTurnStatus: 'completed', reports: { total: 1, working: 1, needsYou: 0, stalled: 0 } }),
            waitingSession({ id: 'offline', agentState: null, active: false, activeAt: 1, presence: 1, latestTurnStatus: 'completed' }),
        ]);
        const mounted = mountSurface();

        await expect(mounted.api.readSession('working')).resolves.toMatchObject({
            workStatus: { bucket: 'working', tone: 'neutral', word: expect.any(String) },
        });
        await expect(mounted.api.readSession('finished')).resolves.toMatchObject({
            workStatus: { bucket: 'finished', tone: 'neutral' },
        });
        await expect(mounted.api.readSession('lead')).resolves.toMatchObject({
            workStatus: { bucket: 'idle', tone: 'neutral' },
        });
        await expect(mounted.api.readSession('offline')).resolves.toMatchObject({
            workStatus: { bucket: 'offline', tone: 'attention' },
        });
        mounted.dispose();
    });

    it('answers through the Session permission decision owner, attributed to the viewer', async () => {
        storage.getState().applySessions([waitingSession()]);
        const mounted = mountSurface();

        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'linked-1',
            requestId: 'req-1',
            answer: 'allowForSession',
        })).resolves.toEqual({ status: 'answered' });

        const call = mockSessionRpcWithPreferredSessionScope.mock.calls.at(-1)?.[0] as
            Readonly<{ sessionId: string; method: string; payload: Record<string, unknown> }>;
        expect(call.sessionId).toBe('linked-1');
        expect(call).toMatchObject({ serverId: 'server-1' });
        expect(call.method).toBe('session.permission.respond');
        expect(call.payload).toMatchObject({
            id: 'req-1',
            turnId: 'turn-1',
            approved: true,
            allowedTools: ['Bash'],
        });
        mounted.dispose();
    });

    it('refuses a Session the Account cannot reach, a request that is not pending, and an answer the viewer may not give', async () => {
        storage.getState().applySessions([
            waitingSession(),
            waitingSession({ id: 'view-only', canApprovePermissions: false, accessLevel: 'view' }),
        ]);
        const mounted = mountSurface();

        await expect(mounted.api.readSession('unknown-session')).resolves.toBeNull();
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'unknown-session',
            requestId: 'req-1',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'sessionUnavailable' });
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'linked-1',
            requestId: 'req-gone',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'requestNotPending' });

        const viewOnly = await mounted.api.readSession('view-only');
        expect(viewOnly?.pendingPermissions[0]?.answers).toEqual([]);
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'view-only',
            requestId: 'req-1',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'answerUnavailable' });

        expect(mockSessionRpcWithPreferredSessionScope).not.toHaveBeenCalled();
        mounted.dispose();
    });

    it('signals a watcher when the Session state changes, and stops after disposal', async () => {
        storage.getState().applySessions([waitingSession()]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];

        const subscription = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });
        // An unrelated Session changing is not this watch's news.
        storage.getState().applySessions([waitingSession({ id: 'other', agentState: null })]);
        expect(events).toHaveLength(0);

        storage.getState().applySessions([waitingSession({ agentState: null, updatedAt: NOW + 2 })]);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toMatchObject({ kind: 'invalidated' });
        await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({ pendingPermissions: [] });

        subscription.dispose();
        storage.getState().applySessions([waitingSession({ updatedAt: NOW + 3 })]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toHaveLength(1);
        mounted.dispose();
    });

    it('invalidates when outstanding reports change the Work presentation without changing awareness', async () => {
        storage.getState().applySessions([waitingSession({
            agentState: null, latestTurnStatus: 'completed',
            reports: { total: 1, working: 1, needsYou: 0, stalled: 0 },
        })]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];
        const subscription = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });

        storage.getState().applySessions([waitingSession({
            agentState: null, latestTurnStatus: 'completed', updatedAt: NOW + 2,
            reports: { total: 1, working: 0, needsYou: 0, stalled: 0 },
        })]);

        await vi.waitFor(() => expect(events).toHaveLength(1));
        await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({
            operational: 'ready', workStatus: { bucket: 'finished', tone: 'neutral' },
        });
        subscription.dispose();
        mounted.dispose();
    });

    it('refuses to watch a Session the Account cannot reach', async () => {
        const mounted = mountSurface();
        await expect(mounted.api.watchSession('unknown-session', () => undefined))
            .rejects.toMatchObject({ code: 'unavailable' });
        mounted.dispose();
    });
});
