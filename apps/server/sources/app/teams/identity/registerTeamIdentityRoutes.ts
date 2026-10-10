import {
    TeamErrorV1Schema,
    TeamIdentityConnectionCreateInputV1Schema,
    TeamIdentityConnectionListInputV1Schema,
    TeamIdentityConnectionListResultV1Schema,
    TeamIdentityConnectionMutationResultV1Schema,
    TeamIdentityConnectionRefInputV1Schema,
    TeamIdentityConnectionSettingsUpdateInputV1Schema,
    TeamIdentityConnectionRemoveResultV1Schema,
    TeamIdentityConnectionRemovalPreflightV1Schema,
    TeamIdentityConnectionTestConsumeInputV1Schema,
    TeamIdentityConnectionTestConsumeResultV1Schema,
    TeamIdentityConnectionTestStartInputV1Schema,
    TeamIdentityConnectionTestStartResultV1Schema,
    TeamIdentityErrorV1Schema,
    TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
    TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
    TeamIdentityWorkosConnectionCreateInputV1Schema,
    TeamIdentityWorkosConnectionSetInputV1Schema,
    TeamIdentityWorkosReconcileInputV1Schema,
    TeamIdentityWorkosReconcileResultV1Schema,
    buildTeamMemberSignInUrl,
    teamIdentityErrorHttpStatusV1,
    type TeamIdentityErrorCodeV1,
} from "@happier-dev/protocol/teams";
import { HOME_IDENTITY_ACTION_PATHS_V1, TEAM_IDENTITY_ACTION_PATHS_V1 } from "@happier-dev/protocol/actions";
import * as home from "@happier-dev/protocol/home";
import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "@/app/api/types";
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import {
    consumeTeamIdentityConnectionTestForActor,
    createTeamIdentityConnectionForActor,
    listTeamIdentityConnectionsForActor,
    preflightTeamIdentityConnectionRemovalForActor,
    removeTeamIdentityConnectionForActor,
    setTeamIdentityConnectionEnabledForActor,
    startTeamIdentityConnectionTestForActor,
    updateTeamIdentityConnectionSettingsForActor,
} from "./teamIdentityConnectionAdministration";
import {
    createTeamWorkosConnection,
    createTeamWorkosAdminPortalLink,
    reconcileTeamWorkosConnection,
    setTeamWorkosConnection,
    type WorkosAdministrationDependencies,
} from "./teamWorkosAdministration";

// These routes sit behind the shared `teams` gate, whose disabled answer is the
// family envelope `{ error: "teams_unavailable" }`. That code is not an identity
// *service* result, so the declared failure contract is the identity vocabulary
// unioned with the family envelope — the same declared union the directory
// routes use behind the same gate.
const IdentityRouteErrorV1Schema = TeamIdentityErrorV1Schema.or(TeamErrorV1Schema);
const ErrorResponses = {
    400: IdentityRouteErrorV1Schema,
    403: IdentityRouteErrorV1Schema,
    404: IdentityRouteErrorV1Schema,
    409: IdentityRouteErrorV1Schema,
    503: IdentityRouteErrorV1Schema,
} as const;

function sendError(reply: FastifyReply, error: TeamIdentityErrorCodeV1) {
    return reply.code(teamIdentityErrorHttpStatusV1(error)).send({ error });
}

/**
 * What this route family needs beyond its own transactions.
 *
 * The member sign-in link resolver is the same one Team invitations use, so a
 * member link and an invitation link always name the identical Home. A Home
 * that publishes no application origin or portable carrier renders `null`,
 * which the overview presents as unavailable rather than as a link that only
 * works on devices which already know this Home.
 */
export type TeamIdentityRouteDependencies = WorkosAdministrationDependencies & Readonly<{
    resolveMemberSignInLinkTarget?: () => Promise<Readonly<{
        applicationOrigin: string | null;
        homeTarget: string | null;
    }>>;
}>;

