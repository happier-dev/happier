import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1, AccountSessionsSignOutEverywhereActionInputV1Schema, AccountSessionsSignOutEverywhereServerErrorV1Schema, AccountSessionsSignOutEverywhereServerOutputV1Schema } from '@happier-dev/protocol/auth/accountSessions';

import { auth } from "@/app/auth/auth";
import { inTx } from "@/storage/inTx";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";

import { type Fastify } from "../../types";

/**
 * Retires the authenticated Account's signed sessions, with optional API-token
 * revocation in the same transaction. Socket eviction follows the commit.
 */
export function registerAccountSessionsSignOutEverywhereRoute(app: Fastify): void {
    app.post(
        ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
        {
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountSessionsSignOutEverywhereActionInputV1Schema,
                response: {
                    200: AccountSessionsSignOutEverywhereServerOutputV1Schema,
                    400: AccountSessionsSignOutEverywhereServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            if (request.body.revokeApiTokens === true) {
                await inTx((tx) => auth.revokeAllAccountCredentialsInTx(tx, request.userId));
            } else {
                await auth.signOutEverywhere(request.userId);
            }
            // API-token viewers also join the Account revocation room.
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "signed_out" });
        },
    );
}
