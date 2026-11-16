import { AutomationActionAdmitRequestV1Schema, AutomationActionAdmitResultV1Schema,
    AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { admitAutomationActionOccurrencesV1 } from '@/app/automations/automationActionAdmissionService';
import type { Fastify } from '../../types';

export function registerAutomationActionRoutes(app: Fastify): void {
    app.post(AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, { preHandler: app.authenticate,
        schema: { body: AutomationActionAdmitRequestV1Schema, response: { 200: AutomationActionAdmitResultV1Schema } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.send(await admitAutomationActionOccurrencesV1({ accountId: request.userId, input: request.body }));
    });
}
