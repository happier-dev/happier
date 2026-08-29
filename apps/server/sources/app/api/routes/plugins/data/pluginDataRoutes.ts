import {
    AccountStoredContentUpgradeRequiredV1Schema,
    PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PluginAccountDataEraseActionInputV1Schema,
    PluginAccountDataEraseServerErrorV1Schema,
    PluginAccountDataEraseServerOutputV1Schema,
    PluginCollectionContractReadRequestV1Schema,
    PluginCollectionContractReadResultV1Schema,
    PluginCollectionCandidatePreparationErrorV1Schema,
    PluginCollectionCandidatePreparationRetireRequestV1Schema,
    PluginCollectionCandidatePreparationRetireResultV1Schema,
    PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
    PluginCollectionCandidatePreparationSourcePageResultV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    PluginCollectionCandidatePreparationStageResultV1Schema,
    PluginCollectionGetRequestV1Schema,
    PluginCollectionGetResultV1Schema,
    PluginCollectionForgetRequestV1Schema,
    PluginCollectionForgetResultV1Schema,
    PluginCollectionMutationErrorV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginCollectionMutationResultV1Schema,
    PluginCollectionQueryRequestV1Schema,
    PluginCollectionQueryResultV1Schema,
    PluginCollectionReadErrorV1Schema,
    PluginCollectionUiQueryErrorV1Schema,
    PluginCollectionUiQueryRequestV1Schema,
    PluginCollectionUiQueryResultV1Schema,
} from "@happier-dev/protocol";

import {
    PluginCollectionMutationOperationError,
    forgetPluginCollection,
    mutatePluginCollection,
} from "@/app/plugins/data/collections/mutation";
import {
    pagePluginCollectionCandidatePreparationSource,
    PluginCollectionCandidatePreparationOperationError,
    retirePluginCollectionCandidatePreparation,
    stagePluginCollectionCandidatePreparation,
} from "@/app/plugins/data/collections/candidatePreparation";
import {
    erasePluginAccountData,
    type PluginAccountDataEraseResult,
} from "@/app/plugins/data/accountDataErase";
import {
    buildPluginDataAccountStoredContentUpgradeRequired,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    getPluginCollection,
    PluginCollectionReadOperationError,
    queryPluginCollection,
    PluginCollectionUiQueryOperationError,
    queryPluginCollectionUiQuery,
    readCurrentPluginCollectionContract,
} from "@/app/plugins/data/collections/uiQuery";
import { Fastify } from "../../../types";

const PLUGIN_COLLECTION_UI_QUERY_PATH_V1 = "/v1/plugins/data/ui-query";

function didErasePluginAccountData(result: PluginAccountDataEraseResult): boolean {
    if (result.status !== "erased") return false;
    return result.accountStorage.status === "tombstoned"
        || result.declarativeSettings.status === "tombstoned"
        || result.collections.tombstonedRowCount > 0
        || result.collections.scrubbedHistoricalTombstoneContentCount > 0
        || result.collections.deletedProjectionCount > 0
        || result.collections.deletedIndexEntryCount > 0
        || result.collections.resetIndexStateCount > 0
        || result.collections.retiredRelationCount > 0;
}

function statusForReadError(code: PluginCollectionReadOperationError["code"]): 400 | 404 | 409 {
    switch (code) {
        case "collection_unavailable":
            return 404;
        case "collection_index_not_ready":
        case "collection_content_mode_mismatch":
        case "collection_contract_inconsistent":
            return 409;
        case "collection_query_invalid":
        case "collection_cursor_invalid":
            return 400;
    }
}

function statusForMutationError(code: PluginCollectionMutationOperationError["code"]): 400 | 404 | 409 {
    switch (code) {
        case "collection_unavailable":
            return 404;
        case "collection_mutation_invalid":
            return 400;
        case "collection_writer_contract_unavailable":
        case "collection_index_not_ready":
        case "collection_relation_unavailable":
        case "collection_relation_restricted":
        case "collection_content_mode_mismatch":
        case "collection_quota_exceeded":
        case "collection_quota_incompatible":
        case "collection_contract_inconsistent":
            return 409;
    }
}

function statusForCandidatePreparationError(
    code: PluginCollectionCandidatePreparationOperationError["code"],
): 400 | 404 | 409 {
    switch (code) {
        case "collection_candidate_preparation_unavailable":
            return 404;
        case "collection_candidate_preparation_invalid":
        case "collection_candidate_preparation_cursor_invalid":
            return 400;
        case "collection_candidate_preparation_source_changed":
        case "collection_candidate_preparation_contract_mismatch":
        case "collection_candidate_preparation_content_mode_mismatch":
        case "collection_quota_incompatible":
            return 409;
    }
}

