import { ActionAutomationIndexV1Schema, ActionAutomationIndexSelectionV1Schema,
    AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { readAutomationActionIndex } from '@/app/automations/automationSharedWorkflowSummaries';
import type { Fastify } from '../../types';

export function registerAutomationActionIndexRoutes(app: Fastify): void {
    app.get(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { preHandler: app.authenticate,
        schema: { response: { 200: ActionAutomationIndexV1Schema } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.send(await readAutomationActionIndex({ accountId: request.userId }));
    });
    app.post(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { preHandler: app.authenticate,
        schema: { body: ActionAutomationIndexSelectionV1Schema, response: { 200: ActionAutomationIndexV1Schema } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.send(await readAutomationActionIndex({ accountId: request.userId, selection: request.body }));
    });
}
