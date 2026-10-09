import * as z from 'zod/mini';
import { lazyDefinition } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';
import { WorkspaceSyncRelationshipV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { PromptStackEntryV1Schema } from '../prompts/library/promptStacksV1.js';

export const PROJECT_ACCOUNT_ROWS_ROUTE_V1 = '/v1/account/project-rows' as const;
export const PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 = '@happier/account/project-rows/v1/' as const;
export const PROJECT_ACCOUNT_ROW_BLOB_KIND_V1 = 'project_account_row' as const;
const IdSchema = lazyDefinition(() => z.string().check(z.minLength(1), z.refine(value => value === value.trim())));
const RevisionSchema = lazyDefinition(() => z.int().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
export const ProjectAccountRowExpectedRevisionV1Schema = lazyDefinition(() => z.union([RevisionSchema, z.literal('absent')]));
export const ProjectAccountWorkspaceRefKeyV1Schema = lazyDefinition(() => z.strictObject({ kind: z.literal('workspace-ref'), serverId: IdSchema, id: IdSchema }));
export const ProjectAccountRelationshipGraphKeyV1Schema = lazyDefinition(() => z.strictObject({ kind: z.literal('relationship-graph') }));
export const ProjectAccountOrganizationKeyV1Schema = lazyDefinition(() => z.strictObject({ kind: z.literal('project-organization'), serverId: IdSchema, projectKey: IdSchema }));
export const ProjectAccountRowKeyV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
    ProjectAccountWorkspaceRefKeyV1Schema, ProjectAccountRelationshipGraphKeyV1Schema, ProjectAccountOrganizationKeyV1Schema,
]));
export type ProjectAccountRowKeyV1 = z.infer<typeof ProjectAccountRowKeyV1Schema>;
export const ProjectAccountRelationshipGraphV1Schema = lazyDefinition(() => z.strictObject({ relationships: z.array(WorkspaceSyncRelationshipV1Schema) }));
export type ProjectAccountRelationshipGraphV1 = z.infer<typeof ProjectAccountRelationshipGraphV1Schema>;
export const ProjectAccountOrganizationV1Schema = lazyDefinition(() => z.strictObject({
    hidden: z.optional(z.boolean()), pinned: z.optional(z.boolean()),
    promptStack: z.optional(z.array(z.strictObject({ ...PromptStackEntryV1Schema.shape,
        ref: z.strictObject({ ...PromptStackEntryV1Schema.shape.ref.shape }),
    }))),
}));
export type ProjectAccountOrganizationV1 = z.infer<typeof ProjectAccountOrganizationV1Schema>;
/** Navigation recency lives in authoring memory, outside structural row revisions. */
export const ProjectAccountWorkspaceRefV1Schema = lazyDefinition(() => {
    const { lastOpenedAtMs: _lastOpenedAtMs, ...structuralFields } = WorkspaceRefV1WriteSchema.shape;
    return z.strictObject({ ...structuralFields, label: z.optional(z.nullable(z.string().check(z.minLength(1)))) });
});
export type ProjectAccountWorkspaceRefV1 = z.infer<typeof ProjectAccountWorkspaceRefV1Schema>;
export const ProjectAccountRowPayloadV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ key: ProjectAccountWorkspaceRefKeyV1Schema, value: ProjectAccountWorkspaceRefV1Schema })
        .check(z.refine(payload => payload.key.id === payload.value.id && payload.key.serverId === payload.value.serverId, 'Workspace row identity mismatch')),
    z.strictObject({ key: ProjectAccountRelationshipGraphKeyV1Schema, value: ProjectAccountRelationshipGraphV1Schema }),
    z.strictObject({ key: ProjectAccountOrganizationKeyV1Schema, value: ProjectAccountOrganizationV1Schema }),
]));
export type ProjectAccountRowPayloadV1 = z.infer<typeof ProjectAccountRowPayloadV1Schema>;
export const StoredProjectAccountRowPayloadV1Schema = createStoredReadSchema(ProjectAccountRowPayloadV1Schema);
export const ProjectAccountRowContentV1Schema = lazyDefinition(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: ProjectAccountRowPayloadV1Schema }),
    z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ProjectAccountRowContentV1 = z.infer<typeof ProjectAccountRowContentV1Schema>;
export const StoredProjectAccountRowContentV1Schema = createStoredReadSchema(ProjectAccountRowContentV1Schema);

