import { z } from "zod";

import { type Fastify } from "../../types";
import { updateAutomation } from "@/app/automations/automationCrudService";
import { toAutomationV2ApiDto } from "@/app/automations/automationApiProjection";
import { AutomationValidationError } from "@/app/automations/automationValidation";

export function registerAutomationAssignmentRoutes(app: Fastify): void {
    app.post('/v2/automations/:id/assignments', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                assignments: z.array(z.object({
                    machineId: z.string().trim().min(1),
                    enabled: z.boolean().optional(),
                    priority: z.number().int().optional(),
                })),
            }),
        },
    }, async (request, reply) => {
        try {
            const updated = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input: {
                    assignments: request.body.assignments,
                },
                expectedTriggerKind: "schedule",
                requireV2DefinitionRepresentability: true,
            });
            if (!updated) {
                return reply.code(404).send({ error: 'automation_not_found' });
            }
            return reply.send(toAutomationV2ApiDto(updated));
        } catch (error) {
            if (!(error instanceof AutomationValidationError)) {
                return reply.code(500).send({ error: "automation_assignment_update_failed" });
            }
            return reply.code(400).send({ error: error.message });
        }
    });
}
