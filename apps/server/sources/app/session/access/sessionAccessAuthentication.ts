import type { AuthTokenAuthenticationEvidenceV1 } from "@happier-dev/protocol";
import type { ApiTokenGrantV1, CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";

import {
    qualifyTeamAuthenticationInTx,
    qualifyTeamAuthenticationsInTx,
    type TeamAuthenticationQualificationV1,
} from "@/app/auth/entry/qualifyTeamAuthentication";
import type { Tx } from "@/storage/inTx";
import type { Socket } from "socket.io";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";

export type SessionAccessAuthentication = Readonly<{
    env: NodeJS.ProcessEnv;
    authority: "present_user" | "account_automation";
    authenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
    tokenEpoch?: number;
    sessionRuntimePrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    /** Direct PAT capability ceiling; a verified signed Action effect has its own admission. */
    apiTokenGrant?: ApiTokenGrantV1;
    /** Verified caller constraints also survive signed Action-effect admission. */
    callerInputConstraints?: CallerInputConstraintsV1;
}>;

/** Exact request credential context stamped by the central authentication decorator. */
export function readSessionAccessAuthenticationFromRequest(request: Readonly<{
    authAuthority?: "present_user" | "account_automation";
    authTokenAuthenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    authTokenEpoch?: number;
    sessionRuntimePrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    apiTokenPrincipal?: Readonly<{ grant: ApiTokenGrantV1 }>;
    externalActionExecutionAuthorized?: boolean;
    externalActionInputConstraints?: CallerInputConstraintsV1;
}>): SessionAccessAuthentication {
    if (!request.authAuthority) {
        throw new Error("Verified request authentication authority is unavailable");
    }
    if (request.externalActionExecutionAuthorized === true && !request.externalActionInputConstraints) {
        throw new Error("Verified Action input constraints are unavailable");
    }
    return {
        env: process.env,
        authority: request.authAuthority,
        authenticationEvidence: request.authTokenAuthenticationEvidence,
        ...(request.externalActionExecutionAuthorized === true ? {
            callerInputConstraints: request.externalActionInputConstraints,
        } : request.apiTokenPrincipal ? {
            callerInputConstraints: {
                models: request.apiTokenPrincipal.grant.models,
                permissionModes: request.apiTokenPrincipal.grant.permissionModes,
            },
            apiTokenGrant: request.apiTokenPrincipal.grant,
        } : {}),
        ...(request.authTokenEpoch !== undefined ? { tokenEpoch: request.authTokenEpoch } : {}),
        ...(request.sessionRuntimePrincipal
            ? { sessionRuntimePrincipal: request.sessionRuntimePrincipal }
            : {}),
    };
}

/** Exact credential facts captured at this socket's latest authenticated admission. */
export function readSessionAccessAuthenticationFromSocket(socket: Pick<Socket, "data">): SessionAccessAuthentication {
    if (!socket.data.authAuthority) {
        throw new Error("Verified socket authentication authority is unavailable");
    }
    const admission = (socket.data as Readonly<{
        ephemeralRunnerAdmission?: Readonly<{ kind?: string; principal?: VerifiedEphemeralSessionRunnerPrincipal }>;
        apiTokenPrincipal?: Readonly<{ grant: ApiTokenGrantV1 }>;
    }>).ephemeralRunnerAdmission;
    const runtimePrincipal = admission?.kind === "session-runtime" || admission?.kind === "machine-runtime"
        ? admission.principal : undefined;
    const apiTokenPrincipal = socket.data.apiTokenPrincipal as Readonly<{ grant: ApiTokenGrantV1 }> | undefined;
    return {
        env: process.env,
        authority: runtimePrincipal ? "account_automation" : socket.data.authAuthority,
        authenticationEvidence: socket.data.authTokenAuthenticationEvidence,
        ...(runtimePrincipal ? { sessionRuntimePrincipal: runtimePrincipal } : {}),
        ...(apiTokenPrincipal ? { apiTokenGrant: apiTokenPrincipal.grant,
            callerInputConstraints: { models: apiTokenPrincipal.grant.models, permissionModes: apiTokenPrincipal.grant.permissionModes },
        } : {}),
    };
}

/**
 * The credential context of background delivery: OS push, the content-free wake
 * and the badge refresh.
 *
 * These legs are produced by a committed server-side event, not by a request, so
 * there is no verified credential evidence to carry. Reading them through the
 * same canonical access owner as every request — rather than through a
 * structural entitlement projection that ignores Team authentication — keeps the
 * owner, direct and inherited-authentication arms delivering exactly as before
 * while a restricted Team admits a recipient only when it currently qualifies
 * with no evidence. What a restricted Team then withholds is delivery metadata
 * (that an event happened, for which Session, and the aggregate badge count);
 * no alert has ever carried Session content.
 *
 * `account_automation` is the honest authority for a server-side leg acting on
 * an Account's behalf: qualification is decided by the presented evidence, and
 * this leg presents none.
 */
export function backgroundDeliveryAuthentication(): SessionAccessAuthentication {
    return {
        env: process.env,
        authority: "account_automation",
        authenticationEvidence: undefined,
    };
}

export async function qualifySessionTeamAuthenticationInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        team: Readonly<{ id: string; authenticationPolicy: unknown }>;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<TeamAuthenticationQualificationV1> {
    const authentication = input.authentication;
    return qualifyTeamAuthenticationInTx(tx, {
        env: authentication.env,
        team: input.team,
        accountId: input.accountId,
        verifiedCredentialEvidence: authentication.authenticationEvidence,
        operationContext: { kind: authentication.authority },
    });
}

/**
 * The Team ids that currently qualify for one credential context, for a
 * set-oriented reader that answers many Accounts from one read.
 *
 * Qualification depends on an Account only through the evidence that Account's
 * credential presented, so a set of Accounts shares one answer exactly while no
 * evidence is presented — background delivery, where a Team qualifies only by
 * inheriting the Home's methods. A credential belongs to exactly one Account,
 * so a presented one resolves exactly one Account here and a mistaken batch
 * fails closed rather than answering one recipient with another's credential.
 * The decision itself stays the canonical qualifier's.
 */
export async function resolveQualifiedSessionTeamIdsInTx(
    tx: Tx,
    input: Readonly<{
        accountIds: readonly string[];
        teams: readonly Readonly<{ id: string; authenticationPolicy: unknown }>[];
        authentication: SessionAccessAuthentication;
    }>,
): Promise<ReadonlySet<string>> {
    const authentication = input.authentication;
    const accountIds = [...new Set(input.accountIds)];
    if ((authentication.authenticationEvidence?.length ?? 0) > 0 && accountIds.length > 1) {
        throw new Error("Presented credential evidence qualifies Teams for exactly one Account");
    }
    const qualified = new Set<string>();
    if (accountIds.length === 0 || input.teams.length === 0) return qualified;
    // A batch of more than one presents no evidence by the invariant above, and
    // evidence is the only way an Account reaches this decision, so the Account
    // named here is the exact one whenever it matters.
    const qualifications = await qualifyTeamAuthenticationsInTx(tx, {
        env: authentication.env,
        teams: input.teams,
        accountId: accountIds[0],
        verifiedCredentialEvidence: authentication.authenticationEvidence,
        operationContext: { kind: authentication.authority },
    });
    for (const [teamId, qualification] of qualifications) {
        if (qualification.status === "satisfied") qualified.add(teamId);
    }
    return qualified;
}
