import { lazyZodSchema } from '../lazyZodSchema.js';
import type { WorkBoardArtifactTransportV1, WorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { applyWidgetDefinitionPatchV1, readWidgetDefinitionResourcesV1, WidgetDefinitionAuthorV1Schema, WidgetDefinitionBodyV1Schema, WidgetDefinitionDraftV1Schema, WidgetDefinitionV1Schema, WidgetDefinitionV1StoredSchema, type WidgetDefinitionPatchV1, type WidgetDefinitionV1 } from './widgetDefinitionV1.js';

export const WIDGET_DEFINITION_ARTIFACT_KIND_V1 = 'widget-definition.v1';
export type WidgetDefinitionArtifactV1 = WorkBoardArtifactV1 & Readonly<{ ownerAccountId: string }>;
export type WidgetDefinitionArtifactTransportV1 = Pick<WorkBoardArtifactTransportV1, 'create' | 'update' | 'delete'> & Readonly<{
    read(artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<WidgetDefinitionArtifactV1 | null>;
    list(options: Readonly<{ limit: number; cursor?: string; signal?: AbortSignal }>): Promise<Readonly<{
        items: readonly Readonly<{ artifactId: string; ownerAccountId: string; header: Readonly<Record<string, unknown>>; headerVersion: number }>[];
        nextCursor?: string;
    }>>;
}>;
export const WidgetDefinitionSummaryV1Schema = lazyZodSchema(() => WidgetDefinitionDraftV1Schema.pick({ name: true, description: true, inputs: true,
    inputSchema: true, sessionInputPath: true, connectedAccountPurposeBindings: true, sizeDeclaration: true }).extend({
    artifactId: z.string().trim().min(1), bodyKind: z.enum(['installed', 'declarative']),
    /** Provenance people read in the Add surface ("made by your agent on Oct 3"), from the definition itself. */
    author: WidgetDefinitionAuthorV1Schema.optional(), createdAt: z.number().int().nonnegative().optional(),
    resources: z.array(asProtocolZod(PluginContributionIdentityV1Schema)),
    sourceDefinition: WidgetDefinitionBodyV1Schema.options[1].optional(),
}).strict());
export type WidgetDefinitionSummaryV1 = z.infer<typeof WidgetDefinitionSummaryV1Schema>;
export const WidgetDefinitionSummaryV1StoredSchema = createStoredReadSchema(WidgetDefinitionSummaryV1Schema);
export type WidgetDefinitionArtifactPortV1 = Readonly<{
    list(signal?: AbortSignal): Promise<readonly WidgetDefinitionSummaryV1[]>;
    get(artifactId: string, signal?: AbortSignal): Promise<WidgetDefinitionV1 | null>;
    create(definition: WidgetDefinitionV1, signal?: AbortSignal): Promise<WidgetDefinitionV1>;
    update(artifactId: string, patch: WidgetDefinitionPatchV1, signal?: AbortSignal): Promise<WidgetDefinitionV1>;
    duplicate(artifactId: string, newArtifactId: string, name?: string, signal?: AbortSignal): Promise<WidgetDefinitionV1>;
    delete(artifactId: string, signal?: AbortSignal): Promise<void>;
}>;
export class WidgetDefinitionErrorV1 extends Error {
    constructor(readonly code: string) { super(code); this.name = 'WidgetDefinitionErrorV1'; }
}
export function buildWidgetDefinitionArtifactHeaderV1(definition: WidgetDefinitionV1): Readonly<Record<string, unknown>> {
    return { kind: WIDGET_DEFINITION_ARTIFACT_KIND_V1, v: 1, title: definition.name,
        summary: { artifactId: definition.id, name: definition.name, inputs: definition.inputs, inputSchema: definition.inputSchema,
            sizeDeclaration: definition.sizeDeclaration,
            bodyKind: definition.body.kind, resources: readWidgetDefinitionResourcesV1(definition),
            ...(definition.body.kind === 'installed' ? { sourceDefinition: definition.body } : {}),
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            ...(definition.provenance.author ? { author: definition.provenance.author } : {}),
            ...(definition.provenance.createdAt !== undefined ? { createdAt: definition.provenance.createdAt } : {}),
            ...(definition.sessionInputPath !== undefined ? { sessionInputPath: definition.sessionInputPath } : {}),
            ...(definition.connectedAccountPurposeBindings ? { connectedAccountPurposeBindings: definition.connectedAccountPurposeBindings } : {}) } };
}
/** Readable header metadata is discovery, never permission to execute the body. */
export function readWidgetDefinitionArtifactSummaryV1(artifactId: string, header: Readonly<Record<string, unknown>>): WidgetDefinitionSummaryV1 | null {
    if (header.kind !== WIDGET_DEFINITION_ARTIFACT_KIND_V1 || header.v !== 1) return null;
    const summary = WidgetDefinitionSummaryV1StoredSchema.safeParse(header.summary);
    return summary.success && summary.data.artifactId === artifactId && summary.data.name === header.title ? summary.data : null;
}
export function readWidgetDefinitionArtifactV1(artifact: Pick<WidgetDefinitionArtifactV1, 'artifactId' | 'header' | 'body'>): WidgetDefinitionV1 {
    if (artifact.header.kind !== WIDGET_DEFINITION_ARTIFACT_KIND_V1 || artifact.header.v !== 1 || typeof artifact.body !== 'string') {
        throw new WidgetDefinitionErrorV1('invalid_widget_definition_record');
    }
    let body: unknown;
    try { body = JSON.parse(artifact.body); } catch { throw new WidgetDefinitionErrorV1('invalid_widget_definition_record'); }
    const parsed = WidgetDefinitionV1StoredSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== artifact.artifactId) throw new WidgetDefinitionErrorV1('invalid_widget_definition_record');
    return parsed.data;
}

/** Account mode and keys belong to the existing Artifact codec, never a definition-local codec. */
export function createWidgetDefinitionArtifactPortV1(transport: WidgetDefinitionArtifactTransportV1, options: Readonly<{
    accountId: string; shouldContinue?: () => boolean;
}>): WidgetDefinitionArtifactPortV1 {
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!options.accountId || options.shouldContinue && !options.shouldContinue()) throw new WidgetDefinitionErrorV1('widget_definition_scope_retired');
    };
    const fetch = async (artifactId: string, signal?: AbortSignal) => {
        check(signal); const artifact = await transport.read(artifactId, { signal }); check(signal);
        if (artifact && (artifact.artifactId !== artifactId || artifact.ownerAccountId !== options.accountId)) throw new WidgetDefinitionErrorV1('widget_definition_account_mismatch');
        return artifact;
    };
    const get = async (artifactId: string, signal?: AbortSignal) => {
        const artifact = await fetch(artifactId, signal); return artifact ? readWidgetDefinitionArtifactV1(artifact) : null;
    };
    const create = async (raw: WidgetDefinitionV1, signal?: AbortSignal) => {
        const definition = WidgetDefinitionV1Schema.parse(raw);
        if (await fetch(definition.id, signal)) throw new WidgetDefinitionErrorV1('widget_definition_already_exists');
        check(signal);
        await transport.create({ artifactId: definition.id, header: buildWidgetDefinitionArtifactHeaderV1(definition), body: JSON.stringify(definition), signal });
        const acknowledged = await get(definition.id, signal);
        if (!acknowledged || !sameStrictJsonValue(acknowledged, definition)) throw new WidgetDefinitionErrorV1('widget_definition_create_conflict');
        return acknowledged;
    };
    return {
        get, create,
        async list(signal) {
            const definitions: WidgetDefinitionSummaryV1[] = [];
            let cursor: string | undefined;
            do {
                check(signal);
                // Existing Artifact page maximum: paging does not cap definition inventory.
                const page = await transport.list({ limit: 500, ...(cursor ? { cursor } : {}), signal });
                check(signal);
                for (const item of page.items) {
                    if (item.header.kind !== WIDGET_DEFINITION_ARTIFACT_KIND_V1) continue;
                    if (item.ownerAccountId !== options.accountId) continue;
                    if (item.header.v !== 1 || typeof item.header.title !== 'string' || !item.header.title.trim()) continue;
                    const summary = readWidgetDefinitionArtifactSummaryV1(item.artifactId, item.header);
                    if (summary) definitions.push(summary);
                }
                cursor = page.nextCursor;
            } while (cursor);
            return definitions;
        },
        async update(artifactId, patch, signal) {
            for (;;) {
            const artifact = await fetch(artifactId, signal);
            if (!artifact) throw new WidgetDefinitionErrorV1('widget_definition_not_found');
            const next = applyWidgetDefinitionPatchV1(readWidgetDefinitionArtifactV1(artifact), patch);
            check(signal);
            const result = await transport.update({ artifactId, expectedRevision: artifact.revision,
                header: buildWidgetDefinitionArtifactHeaderV1(next), body: JSON.stringify(next), signal });
            check(signal);
            if (result.ok) return next;
            if (result.errorCode !== 'version_mismatch') throw new WidgetDefinitionErrorV1(result.errorCode);
            // Replay only the requested fields on the current definition winner.
            }
        },
        async duplicate(artifactId, newArtifactId, name, signal) {
            const current = await get(artifactId, signal);
            if (!current) throw new WidgetDefinitionErrorV1('widget_definition_not_found');
            return create({ ...current, id: newArtifactId, ...(name !== undefined ? { name } : {}) }, signal);
        },
        async delete(artifactId, signal) {
            for (;;) {
            const artifact = await fetch(artifactId, signal);
            if (!artifact) throw new WidgetDefinitionErrorV1('widget_definition_not_found');
            readWidgetDefinitionArtifactV1(artifact);
            check(signal);
            const result = await transport.delete(artifactId, { expectedRevision: artifact.revision, signal });
            check(signal);
            if (result.ok) return;
            if (result.errorCode !== 'version_mismatch') throw new WidgetDefinitionErrorV1(result.errorCode);
            }
        },
    };
}
