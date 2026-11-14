import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { accountSettingsParse, StrictJsonValueSchema } from '@happier-dev/protocol';
import type { AgentState } from '@/api/types';
import { configuration } from '@/configuration';
import type { PermissionRequestPushSender } from '@/settings/notifications/permissionRequestPush';
import { logger } from '@/ui/logger';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { AgentStateRequestStore, isSameAgentStateRequestOccurrence, type PermissionResponseClaim } from './agentStateRequestStore';
import { PermissionRequestCoordinator } from './permissionRequestCoordinator';
import { AgentStateSchema } from '@happier-dev/session-core';
import { SessionFollowRuleSourceEvidenceV1Schema, type SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { captureSemanticSessionFollowRuleSourceEvidence } from '@/agent/runtime/session/follow/sessionFollowRuleSourceEvidence';
import { notificationSettingsSnapshotFixture } from '@/notifications/activity/activityNotification.testkit';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const localPermissionBridgeCoverageOptions = {
    equivalentSources: ['test_local_bridge'],
    equivalentCompletedStatuses: ['canceled'],
    equivalentCompletedReasons: ['Test bridge stopped'],
} satisfies AgentStateRequestCoverageOptions;
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions?.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions?.equivalentCompletedReasons?.[0] ?? '';

class FakeSession {
    sessionId = 'session-test';
    getMetadataSnapshot() { return { flavor: 'claude' }; }
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
        await this.updateAgentState(updater);
    }

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
    }
}

class AsyncFakeSession extends FakeSession {
    override updateAgentState(updater: (state: AgentState) => AgentState): Promise<void> {
        return Promise.resolve().then(() => {
            this.agentState = updater(this.agentState);
        });
    }
}

