import type { Tx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { upsertVerifiedMailboxEvidenceInTx } from "./verifiedMailboxEvidence";
import {
    admitAccountContentKey,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    ensureSameServiceHomeEntryInTx,
    type SameServiceHomeEntryPreparation,
} from "@/app/accountDirectory/accountDirectoryService";
import type { PreparedIdentityConnection } from "@/app/auth/providers/identityProviders/types";
import { randomUUID } from "node:crypto";
import {
    requireTeamOAuthAdmissionInTx,
    acquireTeamOAuthAdmissionAccountsInTx,
    TeamOAuthAdmissionAbort,
} from "@/app/teams/memberships/teamOAuthAdmission";
import type { ProviderReference } from "@/app/auth/providers/providerReference";
import type { TeamOAuthAdmissionSource } from "@/app/teams/memberships/teamOAuthAdmissionSource";
import { acceptTeamInvitationAdmissionReferenceInTx } from "@/app/teams/invitations/accept";
import { changeUsernameInTx, type UsernameChange } from "@/app/social/usernameUpdate";
import { acquireTeamMutationAccountAdmissionInTx } from "@/app/teams/memberships/sessionAccessEffects";

export type FreshAccountInsertSemantics =
    | Readonly<{ kind: "must_create"; accountId: string }>
    | Readonly<{ kind: "idempotent_verified_signing_identity"; publicKey: string }>;

export class FreshAccountProvisionAbort extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = "FreshAccountProvisionAbort";
        this.code = code;
    }
}

/** Throw after the first fresh-Account effect so `inTx` cannot commit a typed failure value. */
export function abortFreshAccountProvision(code: string): never {
    throw new FreshAccountProvisionAbort(code);
}

export interface PreparedFreshAccount {
    insertSemantics: FreshAccountInsertSemantics;
    /** Required for must-create keyed admission; idempotent admission owns its verified key in the semantic. */
    publicKey?: string | null;
    encryptionMode: "plain" | "e2ee";
    usernameChange?: Extract<UsernameChange, { kind: "manual_set" | "identity_fill" }>;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
    contentKeyBinding?: VerifiedAccountContentKeyBinding | null;
    identityConnection?: PreparedIdentityConnection;
    /** Proven by the consuming admission operation, never raw provider profile. */
    verifiedMailbox?: NormalizedVerifiedEmail;
    /** Only deliberate Directory-purpose authentication supplies this effect. */
    directoryPreparation?: SameServiceHomeEntryPreparation | null;
    /** Qualified invitation audience; the caller still consumes the invitation in this transaction. */
    teamInvitationTeamId?: string;
    teamOAuthAdmission?: Readonly<{
        env: NodeJS.ProcessEnv;
        provider: ProviderReference | null | undefined;
        connection: Readonly<{ id: string; revision: number }> | null | undefined;
        source: TeamOAuthAdmissionSource | null | undefined;
    }>;
}

/**
 * Inserts fresh Account facts within the caller's admission transaction.
 * External identity/descriptor preparation precedes this boundary; the auth
 * finalizer issues its credential only after the transaction has committed.
 */
export async function provisionFreshAccountInTx(tx: Tx, prepared: PreparedFreshAccount) {
    const publicKey = prepared.insertSemantics.kind === "idempotent_verified_signing_identity"
        ? prepared.insertSemantics.publicKey
        : prepared.publicKey ?? null;
    const data = {
        id: prepared.insertSemantics.kind === "must_create"
            ? prepared.insertSemantics.accountId
            : randomUUID(),
        publicKey,
        encryptionMode: prepared.encryptionMode,
        ...(prepared.contentKeyBinding ? {
            contentPublicKey: prepared.contentKeyBinding.contentPublicKey,
            contentPublicKeySig: prepared.contentKeyBinding.contentPublicKeySignature,
        } : {}),
    };
    const existing = prepared.insertSemantics.kind === "idempotent_verified_signing_identity"
        ? await tx.account.findUnique({ where: { publicKey: prepared.insertSemantics.publicKey }, select: { id: true } }) : null;
    const accountIds = [existing?.id ?? data.id];
    const recheckAdmission = prepared.teamInvitationTeamId
        ? await acquireTeamMutationAccountAdmissionInTx(tx, {
            teamId: prepared.teamInvitationTeamId, accountIds, affectedAccountIds: accountIds,
            membershipChange: { kind: "teamMembership", teamId: prepared.teamInvitationTeamId }, intent: "exclusive",
        })
        : await acquireTeamOAuthAdmissionAccountsInTx(tx, {
            accountIds,
            provider: prepared.teamOAuthAdmission?.provider,
            connection: prepared.teamOAuthAdmission?.connection,
            admission: prepared.teamOAuthAdmission?.source,
            intent: "exclusive",
        });
    // Only the already-verified Key Challenge retry contract may select this
    // idempotent arm. Native/OAuth/mTLS/JIT/directory admission must explicitly
    // create a new Account even when a submitted signing key already exists.
    const account = prepared.insertSemantics.kind === "idempotent_verified_signing_identity"
        ? await tx.account.upsert({
            where: { publicKey: prepared.insertSemantics.publicKey },
            update: {},
            create: data,
        })
        : await tx.account.create({ data });
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
    await recheckAdmission();
    if (prepared.usernameChange) {
        await changeUsernameInTx(tx, account.id, prepared.usernameChange, prepared.usernamePolicyEnv);
    }
    if (prepared.contentKeyBinding) {
        const admission = await admitAccountContentKey(tx, {
            accountId: account.id,
            contentPublicKey: prepared.contentKeyBinding.contentPublicKey,
            contentPublicKeySignature: prepared.contentKeyBinding.contentPublicKeySignature,
        });
        if (admission.status === "key_mismatch") {
            abortFreshAccountProvision("content_public_key_mismatch");
        }
        if (admission.status === "account_not_found" || admission.status === "invalid_binding") {
            abortFreshAccountProvision("invalid_content_public_key_binding");
        }
    }
    await prepared.identityConnection?.connectInTx(tx);
    if (prepared.verifiedMailbox) {
        await upsertVerifiedMailboxEvidenceInTx(tx, {
            accountId: account.id,
            email: prepared.verifiedMailbox,
        });
    }
    if (prepared.teamOAuthAdmission) {
        await requireTeamOAuthAdmissionInTx(tx, {
            ...prepared.teamOAuthAdmission,
            accountId: account.id,
            admission: prepared.teamOAuthAdmission.source,
        });
        const invitation = prepared.teamOAuthAdmission.source?.kind === "team_invitation"
            ? prepared.teamOAuthAdmission.source
            : null;
        if (invitation) {
            const accepted = await acceptTeamInvitationAdmissionReferenceInTx(tx, {
                invitationId: invitation.invitationId,
                tokenHash: invitation.tokenHash,
                accountId: account.id,
            });
            if (
                (accepted.outcome !== "joined" && accepted.outcome !== "already_member")
                || accepted.teamId !== invitation.teamId
            ) {
                throw new TeamOAuthAdmissionAbort("team_authentication_required");
            }
        }
    }
    if (prepared.directoryPreparation) {
        await ensureSameServiceHomeEntryInTx(tx, {
            accountId: account.id,
            preparation: prepared.directoryPreparation,
        });
    }
    // Prepared identity presentation can also fill name/avatar/username. Return
    // the admitted row rather than the insertion's stale pre-connection value.
    return await tx.account.findUniqueOrThrow({ where: { id: account.id } });
}
