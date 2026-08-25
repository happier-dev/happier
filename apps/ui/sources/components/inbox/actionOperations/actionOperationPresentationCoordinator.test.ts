import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

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

describe('action operation presentation coordinator', () => {
    it.each([
        ['current', 0, 0],
        ['detail', 1, 0],
        ['activity', 0, 1],
    ] as const)('applies presentation.onStart=%s once', (onStart, details, collapses) => {
        const openDetail = vi.fn();
        const collapse = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination: vi.fn(), markPresented: vi.fn() });
        coordinator.register({ requestId: 'request-1', onStart, origin: { resolve: () => null, collapse } });

        coordinator.observe(operation());
        coordinator.observe(operation({ revision: 2 }));

        expect(openDetail).toHaveBeenCalledTimes(details);
        expect(collapse).toHaveBeenCalledTimes(collapses);
    });

    it('reopens an actionable origin with the live snapshot so status, progress, and cancel remain available', () => {
        const openOrigin = vi.fn();
        const openDetail = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination: vi.fn(), markPresented: vi.fn() });
        coordinator.register({
            requestId: 'request-1',
            onStart: 'current',
            origin: { resolve: (snapshot) => () => openOrigin(snapshot) },
        });
        const running = operation();
        coordinator.observe(running);

        coordinator.open(running);

        expect(openOrigin).toHaveBeenCalledWith(running);
        expect(openDetail).not.toHaveBeenCalled();
    });

    it('opens a terminal success destination, then falls back to standard detail when no origin is reconstructable', () => {
        const openDestination = vi.fn();
        const openDetail = vi.fn();
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({ openDetail, openDestination, markPresented });
        coordinator.register({ requestId: 'request-1', onStart: 'current' });
        const succeeded = operation({
            state: 'succeeded',
            revision: 2,
            settledAt: 3,
            result: { childSessionId: 'child-1' },
        });
        coordinator.observe(succeeded);

        coordinator.open(succeeded);
        coordinator.open(operation({ requestId: undefined, operationId: 'unbound' }));

        expect(openDestination).toHaveBeenCalledWith('child-1', succeeded);
        expect(markPresented).toHaveBeenCalledWith(succeeded);
        expect(openDetail).toHaveBeenCalledWith('unbound');
    });

    it('acknowledges an exact terminal operation presented by its existing foreground flow', () => {
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail: vi.fn(),
            openDestination: vi.fn(),
            markPresented,
        });
        const succeeded = operation({ state: 'succeeded', revision: 2, settledAt: 3 });

        coordinator.acknowledgePresented(succeeded);
        coordinator.acknowledgePresented(operation());

        expect(markPresented).toHaveBeenCalledTimes(1);
        expect(markPresented).toHaveBeenCalledWith(succeeded);
    });

    it('reconciles presentation by durable request identity regardless of push ordering', () => {
        const markPresented = vi.fn();
        const coordinator = createActionOperationPresentationCoordinator({
            openDetail: vi.fn(),
            openDestination: vi.fn(),
            markPresented,
        });
        coordinator.register({ requestId: 'request-1', onStart: 'current' });
        const succeeded = operation({ state: 'succeeded', revision: 2, settledAt: 3 });

        coordinator.acknowledgeRequestPresented('request-1');
        coordinator.observe(succeeded);
        coordinator.observe(operation({ operationId: 'operation-2', requestId: 'request-2', state: 'succeeded', revision: 2, settledAt: 3 }));

        expect(markPresented).toHaveBeenCalledTimes(1);
        expect(markPresented).toHaveBeenCalledWith(succeeded);
    });
});
