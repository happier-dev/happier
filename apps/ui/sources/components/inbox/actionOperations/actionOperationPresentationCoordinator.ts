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
}>) {
    const registrations = new Map<string, ActionOperationPresentationRegistration>();
    const requestIdByOperationId = new Map<string, string>();
    const presentedOperationIds = new Set<string>();

    const retainBounded = () => {
        while (registrations.size > MAX_REGISTRATIONS) {
            const oldest = registrations.keys().next().value as string | undefined;
            if (!oldest) return;
            registrations.delete(oldest);
            for (const [operationId, requestId] of requestIdByOperationId) {
                if (requestId === oldest) requestIdByOperationId.delete(operationId);
            }
        }
    };

    const registrationFor = (snapshot: ActionOperationSnapshotV1) => {
        const requestId = snapshot.requestId ?? requestIdByOperationId.get(snapshot.operationId);
        return requestId ? registrations.get(requestId) ?? null : null;
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
                return;
            }
            const destinationSessionId = readActionOperationDestinationSessionId(snapshot);
            if (destinationSessionId) {
                deps.openDestination(destinationSessionId, snapshot);
                return;
            }
            deps.openDetail(snapshot.operationId);
        },
        reset(): void {
            registrations.clear();
            requestIdByOperationId.clear();
            presentedOperationIds.clear();
        },
    });
}

export type ActionOperationPresentationCoordinator = ReturnType<typeof createActionOperationPresentationCoordinator>;