export function registerTeamIdentityRoutes(
    app: Fastify,
    dependencies: TeamIdentityRouteDependencies = {},
) {
    registerScopedIdentityRoutes(app, dependencies, "team");
}

function homeInput<T extends z.ZodObject>(schema: T) {
    return schema.transform((input) => ({ ...input, teamId: null }));
}

/** Both public scopes adapt into the same administration and vendor owners. */
export function registerScopedIdentityRoutes(
    app: Fastify,
    dependencies: TeamIdentityRouteDependencies,
    scope: "home" | "team",
) {
    const workosDependencies: WorkosAdministrationDependencies = dependencies;
    const isHome = scope === "home";
    const paths = (id: keyof typeof TEAM_IDENTITY_ACTION_PATHS_V1) => isHome
        ? HOME_IDENTITY_ACTION_PATHS_V1[id.replace("teams.", "home.") as keyof typeof HOME_IDENTITY_ACTION_PATHS_V1]
        : TEAM_IDENTITY_ACTION_PATHS_V1[id];
    const schemas = {
        listInput: isHome ? homeInput(home.HomeIdentityConnectionListInputV1Schema) : TeamIdentityConnectionListInputV1Schema,
        listResult: isHome ? home.HomeIdentityConnectionListResultV1Schema : TeamIdentityConnectionListResultV1Schema,
        createInput: isHome ? homeInput(home.HomeIdentityConnectionCreateInputV1Schema) : TeamIdentityConnectionCreateInputV1Schema,
        updateInput: isHome ? homeInput(home.HomeIdentityConnectionSettingsUpdateInputV1Schema) : TeamIdentityConnectionSettingsUpdateInputV1Schema,
        refInput: isHome ? homeInput(home.HomeIdentityConnectionRefInputV1Schema) : TeamIdentityConnectionRefInputV1Schema,
        mutationResult: isHome ? home.HomeIdentityConnectionMutationResultV1Schema : TeamIdentityConnectionMutationResultV1Schema,
        removalPreflight: isHome ? home.HomeIdentityConnectionRemovalPreflightV1Schema : TeamIdentityConnectionRemovalPreflightV1Schema,
        testStartInput: isHome ? homeInput(home.HomeIdentityConnectionTestStartInputV1Schema) : TeamIdentityConnectionTestStartInputV1Schema,
        testConsumeInput: isHome ? homeInput(home.HomeIdentityConnectionTestConsumeInputV1Schema) : TeamIdentityConnectionTestConsumeInputV1Schema,
        testConsumeResult: isHome ? home.HomeIdentityConnectionTestConsumeResultV1Schema : TeamIdentityConnectionTestConsumeResultV1Schema,
        portalInput: isHome ? homeInput(home.HomeIdentityWorkosAdminPortalLinkCreateInputV1Schema) : TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
        workosCreateInput: isHome ? homeInput(home.HomeIdentityWorkosConnectionCreateInputV1Schema) : TeamIdentityWorkosConnectionCreateInputV1Schema,
        reconcileInput: isHome ? homeInput(home.HomeIdentityWorkosReconcileInputV1Schema) : TeamIdentityWorkosReconcileInputV1Schema,
        reconcileResult: isHome ? home.HomeIdentityWorkosReconcileResultV1Schema : TeamIdentityWorkosReconcileResultV1Schema,
        selectionInput: isHome ? homeInput(home.HomeIdentityWorkosConnectionSetInputV1Schema) : TeamIdentityWorkosConnectionSetInputV1Schema,
    };

    async function renderMemberSignInUrl(teamId: string): Promise<string | null> {
        const resolve = dependencies.resolveMemberSignInLinkTarget;
        if (!resolve) return null;
        const target = await resolve();
        if (target.applicationOrigin === null || !target.homeTarget?.trim()) return null;
        try {
            return buildTeamMemberSignInUrl({
                applicationOrigin: target.applicationOrigin,
                teamId,
                homeTarget: target.homeTarget,
            });
        } catch {
            // A misconfigured origin is an operator fact, not a reason to fail
            // the whole overview the administrator came here to read.
            return null;
        }
    }

    app.post(paths("teams.identity.connections.list"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.listInput,
            response: { 200: schemas.listResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await listTeamIdentityConnectionsForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        if (!result.ok) return sendError(reply, result.error);
        if (request.body.teamId === null) return reply.send({
            items: result.value.items, eligibleProviders: result.value.eligibleProviders,
        });
        return reply.send({
            ...result.value,
            memberSignInUrl: await renderMemberSignInUrl(request.body.teamId),
        });
    });

    app.post(paths("teams.identity.connections.create"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.createInput,
            response: { 200: schemas.mutationResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await createTeamIdentityConnectionForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        return result.ok ? reply.send({ connection: result.value }) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.connections.settings.update"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.updateInput,
            response: { 200: schemas.mutationResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await updateTeamIdentityConnectionSettingsForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        return result.ok ? reply.send({ connection: result.value }) : sendError(reply, result.error);
    });

    for (const [path, enabled] of [
        [paths("teams.identity.connections.enable"), true],
        [paths("teams.identity.connections.disable"), false],
    ] as const) {
        app.post(path, {
            preHandler: app.authenticate,
            schema: {
                body: schemas.refInput,
                response: { 200: schemas.mutationResult, ...ErrorResponses },
            },
        }, async (request, reply) => {
            const result = await setTeamIdentityConnectionEnabledForActor({
                ...request.body,
                actorAccountId: request.userId,
                enabled,
                ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
            }, workosDependencies);
            return result.ok ? reply.send({ connection: result.value }) : sendError(reply, result.error);
        });
    }

    app.post(paths("teams.identity.connections.remove"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.refInput,
            response: { 200: TeamIdentityConnectionRemoveResultV1Schema, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await removeTeamIdentityConnectionForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        }, workosDependencies);
        return result.ok ? reply.send(result.value) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.connections.remove.preview"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.refInput,
            response: { 200: schemas.removalPreflight, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await preflightTeamIdentityConnectionRemovalForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        return result.ok ? reply.send(result.value) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.connections.test.consume"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.testConsumeInput,
            response: { 200: schemas.testConsumeResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await consumeTeamIdentityConnectionTestForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        reply.header("Cache-Control", "no-store");
        return result.ok ? reply.send(result.value) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.connections.test.start"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.testStartInput,
            response: { 200: TeamIdentityConnectionTestStartResultV1Schema, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await startTeamIdentityConnectionTestForActor({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        });
        reply.header("Cache-Control", "no-store");
        return result.ok ? reply.send(result.value) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.workos.adminPortalLink.create"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.portalInput,
            response: { 200: TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await createTeamWorkosAdminPortalLink({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        }, workosDependencies);
        if (!result.ok) return sendError(reply, result.error);
        reply.header("Cache-Control", "no-store");
        return reply.send(result.value);
    });

    app.post(paths("teams.identity.workos.connection.create"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.workosCreateInput,
            response: { 200: schemas.mutationResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await createTeamWorkosConnection({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        }, workosDependencies);
        return result.ok ? reply.send({ connection: result.value }) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.workos.reconcile"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.reconcileInput,
            response: { 200: schemas.reconcileResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await reconcileTeamWorkosConnection({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        }, workosDependencies);
        return result.ok ? reply.send(result.value) : sendError(reply, result.error);
    });

    app.post(paths("teams.identity.workos.connection.set"), {
        preHandler: app.authenticate,
        schema: {
            body: schemas.selectionInput,
            response: { 200: schemas.mutationResult, ...ErrorResponses },
        },
    }, async (request, reply) => {
        const result = await setTeamWorkosConnection({
            ...request.body,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request, await readRequestHomeEnv(request)),
        }, workosDependencies);
        return result.ok ? reply.send({ connection: result.value }) : sendError(reply, result.error);
    });
}
