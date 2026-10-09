import {
    ACCOUNT_ERASURE_HTTP_PATH_V1,
    AccountErasureErrorV1Schema,
    AccountErasureRequestV1Schema,
    AccountErasureResponseV1Schema,
} from "@happier-dev/protocol";
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { type Fastify } from "../../types";
export function registerAccountErasureRoute(app: Fastify): void {
    app.post(
        ACCOUNT_ERASURE_HTTP_PATH_V1,
        {
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountErasureRequestV1Schema,
                response: {
                    200: AccountErasureResponseV1Schema,
                    400: AccountErasureErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                    409: AccountErasureErrorV1Schema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }
            const result = await deleteAccountForErasure({ accountId: request.userId, managedResourceDispositions: request.body.managedResourceDispositions });
            if (result.status === "failed" && result.code === "account_erasure_managed_resources_review_required") {
                return await reply.code(409).send({ error: result.code, resources: result.resources });
            }
            if (result.status === "failed" && result.code === "account_erasure_transition_cleanup_pending") {
                return await reply.code(409).send({ error: result.code });
            }
            if (result.status === "failed" && result.code === "home_owner_transfer_required") {
                // Actionable, and refused before any external object was
                // deleted: the Account still owns this Home.
                return await reply.code(409).send({ error: "home_owner_transfer_required" });
            }
            if (result.status === "failed" && result.code === "team_owner_transfer_required") {
                // The same shape of answer for a live, staffed Team this
                // Account is the last owner of: transfer ownership, then retry.
                return await reply.code(409).send({ error: "team_owner_transfer_required" });
            }
            if (result.status === "failed") {
                throw new Error(`Account erasure failed before Account deletion: ${result.code}`);
            }
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "deleted" });
        },
    );
}
