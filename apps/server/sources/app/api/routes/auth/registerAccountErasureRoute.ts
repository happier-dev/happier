import { homeGovernanceErrorHttpStatusV1 } from '@happier-dev/protocol/home/governance';
import { ACCOUNT_ERASURE_HTTP_PATH_V1, AccountErasureErrorV1Schema, AccountErasureRequestV1Schema, AccountErasureResponseV1Schema } from '@happier-dev/protocol/auth/accountErasure';
import { ACCOUNT_ERASURE_PREVIEW_HTTP_PATH_V1, AccountErasurePreviewResponseV1Schema } from '@happier-dev/protocol/auth/accountErasureReview';
import { accountErasureFailureResponse, deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { readAccountErasurePreviewInTx } from "@/app/deployments/deploymentAccountPurge";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
export function registerAccountErasureRoute(app: Fastify): void {
    app.get(
        ACCOUNT_ERASURE_PREVIEW_HTTP_PATH_V1,
        { preHandler: app.authenticate, schema: { response: { 200: AccountErasurePreviewResponseV1Schema } } },
        async (request, reply) => await reply.send(await inTx(tx => readAccountErasurePreviewInTx(tx, request.userId))),
    );
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
                const error = accountErasureFailureResponse(result);
                return await reply.code(homeGovernanceErrorHttpStatusV1(result.code)).send(error);
            }
            if (result.status === "disabled_pending_completion") return await reply.send(result);
            app.disconnectAccountSockets(request.userId);
            return await reply.send({ status: "deleted" });
        },
    );
}
