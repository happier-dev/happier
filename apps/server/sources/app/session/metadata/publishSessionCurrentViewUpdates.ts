import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionMetadataRecipientProjectionV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import {
    buildSessionMetadataRecipientUpdate,
    buildAccountChangeWakeUpdate,
    type ClientConnection,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import type { SessionRecipientCursor } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
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
 * report publication failure without emitting a malformed or over-disclosing
 * payload. The write and change cursor have already committed; publication
 * failure must not contradict that mutation receipt. Ordinary cursor recovery
 * remains available to every participant.
 */

export type SessionCurrentViewPublicationSourceV1 = Readonly<{
    runtimeProjection?: Parameters<typeof buildUpdateSessionUpdate>[5];
    /**
     * Which private tuple parts this commit changed. An unchanged owner envelope
     * or Agent state is left out of the frame: its version is unchanged, so every
     * reader already holds it (or recovers it through its ordinary cursor gap).
     * Shared metadata carries the tuple revision and is always sent. Omission
     * means "all changed".
     */
    changed?: Parameters<typeof buildSessionMetadataRecipientUpdate>[5];
}> & (
    | Readonly<{
        kind: "envelope_tuple_v1";
        sessionOwnerId: string;
        ownerAccountMode: "plain" | "e2ee";
        sharedMetadata: Readonly<{ version: number; value: string }>;
        ownerMetadata: Readonly<{ value: string }>;
        agentState: Readonly<{ version: number; value: string | null }>;
        /** Omission leaves the recipient's accepted identity unchanged. */
        projectKey?: string | null;
      }>
    | (Readonly<{
        kind: "legacy_v0";
        sessionOwnerId: string;
      }> & (Readonly<{
        /**
         * The stored row, passed to the projector unchanged so IT keeps owning
         * the layout dispatch. A concurrent layout migration between the write
         * and this read must not be flattened to layout zero here.
         */
        session: SessionMetadataRecipientProjectionInput;
      }> | Readonly<{
        metadata: Readonly<{ version: number; value: string }>;
        agentState?: Readonly<{ version: number; value: string | null }>;
      }> | Readonly<{
        metadata?: Readonly<{ version: number; value: string }>;
        agentState: Readonly<{ version: number; value: string | null }>;
      }>)));

export type PublishSessionCurrentViewUpdatesResult =
    | { ok: true }
    | { ok: false };

export type SessionCurrentViewPublicationAudience = Pick<SessionCurrentViewPublicationSourceV1, 'kind' | 'sessionOwnerId'>;

/** Legacy owner-private tuples cannot supply a shared recipient's current view. */
export function publishesSessionCurrentViewForAccount(source: SessionCurrentViewPublicationAudience, accountId: string): boolean {
    return source.kind === 'envelope_tuple_v1' || accountId === source.sessionOwnerId;
}

/** A failed current-view projection must still announce the durable recovery cursor. */
export function publishSessionCurrentViewRecoveryWake(params: Readonly<{
    sessionId: string;
    recipientCursors: readonly SessionRecipientCursor[];
    source: SessionCurrentViewPublicationAudience;
}>): void {
    for (const { accountId, cursor } of params.recipientCursors) {
        if (!publishesSessionCurrentViewForAccount(params.source, accountId)) continue;
        eventRouter.emitUpdate({ userId: accountId,
            payload: buildAccountChangeWakeUpdate(cursor, randomKeyNaked(12), {
                changeKinds: ['session'], entityIds: [params.sessionId], sessionSystemRecords: [],
            }),
            recipientFilter: { type: 'account-stored-content-v3' },
        });
    }
}

export async function publishSessionCurrentViewUpdates(params: Readonly<{
    sessionId: string;
    recipientCursors: readonly SessionRecipientCursor[];
    source: SessionCurrentViewPublicationSourceV1;
    skipSenderConnection?: ClientConnection;
}>): Promise<PublishSessionCurrentViewUpdatesResult> {
    try {
        const result = await publishCurrentViews(params);
        if (result.ok) return result;
    } catch {
        // The tuple already committed. Delivery failure retains cursor recovery.
    }
    publishSessionCurrentViewRecoveryWake(params);
    return { ok: false };
}

async function publishCurrentViews(params: Parameters<typeof publishSessionCurrentViewUpdates>[0]): Promise<PublishSessionCurrentViewUpdatesResult> {
    const { sessionId, recipientCursors, source } = params;

    if (source.kind === "legacy_v0") {
        let metadata: Parameters<typeof buildUpdateSessionUpdate>[3];
        let agentState: Parameters<typeof buildUpdateSessionUpdate>[4];
        if ("session" in source) {
            try {
                const projection = projectSessionMetadataForRecipient({
                    session: source.session,
                    recipient: { type: "legacy_owner", accountId: source.sessionOwnerId },
                });
                metadata = { value: projection.metadata, version: projection.metadataVersion };
                agentState = { value: projection.agentState, version: projection.agentStateVersion };
            } catch {
                return { ok: false };
            }
        } else {
            metadata = source.metadata;
            agentState = source.agentState;
        }

        await Promise.all(recipientCursors
            .filter(({ accountId }) => publishesSessionCurrentViewForAccount(source, accountId))
            .map(async ({ accountId, cursor }) => {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildUpdateSessionUpdate(
                        sessionId,
                        cursor,
                        randomKeyNaked(12),
                        metadata,
                        agentState,
                        source.runtimeProjection,
                    ),
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                    skipSenderConnection: params.skipSenderConnection,
                });
            }));
        return { ok: true };
    }

    let publications;
    try {
        publications = recipientCursors.map(({ accountId, cursor }) => ({
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
                        ...(source.projectKey !== undefined ? { projectKey: source.projectKey } : {}),
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
                source.runtimeProjection,
                ...(source.changed ? [source.changed] as const : []),
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId },
        });
    }));
    return { ok: true };
}
