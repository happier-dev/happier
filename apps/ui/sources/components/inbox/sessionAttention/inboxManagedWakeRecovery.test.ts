import { describe, expect, it, vi } from 'vitest';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { ManagedWakeProjectionInput } from '@/sync/domains/pending/managedWakeProjection';

// The wake sentence's owner lives beside its popover; native styling and icons are platform boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { buildInboxManagedWakeRecovery } = await import('./inboxManagedWakeRecovery');

const controller = { machineId: 'controller-a', installationId: 'installation-a' };
const target = { homeId: 'home-a', managedId: 'managed-a', enrolledMachineId: 'guest-a', controller,
    origin: { kind: 'session-input', session: { homeId: 'home-a', sessionId: 'session-a' }, pendingRequestId: 'request-a', requestedAt: 20 } };
const stopped: NonNullable<ManagedWakeProjectionInput['managed']> = {
    id: 'managed-a', homeId: 'home-a', creationState: 'active', enrolledMachineId: 'guest-a', allocation: 'bound', controller,
    wakeOnAcceptedMessage: true,
    observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' },
};
const running = { ...stopped, observation: { ...stopped.observation!, power: 'running' as const } };
const queued = { id: 'pending-a', localId: 'request-a', messageRole: 'user', source: 'server_pending',
    pendingDeliveryStatus: 'server_queued', createdAt: 20 } as unknown as PendingMessage;
const names = { controllerName: 'NLDW3', machineName: 'do-bot-1', homeName: 'Personal', agentName: 'Claude' };
const failed = (failureCode: 'managed_start_refused' | 'runtime_start_failed') => ({
    status: 'failed' as const, requestId: 'request-a', requestedAt: 20, failureCode, managedWakeTargetV1: target,
}) as never;
const base = {
    sessionActiveAt: 5, sessionActive: false, canWrite: true, runtimeResumingAt: null,
    pendingMessages: [queued], pendingLoaded: true, managedReadState: 'read' as const, machineInventoryState: 'read' as const, names,
};

describe('Inbox recovery for a failed managed wake', () => {
    it('says why the stopped machine did not wake and retries by re-arming the exact queued input', () => {
        const recovery = buildInboxManagedWakeRecovery({ ...base, authorization: failed('managed_start_refused'),
            managed: stopped, machineReachable: false });
        expect(recovery?.sentence).toContain('do-bot-1');
        expect(recovery?.sentence).toContain('still queued');
        expect(recovery?.retry).toBe('rearm');
        expect(recovery?.presentation.row?.localId).toBe('request-a');
    });

    it('retries the Agent start on the awake machine through the Session resume', () => {
        const recovery = buildInboxManagedWakeRecovery({ ...base, authorization: failed('runtime_start_failed'),
            managed: { ...running, wakeOnAcceptedMessage: false }, machineReachable: true });
        expect(recovery?.retry).toBe('retry');
        expect(recovery?.presentation.managedWakeProjection?.kind).toBe('agentStartFailed');
    });

    it('offers no Retry when the resource is gone, only its reason', () => {
        const recovery = buildInboxManagedWakeRecovery({ ...base, authorization: failed('managed_start_refused'),
            managed: { ...stopped, allocation: 'confirmed-absent' }, machineReachable: false });
        expect(recovery?.retry).toBeNull();
        expect(recovery?.sentence.length).toBeGreaterThan(0);
    });

    it('is absent for an authorization that is not a managed wake or predates the current activation', () => {
        expect(buildInboxManagedWakeRecovery({ ...base, authorization: { status: 'failed', requestId: 'request-a', requestedAt: 20,
            failureCode: 'runtime_start_failed' }, managed: stopped, machineReachable: false })).toBeNull();
        expect(buildInboxManagedWakeRecovery({ ...base, sessionActiveAt: 30, authorization: failed('managed_start_refused'),
            managed: stopped, machineReachable: false })).toBeNull();
    });
});