class FollowNotificationSession extends FakeSession {
    notifySessionFollowRuleRequestCommitted: () => Promise<SessionActivityChangedResult | null | void> = async () => {};
    captureSessionFollowRuleEvidence(event: FollowEventV1) {
        return captureSemanticSessionFollowRuleSourceEvidence({ serverId: 'home', ownerAccountId: 'alice', origin: { kind: 'none' }, event });
    }
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('AgentStateRequestStore', () => {
    it.each(['complete', 'record'] as const)('removes cleared response targets before strict JSON persistence (%s)', async method => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        const store = new AgentStateRequestStore({ logPrefix: '[Strict completion]', target: {
            scopeId: 'workflow-input', readState: () => state,
            updateState: updater => {
                const next = updater(state);
                StrictJsonValueSchema.parse(next);
                state = next;
            },
        } });
        try {
            await store.publishRequestAndWait({ requestId: 'permission', toolName: 'Bash', toolInput: {},
                createdAt: 1, responseTarget: { kind: 'native-permission' } });
            const completion = { requestId: 'permission', status: 'approved', decision: 'approved',
                extraCompletedFields: { responseTarget: undefined } };
            expect(await (method === 'complete' ? store.completeRequest(completion)
                : store.recordCompletedRequest({ ...completion, toolName: 'Bash', toolInput: {} }))).toBe(true);
            expect(state.requests).not.toHaveProperty('permission');
            expect(state.completedRequests?.permission).toMatchObject({ status: 'approved', decision: 'approved' });
            expect(state.completedRequests?.permission).not.toHaveProperty('responseTarget');
        } finally { store.dispose(); }
    });

    it('releases an obsolete native offer claim while preserving claims for the same occurrence', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Native reoffer]' });
        const nativeChoices = { requirementId: 'first-offer', source: 'native', choices: [{
            id: 'run', label: 'Run', decision: 'approved', scope: 'once', response: { approved: true },
        }] } as const;
        const publication = { requestId: 'native-reoffer', toolName: 'NativeTool', toolInput: {}, createdAt: 1, nativeChoices };
        const claim = { version: 1, origin: 'presentUser', actor: {
            kind: 'accountUser', accountId: 'owner', relationship: 'owner',
        }, decision: 'approved', scope: 'request', nativeChoice: { requirementId: 'first-offer', choiceId: 'run' } } as const;
        try {
            store.publishRequest(publication);
            await expect(store.acquirePermissionResponseClaim({ requestId: publication.requestId, claim })).resolves.toEqual({ status: 'acquired' });
            store.publishRequest(publication);
            await expect(store.rejoinPermissionResponseClaim({ requestId: publication.requestId, claim })).resolves.toEqual({ status: 'rejoined' });
            const malformed = { predecessor: 'opaque-answer' };
            session.agentState.requests![publication.requestId].permissionResponseClaimV1 = malformed;
            store.publishRequest(publication);
            await expect(store.acquirePermissionResponseClaim({ requestId: publication.requestId, claim })).resolves.toEqual({ status: 'conflict' });
            store.publishRequest({ ...publication, nativeChoices: { ...nativeChoices, requirementId: 'replacement-offer' } });
            await expect(store.acquirePermissionResponseClaim({ requestId: publication.requestId,
                claim: { ...claim, nativeChoice: { ...claim.nativeChoice, requirementId: 'replacement-offer' } },
            })).resolves.toEqual({ status: 'acquired' });
        } finally { store.dispose(); }
    });
    it.each(['pending', 'late_failure', 'completed', 'newer_request', 'canceled', 'cancel_rejected', 'scoped_cancel', 'disposed', 'replaced'] as const)(
        'reconciles an unacknowledged publication after reconnect: %s', async outcome => {
        let online = false;
        const connection: { listener?: (state: { phase: string }) => void; rejectFirst?: (error: Error) => void } = {};
        class OfflineSession extends FakeSession {
            override async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
                if (outcome === 'canceled') {
                    // The persistence boundary accepts a local retirement while
                    // ordinary network publication is unavailable.
                    this.agentState = updater(this.agentState);
                    return;
                }
                await super.updateAgentStateRequestSettlement(updater);
            }
            subscribeToSessionConnectionState(next: (state: { phase: string }) => void) {
                connection.listener = next;
                return () => { delete connection.listener; };
            }
            override updateAgentState(updater: (state: AgentState) => AgentState): Promise<void> {
                if (outcome === 'late_failure' && !connection.rejectFirst) {
                    return new Promise((_, reject) => { connection.rejectFirst = reject; });
                }
                if (!online) return Promise.reject(new Error('network offline'));
                super.updateAgentState(updater);
                return Promise.resolve();
            }
        }
        const session = new OfflineSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Offline publication]' });
        const request = { requestId: 'offline', toolName: 'Bash', toolInput: { command: 'pwd' }, createdAt: 10, turnId: 'turn-offline', source: 'selected', owner: { kind: 'plugin' as const, pluginId: 'selected' } };
        try {
            if (outcome === 'canceled') session.agentState.completedRequests!.offline = {
                tool: 'Bash', arguments: { command: 'previous' }, createdAt: 1, completedAt: 2, status: 'approved',
            };
            store.publishRequest(request);
            if (outcome === 'scoped_cancel') store.publishRequest({ ...request, requestId: 'neighbor', source: 'other', owner: { kind: 'plugin', pluginId: 'other' } });
            await new Promise(resolve => setImmediate(resolve));
            expect(session.agentState.requests?.offline).toBeUndefined();
            if (outcome === 'completed') session.agentState.completedRequests!.offline = {
                tool: request.toolName, arguments: request.toolInput, createdAt: 10, turnId: request.turnId, completedAt: 20, status: 'approved',
            };
            if (outcome === 'newer_request') session.agentState.requests!.offline = {
                tool: request.toolName, arguments: request.toolInput, createdAt: 30, turnId: 'newer-turn',
            };
            if (outcome === 'canceled' || outcome === 'scoped_cancel') {
                await store.cancelRequestsByOwner({ owner: request.owner, observedRetirement: true, reason: 'Dismissed', requestIds: [] }).catch(() => undefined);
            }
            if (outcome === 'cancel_rejected') await store.cancelRequestsBySource({ source: 'selected', reason: 'Before effect', requestIds: [] }).catch(() => undefined);
            if (outcome === 'disposed') store.dispose();
            if (outcome === 'replaced') store.updateSession(new FakeSession());
            online = true;
            connection.listener?.({ phase: 'online' });
            if (outcome === 'late_failure') connection.rejectFirst?.(new Error('late failed ACK'));
            await new Promise(resolve => setImmediate(resolve));
            if (outcome === 'pending' || outcome === 'late_failure' || outcome === 'cancel_rejected') {
                expect(session.agentState.requests?.offline).toMatchObject({ tool: 'Bash', createdAt: 10, turnId: request.turnId });
                const original = session.agentState.requests!.offline;
                store.publishRequest(request);
                await new Promise(resolve => setImmediate(resolve));
                expect(isSameAgentStateRequestOccurrence(original, session.agentState.requests!.offline)).toBe(true);
            } else if (outcome === 'newer_request') {
                expect(session.agentState.requests?.offline).toMatchObject({ createdAt: 30, turnId: 'newer-turn' });
            } else {
                expect(session.agentState.requests?.offline).toBeUndefined();
                if (outcome === 'completed') expect(session.agentState.completedRequests!.offline.status).toBe('approved');
                if (outcome === 'canceled') expect(session.agentState.completedRequests?.offline).toMatchObject({ status: 'canceled', turnId: request.turnId });
                if (outcome === 'scoped_cancel') expect(session.agentState.requests?.neighbor).toMatchObject({ source: 'other' });
            }
            expect(connection.listener).toBeUndefined();
        } finally { store.dispose(); }
    });
    it('joins source-admitted personal request policy at the original notifier before its only send', async () => {
        let admit!: (value: SessionActivityChangedResult) => void;
        class SourceSession extends FakeSession {
            captureSessionFollowRuleEvidence(event: FollowEventV1) {
                return captureSemanticSessionFollowRuleSourceEvidence({ serverId: 'home', ownerAccountId: 'alice', origin: { kind: 'none' }, event });
            }
            notifySessionFollowRuleRequestCommitted() { return new Promise<SessionActivityChangedResult>(resolve => { admit = resolve; }); }
        }
        const session = new SourceSession();
        const sendToAllDevicesAsync = vi.fn(async () => true); // Expo is the external delivery boundary.
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Joined personal request]',
            getAccountSettings: () => settings, getPushSender: () => ({ sendToAllDevicesAsync,
                readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async sessionId => {
                    const context = createSessionNotificationContextFixture(sessionId);
                    return { ...context, viewer: { ...context.viewer!, follow: { follows: true, notificationLevel: 'important' as const, policy: { preset: 'quiet' as const } } } };
                },
            }),
        });
        try {
            await store.publishRequestAndWait({ requestId: 'joined', turnId: 'turn-joined', toolName: 'AskUserQuestion', toolInput: {}, createdAt: Date.now() });
            await new Promise(resolve => setImmediate(resolve));
            expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
            admit({ personalFollow: { sourceSessionId: session.sessionId,
                requests: [{ requestId: 'joined', policies: [{ preset: 'important' }] }] } });
            await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
            expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
                expect.any(String), expect.any(String),
                expect.objectContaining({ requestId: 'joined', turnId: 'turn-joined', type: 'user_action_request' }),
                expect.any(Object),
            );
            expect(session.agentState.requests!.joined.pushNotifiedAt).toEqual(expect.any(Number));
            store.notifyPermissionRequestPushBestEffort({ permissionId: 'joined', toolName: 'AskUserQuestion', toolInput: {} });
            await new Promise(resolve => setImmediate(resolve));
            expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
        } finally { store.dispose(); }
    });
    it('keeps the original closed-app request alert when the source daemon is unavailable', async () => {
        const session = new FollowNotificationSession();
        session.notifySessionFollowRuleRequestCommitted = async () => { throw new Error('daemon unavailable'); };
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Unavailable daemon]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id) }),
        });
        try {
            await store.publishRequestAndWait({ requestId: 'fallback', turnId: 'turn-fallback', toolName: 'Write', toolInput: {}, createdAt: Date.now() });
            await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
            expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
                expect.any(String), expect.any(String),
                expect.objectContaining({ requestId: 'fallback', turnId: 'turn-fallback', type: 'permission_request' }),
                expect.any(Object),
            );
            expect(session.agentState.requests!.fallback.pushNotifiedAt).toEqual(expect.any(Number));
        } finally { store.dispose(); }
    });
    it('withdraws the native alert when its source owner explicitly rejects currentness', async () => {
        const session = new FollowNotificationSession();
        session.notifySessionFollowRuleRequestCommitted = async () => null;
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Retired source]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id) }),
        });
        try {
            await store.publishRequestAndWait({ requestId: 'retired', toolName: 'Write', toolInput: {}, createdAt: Date.now() });
            await new Promise(resolve => setImmediate(resolve));
            expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
            expect(session.agentState.requests!.retired.pushNotifiedAt).toBeUndefined();
        } finally { store.dispose(); }
    });
    it('withdraws a pending policy contribution when the handler changes and admits the later pass-up', async () => {
        const session = new FollowNotificationSession();
        const admissions: Array<(result: SessionActivityChangedResult) => void> = [];
        session.notifySessionFollowRuleRequestCommitted = () => new Promise(resolve => { admissions.push(resolve); });
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Handler admission]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id) }),
        });
        const createdAt = Date.now();
        try {
            await store.publishRequestAndWait({ requestId: 'passing', toolName: 'AskUserQuestion', toolInput: {}, createdAt,
                questionV1: { mode: 'wait', type: 'decision', lasting: false }, currentHandler: { kind: 'person' } });
            await store.changeQuestionHandler({ requestId: 'passing', expectedCreatedAt: createdAt,
                expectedHandler: { kind: 'person' }, currentHandler: { kind: 'session', sessionId: 'manager' } });
            admissions[0]({ personalFollow: { sourceSessionId: session.sessionId,
                requests: [{ requestId: 'passing', policies: [{ preset: 'important' }] }] } });
            await new Promise(resolve => setImmediate(resolve));
            expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
            expect(session.agentState.requests!.passing.pushNotifiedAt).toBeUndefined();
            expect(admissions).toHaveLength(2);
            admissions[1]({}); // The Session-handler transition publishes its source occurrence, never a person push.
            await store.changeQuestionHandler({ requestId: 'passing', expectedCreatedAt: createdAt,
                expectedHandler: { kind: 'session', sessionId: 'manager' }, currentHandler: { kind: 'person' } });
            expect(admissions).toHaveLength(3);
            admissions[2]({ personalFollow: { sourceSessionId: session.sessionId,
                requests: [{ requestId: 'passing', policies: [{ preset: 'important' }] }] } });
            await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
        } finally { store.dispose(); }
    });
    it('retains accepted request notification custody when the original request rejoins another notifier', async () => {
        const session = new FakeSession();
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const settings = notificationSettingsSnapshotFixture({});
        const params = { session, logPrefix: '[Rejoined notifier]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async (id: string) => createSessionNotificationContextFixture(id) }) };
        const publication = { requestId: 'rejoined', toolName: 'Write', toolInput: {}, createdAt: Date.now() };
        const first = new AgentStateRequestStore(params);
        await first.publishRequestAndWait(publication);
        await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
        const acceptedAt = session.agentState.requests!.rejoined.pushNotifiedAt;
        first.dispose();
        const rejoined = new AgentStateRequestStore(params);
        try {
            await rejoined.publishRequestAndWait(publication);
            expect(session.agentState.requests!.rejoined.pushNotifiedAt).toBe(acceptedAt);
            await new Promise(resolve => setImmediate(resolve));
            expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
        } finally { rejoined.dispose(); }
    });
    it('keeps a reused request retry live after the previous turn receives a late push acknowledgement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
        const session = new FakeSession();
        let acknowledgeFirst!: (delivered: boolean) => void;
        // External push delivery can acknowledge an earlier request after a replacement has failed.
        const sendToAllDevicesAsync = vi.fn<PermissionRequestPushSender['sendToAllDevicesAsync']>()
            .mockImplementationOnce(() => new Promise<boolean>(resolve => { acknowledgeFirst = resolve; }))
            .mockResolvedValueOnce(false).mockResolvedValue(true);
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Late push acknowledgement]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id) }),
        });
        const publication = { requestId: 'reused', toolName: 'Write', toolInput: {}, createdAt: Date.now() };
        try {
            await store.publishRequestAndWait({ ...publication, turnId: 'turn-a' });
            await vi.advanceTimersByTimeAsync(0);
            expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
            expect(await store.completeRequest({ requestId: 'reused', status: 'approved' })).toBe(true);
            await store.publishRequestAndWait({ ...publication, turnId: 'turn-b' });
            await vi.advanceTimersByTimeAsync(0);
            expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
            acknowledgeFirst(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(session.agentState.requests!.reused).toMatchObject({ turnId: 'turn-b' });
            expect(session.agentState.requests!.reused.pushNotifiedAt).toBeUndefined();
            await vi.advanceTimersByTimeAsync(configuration.permissionRequestPushRetryDelaysMs[0]!);
            expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(3);
            expect(sendToAllDevicesAsync.mock.calls[2]?.[2]).toMatchObject({ requestId: 'reused', turnId: 'turn-b' });
            expect(session.agentState.requests!.reused.pushNotifiedAt).toEqual(expect.any(Number));
        } finally { store.dispose(); vi.useRealTimers(); }
    });
    it('does not stamp a replacement request when an earlier push marker reaches the state writer late', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
        let deferWrites = false;
        let applyNotificationWrite: (() => void) | undefined;
        class DeferredNotificationSession extends FakeSession {
            override updateAgentState(updater: (state: AgentState) => AgentState) {
                if (!deferWrites) return super.updateAgentState(updater);
                // Model the real Session client's queued asynchronous persistence boundary.
                return new Promise<void>(resolve => {
                    applyNotificationWrite = () => { this.agentState = updater(this.agentState); resolve(); };
                });
            }
        }
        const session = new DeferredNotificationSession();
        const acknowledgements: Array<(delivered: boolean) => void> = [];
        const sendToAllDevicesAsync = vi.fn<PermissionRequestPushSender['sendToAllDevicesAsync']>(
            () => new Promise<boolean>(resolve => { acknowledgements.push(resolve); }));
        const settings = notificationSettingsSnapshotFixture({});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Late push marker]', getAccountSettings: () => settings,
            getPushSender: () => ({ sendToAllDevicesAsync, readAccountSessionDeliveryMutedScopes: async () => [],
                fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id) }),
        });
        const publication = { requestId: 'reused', toolName: 'Write', toolInput: {}, createdAt: Date.now() };
        try {
            await store.publishRequestAndWait({ ...publication, turnId: 'turn-a' });
            await vi.advanceTimersByTimeAsync(0);
            expect(acknowledgements).toHaveLength(1);
            deferWrites = true;
            acknowledgements[0]!(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(applyNotificationWrite).toEqual(expect.any(Function));
            deferWrites = false;
            expect(await store.completeRequest({ requestId: 'reused', status: 'approved' })).toBe(true);
            await store.publishRequestAndWait({ ...publication, turnId: 'turn-b' });
            await vi.advanceTimersByTimeAsync(0);
            expect(acknowledgements).toHaveLength(2);
            applyNotificationWrite!();
            await vi.advanceTimersByTimeAsync(0);
            expect(session.agentState.requests!.reused).toMatchObject({ turnId: 'turn-b' });
            expect(session.agentState.requests!.reused.pushNotifiedAt).toBeUndefined();
            acknowledgements[1]!(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(session.agentState.requests!.reused.pushNotifiedAt).toEqual(expect.any(Number));
        } finally { store.dispose(); vi.useRealTimers(); }
    });
    it('preserves a completed mirrored request even when it appears before the persistence updater runs', async () => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        let apply!: () => void;
        let accept!: () => void;
        const notifyRequest = vi.fn(); // The push transport is a system boundary.
        const store = new AgentStateRequestStore({ logPrefix: '[Deferred ACP mirror]', target: {
            scopeId: 'deferred-mirror', readState: () => state, notifyRequest,
            updateState: updater => new Promise<void>(resolve => {
                apply = () => { state = updater(state); };
                accept = resolve;
            }),
        } });
        store.publishMirroredRequest({ requestId: 'permission', toolName: 'write', toolInput: {}, createdAt: 11 });
        const completed = { tool: 'write', arguments: {}, createdAt: 7, completedAt: 8, status: 'approved' as const };
        state = { requests: {}, completedRequests: { permission: completed } };
        apply();
        accept();
        await flushMicrotasks();
        expect(state).toEqual({ requests: {}, completedRequests: { permission: completed } });
        expect(notifyRequest).not.toHaveBeenCalled();
        store.dispose();
    });

    it('does not notify a withdrawn question after its delayed publication acknowledgement', async () => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        let acceptPublication!: () => void;
        const notifyRequest = vi.fn(); // Notification transport is the external boundary.
        const store = new AgentStateRequestStore({ logPrefix: '[Late question]', target: {
            scopeId: 'late-question', readState: () => state, notifyRequest,
            updateState: updater => {
                state = updater(state);
                if (!acceptPublication) return new Promise<void>(resolve => { acceptPublication = resolve; });
                return undefined;
            },
        } });
        const publication = store.publishRequestAndWait({ requestId: 'question', toolName: 'AskUserQuestion',
            toolInput: {}, createdAt: 1, kind: 'user_action' });
        expect(notifyRequest).not.toHaveBeenCalled();
        await store.cancelAllRequests({ reason: 'Explicit person Stop', requestIds: [] });
        acceptPublication();
        await publication;
        expect(state.requests).toEqual({});
        expect(state.completedRequests?.question).toMatchObject({ status: 'canceled', reason: 'Explicit person Stop' });
        expect(notifyRequest).not.toHaveBeenCalled();
        store.dispose();
    });

    it('retains rule evidence on the original question and notifies only its committed live occurrence', async () => {
        let accept!: () => void;
        const committed: Array<Readonly<{ requestId: string; createdAt: number; turnId?: string; evidence: SessionFollowRuleSourceEvidenceV1 }>> = [];
        class SourceSession extends FakeSession {
            captureSessionFollowRuleEvidence(event: FollowEventV1) {
                return captureSemanticSessionFollowRuleSourceEvidence({ serverId: 'home', ownerAccountId: 'alice',
                    origin: { kind: 'none' }, event });
            }
            notifySessionFollowRuleRequestCommitted(occurrence: (typeof committed)[number]) { committed.push(occurrence); }
            override updateAgentState(updater: (state: AgentState) => AgentState): Promise<void> {
                const snapshot = structuredClone(updater(this.agentState));
                const durable = AgentStateSchema.parse(JSON.parse(JSON.stringify(snapshot)));
                // The stored reader is deliberately broader than the live CLI
                // state. Prove this produced state survives it without a cast.
                expect(durable.requests).toEqual(snapshot.requests);
                expect(durable.completedRequests).toEqual(snapshot.completedRequests);
                this.agentState = snapshot;
                return new Promise(resolve => { accept = resolve; });
            }
        }
        const session = new SourceSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Rule request]' });
        const publication = { requestId: 'question', toolName: 'AskUserQuestion', toolInput: {}, createdAt: 7,
            turnId: 'turn', kind: 'user_action', questionV1: { mode: 'continue', type: 'blocked', assumption: 'Continue on the current revision', lasting: false },
            currentHandler: { kind: 'session', sessionId: 'manager' } } as const;
        const pending = store.publishRequestAndWait(publication);
        expect(committed).toEqual([]);
        expect(session.agentState.requests?.question).toMatchObject({ happierFollowRuleEvidenceV1: {
            event: { kind: 'needs_you', type: 'blocked', mode: 'continue', handling: 'manager' },
        } });
        accept();
        await pending;
        expect(committed).toEqual([{ requestId: 'question', createdAt: 7, turnId: 'turn',
            evidence: session.agentState.requests!.question.happierFollowRuleEvidenceV1 }]);
        const replay = store.publishRequestAndWait(publication);
        accept();
        await replay;
        expect(session.agentState.requests!.question.happierFollowRuleEvidenceV1).toEqual(committed[0].evidence);
        const withdrawn = store.publishRequestAndWait({ ...publication, requestId: 'withdrawn' });
        delete session.agentState.requests!.withdrawn;
        accept();
        await withdrawn;
        expect(committed.map(occurrence => occurrence.requestId)).toEqual(['question', 'question']);
        store.dispose();
    });
    it.each([
        { questionV1: { mode: 'continue', lasting: false } },
        { currentHandler: { kind: 'session', sessionId: '' } },
    ])('refuses malformed stored question metadata instead of reopening it as a legacy wait question', (metadata) => {
        const session = new FakeSession();
        // Raw persisted bytes are the boundary under test, before the SessionCore schema is applied.
        Object.assign(session.agentState.requests!, { malformed: { tool: 'AskUserQuestion', kind: 'user_action',
            arguments: {}, createdAt: 1, ...metadata } });
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        expect(() => store.readOutstandingRequest('malformed')).toThrow('invalid_question_metadata');
        const owner = new PermissionRequestCoordinator<string>({ store });
        expect(() => owner.requestDecision({ requestId: 'malformed', toolName: 'AskUserQuestion', toolInput: {}, createdAt: 1 }))
            .toThrow('invalid_question_metadata');
        store.dispose();
    });
    it('withdraws questions on archived Session rehydrate before rejoin or response delivery', async () => {
        class ArchivedSession extends FakeSession {
            getArchivedAtSnapshot() { return 42; }
        }
        const session = new ArchivedSession();
        session.agentState.requests!.question = { tool: 'AskUserQuestion', kind: 'user_action',
            arguments: { questions: [{ question: 'Continue?' }] }, createdAt: 1 };
        session.agentState.completedRequests!.answered = { tool: 'AskUserQuestion', kind: 'user_action',
            arguments: {}, createdAt: 1, completedAt: 2, status: 'approved', decision: 'approved',
            responseTarget: { kind: 'test_target' } };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Archive]' });
        const delivered = vi.fn(); // Native response delivery is the process boundary.
        store.registerResponseTargetHandler('test_target', delivered);
        expect(store.readOutstandingRequest('question')).toBeNull();
        await vi.waitFor(() => expect(session.agentState.completedRequests!.question)
            .toMatchObject({ status: 'canceled', reason: 'Session archived' }));
        expect(session.agentState.requests!.question).toBeUndefined();
        expect(delivered).not.toHaveBeenCalled();
        await expect(store.publishRequestAndWait({ requestId: 'new-question', toolName: 'AskUserQuestion',
            toolInput: {}, createdAt: 3 })).rejects.toThrow('session_archived');
        store.dispose();
    });

    it('refuses a live question application immediately after archive, before withdrawal is flushed', async () => {
        class ArchivingSession extends FakeSession {
            archivedAt: number | null = null;
            getArchivedAtSnapshot() { return this.archivedAt; }
        }
        const session = new ArchivingSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Archive application]' });
        const owner = new PermissionRequestCoordinator<string>({ store });
        const pending = owner.requestDecision({ requestId: 'live-question', toolName: 'AskUserQuestion',
            toolInput: {}, createdAt: 1 }).catch(() => null);
        const context = owner.getResponseContext('live-question')!;
        // The raw archive fact is already authoritative even when its
        // asynchronous withdrawal has not yet reached AgentState.
        session.archivedAt = 42;
        const acknowledge = vi.fn(async () => undefined); // Native application is a process boundary.
        await expect(owner.completeResponse({ context, completion: { result: 'answer',
            completedRequest: { status: 'approved', decision: 'approved' } },
            acknowledgeDecisionApplication: acknowledge })).resolves.toBe(false);
        expect(acknowledge).not.toHaveBeenCalled();
        // Store-only/orphan completion must obey the same archive fact.
        await expect(store.completeRequest({ requestId: 'live-question', status: 'approved', decision: 'approved' }))
            .resolves.toBe(false);
        expect(session.agentState.requests?.['live-question']).toBeDefined();
        await store.reconcileSessionArchive();
        await owner.cancelAll('Session archived');
        await pending;
        expect(session.agentState.completedRequests?.['live-question'])
            .toMatchObject({ status: 'canceled', reason: 'Session archived' });
        store.dispose();
    });

    it('rejoins a manager-handled question without changing its handler and passes up the same request once', async () => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        const notifyRequest = vi.fn();
        const store = new AgentStateRequestStore({ target: {
            scopeId: 'question-session', readState: () => state,
            updateState: updater => {
                // This persistence boundary stores the real producer's JSON bytes.
                state = JSON.parse(JSON.stringify(updater(state))) as AgentState;
            },
            notifyRequest,
        }, logPrefix: '[Test]' });
        const questionV1 = { mode: 'continue', assumption: 'Use revision 3', lasting: false } as const;
        const manager = { kind: 'session', sessionId: 'manager' } as const;
        const request = { requestId: 'question', toolName: 'AskUserQuestion', kind: 'user_action',
            toolInput: { questions: [{ question: 'Which revision?' }] }, createdAt: 100,
            lifetime: 'occurrence', questionV1, currentHandler: manager } as const;
        const first = new PermissionRequestCoordinator<string>({ store });
        void first.requestDecision(request);
        expect(notifyRequest).not.toHaveBeenCalled();
        const rejoined = new PermissionRequestCoordinator<string>({ store });
        const answer = rejoined.requestDecision({ ...request, currentHandler: { kind: 'person' } });
        expect(rejoined.getResponseContext('question')).toMatchObject({ questionV1, currentHandler: manager, createdAt: 100 });
        store.publishRequest({ ...request, currentHandler: { kind: 'person' } });
        store.publishRequest({ requestId: request.requestId, toolName: request.toolName,
            toolInput: request.toolInput, createdAt: request.createdAt, kind: request.kind });
        expect(store.readOutstandingRequest('question')).toMatchObject({ questionV1, currentHandler: manager });
        expect(notifyRequest).not.toHaveBeenCalled();
        const nextManager = { kind: 'session', sessionId: 'next-manager' } as const;
        await expect(rejoined.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100, expectedHandler: manager,
            currentHandler: nextManager })).resolves.toBe(true);
        expect(notifyRequest).not.toHaveBeenCalled();
        await expect(rejoined.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100, expectedHandler: manager,
            currentHandler: { kind: 'person' } })).resolves.toBe(false);
        await expect(rejoined.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100, expectedHandler: nextManager,
            currentHandler: { kind: 'person' } })).resolves.toBe(true);
        await expect(rejoined.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100, expectedHandler: nextManager,
            currentHandler: { kind: 'person' } })).resolves.toBe(false);
        expect(notifyRequest).toHaveBeenCalledTimes(1);
        expect(state.requests?.question).toMatchObject({ createdAt: 100, questionV1, currentHandler: { kind: 'person' } });
        expect(isSameAgentStateRequestOccurrence({ ...state.requests?.question, currentHandler: manager }, state.requests?.question)).toBe(true);
        expect(state.completedRequests).toEqual({});
        await rejoined.handleResponse({ requestId: 'question', buildCompletion: () => ({
            result: 'revision-3', completedRequest: { status: 'approved', answeredBy: manager,
                structuredAnswersV1: { 'Which revision?': ['revision-3'] } },
        }) });
        await expect(answer).resolves.toBe('revision-3');
        expect(state.completedRequests?.question).toMatchObject({ questionV1, currentHandler: { kind: 'person' }, answeredBy: manager,
            structuredAnswersV1: { 'Which revision?': ['revision-3'] } });
        expect(AgentStateSchema.parse(state).completedRequests?.question).toMatchObject({ questionV1, answeredBy: manager });
        await expect(rejoined.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100, expectedHandler: { kind: 'person' },
            currentHandler: manager })).resolves.toBe(false);
        store.dispose();
    });
    it('withdraws nothing and writes nothing when a Stop finds no request to cancel', async () => {
        // Every person Stop and "Send now" interrupt awaits this withdrawal before the
        // abort answers; with nothing pending it must not queue an Agent-state write.
        let writes = 0;
        let state: AgentState = { requests: {}, completedRequests: { answered: {
            tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved' } } };
        const store = new AgentStateRequestStore({ logPrefix: '[Stop]', target: {
            scopeId: 'stop-session', readState: () => state,
            updateState: updater => { writes += 1; state = updater(state); },
        } });
        const results = [];
        for (const scope of ['foreground', undefined] as const) {
            results.push(await store.cancelAllRequests({
                ...(scope ? { scope } : {}), reason: 'Foreground turn stopped', decision: 'abort', requestIds: [],
            }));
        }
        expect({ writes, results }).toEqual({ writes: 0, results: [[], []] });
        store.dispose();
    });

    it('returns only cancellation subjects from the committed CAS attempt', async () => {
        class RetriedSession extends FakeSession {
            override updateAgentState(updater: (state: AgentState) => AgentState) {
                // The transport discards the first candidate after a version conflict.
                updater({ requests: { discarded: { tool: 'Bash', arguments: {}, createdAt: 1 } } });
                this.agentState = updater({ requests: { committed: { tool: 'Bash', arguments: {}, createdAt: 2 } } });
            }
        }
        const session = new RetriedSession();
        // The local view still holds the request the conflicting attempt discards.
        session.agentState = { requests: { discarded: { tool: 'Bash', arguments: {}, createdAt: 1 } }, completedRequests: {} };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });

        const canceled = await store.cancelAllRequests({ reason: 'Session ended', requestIds: [] });

        expect(canceled).toEqual([
            { requestId: 'committed', completedRequest: expect.objectContaining({ createdAt: 2, status: 'canceled' }) },
        ]);
        expect(session.agentState.requests).toEqual({});
        expect(session.agentState.completedRequests).not.toHaveProperty('discarded');
        store.dispose();
    });

    it('does not report or notify a question pass-up discarded by a terminal-state CAS retry', async () => {
        const manager = { kind: 'session', sessionId: 'manager' } as const;
        const pending = { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1,
            questionV1: { mode: 'wait', lasting: false }, currentHandler: manager } as const;
        const completed = { ...pending, status: 'approved', completedAt: 2 } as const;
        let state: AgentState = { requests: { question: pending }, completedRequests: {} };
        const notifyRequest = vi.fn();
        const store = new AgentStateRequestStore({ target: {
            scopeId: 'question-session', readState: () => state, notifyRequest,
            updateState: updater => {
                updater(state);
                state = updater({ requests: {}, completedRequests: { question: completed } });
            },
        }, logPrefix: '[Test]' });
        await expect(store.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 1, expectedHandler: manager,
            currentHandler: { kind: 'person' } })).resolves.toBe(false);
        expect(state.requests).toEqual({});
        expect(state.completedRequests?.question).toEqual(completed);
        expect(notifyRequest).not.toHaveBeenCalled();
        store.dispose();
    });

    it('cannot pass up a replacement question that reused the request id and handler', async () => {
        const session = new FakeSession();
        const manager = { kind: 'session', sessionId: 'manager' } as const;
        session.agentState.requests!.question = { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 200,
            questionV1: { mode: 'wait', lasting: true }, currentHandler: manager };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        await expect(store.changeQuestionHandler({ requestId: 'question', expectedCreatedAt: 100,
            expectedHandler: manager, currentHandler: { kind: 'person' } })).resolves.toBe(false);
        expect(store.readOutstandingRequest('question')).toMatchObject({ createdAt: 200, currentHandler: manager });
        store.dispose();
    });

    it.each<PermissionResponseClaim>([
        { version: 1, origin: 'automaticPolicy' },
        { version: 1, origin: 'approvalReviewer', turnId: 'turn-1', decision: 'approved', scope: 'request' },
        { version: 1, origin: 'presentUser', turnId: 'turn-1', actor: { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' }, decision: 'approved', scope: 'request' },
        { version: 1, origin: 'remoteMediation', turnId: 'turn-1', actor: { kind: 'externalHuman', assurance: 'pluginAsserted', namespace: 'discord', principalId: 'person-1', assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' } }, mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42', idempotencyKey: 'retry-1', decision: 'allow', scope: 'request' },
    ])('rejoins and releases the retained $origin claim without granting meaning to extra fields', async (claim) => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        store.publishRequest({ requestId: 'retained', toolName: 'Bash', toolInput: {}, createdAt: 1 });
        const retained = { ...claim, retired: true, ...('actor' in claim ? { actor: { ...claim.actor, retired: true, ...('assertedBy' in claim.actor ? { assertedBy: { ...claim.actor.assertedBy, retired: true } } : {}) } } : {}) };
        session.agentState.requests!['retained'].permissionResponseClaimV1 = retained;
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'rejoined' });
        await expect(store.rejoinPermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'rejoined' });
        const freshWithExtra = { ...claim, retired: true };
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim: freshWithExtra })).rejects.toThrow();
        const mismatch = claim.origin === 'remoteMediation'
            ? { ...retained, mediatorPluginId: 'another.plugin' }
            : claim.origin === 'presentUser'
                ? { ...retained, actor: { ...claim.actor, accountId: 'another-account' } }
                : claim.origin === 'approvalReviewer'
                    ? { ...retained, scope: 'session' }
                    : { ...retained, origin: 'retiredOrigin' };
        session.agentState.requests!['retained'].permissionResponseClaimV1 = mismatch;
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'conflict' });
        session.agentState.requests!['retained'].permissionResponseClaimV1 = retained;
        await store.releasePermissionResponseClaim({ requestId: 'retained', claim });
        expect(session.agentState.requests!['retained']).not.toHaveProperty('permissionResponseClaimV1');
    });

    it('reads retained completed actors but refuses a different known actor identity', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const actor = { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' } as const;
        const claim = { version: 1, origin: 'presentUser', actor, decision: 'approved', scope: 'request' } as const;
        session.agentState.completedRequests!.retained = { tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved', decision: 'approved', permissionDecisionActorV1: { ...actor, retired: true } };
        expect(store.readCompletedPermissionResponseClaim({ requestId: 'retained', claim })).toEqual({ status: 'rejoined' });
        expect(store.readCompletedPermissionResponseClaim({ requestId: 'retained', claim: { ...claim, actor: { ...actor, accountId: 'another-account' } } })).toEqual({ status: 'conflict' });
    });

    it('projects persisted request owner authority during reload and plugin cancellation', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const sourceAuthority = { kind: 'mediatedExternal', mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42', admittedPermissionCeiling: 'default', remoteApprovalMaxScope: 'session' } as const;
        const retained = { tool: 'Bash', arguments: {}, createdAt: 1, owner: { kind: 'plugin', pluginId: 'provider.codex', sourceAuthority: { ...sourceAuthority, retired: true } } };
        session.agentState.requests!.retained = retained;
        expect(store.readOutstandingRequest('retained')?.owner).toEqual({ kind: 'plugin', pluginId: 'provider.codex', sourceAuthority });
        await store.cancelRequestsByOwner({ owner: { kind: 'plugin', pluginId: 'provider.codex' }, reason: 'Plugin stopped', requestIds: ['retained'] });
        expect(session.agentState.requests!.retained).toBeUndefined();
        expect(session.agentState.completedRequests!.retained?.status).toBe('canceled');
    });

    it('surfaces durable publication failure to an interaction producer', async () => {
        const persistenceError = new Error('workflow interaction exceeds durable content capacity');
        const store = new AgentStateRequestStore({
            target: {
                scopeId: 'workflow-invocation:capacity-failure',
                readState: () => ({ requests: Object.create(null), completedRequests: Object.create(null) }),
                updateState: async () => {
                    throw persistenceError;
                },
            },
            logPrefix: '[WorkflowTest]',
        });

        await expect(store.publishRequestAndWait({
            requestId: 'req-too-large',
            toolName: 'Bash',
            toolInput: { command: 'large command' },
            createdAt: 123,
        })).rejects.toBe(persistenceError);
    });

    it('persists and notifies through a non-Session request-state target', async () => {
        let state: AgentState = {
            requests: Object.create(null),
            completedRequests: Object.create(null),
        };
        const notifyRequest = vi.fn();
        const markRequestCompleted = vi.fn();
        const store = new AgentStateRequestStore({
            target: {
                scopeId: 'workflow-invocation:test',
                readState: () => state,
                updateState: (updater) => {
                    state = updater(state);
                },
                notifyRequest,
                markRequestCompleted,
            },
            logPrefix: '[WorkflowTest]',
        });

        store.publishRequest({
            requestId: 'req-run-1',
            toolName: 'Bash',
            toolInput: { command: 'git status' },
            createdAt: 123,
        });
        expect(state.requests?.['req-run-1']).toEqual(expect.objectContaining({ tool: 'Bash' }));
        expect(notifyRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-run-1' }));

        await store.completeRequest({ requestId: 'req-run-1', status: 'approved', decision: 'approved' });
        expect(state.requests?.['req-run-1']).toBeUndefined();
        expect(state.completedRequests?.['req-run-1']).toEqual(expect.objectContaining({ status: 'approved' }));
        expect(markRequestCompleted).toHaveBeenCalledWith('req-run-1');
    });

    it('retires only the selected request source when an Action continuation cannot be restored', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        for (const [requestId, source] of [['action', 'happier_action'], ['native', 'native_tool']] as const) {
            store.publishRequest({ requestId, source, toolName: 'Review', toolInput: {}, createdAt: 1 });
        }
        await store.cancelRequestsBySource?.({
            source: 'happier_action', reason: 'continuation unavailable', decision: 'abort', requestIds: [],
        });
        expect(store.hasOutstandingRequest('action')).toBe(false);
        expect(store.hasOutstandingRequest('native')).toBe(true);
        expect(session.agentState.completedRequests?.action?.status).toBe('canceled');
    });

    it('does not let automatic native policy claim a Happier Action confirmation', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        store.publishRequest({
            requestId: 'action-confirmation',
            toolName: 'Bash',
            toolInput: { command: 'echo hi' },
            createdAt: 1,
            source: 'happier_action',
        });
        await expect(store.acquirePermissionResponseClaim({
            requestId: 'action-confirmation',
            claim: { version: 1, origin: 'automaticPolicy' },
        })).resolves.toEqual({ status: 'conflict' });
        expect(store.hasPermissionResponseClaim('action-confirmation')).toBe(false);
        expect(store.hasOutstandingRequest('action-confirmation')).toBe(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('publishes and completes a request', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            source: 'test-source',
        });

        expect(session.agentState.requests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: ['bash', '-lc', 'echo hi'] },
                createdAt: 123,
                source: 'test-source',
            }),
        );

        store.completeRequest({
            requestId: 'req-1',
            status: 'approved',
            decision: 'approved',
            extraCompletedFields: { answers: { a: 'b' } },
        });

        expect(session.agentState.requests!['req-1']).toBeUndefined();
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                status: 'approved',
                decision: 'approved',
                answers: { a: 'b' },
            }),
        );
    });

    it('does not rejoin a present-user response from a canceled completed request', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const claim = {
            version: 1,
            origin: 'presentUser',
            actor: {
                kind: 'accountUser',
                accountId: 'account-owner',
                relationship: 'owner',
            },
            decision: 'abort',
            scope: 'request',
        } satisfies PermissionResponseClaim;

        store.publishRequest({
            requestId: 'canceled-present-response',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
        });
        await store.completeRequest({
            requestId: 'canceled-present-response',
            status: 'denied',
            decision: 'abort',
            extraCompletedFields: { permissionDecisionActorV1: claim.actor },
        });
        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: ['canceled-present-response'],
        });

        expect(store.readCompletedPermissionResponseClaim({
            requestId: 'canceled-present-response',
            claim,
        })).toEqual({ status: 'conflict' });
    });

    it.each([true, false])('applies recent canonical cancellation coverage only when the bridge declares it: %s', covered => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
            requestCoverage: covered ? localPermissionBridgeCoverageOptions : undefined,
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        session.agentState.completedRequests!['toolu_canonical'] = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: question,
            createdAt: 1_000,
            completedAt: 10_000,
            status: 'canceled',
            reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        } as any;

        store.publishRequest({
            requestId: 'perm_generated',
            toolName: 'AskUserQuestion',
            toolInput: question,
            createdAt: 10_500,
            kind: 'user_action',
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        });

        if (covered) expect(session.agentState.requests!['perm_generated']).toBeUndefined();
        else expect(session.agentState.requests!['perm_generated']).toMatchObject({ source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE });
    });

    it('does not send a permission push for an async publish skipped by completed request coverage', async () => {
        const session = new AsyncFakeSession();
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const settings = accountSettingsParse({
            notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        });
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
            requestCoverage: localPermissionBridgeCoverageOptions,
            pushSender: { sendToAllDevicesAsync, fetchSessionNotificationContext: async (sessionId) => createSessionNotificationContextFixture(sessionId) },
            getAccountSettings: () => settings,
            getSessionTitle: () => 'Session',
            getAgentDisplayName: () => 'Agent',
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        session.agentState.completedRequests!['toolu_canonical'] = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: question,
            createdAt: 1_000,
            completedAt: 10_000,
            status: 'canceled',
            reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        } as any;

        store.publishRequest({
            requestId: 'perm_generated',
            toolName: 'AskUserQuestion',
            toolInput: question,
            createdAt: 10_500,
            kind: 'user_action',
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        });
        await flushMicrotasks();

        expect(session.agentState.requests!['perm_generated']).toBeUndefined();
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });

    it('removes an equivalent generated local-bridge request when the canonical request is canceled', () => {
        const now = new Date('2026-06-19T18:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
            requestCoverage: localPermissionBridgeCoverageOptions,
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        try {
            store.publishRequest({
                requestId: 'perm_generated',
                toolName: 'AskUserQuestion',
                toolInput: question,
                createdAt: now.getTime(),
                kind: 'user_action',
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            });
            store.publishRequest({
                requestId: 'toolu_canonical',
                toolName: 'AskUserQuestion',
                toolInput: question,
                createdAt: 1_000,
                kind: 'user_action',
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            });

            store.completeRequest({
                requestId: 'toolu_canonical',
                status: 'canceled',
                reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            });

            expect(session.agentState.requests!['perm_generated']).toBeUndefined();
            expect(session.agentState.completedRequests!['perm_generated']).toEqual(
                expect.objectContaining({
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves response target metadata through outstanding and completed records', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const responseTarget = {
            kind: 'test_target',
            requestOwner: 'owner-1',
        };
        const subagentRef = {
            runId: 'run-1',
            callId: 'call-1',
        };

        store.publishRequest({
            requestId: 'req-targeted',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget,
            subagentRef,
            sidechainId: 'sidechain-1',
        });

        expect(session.agentState.requests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );
        expect(store.readOutstandingRequest('req-targeted')).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );

        store.completeRequest({
            requestId: 'req-targeted',
            status: 'approved',
            decision: 'approved',
        });

        expect(session.agentState.completedRequests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('dispatches completed requests through the registered response target handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-dispatch',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        });

        store.completeRequest({
            requestId: 'req-dispatch',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-dispatch',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    tool: 'Bash',
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('dispatches response target handlers after asynchronous state updates settle', async () => {
        const session = new AsyncFakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        session.agentState.requests!['req-async'] = {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        };
        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });

        store.completeRequest({
            requestId: 'req-async',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        await flushMicrotasks();

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-async',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('treats async response target handler failures as non-fatal', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        let handled = false;

        store.registerResponseTargetHandler('test_target', async () => {
            handled = true;
            throw new Error('handler failed');
        });
        store.publishRequest({
            requestId: 'req-async-handler',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.completeRequest({
            requestId: 'req-async-handler',
            status: 'approved',
            decision: 'approved',
        });
        await flushMicrotasks();

        expect(handled).toBe(true);
        expect(session.agentState.completedRequests!['req-async-handler']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('retains a failed response delivery for replay and clears its target after later success', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        let available = false;
        const failedDelivery = vi.fn(async () => available);
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

        const unregisterFailedDelivery = store.registerResponseTargetHandler('test_target', failedDelivery);
        store.publishRequest({
            requestId: 'req-recoverable-delivery',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target', requestOwner: 'owner-1' },
        });
        await store.completeRequest({
            requestId: 'req-recoverable-delivery',
            status: 'approved',
            decision: 'approved',
        });
        await flushMicrotasks();

        expect(failedDelivery).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('Response target handler did not deliver'));
        available = true;
        store.replayCompletedResponseTargets();
        await flushMicrotasks();

        expect(failedDelivery).toHaveBeenCalledTimes(2);
        expect(failedDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
            requestId: 'req-recoverable-delivery',
            responseTarget: { kind: 'test_target', requestOwner: 'owner-1' },
            completedRequest: expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        }));

        unregisterFailedDelivery();
        const repeatDelivery = vi.fn(async () => true as never);
        store.registerResponseTargetHandler('test_target', repeatDelivery);
        await flushMicrotasks();

        expect(repeatDelivery).not.toHaveBeenCalled();
        expect(session.agentState.completedRequests!['req-recoverable-delivery']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
        expect(session.agentState.completedRequests!['req-recoverable-delivery']?.responseTarget).toBeUndefined();
        debug.mockRestore();
    });

    it('retires only completed records for an exact terminal turn after delivery while preserving grants', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        for (const [requestId, turnId, decision] of [
            ['prior-plain', 'turn-a', 'approved'],
            ['prior-grant', 'turn-a', 'approved_for_session'],
            ['current-plain', 'turn-b', 'approved'],
        ] as const) {
            store.publishRequest({ requestId, turnId, toolName: 'Bash', toolInput: { command: requestId }, createdAt: 1 });
            await store.completeRequest({ requestId, status: 'approved', decision });
        }
        store.publishRequest({ requestId: 'question-still-open', turnId: 'turn-a', toolName: 'AskUserQuestion',
            toolInput: { questions: [{ question: 'Continue?' }] }, createdAt: 1 });

        await store.retireCompletedRequestsForTurn('turn-a');

        expect(session.agentState.completedRequests?.['prior-plain']).toBeUndefined();
        expect(session.agentState.completedRequests?.['prior-grant']).toMatchObject({
            turnId: 'turn-a',
            decision: 'approved_for_session',
        });
        expect(session.agentState.completedRequests?.['current-plain']).toMatchObject({ turnId: 'turn-b' });
        expect(session.agentState.requests?.['question-still-open']).toMatchObject({ turnId: 'turn-a' });
    });

    it('compacts a terminal turn when its in-flight response delivery later succeeds', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const deliveryControl: { finish: (() => void) | null } = { finish: null };
        store.registerResponseTargetHandler('test_target', async () => {
            await new Promise<void>((resolve) => { deliveryControl.finish = resolve; });
            return true;
        });
        store.publishRequest({
            requestId: 'terminal-delivery',
            turnId: 'turn-terminal',
            toolName: 'Bash',
            toolInput: { command: 'echo done' },
            createdAt: 1,
            responseTarget: { kind: 'test_target' },
        });
        await store.completeRequest({
            requestId: 'terminal-delivery',
            status: 'approved',
            decision: 'approved',
        });

        const retirement = store.retireCompletedRequestsForTurn('turn-terminal');
        await flushMicrotasks();
        expect(session.agentState.completedRequests?.['terminal-delivery']).toBeDefined();
        deliveryControl.finish?.();
        await retirement;
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-delivery']).toBeUndefined();
    });

    it('retains a failed terminal-turn delivery for replay and compacts it after later success', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const releaseFailed = store.registerResponseTargetHandler('test_target', () => false);
        store.publishRequest({
            requestId: 'terminal-replay',
            turnId: 'turn-terminal',
            toolName: 'Bash',
            toolInput: { command: 'echo replay' },
            createdAt: 1,
            responseTarget: { kind: 'test_target' },
        });
        await store.completeRequest({
            requestId: 'terminal-replay',
            status: 'approved',
            decision: 'approved',
        });
        await store.retireCompletedRequestsForTurn('turn-terminal');
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-replay']).toMatchObject({
            responseTarget: { kind: 'test_target' },
        });
        releaseFailed();
        store.registerResponseTargetHandler('test_target', () => true);
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-replay']).toBeUndefined();
    });

    it('does not deliver another Session completed response to the old Session handler', async () => {
        const sessionA = new FakeSession();
        const sessionB = new FakeSession();
        sessionB.sessionId = 'another-session';
        sessionB.agentState.completedRequests!.other = {
            tool: 'Review', arguments: {}, createdAt: 1, completedAt: 2,
            status: 'approved', decision: 'approved', responseTarget: { kind: 'test_target' },
        };
        const store = new AgentStateRequestStore({ session: sessionA, logPrefix: '[Test]' });
        const delivered: string[] = [];
        store.registerResponseTargetHandler('test_target', (dispatch) => { delivered.push(dispatch.requestId); });
        store.updateSession(sessionB);
        await flushMicrotasks();
        expect(delivered).toEqual([]);
    });

    it('replays only undelivered completed response targets after an authoritative session rebind', async () => {
        const sessionA = new FakeSession();
        const sessionB = new FakeSession();
        sessionA.sessionId = 'session-a';
        sessionB.sessionId = 'session-a';
        sessionB.agentState.completedRequests!['delivered'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo delivered'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['returned-false'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo returned-false'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['throws'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo throws'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['rejects'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo rejects'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['other-target'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo other-target'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'other_target' },
        };
        sessionB.agentState.completedRequests!['malformed-target'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo malformed-target'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: '   ' },
        };

        const store = new AgentStateRequestStore({
            session: sessionA,
            logPrefix: '[Test]',
        });
        const dispatches: string[] = [];
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const unsubscribe = store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch.requestId);
            if (dispatch.requestId === 'returned-false') return false;
            if (dispatch.requestId === 'throws') throw new Error('delivery failed');
            if (dispatch.requestId === 'rejects') return Promise.reject(new Error('delivery rejected'));
            return true;
        });

        store.updateSession(sessionB);
        await flushMicrotasks();

        expect(dispatches.sort()).toEqual(['delivered', 'rejects', 'returned-false', 'throws']);

        // Successful delivery removes only its response target. Failed
        // deliveries retain their exact durable replay obligation.
        store.updateSession(sessionB);
        await flushMicrotasks();

        expect(dispatches.sort()).toEqual([
            'delivered',
            'rejects',
            'rejects',
            'returned-false',
            'returned-false',
            'throws',
            'throws',
        ]);

        unsubscribe();
        store.updateSession(sessionB);
        await flushMicrotasks();
        expect(dispatches).toHaveLength(7);

        const disposedStore = new AgentStateRequestStore({
            session: sessionA,
            logPrefix: '[Disposed Test]',
        });
        const disposedHandler = vi.fn();
        disposedStore.registerResponseTargetHandler('test_target', disposedHandler);
        disposedStore.dispose();
        disposedStore.updateSession(sessionB);
        await flushMicrotasks();
        expect(disposedHandler).not.toHaveBeenCalled();
        debug.mockRestore();
    });

    it('preserves response target metadata when recording completed requests directly', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        await store.recordCompletedRequest({
            requestId: 'req-recorded',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            status: 'approved',
            decision: 'approved',
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
            subagentRef: {
                runId: 'run-1',
                callId: 'call-1',
            },
            sidechainId: 'sidechain-1',
            permissionSuggestions: [{ mode: 'allow' }],
        });
        await flushMicrotasks();

        expect(session.agentState.completedRequests!['req-recorded']).toEqual(
            expect.objectContaining({
                subagentRef: {
                    runId: 'run-1',
                    callId: 'call-1',
                },
                sidechainId: 'sidechain-1',
                permissionSuggestions: [{ mode: 'allow' }],
            }),
        );
        expect(session.agentState.completedRequests!['req-recorded']?.responseTarget).toBeUndefined();
        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-recorded',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
            }),
        ]);
    });

    it('rejects duplicate response target handlers and unregisters only the exact handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: string[] = [];
        const firstUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('first');
        });

        expect(() => store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('duplicate');
        })).toThrow(/test_target/);

        firstUnsubscribe();
        const secondUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('second');
        });
        firstUnsubscribe();

        store.publishRequest({
            requestId: 'req-second',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });
        store.completeRequest({
            requestId: 'req-second',
            status: 'approved',
            decision: 'approved',
        });

        secondUnsubscribe();
        store.publishRequest({
            requestId: 'req-after-unsubscribe',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo bye'] },
            createdAt: 124,
            responseTarget: { kind: 'test_target' },
        });

        expect(() => store.completeRequest({
            requestId: 'req-after-unsubscribe',
            status: 'approved',
            decision: 'approved',
        })).not.toThrow();
        expect(dispatches).toEqual(['second']);
        expect(session.agentState.completedRequests!['req-after-unsubscribe']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('clears response target handlers when disposed', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-after-dispose',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.dispose();
        store.completeRequest({
            requestId: 'req-after-dispose',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        expect(session.agentState.completedRequests!['req-after-dispose']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('cancels all outstanding requests', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
        });
        store.publishRequest({
            requestId: 'req-2',
            toolName: 'Write',
            toolInput: { path: '/tmp/x', content: 'hi' },
            createdAt: 2,
        });

        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: [],
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);
        expect(Object.keys(session.agentState.completedRequests ?? {}).sort()).toEqual(['req-1', 'req-2']);
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({ status: 'canceled', decision: 'abort', reason: 'Session ended' }),
        );
        expect(session.agentState.completedRequests!['req-2']).toEqual(
            expect.objectContaining({ status: 'canceled', decision: 'abort', reason: 'Session ended' }),
        );
    });

    it('makes lifecycle cancellation durably nonauthorizing even for an opaque first-answer claim', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const owner = { kind: 'plugin' as const, pluginId: 'happier.channels', runtimeId: 'channels-runtime' };
        store.publishRequest({
            requestId: 'opaque-claim',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
            owner,
        });
        const opaqueClaim = { predecessor: 'unrecognized-first-answer-claim' };
        session.agentState.requests!['opaque-claim'].permissionResponseClaimV1 = opaqueClaim;

        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: ['opaque-claim'],
        });
        await store.cancelRequestsByOwner({
            owner,
            reason: 'plugin_deactivated',
            decision: 'abort',
            requestIds: ['opaque-claim'],
        });
        await expect(store.completeRequest({
            requestId: 'opaque-claim',
            status: 'canceled',
            decision: 'abort',
            reason: 'caller_aborted',
            fallback: {
                toolName: 'Bash',
                toolInput: { command: ['bash', '-lc', 'echo hi'] },
                createdAt: 1,
                owner,
            },
        })).resolves.toBe(false);
        await expect(store.recordCompletedRequest({
            requestId: 'opaque-claim',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            status: 'approved',
            decision: 'approved',
            owner,
        })).resolves.toBe(false);

        expect(session.agentState.requests!['opaque-claim']).toBeUndefined();
        expect(session.agentState.completedRequests!['opaque-claim']).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            reason: 'Session ended',
            owner,
        }));
        expect(session.agentState.completedRequests!['opaque-claim']).not.toHaveProperty('permissionResponseClaimV1');
    });
});
