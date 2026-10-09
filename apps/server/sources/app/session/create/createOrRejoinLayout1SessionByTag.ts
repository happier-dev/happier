import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
} from "@happier-dev/protocol";

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { publishSessionArchiveTransition } from "@/app/session/archive/publishSessionArchiveTransition";
import {
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { parsePersistedSessionOwnerMetadataEnvelopeV1 } from "@/app/session/metadata/sessionOwnerMetadataPersistence";
import { readSessionOrganizationPlacementInTx } from "@/app/session/organization/organizationMutations";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/db";

import {
    ensureLayout1SessionCreateInvariantsInTx,
    readSessionCreatorCurrentness,
} from "./layout1SessionCreateInvariants";
import {
    applyRequestedSessionPlacementInTx,
    insertLayout1SessionRowInTx,
    type Layout1SessionCreateOutcome,
} from "./layout1SessionRowWrite";
import { classifyLayout1SessionCreateThrow } from "./createFreshBoundLayout1Session";
import type { PreparedLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { restoreSessionTagRejoinInTx } from "./restoreSessionTagRejoinInTx";
import type { ExternalActionExecutionAuthorizationBindingV1 } from "@happier-dev/protocol/actions";
import { readSessionCreationApiTokenIdInTx } from './apiTokenSessionCreationAuthorization';

/**
 * Ordinary released create-or-rejoin identity: `(accountId, tag)` owns
 * idempotent Session creation for every existing client. A rejoin never
 * rewrites stored content, placement or mode; its ordinary lifecycle restores
 * archived rows and refreshes recency for a stopped Session.
 */

function isExistingSessionStorageCompatibleWithCreateRequest(params: Readonly<{
    requestedStorageState: "machine_only" | undefined;
    existingStorageState: string;
}>): boolean {
    if (params.requestedStorageState !== "machine_only") {
        return params.existingStorageState === "hosted";
    }

    // `machine_only` declares external storage authority at creation time. A
    // concurrent materializer may advance that same authority before this
    // create-or-load request observes the row, so its successor states remain
    // valid loads. Hosted and legacy/unknown rows are not admitted here.
    return params.existingStorageState === "machine_only"
        || params.existingStorageState === "server_partial"
        || params.existingStorageState === "snapshot_complete";
}

async function resolveExistingLayout1SessionInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    accountEncryptionMode: "e2ee" | "plain",
): Promise<Layout1SessionCreateOutcome | null> {
    const existing = await tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: prepared.accountId,
                tag: prepared.tag,
            },
        },
    });
    if (!existing) return null;

    const storedOwnerEnvelope = parsePersistedSessionOwnerMetadataEnvelopeV1({
        metadataLayoutVersion: existing.metadataLayoutVersion ?? 0,
        accountMode: accountEncryptionMode,
        ownerMetadata: existing.ownerMetadata,
        allowRetainedDevelopmentCiphertext: true,
    });
    if (
        (existing.metadataLayoutVersion ?? 0) === SESSION_METADATA_LAYOUT_VERSION_V1
        && !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
            accountMode: accountEncryptionMode,
            envelope: storedOwnerEnvelope,
        }).ok
    ) {
        return { kind: "rejected", rejection: { reason: "privacy-upgrade-required" } };
    }

    if (
        (existing.metadataLayoutVersion ?? 0) !== SESSION_METADATA_LAYOUT_VERSION_V1
        || existing.encryptionMode !== prepared.effectiveEncryptionMode
        || !isExistingSessionStorageCompatibleWithCreateRequest({
            requestedStorageState: prepared.requestedStorageState,
            existingStorageState: existing.currentStorageState,
        })
    ) {
        return { kind: "rejected", rejection: { reason: "privacy-upgrade-required" } };
    }

    try {
        projectSessionMetadataForRecipient({
            session: existing,
            recipient: {
                type: "owner",
                accountId: prepared.accountId,
                accountMode: accountEncryptionMode,
            },
        });
    } catch (error) {
        if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
            return { kind: "rejected", rejection: { reason: "privacy-upgrade-required" } };
        }
        throw error;
    }

    const restored = await restoreSessionTagRejoinInTx(tx, existing);
    return {
        kind: "rejoined",
        session: restored.session,
        ownerAccountMode: accountEncryptionMode,
        organizationPlacement: await readSessionOrganizationPlacementInTx(tx, {
            accountId: prepared.accountId,
            sessionId: existing.id,
        }),
        publication: restored.publication,
    };
}

