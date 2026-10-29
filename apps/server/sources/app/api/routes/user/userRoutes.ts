import { z } from "zod/mini";
import { Fastify } from "../../types";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { RelationshipStatus, type RelationshipStatus as RelationshipStatusType } from "@/storage/prisma";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile, describeIdentityPresentation, toSocialIdentities } from "@/app/social/type";
import {
    FriendsDisabledError,
    FriendsIdentityProviderRequiredError,
    FriendsUsernameRequiredError,
} from "@/app/social/friendAdd";
import { resolveFriendsPolicyFromServerFeatures } from "@/app/social/resolveFriendsPolicyFromServerFeatures";
import {
    createServerFeatureGatedRouteApp,
    isServerFeatureEnabledForRequest,
} from "@/app/features/catalog/serverFeatureGate";
import { UserProfileSchema, UserRecipientEnvelopeResponseSchema, UsersSearchQueryV1Schema, UsersSearchResponseSchema } from '@happier-dev/protocol/social/friends';
import { decodeKeysetCursorV1, encodeKeysetCursorV1, readKeysetCursorIdV1, readKeysetCursorTextV1 } from '@happier-dev/protocol/pagination/keysetCursorV1';
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { buildAccountTextPrefixFilter } from "@/app/account/accountTextPrefixFilter";
import { buildSessionAccessCollaborationAccountWhere } from "@/app/session/access/sessionAccessGrantEligibility";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { portableQueryChunks } from "@/storage/portableQueryChunks";

