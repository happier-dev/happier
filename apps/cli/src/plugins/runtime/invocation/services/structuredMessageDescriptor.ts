import { z } from 'zod';

import {
    normalizePluginJsonSchema,
    PluginContributionLocalIdSchema,
    PluginIdSchema,
    type PluginJsonSchemaV2,
} from '@happier-dev/protocol/plugins/manifest';

import { asHostProtocolZod } from '../../protocolComposableZodAdapter';

export const MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1 = 64;

const HostPluginContributionLocalIdSchema = asHostProtocolZod(PluginContributionLocalIdSchema);
const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);

type HostJsonValue = null | boolean | number | string | HostJsonValue[] | { [key: string]: HostJsonValue };

const HostJsonValueSchema: z.ZodType<HostJsonValue> = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(HostJsonValueSchema),
    z.record(z.string(), HostJsonValueSchema),
]));

const HostLocalizedStringSchema = z.union([
    z.string().trim().min(1),
    z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict(),
]);

const HostContributionReferenceSchema = z.union([
    HostPluginContributionLocalIdSchema,
    z.object({ pluginId: HostPluginIdSchema, localId: HostPluginContributionLocalIdSchema }).strict(),
]);

type HostPolicyExpression =
    | { fact: string; operator: string; value: boolean | string }
    | { all: HostPolicyExpression[] }
    | { any: HostPolicyExpression[] }
    | { not: HostPolicyExpression };

const HostPolicyExpressionSchema: z.ZodType<HostPolicyExpression> = z.lazy(() => z.union([
    z.object({ fact: z.enum(['plugin.enabled', 'session.exists', 'project.exists', 'browser.exists']), operator: z.literal('equals'), value: z.boolean() }).strict(),
    z.object({ fact: z.literal('host.platform'), operator: z.enum(['equals', 'notEquals']), value: z.enum(['web', 'ios', 'android', 'desktop']) }).strict(),
    z.object({ fact: z.literal('host.feature'), operator: z.literal('enabled'), value: z.string().trim().min(1) }).strict(),
    z.object({ fact: z.enum(['session.agentId', 'session.state', 'project.id', 'machine.id', 'browser.origin']), operator: z.enum(['equals', 'notEquals']), value: z.string() }).strict(),
    z.object({ fact: z.literal('session.capability'), operator: z.literal('contains'), value: z.string().trim().min(1) }).strict(),
    z.object({ all: z.array(HostPolicyExpressionSchema) }).strict(),
    z.object({ any: z.array(HostPolicyExpressionSchema) }).strict(),
    z.object({ not: HostPolicyExpressionSchema }).strict(),
]));

const HostAvailabilityDescriptorSchema = z.union([
    z.object({ when: HostPolicyExpressionSchema.optional(), disabledWhen: z.never().optional(), disabledReason: z.never().optional() }).strict(),
    z.object({ when: HostPolicyExpressionSchema.optional(), disabledWhen: HostPolicyExpressionSchema, disabledReason: HostLocalizedStringSchema }).strict(),
]);

const HostPluginJsonSchemaV2Schema = z.custom<PluginJsonSchemaV2>((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
        normalizePluginJsonSchema(value);
        return true;
    } catch {
        return false;
    }
}, { message: 'Structured-message payloadSchema must be a supported plugin JSON Schema.' });

/**
 * Host-private descriptor grammar retained only for incumbent message parsing.
 * It is deliberately not part of the plugin manifest or SDK authoring surface.
 */
export const HostStructuredMessageDescriptorV1Schema = z.object({
    id: HostPluginContributionLocalIdSchema,
    title: HostLocalizedStringSchema,
    description: HostLocalizedStringSchema.optional(),
    kind: z.string().trim().min(1),
    payloadSchema: HostPluginJsonSchemaV2Schema,
    renderer: HostPluginContributionLocalIdSchema,
    actions: z.array(HostContributionReferenceSchema)
        .max(MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1)
        .optional(),
    fallback: z.union([
        z.object({ kind: z.literal('summary'), template: z.string() }).strict(),
        z.object({ kind: z.literal('hidden') }).strict(),
    ]),
    availability: HostAvailabilityDescriptorSchema.optional(),
    metadata: z.record(z.string(), HostJsonValueSchema).optional(),
}).strict();

export type HostStructuredMessageDescriptorV1 = z.infer<typeof HostStructuredMessageDescriptorV1Schema>;
