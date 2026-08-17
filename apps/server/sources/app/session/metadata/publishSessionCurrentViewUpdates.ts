import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionMetadataRecipientProjectionV1Schema,
} from "@happier-dev/protocol";

import {
    buildSessionMetadataRecipientUpdate,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import {
    projectSessionMetadataForRecipient,
    type SessionMetadataRecipientProjectionInput,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

/**
 * The one publisher for a committed Session current view.
 *
 * Every writer that commits new `metadata`/`ownerMetadata`/`agentState` must
 * announce it through here. The projection decision itself is NOT made here —
 * `projectSessionMetadataForRecipient` remains its only owner — but the
 * cursor -> recipient -> payload -> emit glue is, so a second writer cannot
 * quietly announce a current view differently, or forget to announce it.
 *
 * Layout selects both the projection authority and the audience, and the two
 * shapes are not interchangeable:
 *
 * - `envelope_tuple_v1` projects PER RECIPIENT (owner and shared participants
 *   legitimately see different envelopes) and publishes to every participant
 *   cursor;
 * - `legacy_v0` has no per-recipient envelope at all. The projector throws
 *   `SessionMetadataPrivacyUpgradeRequiredError` for a non-owner, so this layout
 *   publishes ONLY to the owner and shared participants learn through their
 *   ordinary change cursor instead.
 *
 * Returns `{ ok: false }` when the projection cannot be built, so the caller can
 * fail its request rather than emit a malformed or over-disclosing payload. The
 * write has already committed at that point; refusing to publish is the safe
 * direction, because the change cursor still wakes every participant.
 */

export type SessionCurrentViewPublicationSourceV1 =
    | Readonly<{
        kind: "envelope_tuple_v1";
        sessionOwnerId: string;
        ownerAccountMode: "plain" | "e2ee";
        sharedMetadata: Readonly<{ version: number; value: string }>;
        ownerMetadata: Readonly<{ value: string }>;
        agentState: Readonly<{ version: number; value: string | null }>;
      }>
    | Readonly<{
        kind: "legacy_v0";
        sessionOwnerId: string;
        /**
         * The stored row, passed to the projector unchanged so IT keeps owning
         * the layout dispatch. A concurrent layout migration between the write
         * and this read must not be flattened to layout zero here.
         */
        session: SessionMetadataRecipientProjectionInput;
      }>;

export type PublishSessionCurrentViewUpdatesResult =
    | { ok: true }
    | { ok: false };

export async function publishSessionCurrentViewUpdates(params: Readonly<{
    sessionId: string;
    participantCursors: readonly SessionParticipantCursor[];
    source: SessionCurrentViewPublicationSourceV1;
}>): Promise<PublishSessionCurrentViewUpdatesResult> {
    const { sessionId, participantCursors, source } = params;

    if (source.kind === "legacy_v0") {
        let payloadProjection;
        try {
            payloadProjection = projectSessionMetadataForRecipient({
                session: source.session,
                recipient: { type: "legacy_owner", accountId: source.sessionOwnerId },
            });
        } catch {
            return { ok: false };
        }

        await Promise.all(participantCursors
            .filter(({ accountId }) => accountId === source.sessionOwnerId)
            .map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildUpdateSessionUpdate(
                        sessionId,
                        cursor,
                        randomKeyNaked(12),
                        {
                            value: payloadProjection.metadata,
                            version: payloadProjection.metadataVersion,
                        },
                        {
                            value: payloadProjection.agentState,
                            version: payloadProjection.agentStateVersion,
                        },
                    ),
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                });
            }));
        return { ok: true };
    }

    let publications;
    try {
        publications = participantCursors.map(({ accountId, cursor }) => ({
            accountId,
            cursor,
            projection: SessionMetadataRecipientProjectionV1Schema.parse(
                projectSessionMetadataForRecipient({
                    session: {
                        accountId: source.sessionOwnerId,
                        metadata: source.sharedMetadata.value,
                        metadataVersion: source.sharedMetadata.version,
                        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
                        ownerMetadata: source.ownerMetadata.value,
                        agentState: source.agentState.value,
                        agentStateVersion: source.agentState.version,
                    },
                    recipient: accountId === source.sessionOwnerId
                        ? {
                            type: "owner",
                            accountId,
                            accountMode: source.ownerAccountMode,
                          }
                        : {
                            type: "shared",
                            accountId,
                            ownerAccountMode: source.ownerAccountMode,
                          },
                }),
            ),
        }));
    } catch {
        return { ok: false };
    }

    await Promise.all(publications.map(async ({ accountId, cursor, projection }) => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildSessionMetadataRecipientUpdate(
                sessionId,
                cursor,
                randomKeyNaked(12),
                projection,
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId },
        });
    }));
    return { ok: true };
}
