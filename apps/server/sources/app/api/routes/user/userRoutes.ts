import { z } from "zod";
import { Fastify } from "../../types";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { RelationshipStatus, type RelationshipStatus as RelationshipStatusType } from "@/storage/prisma";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile } from "@/app/social/type";
import {
    FriendsDisabledError,
    FriendsIdentityProviderRequiredError,
    FriendsUsernameRequiredError,
} from "@/app/social/friendAdd";
import { resolveFriendsPolicyFromServerFeatures } from "@/app/social/resolveFriendsPolicyFromServerFeatures";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { UserProfileSchema } from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";

export async function userRoutes(app: Fastify) {
    const friendsApp = createServerFeatureGatedRouteApp(app, "social.friends", process.env);

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
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
        const identities = user.AccountIdentity.map((identity) => ({
            provider: identity.provider,
            providerLogin: identity.providerLogin ?? null,
            profile: identity.profile,
            showOnProfile: Boolean(identity.showOnProfile),
        }));
        return reply.send({
            user: buildUserProfile(user as any, status, identities)
        });
    });

    // Search for users
    friendsApp.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string()
            }),
            response: {
                200: z.object({
                    users: z.array(UserProfileSchema)
                }),
                404: NotFoundSchema,
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const friendsPolicy = resolveFriendsPolicyFromServerFeatures(process.env);
        const requiredIdentityProviderId = friendsPolicy.requiredIdentityProviderId;

        const { query } = request.query;

        const serverFlavorRaw = (process.env.HAPPIER_SERVER_FLAVOR ?? process.env.HAPPY_SERVER_FLAVOR)?.trim();
        const fallbackProvider = serverFlavorRaw === "light" ? "sqlite" : "postgres";
        const dbProvider = getDbProviderFromEnv(process.env, fallbackProvider);
        const username =
            dbProvider === "sqlite"
                ? { startsWith: query }
                : { startsWith: query, mode: 'insensitive' as const };

        // Search for users by username, first 10 matches
        const users = await db.account.findMany({
            where: {
                username,
                ...(requiredIdentityProviderId
                    ? {
                          AccountIdentity: {
                              some: { provider: requiredIdentityProviderId },
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
            take: 10,
            orderBy: {
                username: 'asc'
            }
        });

        // Resolve relationship status for each user
        const userProfiles = await Promise.all(users.map(async (user) => {
            const relationship = await db.userRelationship.findFirst({
                where: {
                    fromUserId: request.userId,
                    toUserId: user.id
                }
            });
            const status: RelationshipStatusType = relationship?.status || RelationshipStatus.none;
            const identities = user.AccountIdentity.map((identity) => ({
                provider: identity.provider,
                providerLogin: identity.providerLogin ?? null,
                profile: identity.profile,
                showOnProfile: Boolean(identity.showOnProfile),
            }));
            return buildUserProfile(user as any, status, identities);
        }));

        return reply.send({
            users: userProfiles
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
                    user: UserProfileSchema.nullable()
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
                    user: UserProfileSchema.nullable()
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