export async function userRoutes(app: Fastify) {
    const friendsApp = createServerFeatureGatedRouteApp(app, "social.friends", process.env);

    // Exact People projection under the incumbent authenticated profile-read authority,
    // not directory discovery. A rendered page makes one read; absent ids are omitted.
    app.post('/v1/user/profiles', {
        schema: { body: z.strictObject({ ids: z.array(z.string()) }), response: { 200: UsersSearchResponseSchema } },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const ids = [...new Set(request.body.ids)];
        if (ids.length === 0) return reply.send({ users: [] });
        const [accountPages, relationshipPages] = await Promise.all([
            Promise.all(portableQueryChunks({ values: ids, bindingsPerValue: 1 }).map(chunk => db.account.findMany({
                where: { id: { in: [...chunk] } },
                include: { AccountIdentity: { select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: 'asc' } } },
            }))),
            Promise.all(portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: 1 })
                .map(chunk => db.userRelationship.findMany({ where: { fromUserId: request.userId, toUserId: { in: [...chunk] } } }))),
        ]);
        const accounts = accountPages.flat();
        const relationships = new Map(relationshipPages.flat().map(row => [row.toUserId, row.status]));
        const identities = new Map(accounts.map(account => [account.id, toSocialIdentities(account.AccountIdentity)]));
        const presentation = await describeIdentityPresentation([...identities.values()].flat());
        const profiles = new Map(accounts.map(account => [account.id, buildUserProfile({ ...account,
            // Avatar is the existing ImageRef JSON column at the database boundary.
            avatar: account.avatar as Parameters<typeof buildUserProfile>[0]['avatar'],
        }, relationships.get(account.id) ?? RelationshipStatus.none, identities.get(account.id) ?? [], presentation)]));
        return reply.send({ users: ids.flatMap(id => { const profile = profiles.get(id); return profile ? [profile] : []; }) });
    });

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: UserRecipientEnvelopeResponseSchema,
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { id } = request.params;

        // Fetch user
        const user = await db.account.findUnique({
            where: {
                id: id
            },
            include: {
                AccountIdentity: {
                    select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: "asc" },
                },
            },
        });

        if (!user) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Resolve relationship status
        const relationship = await db.userRelationship.findFirst({
            where: {
                fromUserId: request.userId,
                toUserId: id
            }
        });
        const status: RelationshipStatusType = relationship?.status || RelationshipStatus.none;

        // Build user profile
        const identities = toSocialIdentities(user.AccountIdentity);
        const profile = buildUserProfile(user as any, status, identities, await describeIdentityPresentation(identities));
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(user);
        return reply.send({
            user: {
                ...profile,
                recipientEnvelopeReadiness: readiness.status === "available"
                    ? { status: "available" as const }
                    : readiness,
            },
        });
    });

    // Search for users
    app.get('/v1/user/search', {
        schema: {
            querystring: UsersSearchQueryV1Schema,
            response: {
                200: UsersSearchResponseSchema,
                400: z.strictObject({ error: z.literal("invalid_cursor") }),
                404: NotFoundSchema,
            }
        },
        preHandler: [
            async (request, reply) => {
                const requestHomeEnv = await readRequestHomeEnv(request);
                if (request.query.purpose === "collaboration") return;
                if (!isServerFeatureEnabledForRequest("social.friends", requestHomeEnv)) {
                    return reply.code(404).send({ error: "not_found" });
                }
            },
            app.authenticate,
        ],
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const friendsPolicy = resolveFriendsPolicyFromServerFeatures(requestHomeEnv);
        const requiredIdentityProviderId = friendsPolicy.requiredIdentityProviderId;

        const { query, cursor, purpose } = request.query;
        // Collaboration eligibility is established by friendship/shared-Team
        // authority, not by the provider policy governing social discovery.
        const searchIdentityProviderId = purpose === "collaboration" ? null : requiredIdentityProviderId;

        const serverFlavorRaw = (process.env.HAPPIER_SERVER_FLAVOR ?? process.env.HAPPY_SERVER_FLAVOR)?.trim();
        const fallbackProvider = serverFlavorRaw === "light" ? "sqlite" : "postgres";
        const dbProvider = getDbProviderFromEnv(requestHomeEnv, fallbackProvider);
        const textPrefix = buildAccountTextPrefixFilter(query, dbProvider);
        const collaboration = purpose === "collaboration";

        const queryKey = `v1:user-search:${query}:${searchIdentityProviderId ?? "username"}:${purpose ?? "social"}${collaboration ? ":id" : ""}`;
        let after: Readonly<{ kind: "id"; id: string } | { kind: "username"; username: string; id: string }> | null = null;
        if (cursor) {
            const decoded = decodeKeysetCursorV1(cursor, queryKey);
            const afterUsername = decoded.status === "ok" ? readKeysetCursorTextV1(decoded.parts[0]) : null;
            const afterId = decoded.status === "ok" ? readKeysetCursorIdV1(decoded.parts[collaboration ? 0 : 1]) : null;
            if (afterId === null || (!collaboration && afterUsername === null)) {
                return reply.code(400).send({ error: "invalid_cursor" });
            }
            after = collaboration ? { kind: "id", id: afterId } : { kind: "username", username: afterUsername!, id: afterId };
        }

        // Keep the released ten-row page while making the rest of the
        // directory reachable through the same query-bound keyset owner.
        const rows = await db.account.findMany({
            where: {
                // Account.name is the current display identity; legacy first/last fields can be stale.
                ...(collaboration
                    ? { OR: [{ name: textPrefix }, { username: textPrefix }] }
                    : { username: textPrefix }),
                AND: [
                    ...(purpose === "collaboration"
                        ? [buildSessionAccessCollaborationAccountWhere(request.userId)]
                        : []),
                    ...(after
                        ? after.kind === "id" ? [{ id: { gt: after.id } }] : [{ OR: [
                            { username: { gt: after.username } },
                            { username: after.username, id: { gt: after.id } },
                        ] }]
                        : []),
                ],
                ...(searchIdentityProviderId
                    ? {
                          AccountIdentity: {
                              some: { provider: searchIdentityProviderId },
                          },
                      }
                    : {}),
            },
            include: {
                AccountIdentity: {
                    select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: "asc" },
                },
            },
            take: 11,
            // Username-less colleagues must remain pageable, including equal display names.
            orderBy: collaboration ? [{ id: 'asc' }] : [{ username: 'asc' }, { id: 'asc' }],
        });
        const users = rows.slice(0, 10);
        const last = rows.length > 10 ? users[users.length - 1] : undefined;

        // One provider presentation load for the whole search result.
        const presentation = await describeIdentityPresentation(
            users.flatMap((user) => toSocialIdentities(user.AccountIdentity)),
        );

        // Resolve relationship status for each user
        const userProfiles = await Promise.all(users.map(async (user) => {
            const relationship = await db.userRelationship.findFirst({
                where: {
                    fromUserId: request.userId,
                    toUserId: user.id
                }
            });
            const status: RelationshipStatusType = relationship?.status || RelationshipStatus.none;
            const identities = toSocialIdentities(user.AccountIdentity);
            return buildUserProfile(user as any, status, identities, presentation);
        }));

        return reply.send({
            users: userProfiles,
            nextCursor: last && (collaboration || last.username !== null)
                ? encodeKeysetCursorV1({ queryKey, parts: collaboration ? [last.id] : [last.username!, last.id] })
                : null,
        });
    });

    // Add friend
    friendsApp.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: z.nullable(UserProfileSchema)
                }),
                400: z.union([
                    z.object({ error: z.literal("username-required") }),
                    z.object({ error: z.literal("provider-required"), provider: z.string() }),
                ]),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("User not found") })]),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const user = await friendAdd(Context.create(request.userId), request.body.uid);
            return reply.send({ user });
        } catch (e) {
            if (e instanceof FriendsIdentityProviderRequiredError) {
                return reply.code(400).send({ error: "provider-required", provider: e.provider });
            }
            if (e instanceof FriendsUsernameRequiredError) {
                return reply.code(400).send({ error: 'username-required' });
            }
            if (e instanceof FriendsDisabledError) {
                return reply.code(404).send({ error: "not_found" });
            }
            throw e;
        }
    });

    friendsApp.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: z.nullable(UserProfileSchema)
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("User not found") })]),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendRemove(Context.create(request.userId), request.body.uid);
        return reply.send({ user });
    });

    friendsApp.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                }),
                404: NotFoundSchema,
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const friends = await friendList(Context.create(request.userId));
        return reply.send({ friends });
    });
};
