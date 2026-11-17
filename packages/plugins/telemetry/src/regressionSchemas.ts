import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { keyFlowMeasureSchema } from './healthSchemas.js';

const text = defineProtocolString({ minLength: 1 });
const duration = defineProtocolNumber({ integer: true, minimum: 1 });
export const regressionCompareInputSchema = defineProtocolObject({ serverId: text, environmentId: text,
    serviceName: text, measure: keyFlowMeasureSchema, windowMs: duration,
}, { policy: 'closed' });
const evidence = { liveDeploymentId: text.optional(), previousDeploymentId: text.optional(),
    before: HealthCheckResultV1ProtocolSchema.optional(), after: HealthCheckResultV1ProtocolSchema.optional() };
export const regressionCompareResultSchema = defineProtocolUnion([
    defineProtocolObject({ ...evidence, status: defineProtocolLiteral('comparable'), change: defineProtocolNumber(),
        changePercent: defineProtocolUnion([defineProtocolNumber(), defineProtocolLiteral(null)]) }, { policy: 'closed' }),
    defineProtocolObject({ ...evidence, status: defineProtocolLiteral('inconclusive'), reasons: defineProtocolArray(text) }, { policy: 'closed' }),
]);
export const regressionScheduleInputSchema = defineProtocolObject({ serverId: text, environmentId: text,
    deploymentId: text, workflow: text, project: defineProtocolObject({ machineId: text, directory: text }, { policy: 'closed' }),
    observationDelayMs: duration,
}, { policy: 'closed' });
export const regressionScheduleResultSchema = defineProtocolObject({
    scheduledAt: defineProtocolNumber({ integer: true, minimum: 0 }), automationId: text, triggerId: text.optional(),
}, { policy: 'closed' });
