import {
    ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    AccountSessionsSignOutEverywhereActionInputV1Schema,
    AccountSessionsSignOutEverywhereServerErrorV1Schema,
    AccountSessionsSignOutEverywhereServerOutputV1Schema,
} from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";

import { type Fastify } from "../../types";

/**
 * One present-user route for revoking the authenticated Account's signed
 * sessions. The Account id is derived solely from verified bearer provenance.
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

            await auth.signOutEverywhere(request.userId);
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "signed_out" });
        },
    );
}
