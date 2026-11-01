import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { HealthCheckResultV1ProtocolSchema } from '../../deployments/healthCheckV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema, pluginJsonValuesEqual } from '../actions/protocolComposableSchema.js';
import type { PluginActionContributionV2 } from '../actions/v2.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';

/** One declarative finite producer; the existing Action owns executable admission. */
export const HealthCheckKindContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    title: PluginLocalizedStringV2Schema,
    description: z.optional(PluginLocalizedStringV2Schema),
    configSchema: PluginJsonSchemaV2Schema.check(z.superRefine((schema, context) => {
        try {
            normalizePluginJsonSchema(schema);
            if (!isRecursivelyClosedPluginJsonSchemaV2(schema)) {
                context.addIssue({ code: 'custom', message: 'Health check configuration must be recursively closed.' });
            }
        } catch {
            context.addIssue({ code: 'custom', message: 'Invalid portable health check configuration schema.' });
        }
    })),
    action: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type HealthCheckKindContributionV1 = z.infer<typeof HealthCheckKindContributionV1Schema>;

/** Catalog ingestion withdraws only the failed declaration and retains healthy siblings. */
export function validateHealthCheckKindContributionsV1(
    value: Readonly<{ healthCheckKinds: readonly HealthCheckKindContributionV1[]; actions: readonly PluginActionContributionV2[] }>,
    context: z.core.$RefinementCtx,
): void {
    value.healthCheckKinds.forEach((kind, index) => {
        const path = ['healthCheckKinds', index, 'action'];
        const action = value.actions.find(candidate => candidate.id === kind.action);
        if (!action) {
            context.addIssue({ code: 'custom', path, message: 'Health check kinds require a declared same-plugin Action.' });
            return;
        }
        if (action.execution.target !== 'daemon' || action.operation !== undefined) {
            context.addIssue({ code: 'custom', path, message: 'Health checks require finite daemon Actions without tracked operations.' });
        }
        if (!action.inputSchema || !action.resultSchema
            || !isRecursivelyClosedPluginJsonSchemaV2(action.inputSchema)
            || !isRecursivelyClosedPluginJsonSchemaV2(action.resultSchema)) {
            context.addIssue({ code: 'custom', path, message: 'Health check Actions require explicit recursively closed input and result schemas.' });
            return;
        }
        try {
            normalizePluginJsonSchema(action.inputSchema);
            if (!pluginJsonValuesEqual(normalizePluginJsonSchema(action.resultSchema),
                normalizePluginJsonSchema(HealthCheckResultV1ProtocolSchema.jsonSchema))) {
                context.addIssue({ code: 'custom', path, message: 'Health check Actions must return the canonical HealthCheckResultV1 schema.' });
            }
        } catch {
            context.addIssue({ code: 'custom', path, message: 'Health check Actions require valid portable schemas.' });
        }
    });
}
