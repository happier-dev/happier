import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { scheduleSessionActivityRemoteAlerts } from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { markSessionProjectionRecipientsChanged, type SessionRecipientCursor } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import type { SessionReadyProjectionUpdate } from "@/app/session/sessionWriteService";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx } from "@/storage/inTx";
import { resolveSessionAccountChangePublications } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";

export async function publishSessionReadyProjectionUpdate(params: Readonly<{
    sessionId: string;
    readyProjection?: SessionReadyProjectionUpdate;
    skipSenderAccountId?: string;
    skipSenderConnection?: ClientConnection;
    runtimeComposition?: Readonly<{
        publisherAuthority: CurrentSessionPublisherAuthority;
        ownerActivityDelivery: "rich_sender" | "home_required";
    }>;
}>): Promise<SessionRecipientCursor[]> {
    const readyProjection = params.readyProjection;
    if (!readyProjection) return [];

    const publications = await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId]);
        return markSessionProjectionRecipientsChanged({
            tx,
            sessionId: params.sessionId,
            usageAccountingChanged: false,
            memoryInputsChanged: false,
            // Pushed below as `update-session` to each recipient.
            sessionAudienceReceivesUpdate: true,
            hint: {
                latestReadyEventSeq: readyProjection.latestReadyEventSeq,
                latestReadyEventAt: readyProjection.latestReadyEventAt,
            },
        });
    });
    const recipientCursors = resolveSessionAccountChangePublications(publications);

    const session = await loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    if (session) {
        await Promise.all(recipientCursors.map(async ({ accountId, cursor }) => {
            const projection = projectSessionTranscriptPublicationRealtimeProjection(
                {
                    latestReadyEventSeq: readyProjection.latestReadyEventSeq,
                    latestReadyEventAt: readyProjection.latestReadyEventAt,
                    ...(readyProjection.latestReadyEventLocalId
                        ? { latestReadyEventLocalId: readyProjection.latestReadyEventLocalId }
                        : {}),
                },
                session,
                accountId,
            );
            if (projection.kind === "suppress") return;
            const payload = buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                projection.value,
            );
            await eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
                ...(params.skipSenderConnection && accountId === params.skipSenderAccountId
                    ? { skipSenderConnection: params.skipSenderConnection }
                    : {}),
            });
        }));
    }

    // The Activity owner derives owner responsibility from the authenticated
    // exact current publisher authority and its actual sender composition. A
    // Runner, superseded publisher, or runtime without the rich sender stays
    // on this leg.
    scheduleSessionActivityRemoteAlerts({
        sessionId: params.sessionId,
        event: "ready",
        committedMessage: { domain: "session_transcript", seq: readyProjection.latestReadyEventSeq },
        ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
    });

    return recipientCursors;
}