/** The one authenticated direct producer for plugin Data reads, writes, and current-Account erasure. */
export function pluginDataRoutes(app: Fastify): void {
    app.post(PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginAccountDataEraseActionInputV1Schema,
            response: {
                200: PluginAccountDataEraseServerOutputV1Schema,
                400: PluginAccountDataEraseServerErrorV1Schema,
                403: PluginAccountDataEraseServerErrorV1Schema,
                404: PluginAccountDataEraseServerOutputV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.authTokenKind !== "account") {
            return await reply.code(403).send({
                error: "plugin_account_data_erase_present_user_required",
            });
        }
        if (request.validationError) {
            return await reply.code(400).send({ error: "plugin_account_data_erase_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        const result = await erasePluginAccountData({
            accountId: request.userId,
            pluginId: request.body.pluginId,
        });
        if (result.status === "account-not-found") {
            return await reply.code(404).send(result);
        }
        if (result.status === "transition-cleanup-pending") {
            return await reply.send(result);
        }
        return await reply.send({
            status: "erased",
            changed: didErasePluginAccountData(result),
        });
    });

    app.post(PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionContractReadRequestV1Schema,
            response: {
                200: PluginCollectionContractReadResultV1Schema,
                400: PluginCollectionReadErrorV1Schema,
                404: PluginCollectionReadErrorV1Schema,
                409: PluginCollectionReadErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_query_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        try {
            return await reply.send(await readCurrentPluginCollectionContract({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionReadOperationError) {
                return await reply.code(statusForReadError(error.code)).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_GET_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionGetRequestV1Schema,
            response: {
                200: PluginCollectionGetResultV1Schema,
                400: PluginCollectionReadErrorV1Schema,
                404: PluginCollectionReadErrorV1Schema,
                409: PluginCollectionReadErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_query_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        try {
            return await reply.send(await getPluginCollection({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionReadOperationError) {
                return await reply.code(statusForReadError(error.code)).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionForgetRequestV1Schema,
            response: {
                200: PluginCollectionForgetResultV1Schema,
                400: PluginCollectionMutationErrorV1Schema,
                404: PluginCollectionMutationErrorV1Schema,
                409: PluginCollectionMutationErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_mutation_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(buildPluginDataAccountStoredContentUpgradeRequired());
        }
        try {
            return await reply.send(await forgetPluginCollection({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                return await reply.code(statusForMutationError(error.code)).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionQueryRequestV1Schema,
            response: {
                200: PluginCollectionQueryResultV1Schema,
                400: PluginCollectionReadErrorV1Schema,
                404: PluginCollectionReadErrorV1Schema,
                409: PluginCollectionReadErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_query_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        try {
            return await reply.send(await queryPluginCollection({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionReadOperationError) {
                return await reply.code(statusForReadError(error.code)).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionMutationRequestV1Schema,
            response: {
                200: PluginCollectionMutationResultV1Schema,
                400: PluginCollectionMutationErrorV1Schema,
                404: PluginCollectionMutationErrorV1Schema,
                409: PluginCollectionMutationErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_mutation_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        try {
            return await reply.send(await mutatePluginCollection({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                return await reply.code(statusForMutationError(error.code)).send(error.toWireError());
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
            response: {
                200: PluginCollectionCandidatePreparationSourcePageResultV1Schema,
                400: PluginCollectionCandidatePreparationErrorV1Schema,
                404: PluginCollectionCandidatePreparationErrorV1Schema,
                409: PluginCollectionCandidatePreparationErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_candidate_preparation_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(buildPluginDataAccountStoredContentUpgradeRequired());
        }
        try {
            return await reply.send(await pagePluginCollectionCandidatePreparationSource({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                return await reply.code(statusForCandidatePreparationError(error.code)).send(error.toWireError());
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionCandidatePreparationStageRequestV1Schema,
            response: {
                200: PluginCollectionCandidatePreparationStageResultV1Schema,
                400: PluginCollectionCandidatePreparationErrorV1Schema,
                404: PluginCollectionCandidatePreparationErrorV1Schema,
                409: PluginCollectionCandidatePreparationErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_candidate_preparation_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(buildPluginDataAccountStoredContentUpgradeRequired());
        }
        try {
            return await reply.send(await stagePluginCollectionCandidatePreparation({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                return await reply.code(statusForCandidatePreparationError(error.code)).send(error.toWireError());
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: PluginCollectionCandidatePreparationRetireRequestV1Schema,
            response: {
                200: PluginCollectionCandidatePreparationRetireResultV1Schema,
                400: PluginCollectionCandidatePreparationErrorV1Schema,
                404: PluginCollectionCandidatePreparationErrorV1Schema,
                409: PluginCollectionCandidatePreparationErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_candidate_preparation_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(buildPluginDataAccountStoredContentUpgradeRequired());
        }
        try {
            return await reply.send(await retirePluginCollectionCandidatePreparation({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                return await reply.code(statusForCandidatePreparationError(error.code)).send(error.toWireError());
            }
            throw error;
        }
    });

    app.post(PLUGIN_COLLECTION_UI_QUERY_PATH_V1, {
        preHandler: app.authenticate,
        // Keep the Data error union authoritative even when Fastify rejects a
        // malformed request shape before the query owner receives it.
        attachValidation: true,
        schema: {
            body: PluginCollectionUiQueryRequestV1Schema,
            response: {
                200: PluginCollectionUiQueryResultV1Schema,
                400: PluginCollectionUiQueryErrorV1Schema,
                404: PluginCollectionUiQueryErrorV1Schema,
                409: PluginCollectionUiQueryErrorV1Schema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return await reply.code(400).send({ error: "collection_query_invalid" });
        }
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return await reply.code(426).send(
                buildPluginDataAccountStoredContentUpgradeRequired(),
            );
        }
        try {
            return await reply.send(await queryPluginCollectionUiQuery({
                accountId: request.userId,
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginCollectionUiQueryOperationError) {
                return await reply.code(statusForReadError(error.code)).send({ error: error.code });
            }
            throw error;
        }
    });
}
