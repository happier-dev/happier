import {
    APP_LOCK_RECOVERY_ROUTES,
    AppLockRecoveryCodeRequestSchema,
    AppLockRecoveryErrorResponseSchema,
    AppLockRecoveryLockRequestSchema,
    AppLockRecoveryOkResponseSchema,
    AppLockRecoveryRedeemResponseSchema,
    AppLockRecoveryRegisterRequestSchema,
    AppLockMailSettingsInputSchema,
    AppLockMailSettingsResponseSchema,
    type AppLockRecoveryErrorCode,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { appLockRecoveryRegister } from "@/app/appLock/appLockRecoveryRegister";
import { appLockRecoveryRemove } from "@/app/appLock/appLockRecoveryRemove";
import { appLockRecoveryRequestResetCode } from "@/app/appLock/appLockRecoveryRequestResetCode";
import { appLockRecoveryRedeem } from "@/app/appLock/appLockRecoveryRedeem";
import { appLockMailSettingsGet } from "@/app/appLock/appLockMailSettingsGet";
import { appLockMailSettingsSave } from "@/app/appLock/appLockMailSettingsSave";
import { appLockMailSettingsSendTest } from "@/app/appLock/appLockMailSettingsSendTest";

const STATUS_BY_ERROR: Record<AppLockRecoveryErrorCode, 400 | 404 | 409 | 429 | 502> = {
    mail_not_configured: 409,
    invalid_code: 400,
    code_expired: 400,
    too_many_attempts: 400,
    cooldown: 429,
    not_found: 404,
    email_failed: 502,
};

const errorResponses = {
    400: AppLockRecoveryErrorResponseSchema,
    404: AppLockRecoveryErrorResponseSchema,
    409: AppLockRecoveryErrorResponseSchema,
    429: AppLockRecoveryErrorResponseSchema,
    502: AppLockRecoveryErrorResponseSchema,
};

function sendFailure(reply: any, failure: { error: AppLockRecoveryErrorCode; retryAfterSeconds?: number }) {
    return reply.code(STATUS_BY_ERROR[failure.error]).send(
        failure.retryAfterSeconds !== undefined
            ? { error: failure.error, retryAfterSeconds: failure.retryAfterSeconds }
            : { error: failure.error },
    );
}

/**
 * App-lock email recovery. Authenticated routes manage the caller's escrow and SMTP settings; the
 * reset routes are public because a locked device cannot unseal its credentials. All routes
 * require the `appLock.emailRecovery` server feature.
 */
export function appLockRecoveryRoutes(fastify: Fastify) {
    const app = createServerFeatureGatedRouteApp(fastify, "appLock.emailRecovery");
    const manageRateLimit = resolveApiHotEndpointRateLimit(process.env, "appLock.recovery.manage");
    const publicRateLimit = resolveApiHotEndpointRateLimit(process.env, "appLock.recovery.public");

    app.post(APP_LOCK_RECOVERY_ROUTES.register, {
        preHandler: fastify.authenticate,
        config: { rateLimit: manageRateLimit },
        schema: {
            body: AppLockRecoveryRegisterRequestSchema,
            response: { 200: AppLockRecoveryOkResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const result = await appLockRecoveryRegister({ uid: request.userId }, request.body);
        return result.ok ? reply.send({ ok: true }) : sendFailure(reply, result);
    });

    app.post(APP_LOCK_RECOVERY_ROUTES.remove, {
        preHandler: fastify.authenticate,
        config: { rateLimit: manageRateLimit },
        schema: {
            body: AppLockRecoveryLockRequestSchema,
            response: { 200: AppLockRecoveryOkResponseSchema },
        },
    }, async (request, reply) => {
        await appLockRecoveryRemove({ uid: request.userId }, request.body);
        return reply.send({ ok: true });
    });

    app.get(APP_LOCK_RECOVERY_ROUTES.mailSettings, {
        preHandler: fastify.authenticate,
        config: { rateLimit: manageRateLimit },
        schema: {
            response: { 200: AppLockMailSettingsResponseSchema },
        },
    }, async (request, reply) => {
        return reply.send({ settings: await appLockMailSettingsGet({ uid: request.userId }) });
    });

    app.put(APP_LOCK_RECOVERY_ROUTES.mailSettings, {
        preHandler: fastify.authenticate,
        config: { rateLimit: manageRateLimit },
        schema: {
            body: AppLockMailSettingsInputSchema,
            response: { 200: AppLockRecoveryOkResponseSchema },
        },
    }, async (request, reply) => {
        await appLockMailSettingsSave({ uid: request.userId }, request.body);
        return reply.send({ ok: true });
    });

    app.post(APP_LOCK_RECOVERY_ROUTES.mailSettingsTest, {
        preHandler: fastify.authenticate,
        config: { rateLimit: manageRateLimit },
        schema: {
            response: { 200: AppLockRecoveryOkResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const result = await appLockMailSettingsSendTest({ uid: request.userId });
        return result.ok ? reply.send({ ok: true }) : sendFailure(reply, result);
    });

    app.post(APP_LOCK_RECOVERY_ROUTES.requestResetCode, {
        config: { rateLimit: publicRateLimit },
        schema: {
            body: AppLockRecoveryLockRequestSchema,
            response: { 200: AppLockRecoveryOkResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const result = await appLockRecoveryRequestResetCode(request.body);
        return result.ok ? reply.send({ ok: true }) : sendFailure(reply, result);
    });

    app.post(APP_LOCK_RECOVERY_ROUTES.redeemResetCode, {
        config: { rateLimit: publicRateLimit },
        schema: {
            body: AppLockRecoveryCodeRequestSchema,
            response: { 200: AppLockRecoveryRedeemResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const result = await appLockRecoveryRedeem(request.body);
        return result.ok ? reply.send({ recoveryKey: result.recoveryKey }) : sendFailure(reply, result);
    });
}
