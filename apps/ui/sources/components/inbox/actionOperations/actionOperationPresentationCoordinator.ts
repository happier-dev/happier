import type { ActionOperationDeclarationV1, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import {
    actionOperationAddress,
    actionOperationAddressKey,
    actionOperationRequestAddressKey,
    normalizeActionOperationServerId,
    type ActionOperationAddress,
    type QualifiedActionOperation,
} from '@/sync/domains/actionOperations/qualifiedActionOperation';

import {
    readActionOperationDestinationServerId,
    readActionOperationDestinationSessionId,
} from './actionOperationPresentation';

export type ActionOperationReentryOrigin = Readonly<{
    /** Returns a reconstructable presentation for this exact current snapshot. */
    resolve(snapshot: ActionOperationSnapshotV1): (() => void) | null;
    /** Collapses the current foreground surface without cancelling daemon custody. */
    collapse?: () => void;
}>;

export type ActionOperationPresentationRegistration = Readonly<{
    serverId: string | null;
    accountId: string;
    requestId: string;
    onStart: ActionOperationDeclarationV1['presentation']['onStart'];
    origin?: ActionOperationReentryOrigin;
}>;

const MAX_REGISTRATIONS = 100;

export function createActionOperationPresentationCoordinator(deps: Readonly<{
    openDetail(address: ActionOperationAddress): void;
    openDestination(sessionId: string, operation: QualifiedActionOperation): void;
    markPresented(operation: QualifiedActionOperation): void;
}>) {
    const registrationsByRequestKey = new Map<string, ActionOperationPresentationRegistration>();
    const requestKeyByOperationKey = new Map<string, string>();
    const latestOperationByRequestKey = new Map<string, QualifiedActionOperation>();
    const presentedRequestKeys = new Set<string>();
    const presentedOperationIds = new Set<string>();
    const acknowledgedOperationIds = new Set<string>();

    const retainBounded = () => {
        while (registrationsByRequestKey.size > MAX_REGISTRATIONS) {
            const oldest = registrationsByRequestKey.keys().next().value as string | undefined;
            if (!oldest) return;
            registrationsByRequestKey.delete(oldest);
            for (const [operationKey, requestKey] of requestKeyByOperationKey) {
                if (requestKey === oldest) {
                    requestKeyByOperationKey.delete(operationKey);
                    acknowledgedOperationIds.delete(operationKey);
                }
            }
            latestOperationByRequestKey.delete(oldest);
            presentedRequestKeys.delete(oldest);
        }
    };

    const requestKeyForOperation = (operation: QualifiedActionOperation | undefined): string | null => {
        if (!operation) return null;
        if (!normalizeActionOperationServerId(operation.serverId)) return null;
        const requestId = operation.snapshot.requestId;
        return requestId ? actionOperationRequestAddressKey({
            serverId: operation.serverId,
            accountId: operation.snapshot.scope.accountId,
            requestId,
        }) : null;
    };

    const registrationFor = (operation: QualifiedActionOperation) => {
        const requestKey = requestKeyForOperation(operation) ?? requestKeyByOperationKey.get(actionOperationAddressKey(
            actionOperationAddress(operation.serverId, operation.snapshot.operationId),
        ));
        return requestKey ? registrationsByRequestKey.get(requestKey) ?? null : null;
    };

    const acknowledgePresented = (operation: QualifiedActionOperation): void => {
        if (!normalizeActionOperationServerId(operation.serverId)) return;
        const { snapshot } = operation;
        if (
            snapshot.state !== 'succeeded'
            && snapshot.state !== 'failed'
            && snapshot.state !== 'cancelled'
        ) {
            return;
        }
        const operationKey = actionOperationAddressKey(actionOperationAddress(operation.serverId, snapshot.operationId));
        if (acknowledgedOperationIds.has(operationKey)) return;
        acknowledgedOperationIds.add(operationKey);
        deps.markPresented(operation);
    };

    return Object.freeze({
        register(registration: ActionOperationPresentationRegistration): void {
            const requestKey = actionOperationRequestAddressKey(registration);
            registrationsByRequestKey.delete(requestKey);
            registrationsByRequestKey.set(requestKey, registration);
            retainBounded();
        },
        observe(operation: QualifiedActionOperation): void {
            if (!normalizeActionOperationServerId(operation.serverId)) return;
            const { snapshot } = operation;
            const requestKey = requestKeyForOperation(operation);
            if (!requestKey) return;
            const registration = registrationsByRequestKey.get(requestKey);
            if (!registration) return;
            const operationKey = actionOperationAddressKey(actionOperationAddress(operation.serverId, snapshot.operationId));
            requestKeyByOperationKey.set(operationKey, requestKey);
            latestOperationByRequestKey.set(requestKey, operation);
            if (presentedRequestKeys.has(requestKey)) acknowledgePresented(operation);
            if (presentedOperationIds.has(operationKey)) return;
            presentedOperationIds.add(operationKey);
            if (registration.onStart === 'detail') deps.openDetail(actionOperationAddress(operation.serverId, snapshot.operationId));
            if (registration.onStart === 'activity') registration.origin?.collapse?.();
        },
        open(operation: QualifiedActionOperation): void {
            if (!normalizeActionOperationServerId(operation.serverId)) return;
            const { snapshot } = operation;
            const registration = registrationFor(operation);
            const reopen = registration?.origin?.resolve(snapshot) ?? null;
            if (reopen) {
                reopen();
                acknowledgePresented(operation);
                return;
            }
            const destinationSessionId = readActionOperationDestinationSessionId(snapshot);
            if (destinationSessionId && readActionOperationDestinationServerId(snapshot, operation.serverId)) {
                deps.openDestination(destinationSessionId, operation);
                acknowledgePresented(operation);
                return;
            }
            deps.openDetail(actionOperationAddress(operation.serverId, snapshot.operationId));
            acknowledgePresented(operation);
        },
        acknowledgePresented,
        acknowledgeRequestPresented(
            request: Readonly<{ serverId: string | null; accountId: string; requestId: string }>,
            operation?: QualifiedActionOperation,
        ): void {
            const requestKey = actionOperationRequestAddressKey(request);
            const exactOperation = requestKeyForOperation(operation) === requestKey
                ? operation
                : latestOperationByRequestKey.get(requestKey);
            if (!exactOperation && !registrationsByRequestKey.has(requestKey)) return;
            presentedRequestKeys.add(requestKey);
            if (exactOperation) acknowledgePresented(exactOperation);
        },
        reset(): void {
            registrationsByRequestKey.clear();
            requestKeyByOperationKey.clear();
            presentedOperationIds.clear();
            acknowledgedOperationIds.clear();
            latestOperationByRequestKey.clear();
            presentedRequestKeys.clear();
        },
    });
}

export type ActionOperationPresentationCoordinator = ReturnType<typeof createActionOperationPresentationCoordinator>;
