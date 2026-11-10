import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { qualifyActionOperationSnapshot } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import { createActionOperationPresentationCoordinator } from './actionOperationPresentationCoordinator';

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.fork',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'source-1' },
        title: 'Fork session',
        requestId: 'request-1',
        createdAt: 1,
        startedAt: 2,
        progress: { kind: 'phase', phase: 'forking', label: 'Forking' },
        cancellation: 'supported',
        ...overrides,
    };
}

const qualified = (snapshot: ActionOperationSnapshotV1, serverId: string = 'home-a') => (
    qualifyActionOperationSnapshot(serverId, snapshot)
);

describe('action operation presentation coordinator', () => {
    it('acknowledges the retained composer handoff only after navigation succeeds', async () => {
        const completed = qualified(operation({ state: 'succeeded', revision: 2, settledAt: 3 }));
        const address = { serverId: completed.serverId, operationId: completed.snapshot.operationId };
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail() {}, openDestination() {}, markPresented,
        });
        actionOperationStore.reset();
        try {
            actionOperationStore.mergeSnapshots({ serverId: completed.serverId, snapshots: [completed.snapshot] });
            actionOperationStore.retainNewSessionContinuation(address, async () => ({ code: 'unavailable' }));
            coordinator.open(completed);
            await Promise.resolve();
            expect(markPresented).not.toHaveBeenCalled();
            actionOperationStore.retainNewSessionContinuation(address, async () => null);
            coordinator.open(completed);
            await vi.waitFor(() => expect(markPresented).toHaveBeenCalledTimes(1));
        } finally { actionOperationStore.reset(); }
    });

    it.each([
        ['current', 0, 0],
        ['detail', 1, 0],
        ['activity', 0, 1],
    ] as const)('applies presentation.onStart=%s once', (onStart, details, collapses) => {
        const openDetail = vi.fn();
        const collapse = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination: vi.fn(), markPresented: vi.fn() });
        coordinator.register({ serverId: 'home-a', accountId: 'account-1', requestId: 'request-1', onStart, origin: { resolve: () => null, collapse } });

        coordinator.observe(qualified(operation()));
        coordinator.observe(qualified(operation({ revision: 2 })));

        expect(openDetail).toHaveBeenCalledTimes(details);
        expect(collapse).toHaveBeenCalledTimes(collapses);
    });

    it('reopens an actionable origin with the live snapshot so status, progress, and cancel remain available', () => {
        const openOrigin = vi.fn();
        const openDetail = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination: vi.fn(), markPresented: vi.fn() });
        coordinator.register({
            serverId: 'home-a',
            accountId: 'account-1',
            requestId: 'request-1',
            onStart: 'current',
            origin: { resolve: (snapshot) => () => openOrigin(snapshot) },
        });
        const running = operation();
        coordinator.observe(qualified(running));

        coordinator.open(qualified(running));

        expect(openOrigin).toHaveBeenCalledWith(running);
        expect(openDetail).not.toHaveBeenCalled();
    });

    it('opens a terminal success destination, then falls back to standard detail when no origin is reconstructable', () => {
        const openDestination = vi.fn();
        const openDetail = vi.fn();
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination, markPresented });
        coordinator.register({ serverId: 'home-a', accountId: 'account-1', requestId: 'request-1', onStart: 'current' });
        const succeeded = operation({
            state: 'succeeded',
            revision: 2,
            settledAt: 3,
            result: { childSessionId: 'child-1' },
        });
        coordinator.observe(qualified(succeeded));

        coordinator.open(qualified(succeeded));
        coordinator.open(qualified(operation({ requestId: undefined, operationId: 'unbound' })));

        expect(openDestination).toHaveBeenCalledWith('child-1', qualified(succeeded));
        expect(markPresented).toHaveBeenCalledWith(qualified(succeeded));
        expect(openDetail).toHaveBeenCalledWith({ serverId: 'home-a', operationId: 'unbound' });
    });

    it('acknowledges an exact terminal operation presented by its existing foreground flow', () => {
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail: vi.fn(),
            openDestination: vi.fn(),
            markPresented,
        });
        const succeeded = operation({ state: 'succeeded', revision: 2, settledAt: 3 });

        coordinator.acknowledgePresented(qualified(succeeded));
        coordinator.acknowledgePresented(qualified(operation()));

        expect(markPresented).toHaveBeenCalledTimes(1);
        expect(markPresented).toHaveBeenCalledWith(qualified(succeeded));
    });

    it('does not route an unqualified legacy success through an ambient Home', () => {
        const openDestination = vi.fn();
        const openDetail = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail,
            openDestination,
            markPresented: vi.fn(),
        });
        const succeeded = operation({
            state: 'succeeded',
            revision: 2,
            settledAt: 3,
            result: { childSessionId: 'same-session-id' },
        });

        coordinator.open({ serverId: null, snapshot: succeeded } as unknown as Parameters<typeof coordinator.open>[0]);

        expect(openDestination).not.toHaveBeenCalled();
        expect(openDetail).not.toHaveBeenCalled();
    });

    it('keeps identical request IDs isolated by authenticated Home and Account scope', () => {
        const openHomeA = vi.fn();
        const openHomeB = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail: vi.fn(),
            openDestination: vi.fn(),
            markPresented: vi.fn(),
        });
        const homeARegistration = {
            serverId: 'home-a',
            accountId: 'account-1',
            requestId: 'request-1',
            onStart: 'current' as const,
            origin: { resolve: () => openHomeA },
        };
        const homeBRegistration = {
            serverId: 'home-b',
            accountId: 'account-2',
            requestId: 'request-1',
            onStart: 'current' as const,
            origin: { resolve: () => openHomeB },
        };
        coordinator.register(homeARegistration);
        coordinator.register(homeBRegistration);

        const operationA = qualified(operation(), 'home-a');
        const operationB = qualified(operation({
            scope: { accountId: 'account-2', machineId: 'machine-1', sessionId: 'source-1' },
        }), 'home-b');
        coordinator.observe(operationA);
        coordinator.observe(operationB);
        coordinator.open(operationA);
        coordinator.open(operationB);

        expect(openHomeA).toHaveBeenCalledTimes(1);
        expect(openHomeB).toHaveBeenCalledTimes(1);
    });

    it('reconciles presentation by durable request identity regardless of push ordering', () => {
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail: vi.fn(),
            openDestination: vi.fn(),
            markPresented,
        });
        coordinator.register({ serverId: 'home-a', accountId: 'account-1', requestId: 'request-1', onStart: 'current' });
        const succeeded = operation({ state: 'succeeded', revision: 2, settledAt: 3 });

        coordinator.acknowledgeRequestPresented({
            serverId: 'home-a',
            accountId: 'account-1',
            requestId: 'request-1',
        });
        coordinator.observe(qualified(succeeded));
        coordinator.observe(qualified(operation({ operationId: 'operation-2', requestId: 'request-2', state: 'succeeded', revision: 2, settledAt: 3 })));

        expect(markPresented).toHaveBeenCalledTimes(1);
        expect(markPresented).toHaveBeenCalledWith(qualified(succeeded));
    });
});
