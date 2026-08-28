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
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }
            await deleteAccountForErasure({ accountId: request.userId });
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "deleted" });
        },
    );
}