/** Opened private payloads must belong to the exact requested physical row. */
export function assertProjectAccountRowPayloadBindingV1(key: ProjectAccountRowKeyV1, input: unknown): ProjectAccountRowPayloadV1 {
    const payload = StoredProjectAccountRowPayloadV1Schema.parse(input);
    if (buildProjectAccountRowPhysicalKeyV1(payload.key) !== buildProjectAccountRowPhysicalKeyV1(key)) {
        throw new Error('Project Account row identity mismatch');
    }
    return payload;
}
export function assertProjectAccountRowContentForModeV1(input: unknown, mode: 'plain' | 'e2ee'): ProjectAccountRowContentV1 {
    const content = StoredProjectAccountRowContentV1Schema.parse(input);
    if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && (content.t !== 'encrypted'
        || !isAccountScopedBlobCiphertextForKind({ kind: PROJECT_ACCOUNT_ROW_BLOB_KIND_V1, ciphertext: content.c })))) {
        throw new Error('Project Account row mode mismatch');
    }
    return content;
}
export function buildProjectAccountRowPhysicalKeyV1(input: ProjectAccountRowKeyV1): string {
    const key = ProjectAccountRowKeyV1Schema.parse(input);
    if (key.kind === 'relationship-graph') return `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}graph`;
    if (key.kind === 'workspace-ref') return `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}ref/${encodeURIComponent(key.serverId)}/${encodeURIComponent(key.id)}`;
    return `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}organization/${encodeURIComponent(key.serverId)}/${encodeURIComponent(key.projectKey)}`;
}
export function parseProjectAccountRowPhysicalKeyV1(physicalKey: string): ProjectAccountRowKeyV1 | null {
    if (!physicalKey.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1)) return null;
    const parts = physicalKey.slice(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1.length).split('/');
    let input: unknown;
    try {
        if (parts.length === 1 && parts[0] === 'graph') input = { kind: 'relationship-graph' };
        else if (parts.length === 3 && parts[0] === 'ref') input = { kind: 'workspace-ref', serverId: decodeURIComponent(parts[1]!), id: decodeURIComponent(parts[2]!) };
        else if (parts.length === 3 && parts[0] === 'organization') input = { kind: 'project-organization', serverId: decodeURIComponent(parts[1]!), projectKey: decodeURIComponent(parts[2]!) };
        else return null;
    } catch { return null; }
    const parsed = ProjectAccountRowKeyV1Schema.safeParse(input);
    return parsed.success && buildProjectAccountRowPhysicalKeyV1(parsed.data) === physicalKey ? parsed.data : null;
}
export const ProjectAccountRowV1Schema = lazyDefinition(() => z.strictObject({ key: ProjectAccountRowKeyV1Schema, revision: RevisionSchema, content: z.nullable(ProjectAccountRowContentV1Schema) }));
export type ProjectAccountRowV1 = z.infer<typeof ProjectAccountRowV1Schema>;
export const ProjectAccountRowReadRequestV1Schema = lazyDefinition(() => z.strictObject({ key: ProjectAccountRowKeyV1Schema }));
export const ProjectAccountRowListRequestV1Schema = lazyDefinition(() => z.strictObject({
    kinds: z.optional(z.array(z.enum(['workspace-ref', 'relationship-graph', 'project-organization']))), serverId: z.optional(IdSchema),
}));
export type ProjectAccountRowListRequestV1 = z.infer<typeof ProjectAccountRowListRequestV1Schema>;
export const ProjectAccountRowMutationRequestV1Schema = lazyDefinition(() => z.strictObject({
    mutations: z.array(z.strictObject({ key: ProjectAccountRowKeyV1Schema, expectedRevision: ProjectAccountRowExpectedRevisionV1Schema, content: z.nullable(ProjectAccountRowContentV1Schema) })).check(z.minLength(1)),
    expectedRefs: z.array(z.strictObject({ key: ProjectAccountWorkspaceRefKeyV1Schema, expectedRevision: ProjectAccountRowExpectedRevisionV1Schema })),
    topologyChange: z.boolean(),
}));
export type ProjectAccountRowMutationRequestV1 = z.infer<typeof ProjectAccountRowMutationRequestV1Schema>;
export const ProjectAccountRowFailureV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.enum(['account-not-found', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-request', 'graph-required', 'graph-deletion-forbidden']) }),
    z.strictObject({ status: z.literal('account-inconsistent'), reason: z.string() }),
    z.strictObject({ status: z.literal('conflict'), key: ProjectAccountRowKeyV1Schema, revision: z.int().check(z.minimum(-1), z.maximum(Number.MAX_SAFE_INTEGER)) }),
]));
export type ProjectAccountRowFailureV1 = z.infer<typeof ProjectAccountRowFailureV1Schema>;
export const ProjectAccountRowReadResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('present'), row: ProjectAccountRowV1Schema }),
    z.strictObject({ status: z.literal('absent') }),
    z.strictObject({ status: z.literal('deleted'), revision: RevisionSchema }), ProjectAccountRowFailureV1Schema,
]));
export type ProjectAccountRowReadResponseV1 = z.infer<typeof ProjectAccountRowReadResponseV1Schema>;
export const ProjectAccountRowListResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('listed'), rows: z.array(ProjectAccountRowV1Schema), coverage: z.literal('complete') }), ProjectAccountRowFailureV1Schema,
]));
export type ProjectAccountRowListResponseV1 = z.infer<typeof ProjectAccountRowListResponseV1Schema>;
export const ProjectAccountRowMutationResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('updated'), rows: z.array(ProjectAccountRowV1Schema), cursor: RevisionSchema }), ProjectAccountRowFailureV1Schema,
]));
export type ProjectAccountRowMutationResponseV1 = z.infer<typeof ProjectAccountRowMutationResponseV1Schema>;
export const ProjectAccountRowChangeHintV1Schema = lazyDefinition(() => z.strictObject({ projectAccountRow: z.literal(true), key: ProjectAccountRowKeyV1Schema, revision: RevisionSchema }));
