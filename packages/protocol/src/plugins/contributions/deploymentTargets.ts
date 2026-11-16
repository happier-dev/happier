import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { deploymentTargetFitFieldsV1 } from '../../deployments/deployShapeV1.js';
import { WorkflowActionFieldBindingV1Schema } from '../../workflows/workflowLeafV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema, pluginJsonValuesEqual } from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginActionIconV2Schema, type PluginActionContributionV2 } from '../actions/v2.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';
import type { PluginResourceContributionV2 } from './v2.js';
import { DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema, DeploymentTargetLinkProviderContentV1ProtocolSchema, DeploymentTargetLogsResultV1ProtocolSchema, DeploymentTargetDomainResultV1ProtocolSchema,
    DeploymentTargetVariablesReadResultV1ProtocolSchema, DeploymentTargetVariablesSyncResultV1ProtocolSchema,
    DeploymentTargetPreparationBaseV1ProtocolSchema } from './deploymentTargetRolesV1.js';
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
        inspect: action, link: action, deploy: action, observe: action, create: z.optional(action),
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
export const DeploymentDataParentBranchRefV1ProtocolSchema = projectZodProtocolSchema(DeploymentDataParentBranchRefV1Schema);

/** Optional managed-data capabilities share one grammar across declaration and normalized refs. */
export function createDeploymentTargetDataV1Schema<TAction extends z.ZodMiniType, TResource extends z.ZodMiniType>(action: TAction, resource: TResource) {
    return z.strictObject({
        projects: z.optional(z.strictObject({ list: z.optional(resource), listAction: z.optional(action),
            provisionOptions: z.optional(resource), provisionOptionsAction: z.optional(action),
            provision: z.optional(action), link: z.optional(action), delete: z.optional(action), observe: z.optional(action) })),
        branches: z.optional(z.strictObject({ list: z.optional(resource), listAction: z.optional(action),
            create: z.optional(action), delete: z.optional(action),
            /** Plugin-owned preview operands, evaluated against the occurrence's neutral preview input. */
            previewInput: z.optional(z.record(z.string().check(z.minLength(1)), WorkflowActionFieldBindingV1Schema)) })),
        query: z.optional(z.strictObject({ readOnly: z.optional(action) })),
        connectionSecret: z.optional(z.strictObject({ save: z.optional(action) })),
    });
}

const descriptorFields = () => ({
    ...deploymentTargetFitFieldsV1(),
    id: local(), title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema),
    icon: PluginActionIconV2Schema, targetKind: local(),
    targetSchema: closedSchema, linkSchema: closedSchema,
});

/** Provider-declared cadence for demanded, unsettled receipts; the receipt observer owns scheduling. */
export const DeploymentTargetStatusIntervalMsV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)));

