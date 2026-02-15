import { z } from "zod";

import { type Fastify } from "../../types";
import {
    createAutomation,
    deleteAutomation,
    getAutomation,
    listAutomationRuns,
    listAutomations,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
} from "@/app/automations/automationCrudService";
import {
    AutomationValidationError,
    parseAutomationPatchInput,
    parseAutomationUpsertInput,
} from "@/app/automations/automationValidation";
import { toAutomationApiDto, toAutomationRunApiDto } from "@/app/automations/automationTypes";

export function registerAutomationCrudRoutes(app: Fastify): void {
    app.get('/v2/automations', {
        preHandler: app.authenticate,
    }, async (request) => {
        const rows = await listAutomations({ accountId: request.userId });
        return rows.map(toAutomationApiDto);
    });

    app.post('/v2/automations', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const input = parseAutomationUpsertInput(request.body);
            const created = await createAutomation({
                accountId: request.userId,
                input,
            });
            return reply.send(toAutomationApiDto(created));
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
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const row = await getAutomation({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (!row) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationApiDto(row));
    });

    app.patch('/v2/automations/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        try {
            const input = parseAutomationPatchInput(request.body);
            const updated = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input,
            });
            if (!updated) {
                return reply.code(404).send({ error: 'automation_not_found' });
            }
            return reply.send(toAutomationApiDto(updated));
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
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const deleted = await deleteAutomation({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (!deleted) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send({ ok: true });
    });

    app.post('/v2/automations/:id/pause', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const updated = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: false,
        });
        if (!updated) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationApiDto(updated));
    });

    app.post('/v2/automations/:id/resume', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const updated = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: true,
        });
        if (!updated) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send(toAutomationApiDto(updated));
    });

    app.post('/v2/automations/:id/run-now', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const run = await runAutomationNow({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_not_found' });
        }
        return reply.send({ run: toAutomationRunApiDto(run) });
    });

    app.get('/v2/automations/:id/runs', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).optional(),
                cursor: z.string().optional(),
            }).optional(),
        },
    }, async (request) => {
        const result = await listAutomationRuns({
            accountId: request.userId,
            automationId: request.params.id,
            limit: request.query?.limit ?? 20,
            cursor: request.query?.cursor,
        });

        return {
            runs: result.runs.map(toAutomationRunApiDto),
            nextCursor: result.nextCursor,
        };
    });
}
