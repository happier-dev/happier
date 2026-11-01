import { SESSION_METADATA_LAYOUT_VERSION_V1, validateSessionOwnerMetadataEnvelopeForAccountModeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { publishSessionArchiveTransition } from "@/app/session/archive/publishSessionArchiveTransition";
import {
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { parsePersistedSessionOwnerMetadataEnvelopeV1 } from "@/app/session/metadata/sessionOwnerMetadataPersistence";
import { readSessionOrganizationPlacementInTx } from "@/app/session/organization/organizationMutations";
import { inTx, transactionResult, type TransactionResult, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/db";
import { acquireLayout1SessionCreatePublicationAdmissionInTx, prepareLayout1SessionCreatePublicationAdmission } from "./sessionCreationPublicationAudience";

import {
    ensureLayout1SessionCreateInvariantsInTx,
    readSessionCreatorCurrentness,
    type Layout1SessionCreateInvariants,
} from "./layout1SessionCreateInvariants";
import {
    applyRequestedSessionPlacementInTx,
    insertLayout1SessionRowInTx,
    type Layout1SessionCreateOutcome,
    SessionCreationOriginError,
} from "./layout1SessionRowWrite";
import { validateDiscussionParticipantBirthInTx, bindDiscussionParticipantSessionInTx } from "@/app/discussions/accessService";
import { classifyLayout1SessionCreateThrow } from "./createFreshBoundLayout1Session";
import type { PreparedLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { restoreSessionTagRejoinInTx } from "./restoreSessionTagRejoinInTx";
import type { SessionCreationExecutionAuthorization } from './apiTokenSessionCreationAuthorization';
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
    authentication?: SessionAccessAuthentication,
): Promise<Layout1SessionCreateOutcome | TransactionResult<Layout1SessionCreateOutcome> | null> {
    const existing = await tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: prepared.accountId,
                tag: prepared.tag,
            },
        },
    });
    if (!existing) return null;
    if (existing.originKind === "discussion" || prepared.discussionParticipant) {
        if (!authentication || !prepared.discussionParticipant || !prepared.discussionParticipantLaunch
            || existing.originKind !== "discussion"
            || existing.originDiscussionId !== prepared.discussionParticipant.discussionId
            || existing.originDiscussionParticipantSlotId !== prepared.discussionParticipant.participantSlotId) {
            throw new SessionCreationOriginError();
        }
        const admission = await validateDiscussionParticipantBirthInTx(tx, {
            accountId: prepared.accountId, discussionParticipant: prepared.discussionParticipant,
            launch: prepared.discussionParticipantLaunch, authentication,
        });
        if (!admission.ok || admission.value.sessionId !== existing.id) throw new SessionCreationOriginError();
    }

    const storedOwnerEnvelope = parsePersistedSessionOwnerMetadataEnvelopeV1({
        metadataLayoutVersion: existing.metadataLayoutVersion ?? 0,
        accountMode: accountEncryptionMode,
        ownerMetadata: existing.ownerMetadata,
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
    if (prepared.discussionParticipant && prepared.discussionParticipantLaunch && authentication) {
        const bound = await bindDiscussionParticipantSessionInTx(tx, {
            accountId: prepared.accountId, discussionParticipant: prepared.discussionParticipant,
            launch: prepared.discussionParticipantLaunch, sessionId: existing.id, authentication,
        });
        if (!bound.ok) throw new SessionCreationOriginError();
    }
    const organizationPlacement = await readSessionOrganizationPlacementInTx(tx, {
        accountId: prepared.accountId,
        sessionId: existing.id,
    });
    return transactionResult<Layout1SessionCreateOutcome>(() => ({
        kind: "rejoined",
        session: restored.session,
        ownerAccountMode: accountEncryptionMode,
        organizationPlacement,
        publication: restored.resolveResult().publication,
    }));
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
    sessionCreationAuthorization?: SessionCreationExecutionAuthorization,
): Promise<Layout1SessionCreateOutcome | TransactionResult<Layout1SessionCreateOutcome>> {
    await acquireLayout1SessionCreatePublicationAdmissionInTx(tx, prepared);
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
        authentication,
    );
    if (existing) return existing;

    return await insertAdmittedLayout1SessionInTx(tx, prepared, authentication, invariants, sessionCreationAuthorization);
}

