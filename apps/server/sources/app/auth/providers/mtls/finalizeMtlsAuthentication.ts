import type { TeamInvitationPostAuthContinuationV1 } from '@happier-dev/protocol/teams/invitation';

import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";
import { resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { auth } from "@/app/auth/auth";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { linkIdentityInTx } from "@/app/auth/providers/accountIdentityLifecycle";
import type { MtlsIdentity } from "@/app/auth/providers/mtls/mtlsIdentity";
import { provisionFreshAccountInTx } from "@/app/auth/provisionFreshAccountInTx";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { readHomeConfigEnvInTx } from "@/app/home/settings/homeSettings";
import { shouldDenyPublicSignupProvisioningAction } from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import { requireTeamInvitationFreshAccountAdmissionReferenceInTx } from "@/app/teams/invitations/freshAccountAdmission";
import { readActiveTeamInvitationAdmissionReferenceInTx } from "@/app/teams/invitations/invitationLifecycle";
import { claimTeamInvitationPostAuthContinuationInTx } from "@/app/teams/invitations/postAuthContinuation";
import { isTeamMembershipAdmissionEnabled } from "@/app/teams/memberships/membershipService";
import type { Tx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFencesInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { randomUUID } from "node:crypto";

import {
    consumeAcquiredMtlsAuthenticationClaimInTx,
    type AcquiredMtlsAuthenticationClaim,
    type MtlsTeamInvitationReference,
} from "./mtlsClaimCode";

export type MtlsFinalizationError = "invalid-code" | "not-eligible" | "account-disabled" | "e2ee-required" | "restore-required";

export class MtlsFinalizationAbort extends Error {
    constructor(readonly code: MtlsFinalizationError) {
        super(code);
        this.name = "MtlsFinalizationAbort";
    }
}

function abort(code: MtlsFinalizationError): never {
    throw new MtlsFinalizationAbort(code);
}

export async function isMtlsAcceptedByCurrentTeamPolicyInTx(
    tx: Tx,
    team: Readonly<{ id: string; authenticationPolicy: unknown }>,
    invitation: boolean,
): Promise<boolean> {
    try {
        const policy = await resolveTeamAuthenticationPolicyInTx(tx, {
            env: await readHomeConfigEnvInTx(tx),
            teamId: team.id,
            policy: team.authenticationPolicy,
            ...(invitation ? { admission: { kind: "team_invitation" as const } } : {}),
        });
        if (policy.resolution.status === "inherit") return true;
        return policy.resolution.status === "restricted"
            && policy.resolution.choices.some((choice) => choice.availability === "usable"
                && choice.reference.kind === "home_method"
                && choice.reference.methodId.trim().toLowerCase() === "mtls");
    } catch {
        return false;
    }
}

export async function finalizeMtlsAuthenticationInTx(
    tx: Tx,
    params: Readonly<{
        requestIp: unknown;
        identity: MtlsIdentity;
        team?: Readonly<{
            teamId: string;
            invitation?: MtlsTeamInvitationReference;
        }>;
        claim?: AcquiredMtlsAuthenticationClaim;
    }>,
): Promise<Readonly<{
    token: string;
    accountId: string;
    teamId?: string;
    teamInvitationContinuation?: TeamInvitationPostAuthContinuationV1;
}>> {
    const env = await readHomeConfigEnvInTx(tx);
    if (params.team?.invitation && !await isTeamMembershipAdmissionEnabled({ tx, env })) abort("not-eligible");
    const team = params.team
        ? await tx.team.findUnique({
            where: { id: params.team.teamId },
            select: { id: true, archivedAt: true, admissionMode: true, authenticationPolicy: true },
        })
        : null;
    if (params.team && (!team || team.archivedAt !== null)) abort("not-eligible");

    const existingIdentity = await tx.accountIdentity.findFirst({
        where: { provider: "mtls", providerUserId: params.identity.providerUserId },
        select: { accountId: true },
    });
    const existingAccount = existingIdentity !== null;
    let accountId: string;
    if (existingIdentity) {
        await acquireAccountSessionOwnerMetadataFencesInTx(tx, [existingIdentity.accountId], "content");
        if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
            env,
            methodId: "mtls",
            actionId: "login",
            mode: "keyless",
        })) abort("not-eligible");
        const account = await tx.account.findUnique({
            where: { id: existingIdentity.accountId },
            select: {
                status: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        if (!account) abort("not-eligible");
        if (account.status !== "active") abort("account-disabled");
        const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
        if (currentness.status === "inconsistent" || currentness.currentness.encryptionMode === "e2ee") {
            abort("restore-required");
        }
        accountId = existingIdentity.accountId;
    } else {
        const invitation = params.team?.invitation;
        if (!readAuthMtlsFeatureEnv(env).autoProvision
            || !await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env,
                methodId: "mtls",
                actionId: "provision",
                mode: "keyless",
                ...(invitation ? { admission: { kind: "team_invitation" as const } } : {}),
            })
            || (!invitation && shouldDenyPublicSignupProvisioningAction({
                env,
                requestIp: params.requestIp,
                methodId: "mtls",
                mode: "keyless",
            }))) abort("not-eligible");
        const eligibility = resolveKeylessAutoProvisionEligibility(env);
        if (!eligibility.ok) abort(eligibility.error);
        accountId = randomUUID();
        await provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: "must_create", accountId },
            publicKey: null,
            encryptionMode: eligibility.encryptionMode,
            ...(invitation ? { teamInvitationTeamId: invitation.teamId } : {}),
            identityConnection: {
                connectInTx: async (identityTx) => await linkIdentityInTx(identityTx, {
                    accountId,
                    provider: "mtls",
                    providerUserId: params.identity.providerUserId,
                    providerLogin: params.identity.providerLogin,
                    profile: params.identity.profile,
                    showOnProfile: false,
                }),
            },
        });
    }

    if (team && !params.team?.invitation) {
        const qualification = await qualifyTeamAuthenticationInTx(tx, {
            env,
            team,
            accountId,
            verifiedCredentialEvidence: [{ kind: "home_method", methodId: "mtls" }],
            operationContext: { kind: "present_user" },
        });
        if (qualification.status !== "satisfied") abort("not-eligible");
    }

    const invitation = params.team?.invitation;
    if (invitation) {
        if (!team || team.admissionMode !== "invite_only") abort("not-eligible");
        if (existingAccount) {
            if (!await readActiveTeamInvitationAdmissionReferenceInTx(tx, invitation)) abort("not-eligible");
        } else {
            const admitted = await requireTeamInvitationFreshAccountAdmissionReferenceInTx(tx, {
                ...invitation,
                accountId,
            });
            if (admitted.teamId !== team.id) abort("not-eligible");
        }
    }

    const token = await auth.createTokenInTx(tx, accountId, undefined, {
        kind: "account",
        authority: "present_user",
        authenticationEvidence: [{ kind: "home_method", methodId: "mtls" }],
    });

    let teamInvitationContinuation: TeamInvitationPostAuthContinuationV1 | undefined;
    if (params.claim && invitation && existingAccount) {
        const claimed = await claimTeamInvitationPostAuthContinuationInTx(tx, {
            reference: params.claim.key,
            expectedValue: params.claim.value,
            accountId,
            invitation,
        });
        if (!claimed) abort("invalid-code");
        teamInvitationContinuation = claimed.continuation;
    } else if (params.claim && !await consumeAcquiredMtlsAuthenticationClaimInTx(tx, params.claim)) {
        abort("invalid-code");
    }

    return {
        token,
        accountId,
        ...(team ? { teamId: team.id } : {}),
        ...(teamInvitationContinuation ? { teamInvitationContinuation } : {}),
    };
}
