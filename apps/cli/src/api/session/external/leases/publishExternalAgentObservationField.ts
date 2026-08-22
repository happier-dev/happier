import {
    readExternalAgentObservationSessionState,
    writeExternalAgentObservationSessionState,
} from '@happier-dev/agents';
import {
    readLinkedExternalSessionV1FromMetadata,
    reserveExternalSessionCompletedBoundaryV1,
    type ExternalAgentObservationSnapshotV1,
    type SessionMetadata,
} from '@happier-dev/protocol';

import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { readStoredCredentials } from '@/persistence';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import {
    getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { deepEqual } from '@/utils/deterministicJson';

type PublishExternalAgentObservationFieldInput = Readonly<{
    sessionId: string;
    fieldId: 'runtime.externalAgent';
    value: ExternalAgentObservationSnapshotV1;
}>;

type ReadyNotificationInput = Readonly<{
    sessionId: string;
    sessionTitle: string | null;
    boundaryId: string;
}>;

type ExternalAgentObservationFieldPublisherParams = Readonly<{
    shouldSendReadyNotification(sessionId: string): boolean;
    readCredentials?: typeof readStoredCredentials;
    updateMetadataForTarget?: typeof updateSessionMetadataForTarget;
    dispatchReadyNotification?: (input: ReadyNotificationInput) => Promise<void>;
}>;

class StaleExternalAgentObservationPublicationError extends Error {}

function hasSameObservationTarget(
    current: ExternalAgentObservationSnapshotV1,
    candidate: ExternalAgentObservationSnapshotV1,
): boolean {
    return (
        current.linkGeneration === candidate.linkGeneration
        && deepEqual(
            current.qualifiedLinkIdentity,
            candidate.qualifiedLinkIdentity,
        )
    );
}

function hasSameDurableObservationLink(
    metadata: SessionMetadata,
    candidate: ExternalAgentObservationSnapshotV1,
): boolean {
    const currentLink = readLinkedExternalSessionV1FromMetadata(metadata);
    if (
        !currentLink
        || currentLink.linkedAtMs === undefined
        || String(currentLink.linkedAtMs) !== candidate.linkGeneration
    ) {
        return false;
    }
    return (
        !currentLink.qualifiedIdentity
        || deepEqual(
            currentLink.qualifiedIdentity,
            candidate.qualifiedLinkIdentity,
        )
    );
}

async function dispatchExternalSessionReadyNotification(
    input: ReadyNotificationInput,
): Promise<void> {
    const settings = getActiveAccountSettingsSnapshot();
    if (!settings || settings.source === 'none') {
        return;
    }
    await dispatchActivityNotificationAsync({
        settings: settings.settings,
        settingsSecretsReadKeys: settings.settingsSecretsReadKeys,
        event: {
            topic: 'ready',
            sessionId: input.sessionId,
            sessionTitle: input.sessionTitle,
            waitingForCommandLabel: input.sessionTitle ?? input.sessionId,
        },
    });
}

/**
 * Publishes the canonical External Agent snapshot and uses its durable completed
 * boundary as the one best-effort ready-notification reservation.
 *
 * The boundary commits before dispatch. A crash before dispatch may lose that
 * notification, while a crash after dispatch cannot replay it after restart.
 */
export function createExternalAgentObservationFieldPublisher(
    params: ExternalAgentObservationFieldPublisherParams,
) {
    const readCurrentCredentials =
        params.readCredentials ?? readStoredCredentials;
    const updateMetadata = params.updateMetadataForTarget
        ?? updateSessionMetadataForTarget;
    const dispatchReadyNotification = params.dispatchReadyNotification
        ?? dispatchExternalSessionReadyNotification;

    return async (
        input: PublishExternalAgentObservationFieldInput,
    ): Promise<void> => {
        const credentials = await readCurrentCredentials();
        if (!credentials) {
            throw new Error(
                'External Agent observation publication requires authentication',
            );
        }

        let reservedBoundaryId: string | null = null;
        const result = await updateMetadata({
            credentials,
            idOrPrefix: input.sessionId,
            updater: (metadata) => {
                reservedBoundaryId = null;
                if (
                    !hasSameDurableObservationLink(
                        metadata as SessionMetadata,
                        input.value,
                    )
                ) {
                    throw new StaleExternalAgentObservationPublicationError();
                }
                const current = readExternalAgentObservationSessionState(
                    metadata as SessionMetadata,
                ).value;
                const currentForTarget = (
                    current
                    && hasSameObservationTarget(current, input.value)
                )
                    ? current
                    : null;
                let next = input.value;

                if (input.value.boundary) {
                    const reservation = reserveExternalSessionCompletedBoundaryV1(
                        currentForTarget?.boundary ?? null,
                        input.value.boundary,
                    );
                    next = {
                        ...input.value,
                        boundary: reservation.boundary,
                    };
                    if (reservation.outcome === 'reserved') {
                        reservedBoundaryId = reservation.boundary.id;
                    }
                } else if (currentForTarget?.boundary) {
                    next = {
                        ...input.value,
                        boundary: currentForTarget.boundary,
                    };
                }

                return writeExternalAgentObservationSessionState(
                    metadata,
                    next,
                );
            },
        })
            .catch((error: unknown) => {
                if (
                    error
                    instanceof StaleExternalAgentObservationPublicationError
                ) {
                    return null;
                }
                throw error;
            });
        if (!result) {
            return;
        }
        if (!result.ok) {
            throw new Error(
                `External Agent observation metadata update failed: ${result.code}`,
            );
        }

        const boundaryId = reservedBoundaryId as string | null;
        if (
            !boundaryId
            || !params.shouldSendReadyNotification(input.sessionId)
        ) {
            return;
        }

        const sessionTitle = getSessionNotificationTitle(
            () => result.metadata,
        );
        await dispatchReadyNotification({
            sessionId: input.sessionId,
            sessionTitle,
            boundaryId,
        }).catch(() => undefined);
    };
}