/** Both transactional entries share the same admitted row, placement and publication producer. */
async function insertAdmittedLayout1SessionInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
    invariants: Extract<Layout1SessionCreateInvariants, { ok: true }>,
    sessionCreationAuthorization?: SessionCreationExecutionAuthorization,
): Promise<Extract<Layout1SessionCreateOutcome, { kind: "created" }>> {
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
 * Only a fresh private row with Account-local admission is protected completely
 * by the existing owner-metadata fence. A Workflow birth Run belongs to that
 * same Account; its lifecycle writers take this fence before changing the Run.
 * Other referenced resources and composed admission use the prepared audience
 * path below rather than this private-birth shortcut.
 */
function hasOnlyAccountLocalCreationAdmission(
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
    authorization: SessionCreationExecutionAuthorization | undefined,
): boolean {
    return (prepared.initialTriggers?.length ?? 0) === 0
        && (prepared.initialAccess?.grants.length ?? 0) === 0
        && prepared.primaryTeamId == null
        && prepared.discussionParticipant === undefined
        && (prepared.teamCredentialBindings?.length ?? 0) === 0
        && authorization === undefined
        && authentication.sessionRuntimePrincipal === undefined
        && authentication.apiTokenGrant === undefined
        && authentication.callerInputConstraints === undefined
        && ((prepared.originKind ?? "none") === "none" && prepared.originRunId === undefined
            || prepared.originKind === "run_step" && prepared.originRunId !== undefined)
        && prepared.originSessionId === undefined
        && prepared.manager === undefined;
}

/** A tag hit ends this probe before any rejoin lifecycle or relation read/write. */
async function tryCreateAccountLocalSessionInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
): Promise<Layout1SessionCreateOutcome | null> {
    const invariants = await ensureLayout1SessionCreateInvariantsInTx(tx, prepared);
    if (!invariants.ok) return { kind: "rejected", rejection: invariants.rejection };
    const existing = await tx.session.findUnique({
        where: { accountId_tag: { accountId: prepared.accountId, tag: prepared.tag } },
        select: { id: true },
    });
    if (existing) return null;
    return await insertAdmittedLayout1SessionInTx(tx, prepared, authentication, invariants);
}

/**
 * Rejoin-only entry for the unique-insert loser. It must not re-apply creation
 * input: the winner's row, placement and stored content are authoritative.
 * Returns `null` when the winner is no longer visible.
 */
export async function rejoinLayout1SessionByTagInTx(
    tx: Tx,
    prepared: PreparedLayout1SessionCreate,
    sessionCreationAuthorization?: SessionCreationExecutionAuthorization,
    authentication?: SessionAccessAuthentication,
): Promise<Layout1SessionCreateOutcome | TransactionResult<Layout1SessionCreateOutcome> | null> {
    await acquireLayout1SessionCreatePublicationAdmissionInTx(tx, prepared);
    // The unique-insert loser starts a fresh transaction: its original
    // invocation must still be current before restoring the winner's row.
    await readSessionCreationApiTokenIdInTx(tx, prepared.accountId, sessionCreationAuthorization);
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.accountId, "content");
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
        authentication,
    );
}

/**
 * Owner-level orchestration for callers that do not compose a wider
 * transaction. Fresh Account-local creation consumes the existing Account
 * fence without certifying unrelated cursor writes. A tag hit or composed
 * admission prepares the complete existing Session audience before its reads;
 * unique-insert losers rejoin its winner through the same preparation.
 */
export async function createOrRejoinLayout1SessionByTag(
    prepared: PreparedLayout1SessionCreate,
    authentication: SessionAccessAuthentication,
    sessionCreationAuthorization?: SessionCreationExecutionAuthorization,
): Promise<Layout1SessionCreateOutcome> {
    // Each composed owner rechecks mutable admission during terminal
    // publication, including both sides of the Machine assignment/removal race.
    // Placement deletion holds its existing exclusive Account admission.
    const isolationLevel = "ReadCommitted";
    try {
        const fresh = hasOnlyAccountLocalCreationAdmission(prepared, authentication, sessionCreationAuthorization)
            ? await inTx(tx => tryCreateAccountLocalSessionInTx(tx, prepared, authentication), {
                isolationLevel: "ReadCommitted",
                transactionClass: "session.private-create",
            })
            : null;
        const outcome = fresh ?? await inTx(async (tx) => createOrRejoinLayout1SessionByTagInTx(tx, prepared, authentication, sessionCreationAuthorization), {
            isolationLevel,
            transactionClass: "session.create-or-rejoin",
            prepare: () => prepareLayout1SessionCreatePublicationAdmission(prepared),
        });
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
        const rejoined = await inTx(async (tx) => rejoinLayout1SessionByTagInTx(tx, prepared, sessionCreationAuthorization, authentication), {
            isolationLevel,
            transactionClass: "session.rejoin-after-create-race",
            prepare: () => prepareLayout1SessionCreatePublicationAdmission(prepared),
        });
        if (rejoined === null) throw error;
        if (rejoined.kind === "rejoined" && rejoined.publication) {
            await publishSessionArchiveTransition(rejoined.publication);
        }
        return rejoined;
    }
}