/** Runtime and data are closed alternatives; association unlink stays with the host. */
export const DeploymentTargetContributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('role', [
    z.strictObject({ ...descriptorFields(), role: z.literal('runtime'), statusIntervalMs: z.optional(DeploymentTargetStatusIntervalMsV1Schema), actions: createDeploymentTargetRuntimeActionsV1Schema(local()) }),
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

/** Role grammar decides read-only classification for declaration and host admission. */
export function isDeploymentTargetRoleReadOnlyV1(role: string): boolean {
    const [group, operation] = role.split('.');
    return operation === undefined ? group === 'inspect' || group === 'observe'
        : operation === 'list' || operation === 'provisionOptions' || operation === 'link' || operation === 'observe'
            || operation === 'read' || operation === 'verify' || group === 'query' || group === 'logs';
}

/** One traversal supplies kind-aware reference admission and normalized catalog projection. */
export function readDeploymentTargetReferenceRolesV1(descriptor: DeploymentTargetContributionV1): readonly DeploymentTargetReferenceRoleV1[] {
    if (descriptor.role === 'data') return Object.entries(descriptor.dataV1 ?? {}).flatMap(([group, value]) => {
        if (!value) return [];
        return Object.entries(value).flatMap(([leaf, reference]) => {
            if (typeof reference !== 'string') return [];
            // A Resource's backing Action spends the same role through the ordinary executor.
            const operation = leaf.endsWith('Action') ? leaf.slice(0, -6) : leaf;
            return [{
            role: `${group}.${operation}`, reference,
            targetFamily: leaf === 'list' || leaf === 'provisionOptions' ? 'resources' as const : 'actions' as const,
            path: ['dataV1', group, leaf], readOnly: isDeploymentTargetRoleReadOnlyV1(`${group}.${operation}`),
        }]; });
    });
    return Object.entries(descriptor.actions).flatMap(([group, value]) => {
        if (value === undefined) return [];
        if (typeof value === 'string') return [{ role: group, reference: value, targetFamily: 'actions' as const, path: ['actions', group],
            readOnly: isDeploymentTargetRoleReadOnlyV1(group) }];
        return Object.entries(value).flatMap(([role, action]) => action === undefined ? [] : [{
            role: `${group}.${role}`, reference: action, targetFamily: 'actions' as const, path: ['actions', group, role],
            readOnly: isDeploymentTargetRoleReadOnlyV1(`${group}.${role}`),
        }]);
    });
}

/** Existing Action-only consumers delegate to the same kind-aware role owner. */
export function readDeploymentTargetActionRolesV1(descriptor: DeploymentTargetContributionV1): readonly DeploymentTargetActionRoleV1[] {
    return readDeploymentTargetReferenceRolesV1(descriptor).flatMap(binding => binding.targetFamily === 'actions'
        ? [{ role: binding.role, action: binding.reference, path: binding.path, readOnly: binding.readOnly }] : []);
}

/** Declaration admission grants no invocation authority; installation and role custody remain host-owned. */
export function validateDeploymentTargetContributionsV1(
    value: Readonly<{ deploymentTargets: readonly DeploymentTargetContributionV1[]; actions: readonly PluginActionContributionV2[];
        resources: readonly PluginResourceContributionV2[] }>,
    context: z.core.$RefinementCtx,
): void {
    const ids = new Set<string>();
    value.deploymentTargets.forEach((descriptor, index) => {
        if (ids.has(descriptor.id)) context.addIssue({ code: 'custom', path: ['deploymentTargets', index, 'id'], message: 'Duplicate deployment target id.' });
        ids.add(descriptor.id);
        for (const binding of readDeploymentTargetReferenceRolesV1(descriptor)) {
            const path = ['deploymentTargets', index, ...binding.path];
            if (binding.targetFamily === 'resources') {
                const resource = value.resources.find(candidate => candidate.id === binding.reference);
                if (!resource || resource.source !== 'dynamic') {
                    context.addIssue({ code: 'custom', path, message: 'Deployment data reads require declared same-plugin dynamic Resources.' });
                }
                continue;
            }
            const action = value.actions.find(candidate => candidate.id === binding.reference);
            if (!action) {
                context.addIssue({ code: 'custom', path, message: 'Deployment target roles require declared same-plugin Actions.' });
                continue;
            }
            if (action.execution.target === 'client' || binding.role === 'uploadDeploy' && action.execution.target !== 'daemon') {
                context.addIssue({ code: 'custom', path, message: 'Deployment target roles require Account or daemon placement; uploadDeploy requires daemon placement.' });
            }
            // The query's named string parameters are the canonical typed map;
            // every custody field and the enclosing input remain exact/closed.
            const queryInput = binding.role === 'query.readOnly';
            let validInput = false;
            try {
                validInput = Boolean(action.inputSchema && (queryInput
                    ? pluginJsonValuesEqual(normalizePluginJsonSchema(action.inputSchema),
                        normalizePluginJsonSchema(DeploymentTargetRoleInputProtocolSchemasV1['query.readOnly'].jsonSchema))
                    : isRecursivelyClosedPluginJsonSchemaV2(action.inputSchema)));
            } catch { /* Invalid authored schemas receive the same typed declaration refusal below. */ }
            if (!validInput || !action.resultSchema
                || !isRecursivelyClosedPluginJsonSchemaV2(action.resultSchema)) {
                context.addIssue({ code: 'custom', path, message: 'Deployment target roles require explicit recursively closed input and result schemas.' });
            }
            if ((binding.role === 'projects.delete' || binding.role === 'projects.observe') && (!action.resultSchema
                || !pluginJsonValuesEqual(normalizePluginJsonSchema(action.resultSchema),
                    normalizePluginJsonSchema(DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema)))) {
                context.addIssue({ code: 'custom', path, message: 'Data project deletion and recovery require the canonical absence observation.' });
            }
            if (descriptor.role === 'runtime' && binding.role !== 'inspect' && binding.role !== 'link'
                && Object.hasOwn(DeploymentTargetRoleInputProtocolSchemasV1, binding.role)) {
                const role = binding.role as keyof typeof DeploymentTargetRoleInputProtocolSchemasV1;
                try {
                    if (!action.inputSchema || !action.resultSchema
                        || !pluginJsonValuesEqual(normalizePluginJsonSchema(action.inputSchema),
                            normalizePluginJsonSchema(DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema))
                        || !pluginJsonValuesEqual(normalizePluginJsonSchema(action.resultSchema),
                            normalizePluginJsonSchema((binding.role === 'create' ? DeploymentTargetLinkProviderContentV1ProtocolSchema
                                : binding.role.startsWith('domains.') ? DeploymentTargetDomainResultV1ProtocolSchema
                                : binding.role.startsWith('logs.')
                                ? DeploymentTargetLogsResultV1ProtocolSchema
                                : role === 'variables.read' ? DeploymentTargetVariablesReadResultV1ProtocolSchema
                                : role === 'variables.sync' ? DeploymentTargetVariablesSyncResultV1ProtocolSchema
                                : DeploymentTargetRoleResultV1ProtocolSchema).jsonSchema))) {
                        context.addIssue({ code: 'custom', path, message: 'Deployment lifecycle roles require their exact canonical input and observation schemas.' });
                    }
                } catch {
                    context.addIssue({ code: 'custom', path, message: 'Deployment lifecycle roles require valid canonical schemas.' });
                }
            }
            if (!queryInput && (descriptor.role === 'data' || binding.role === 'inspect' || binding.role === 'link')) {
                try {
                    const declared = action.inputSchema && normalizePluginJsonSchema(action.inputSchema);
                    const role = binding.role as keyof typeof DeploymentTargetRoleInputProtocolSchemasV1;
                    const base = normalizePluginJsonSchema(descriptor.role === 'data'
                        ? DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema
                        : DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema);
                    const valid = declared?.type === 'object' && (base.required ?? []).every(key =>
                        declared.required?.includes(key) && declared.properties?.[key] !== undefined
                        && (key === 'providerEnvironment' || pluginJsonValuesEqual(declared.properties[key], base.properties?.[key])))
                        && Object.keys(base.properties ?? {}).every(key => declared.properties?.[key] === undefined
                            || key === 'providerEnvironment' || pluginJsonValuesEqual(declared.properties[key], base.properties?.[key]));
                    if (!valid) context.addIssue({ code: 'custom', path,
                        message: 'Deployment preparation requires canonical shared custody fields; product scope and operands remain declared.' });
                } catch {
                    context.addIssue({ code: 'custom', path, message: 'Deployment preparation requires valid canonical custody schemas.' });
                }
            }
            if (binding.readOnly ? action.dangerLevel !== 'safe' || action.readOnly === false
                || descriptor.role === 'data' && action.readOnly !== true
                : action.dangerLevel === 'safe' || action.readOnly === true) {
                context.addIssue({ code: 'custom', path, message: 'Deployment target role effect metadata must match its read or mutation contract.' });
            }
        }
    });
}
