import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema, pluginJsonValuesEqual } from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginActionIconV2Schema, type PluginActionContributionV2 } from '../actions/v2.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';
import type { PluginResourceContributionV2 } from './v2.js';
import type { PluginEventContributionV1 } from './events.js';
import { DeploymentTargetFailureTransitionV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema, DeploymentTargetPreparationBaseV1ProtocolSchema } from './deploymentTargetRolesV1.js';
export * from './deploymentTargetRolesV1.js';

const local = () => asProtocolZod(PluginContributionLocalIdSchema);
const closedSchema = lazyZodSchema(() => PluginJsonSchemaV2Schema.check(z.superRefine((value, context) => {
    try {
        normalizePluginJsonSchema(value);
        if (!isRecursivelyClosedPluginJsonSchemaV2(value)) {
            context.addIssue({ code: 'custom', message: 'Deployment target schemas must be recursively closed.' });
        }
    } catch {
        context.addIssue({ code: 'custom', message: 'Invalid portable deployment target schema.' });
    }
})));

/** Contribution and normalized catalogs share the role grammar, with boundary-specific references. */
export function createDeploymentTargetRuntimeActionsV1Schema<TSchema extends z.ZodMiniType>(action: TSchema) {
    return z.strictObject({
        inspect: action, link: action, deploy: action, observe: action,
        uploadDeploy: z.optional(action), cancel: z.optional(action), rollback: z.optional(action),
        promote: z.optional(action), teardown: z.optional(action),
        variables: z.optional(z.strictObject({ read: z.optional(action), sync: z.optional(action) })),
        domains: z.optional(z.strictObject({ read: z.optional(action), add: z.optional(action), verify: z.optional(action), remove: z.optional(action) })),
        previews: z.optional(z.strictObject({ read: z.optional(action), remove: z.optional(action) })),
        logs: z.optional(z.strictObject({ build: z.optional(action), runtime: z.optional(action) })),
    });
}

/** Provider-returned identity within the selected data link; not a display name or grant. */
export const DeploymentDataParentBranchRefV1Schema = lazyZodSchema(() => z.strictObject({
    providerProjectId: z.string(), branchId: z.string(),
}));
export type DeploymentDataParentBranchRefV1 = z.infer<typeof DeploymentDataParentBranchRefV1Schema>;

/** Optional managed-data capabilities share one grammar across declaration and normalized refs. */
export function createDeploymentTargetDataV1Schema<TAction extends z.ZodMiniType, TResource extends z.ZodMiniType>(action: TAction, resource: TResource) {
    return z.strictObject({
        projects: z.optional(z.strictObject({ list: z.optional(resource), listAction: z.optional(action),
            provisionOptions: z.optional(resource), provisionOptionsAction: z.optional(action),
            provision: z.optional(action), link: z.optional(action) })),
        branches: z.optional(z.strictObject({ list: z.optional(resource), listAction: z.optional(action),
            create: z.optional(action), delete: z.optional(action) })),
        query: z.optional(z.strictObject({ readOnly: z.optional(action) })),
        connectionSecret: z.optional(z.strictObject({ save: z.optional(action) })),
    });
}

const descriptorFields = () => ({
    id: local(), title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema),
    icon: PluginActionIconV2Schema, targetKind: local(),
    targetSchema: closedSchema, linkSchema: closedSchema,
});

/** Runtime and data are closed alternatives; association unlink stays with the host. */
export const DeploymentTargetContributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('role', [
    z.strictObject({ ...descriptorFields(), role: z.literal('runtime'), actions: createDeploymentTargetRuntimeActionsV1Schema(local()),
        failureTransitionEvent: z.optional(local()) }),
    z.strictObject({ ...descriptorFields(), role: z.literal('data'), dataV1: z.optional(createDeploymentTargetDataV1Schema(local(), local())) }),
]));
export type DeploymentTargetContributionV1 = z.infer<typeof DeploymentTargetContributionV1Schema>;

export type DeploymentTargetActionRoleV1 = Readonly<{
    role: string;
    action: string;
    path: readonly string[];
    readOnly: boolean;
}>;

export type DeploymentTargetReferenceRoleV1 = Readonly<{
    role: string;
    reference: string;
    targetFamily: 'actions' | 'resources';
    path: readonly string[];
    readOnly: boolean;
}>;

/** One traversal supplies kind-aware reference admission and normalized catalog projection. */
export function readDeploymentTargetReferenceRolesV1(descriptor: DeploymentTargetContributionV1): readonly DeploymentTargetReferenceRoleV1[] {
    if (descriptor.role === 'data') return Object.entries(descriptor.dataV1 ?? {}).flatMap(([group, value]) => {
        if (!value) return [];
        return Object.entries(value).flatMap(([leaf, reference]) => {
            if (reference === undefined) return [];
            // A Resource's backing Action spends the same role through the ordinary executor.
            const operation = leaf.endsWith('Action') ? leaf.slice(0, -6) : leaf;
            return [{
            role: `${group}.${operation}`, reference,
            targetFamily: leaf === 'list' || leaf === 'provisionOptions' ? 'resources' as const : 'actions' as const,
            path: ['dataV1', group, leaf], readOnly: operation === 'list' || operation === 'provisionOptions'
                || operation === 'link' || group === 'query',
        }]; });
    });
    return Object.entries(descriptor.actions).flatMap(([group, value]) => {
        if (value === undefined) return [];
        if (typeof value === 'string') return [{ role: group, reference: value, targetFamily: 'actions' as const, path: ['actions', group],
            readOnly: group === 'inspect' || group === 'observe' }];
        return Object.entries(value).flatMap(([role, action]) => action === undefined ? [] : [{
            role: `${group}.${role}`, reference: action, targetFamily: 'actions' as const, path: ['actions', group, role],
            readOnly: role === 'read' || role === 'verify' || group === 'logs',
        }]);
    });
}

/** Existing Action-only consumers delegate to the same kind-aware role owner. */
export function readDeploymentTargetActionRolesV1(descriptor: DeploymentTargetContributionV1): readonly DeploymentTargetActionRoleV1[] {
    return readDeploymentTargetReferenceRolesV1(descriptor).flatMap(binding => binding.targetFamily === 'actions'
        ? [{ role: binding.role, action: binding.reference, path: binding.path, readOnly: binding.readOnly }] : []);
}
