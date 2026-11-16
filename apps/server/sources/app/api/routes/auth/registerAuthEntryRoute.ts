import { AuthEntryProjectionV1Schema, AuthEntryRequestV1Schema } from '@happier-dev/protocol/auth/entry';
import { z } from 'zod/mini';

import type { Fastify } from '@/app/api/types';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { verifyRequestPrincipal } from '@/app/api/utils/verifyRequestPrincipal';
import {
    resolveOptionalPublicAuthDisposition,
    SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR,
} from '@/app/api/utils/apiTokenRouteAdmission';
import { projectUnavailableHomeAuthEntry, resolveAuthEntry } from '@/app/auth/entry/resolveAuthEntry';
import { isAuthEmailDeliveryReady } from '@/app/auth/email/resolveAuthEmailDelivery';
import { captureFastifyExceptionForSentry } from '@/app/monitoring/sentry';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';

/**
 * Public, stateless authentication presentation. The response is never
 * authorization evidence.
 *
 * The route stays public — an anonymous visitor must always reach a Home or Team
 * sign-in page — but it optionally authenticates through the same canonical
 * verifier the authenticating decorator uses, so an already-admitted member is
 * offered continuation rather than a pointless second login. Absent, malformed,
 * ineligible, PAT and Directory credentials retain anonymous-compatible behavior
 * and cannot ask whether an Account is a member. A verified restricted Session
 * runtime is rejected instead of being silently downgraded to a public caller.
 */
export function registerAuthEntryRoute(app: Fastify, params: Readonly<{
    isEmailDeliveryReady: () => boolean | Promise<boolean>;
}> = { isEmailDeliveryReady: () => isAuthEmailDeliveryReady({}) }): void {
    app.post(
        '/v1/auth/entry',
        {
            config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'auth.entry') },
            schema: {
                body: AuthEntryRequestV1Schema,
                response: {
                    200: AuthEntryProjectionV1Schema,
                    403: z.strictObject({
                        error: z.literal(SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR),
                    }),
                },
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const verification = await verifyRequestPrincipal({
                authorizationHeader: request.headers?.authorization,
                allowLegacyHomeToken: true,
                readEnv: async () => requestHomeEnv,
            });
            const publicAuthDisposition = resolveOptionalPublicAuthDisposition(
                verification.status === 'verified'
                    ? {
                        userId: verification.principal.accountId,
                        authTokenKind: verification.principal.kind,
                        authority: verification.principal.authority,
                        authenticationEvidence: verification.principal.authenticationEvidence,
                    }
                    : verification.status === 'rejected_restricted'
                        ? {
                            status: verification.status,
                            authTokenKind: verification.kind,
                        }
                        : null,
            );
            if (publicAuthDisposition.status === 'session_runtime_forbidden') {
                reply.header('Cache-Control', 'no-store');
                return reply.code(403).send({ error: SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR });
            }
            const principal = verification.status === 'verified'
                && verification.principal.kind === 'account'
                && verification.principal.authority === 'present_user'
                ? {
                    accountId: verification.principal.accountId,
                    ...(verification.principal.authenticationEvidence
                        ? { authenticationEvidence: verification.principal.authenticationEvidence }
                        : {}),
                }
                : null;
            const projection = await resolveAuthEntry(request.body, {
                env: requestHomeEnv,
                principal,
                emailDeliveryReady: await params.isEmailDeliveryReady(),
                requestIp: request.ip,
            }).catch((error: unknown) => {
                if (request.body.scope.kind !== 'home') throw error;
                app.log.error({ err: error }, 'Failed to resolve the Home authentication policy for auth entry');
                captureFastifyExceptionForSentry(error, request);
                return projectUnavailableHomeAuthEntry('authentication_policy_unavailable');
            });
            reply.header('Cache-Control', 'no-store');
            return reply.send(projection);
        },
    );
}