/**
 * Canonical ordinary Layout-1 entry: create the `(accountId, tag)` Session or
 * rejoin the existing one. Throws `SessionCreationPlacementError` so an invalid
 * requested placement rolls back the Session row with it.
 */
export async function createOrRejoinLayout1SessionByTagInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
    sessionCreationAuthorization?: ExternalActionExecutionAuthorizationBindingV1,
): Promise<Layout1SessionCreateOutcome> {
    // Both fresh creation and the released tag-rejoin mutation consume the
    // same already-verified invocation inside this transaction.
    await readSessionCreationApiTokenIdInTx(tx, prepared.accountId, sessionCreationAuthorization);
    const invariants = await ensureLayout1SessionCreateInvariantsInTx(tx, prepared);
    if (!invariants.ok) {
        return { kind: "rejected", rejection: invariants.rejection };
    }

    const existing = await resolveExistingLayout1SessionInTx(
        tx,
        prepared,
        invariants.accountEncryptionMode,
    );
    if (existing) return existing;

    const created = await insertLayout1SessionRowInTx(tx, {
        prepared,
        effectiveEncryptionMode: invariants.effectiveEncryptionMode,
        ownerAccountMode: invariants.accountEncryptionMode,
        authentication,
        sessionCreationAuthorization,
    });
    return {
        kind: "created",
        session: created,
        ownerAccountMode: invariants.accountEncryptionMode,
        organizationPlacement: await applyRequestedSessionPlacementInTx(tx, {
            prepared,
            sessionId: created.id,
        }),
    };
}

/**
 * Rejoin-only entry for the unique-insert loser. It must not re-apply creation
 * input: the winner's row, placement and stored content are authoritative.
 * Returns `null` when the winner is no longer visible.
 */
export async function rejoinLayout1SessionByTagInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    sessionCreationAuthorization?: ExternalActionExecutionAuthorizationBindingV1,
): Promise<Layout1SessionCreateOutcome | null> {
    // The unique-insert loser starts a fresh transaction: its original
    // invocation must still be current before restoring the winner's row.
    await readSessionCreationApiTokenIdInTx(tx, prepared.accountId, sessionCreationAuthorization);
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.accountId);
    const currentness = await readSessionCreatorCurrentness(tx, prepared.accountId);
    if (currentness?.status === "inactive") {
        return { kind: "rejected", rejection: { reason: "account-disabled" } };
    }
    if (currentness === null || currentness.status !== "ready") {
        return { kind: "rejected", rejection: { reason: "invalid-params" } };
    }
    return resolveExistingLayout1SessionInTx(
        tx,
        prepared,
        currentness.currentness.encryptionMode,
    );
}

/**
 * Owner-level orchestration for callers that do not compose a wider
 * transaction: one create-or-rejoin transaction, and the rejoin-only retry a
 * competing create forces through the unique `(accountId, tag)` insert.
 */
export async function createOrRejoinLayout1SessionByTag(
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
    sessionCreationAuthorization?: ExternalActionExecutionAuthorizationBindingV1,
): Promise<Layout1SessionCreateOutcome> {
    try {
        const outcome = await inTx(async (tx) => createOrRejoinLayout1SessionByTagInTx(tx, prepared, authentication, sessionCreationAuthorization));
        if (outcome.kind === "rejoined" && outcome.publication) {
            await publishSessionArchiveTransition(outcome.publication);
        }
        return outcome;
    } catch (error) {
        const rejection = classifyLayout1SessionCreateThrow(error);
        // The reserved-identity refusals cannot reach a tag create.
        if (rejection && rejection.reason !== "session-id-taken" && rejection.reason !== "session-tag-taken") {
            return { kind: "rejected", rejection };
        }
        if (!isPrismaErrorCode(error, "P2002")) {
            throw error;
        }

        // A competing Layout-1 create can pass the initial lookup and lose the
        // unique `(accountId, tag)` insert. It must rejoin the winner's atomic
        // placement rather than retrying a placement write of its own.
        const rejoined = await inTx(async (tx) => rejoinLayout1SessionByTagInTx(tx, prepared, sessionCreationAuthorization));
        if (rejoined === null) throw error;
        if (rejoined.kind === "rejoined" && rejoined.publication) {
            await publishSessionArchiveTransition(rejoined.publication);
        }
        return rejoined;
    }
}
