import type { ActionOperationDeclarationV1, ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { readActionOperationDestinationSessionId } from './actionOperationPresentation';

export type ActionOperationReentryOrigin = Readonly<{
    /** Returns a reconstructable presentation for this exact current snapshot. */
    resolve(snapshot: ActionOperationSnapshotV1): (() => void) | null;
    /** Collapses the current foreground surface without cancelling daemon custody. */
    collapse?: () => void;
}>;

export type ActionOperationPresentationRegistration = Readonly<{
    requestId: string;
    onStart: ActionOperationDeclarationV1['presentation']['onStart'];
    origin?: ActionOperationReentryOrigin;
}>;

const MAX_REGISTRATIONS = 100;

export function createActionOperationPresentationCoordinator(deps: Readonly<{
    openDetail(operationId: string): void;
    openDestination(sessionId: string, snapshot: ActionOperationSnapshotV1): void;
    markPresented(snapshot: ActionOperationSnapshotV1): void;
}>) {
    const registrations = new Map<string, ActionOperationPresentationRegistration>();
    const requestIdByOperationId = new Map<string, string>();
    const latestSnapshotByRequestId = new Map<string, ActionOperationSnapshotV1>();
    const presentedRequestIds = new Set<string>();
    const presentedOperationIds = new Set<string>();
    const acknowledgedOperationIds = new Set<string>();

    const retainBounded = () => {
        while (registrations.size > MAX_REGISTRATIONS) {
            const oldest = registrations.keys().next().value as string | undefined;
            if (!oldest) return;
            registrations.delete(oldest);
            for (const [operationId, requestId] of requestIdByOperationId) {
                if (requestId === oldest) {
                    requestIdByOperationId.delete(operationId);
                    acknowledgedOperationIds.delete(operationId);
                }
            }
            latestSnapshotByRequestId.delete(oldest);
            presentedRequestIds.delete(oldest);
        }
    };

    const registrationFor = (snapshot: ActionOperationSnapshotV1) => {
        const requestId = snapshot.requestId ?? requestIdByOperationId.get(snapshot.operationId);
        return requestId ? registrations.get(requestId) ?? null : null;
    };

    const acknowledgePresented = (snapshot: ActionOperationSnapshotV1): void => {
        if (
            snapshot.state !== 'succeeded'
            && snapshot.state !== 'failed'
            && snapshot.state !== 'cancelled'
        ) {
            return;
        }
        if (acknowledgedOperationIds.has(snapshot.operationId)) return;
        acknowledgedOperationIds.add(snapshot.operationId);
        deps.markPresented(snapshot);
    };

    return Object.freeze({
        register(registration: ActionOperationPresentationRegistration): void {
            registrations.delete(registration.requestId);
            registrations.set(registration.requestId, registration);
            retainBounded();
        },
        observe(snapshot: ActionOperationSnapshotV1): void {
            if (!snapshot.requestId) return;
            const registration = registrations.get(snapshot.requestId);
            if (!registration) return;
            requestIdByOperationId.set(snapshot.operationId, snapshot.requestId);
            latestSnapshotByRequestId.set(snapshot.requestId, snapshot);
            if (presentedRequestIds.has(snapshot.requestId)) acknowledgePresented(snapshot);
            if (presentedOperationIds.has(snapshot.operationId)) return;
            presentedOperationIds.add(snapshot.operationId);
            if (registration.onStart === 'detail') deps.openDetail(snapshot.operationId);
            if (registration.onStart === 'activity') registration.origin?.collapse?.();
        },
        open(snapshot: ActionOperationSnapshotV1): void {
            const registration = registrationFor(snapshot);
            const reopen = registration?.origin?.resolve(snapshot) ?? null;
            if (reopen) {
                reopen();
                acknowledgePresented(snapshot);
                return;
            }
            const destinationSessionId = readActionOperationDestinationSessionId(snapshot);
            if (destinationSessionId) {
                deps.openDestination(destinationSessionId, snapshot);
                acknowledgePresented(snapshot);
                return;
            }
            deps.openDetail(snapshot.operationId);
            acknowledgePresented(snapshot);
        },
        acknowledgePresented,
        acknowledgeRequestPresented(requestId: string, snapshot?: ActionOperationSnapshotV1): void {
            const normalizedRequestId = requestId.trim();
            if (!normalizedRequestId) return;
            const exactSnapshot = snapshot?.requestId === normalizedRequestId
                ? snapshot
                : latestSnapshotByRequestId.get(normalizedRequestId);
            if (!exactSnapshot && !registrations.has(normalizedRequestId)) return;
            presentedRequestIds.add(normalizedRequestId);
            if (exactSnapshot) acknowledgePresented(exactSnapshot);
        },
        reset(): void {
            registrations.clear();
            requestIdByOperationId.clear();
            presentedOperationIds.clear();
            acknowledgedOperationIds.clear();
            latestSnapshotByRequestId.clear();
            presentedRequestIds.clear();
        },
    });
}

export type ActionOperationPresentationCoordinator = ReturnType<typeof createActionOperationPresentationCoordinator>;
