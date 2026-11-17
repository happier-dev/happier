import { homeGovernanceErrorHttpStatusV1 } from '@happier-dev/protocol/home/governance';
import { ACCOUNT_ERASURE_HTTP_PATH_V1, AccountErasureErrorV1Schema, AccountErasureRequestV1Schema, AccountErasureResponseV1Schema } from '@happier-dev/protocol/auth/accountErasure';
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
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
                    403: AccountErasureErrorV1Schema,
                    404: AccountErasureErrorV1Schema,
                    409: AccountErasureErrorV1Schema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }
            const result = await deleteAccountForErasure({ accountId: request.userId, managedResourceDispositions: request.body.managedResourceDispositions });
            if (result.status === "failed") {
                const error = result.code === "account_erasure_managed_resources_review_required"
                    ? { error: result.code, resources: [...result.resources] }
                    : { error: result.code };
                return await reply.code(homeGovernanceErrorHttpStatusV1(result.code)).send(error);
            }
            if (result.status === "disabled_pending_completion") return await reply.send(result);
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "deleted" });
        },
    );
}
