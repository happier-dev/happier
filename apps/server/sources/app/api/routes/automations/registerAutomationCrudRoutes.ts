import { z } from "zod";
import { AutomationManualIdempotencyKeyV1Schema } from "@happier-dev/protocol";

import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    createAutomation,
    deleteAutomation,
    getAutomation,
    listAutomationRuns,
    listAutomations,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    AutomationDisabledError,
} from "@/app/automations/automationCrudService";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    AutomationValidationError,
    parseAutomationPatchInput,
    parseAutomationUpsertInput,
} from "@/app/automations/automationValidation";
import {
    isAutomationV2Compatible,
    toAutomationRunV2ApiDto,
    toAutomationV2ApiDto,
} from "@/app/automations/automationApiProjection";
import { requirePresentUser } from "../../utils/requirePresentUser";

export function registerAutomationCrudRoutes(app: Fastify): void {
    const runNowHeadersSchema = z.object({
        "idempotency-key": AutomationManualIdempotencyKeyV1Schema.optional(),
    }).passthrough();
    app.get('/v2/automations', {
        preHandler: [app.authenticate, requirePresentUser],
    }, async (request) => {
        const rows = await listAutomations({
            accountId: request.userId,
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        return rows.map(toAutomationV2ApiDto);
    });

    app.post('/v2/automations', {
        preHandler: [app.authenticate, requirePresentUser],
    }, async (request, reply) => {
        try {
            const account = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            if (!account) {
                return reply.code(500).send({ error: "automation_create_failed" });
            }
            const currentness =
                deriveAccountEncryptionCurrentnessFromRow(account);
            if (currentness.status === "inconsistent") {
                return reply.code(500).send({
                    error: "automation_create_failed",
                });
            }
            const mode = currentness.currentness.encryptionMode;
            const input = parseAutomationUpsertInput(request.body, {
                accountMode: mode,
                // The request parser admits the exact released encrypted
                // predecessor only for a peer that has not declared the
                // current stored-content protocol. New writers remain strict.
                allowLegacyEncryptedExistingSessionTemplate:
                    !readAccountStoredContentCompatibilityForHttpRequest(request)
                        .supportsCurrentProtocol,
            });
            const created = await createAutomation({
                accountId: request.userId,
                input,
                requireV2DefinitionRepresentability: true,
            });
            return reply.send(toAutomationV2ApiDto(created));
        } catch (error) {
            if (!(error instanceof AutomationValidationError)) {
                return reply.code(500).send({ error: "automation_create_failed" });
            }
            return reply.code(400).send({
                error: error.message,
            });
        }
    });

    app.get('/v2/automations/:id', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const row = await getAutomation({
            accountId: request.userId,
            automationId: request.params.id,
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        if (!row) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationV2ApiDto(row));
    });

    app.patch('/v2/automations/:id', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        try {
            const account = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            if (!account) {
                return reply.code(500).send({ error: "automation_update_failed" });
            }
            const currentness =
                deriveAccountEncryptionCurrentnessFromRow(account);
            if (currentness.status === "inconsistent") {
                return reply.code(500).send({
                    error: "automation_update_failed",
                });
            }
            const mode = currentness.currentness.encryptionMode;
            const compatibility =
                readAccountStoredContentCompatibilityForHttpRequest(request);
            const existing = await getAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                expectedTriggerKind: "schedule",
                requireV2DefinitionRepresentability: true,
            });
            const legacyExisting = existing && isAutomationV2Compatible(existing)
                ? existing
                : null;
            if (!legacyExisting) {
                return reply.code(404).send({ error: "automation_not_found" });
            }
            const input = parseAutomationPatchInput(request.body, {
                accountMode: mode,
                allowLegacyEncryptedExistingSessionTemplate:
                    !compatibility.supportsCurrentProtocol,
                effectiveTargetType: legacyExisting.targetType,
            });
            const updated = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input,
                expectedTriggerKind: "schedule",
                requireV2DefinitionRepresentability: true,
            });
            if (!updated) {
                return reply.code(404).send({ error: 'automation_not_found' });
            }
            return reply.send(toAutomationV2ApiDto(updated));
        } catch (error) {
            if (!(error instanceof AutomationValidationError)) {
                return reply.code(500).send({ error: "automation_update_failed" });
            }
            return reply.code(400).send({
                error: error.message,
            });
        }
    });

    app.delete('/v2/automations/:id', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const deleted = await deleteAutomation({
            accountId: request.userId,
            automationId: request.params.id,
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        if (!deleted) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send({ ok: true });
    });

    app.post('/v2/automations/:id/pause', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const updated = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: false,
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        if (!updated) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationV2ApiDto(updated));
    });

    app.post('/v2/automations/:id/resume', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const updated = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: true,
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        if (!updated) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationV2ApiDto(updated));
    });

    app.post('/v2/automations/:id/run-now', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            headers: runNowHeadersSchema,
        },
    }, async (request, reply) => {
        try {
            const headers = runNowHeadersSchema.parse(request.headers);
            const run = await runAutomationNow({
                accountId: request.userId,
                automationId: request.params.id,
                expectedTriggerKind: "schedule",
                requireV2DefinitionRepresentability: true,
                ...(headers["idempotency-key"]
                    ? { idempotencyKey: headers["idempotency-key"] }
                    : {}),
            });
            if (!run) {
                return reply.code(404).send({ error: 'automation_not_found' });
            }
            return reply.send({ run: toAutomationRunV2ApiDto(run) });
        } catch (error) {
            if (error instanceof AutomationDisabledError) {
                return reply.code(409).send({ error: "automation_disabled" });
            }
            if (error instanceof AutomationValidationError || error instanceof z.ZodError) {
                return reply.code(400).send({ error: "invalid_idempotency_key" });
            }
            throw error;
        }
    });

    app.get('/v2/automations/:id/runs', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).optional(),
                cursor: z.string().optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const result = await listAutomationRuns({
            accountId: request.userId,
            automationId: request.params.id,
            limit: request.query?.limit ?? 20,
            cursor: request.query?.cursor,
            expectedTriggerKind: "schedule",
            requireV2RunRepresentability: true,
        });
        if (!result) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }

        return {
            runs: result.runs
                .map(toAutomationRunV2ApiDto),
            nextCursor: result.nextCursor,
        };
    });
}
