import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { WidgetDefinitionAuthorV1Schema } from './widgetDefinitionV1.js';
import type { WidgetDefinitionArtifactTransportV1, WidgetDefinitionArtifactV1 } from './widgetDefinitionArtifactV1.js';
import { applyWidgetLayoutFragmentPatchV1, WidgetLayoutFragmentDraftV1Schema, WidgetLayoutFragmentV1Schema,
    WidgetLayoutFragmentV1StoredSchema, type WidgetLayoutFragmentPatchV1, type WidgetLayoutFragmentV1 } from './widgetLayoutFragmentV1.js';

export const WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1 = 'widget-layout-fragment.v1';
export const WidgetLayoutFragmentSummaryV1Schema = lazyZodSchema(() => WidgetLayoutFragmentDraftV1Schema.extend({
    artifactId: z.string().trim().min(1), childCount: z.number().int().positive(),
    author: WidgetDefinitionAuthorV1Schema.optional(), createdAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
    if (value.childCount !== value.group.children.length) context.addIssue({ code: 'custom', path: ['childCount'], message: 'Group child count mismatch' });
}));
export type WidgetLayoutFragmentSummaryV1 = z.infer<typeof WidgetLayoutFragmentSummaryV1Schema>;
export const WidgetLayoutFragmentSummaryV1StoredSchema = createStoredReadSchema(WidgetLayoutFragmentSummaryV1Schema);
export type WidgetLayoutFragmentArtifactPortV1 = Readonly<{
    list(signal?: AbortSignal): Promise<readonly WidgetLayoutFragmentSummaryV1[]>;
    get(artifactId: string, signal?: AbortSignal): Promise<WidgetLayoutFragmentV1 | null>;
    create(fragment: WidgetLayoutFragmentV1, signal?: AbortSignal): Promise<WidgetLayoutFragmentV1>;
    update(artifactId: string, patch: WidgetLayoutFragmentPatchV1, signal?: AbortSignal): Promise<WidgetLayoutFragmentV1>;
    duplicate(artifactId: string, newArtifactId: string, name?: string, signal?: AbortSignal): Promise<WidgetLayoutFragmentV1>;
    delete(artifactId: string, signal?: AbortSignal): Promise<void>;
}>;
export class WidgetLayoutFragmentErrorV1 extends Error {
    constructor(readonly code: string) { super(code); this.name = 'WidgetLayoutFragmentErrorV1'; }
}
export function buildWidgetLayoutFragmentArtifactHeaderV1(fragment: WidgetLayoutFragmentV1): Readonly<Record<string, unknown>> {
    return { kind: WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1, v: 1, title: fragment.name,
        summary: { artifactId: fragment.id, name: fragment.name, inputs: fragment.inputs, inputSchema: fragment.inputSchema,
            group: fragment.group, childCount: fragment.group.children.length,
            ...(fragment.description !== undefined ? { description: fragment.description } : {}),
            ...(fragment.origin ? { origin: fragment.origin } : {}),
            ...(fragment.provenance.author ? { author: fragment.provenance.author } : {}),
            ...(fragment.provenance.createdAt !== undefined ? { createdAt: fragment.provenance.createdAt } : {}) } };
}
export function readWidgetLayoutFragmentArtifactSummaryV1(artifactId: string, header: Readonly<Record<string, unknown>>): WidgetLayoutFragmentSummaryV1 | null {
    if (header.kind !== WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1 || header.v !== 1) return null;
    const parsed = WidgetLayoutFragmentSummaryV1StoredSchema.safeParse(header.summary);
    return parsed.success && parsed.data.artifactId === artifactId && parsed.data.name === header.title ? parsed.data : null;
}
export function readWidgetLayoutFragmentArtifactV1(artifact: Pick<WidgetDefinitionArtifactV1, 'artifactId' | 'header' | 'body'>): WidgetLayoutFragmentV1 {
    if (artifact.header.kind !== WIDGET_LAYOUT_FRAGMENT_ARTIFACT_KIND_V1 || artifact.header.v !== 1 || typeof artifact.body !== 'string') {
        throw new WidgetLayoutFragmentErrorV1('invalid_widget_fragment_record');
    }
    let body: unknown;
    try { body = JSON.parse(artifact.body); } catch { throw new WidgetLayoutFragmentErrorV1('invalid_widget_fragment_record'); }
    const parsed = WidgetLayoutFragmentV1StoredSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== artifact.artifactId) throw new WidgetLayoutFragmentErrorV1('invalid_widget_fragment_record');
    return parsed.data;
}

/** Encryption-mode admission remains at the existing Account Artifact transport. */
export function createWidgetLayoutFragmentArtifactPortV1(transport: WidgetDefinitionArtifactTransportV1, options: Readonly<{
    accountId: string; shouldContinue?: () => boolean;
}>): WidgetLayoutFragmentArtifactPortV1 {
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!options.accountId || options.shouldContinue && !options.shouldContinue()) throw new WidgetLayoutFragmentErrorV1('widget_fragment_scope_retired');
    };
    const fetch = async (artifactId: string, signal?: AbortSignal) => {
        check(signal); const artifact = await transport.read(artifactId, { signal }); check(signal);
        if (artifact && (artifact.artifactId !== artifactId || artifact.ownerAccountId !== options.accountId)) throw new WidgetLayoutFragmentErrorV1('widget_fragment_account_mismatch');
        return artifact;
    };
    const get = async (artifactId: string, signal?: AbortSignal) => {
        const artifact = await fetch(artifactId, signal); return artifact ? readWidgetLayoutFragmentArtifactV1(artifact) : null;
    };
    const create = async (raw: WidgetLayoutFragmentV1, signal?: AbortSignal) => {
        const fragment = WidgetLayoutFragmentV1Schema.parse(raw);
        if (await fetch(fragment.id, signal)) throw new WidgetLayoutFragmentErrorV1('widget_fragment_already_exists');
        check(signal);
        await transport.create({ artifactId: fragment.id, header: buildWidgetLayoutFragmentArtifactHeaderV1(fragment), body: JSON.stringify(fragment), signal });
        const acknowledged = await get(fragment.id, signal);
        if (!acknowledged || !sameStrictJsonValue(acknowledged, fragment)) throw new WidgetLayoutFragmentErrorV1('widget_fragment_create_conflict');
        return acknowledged;
    };
    return { get, create,
        async list(signal) {
            const fragments: WidgetLayoutFragmentSummaryV1[] = [];
            let cursor: string | undefined;
            do {
                check(signal);
                // Reuse the existing Artifact page maximum without limiting the saved-group inventory.
                const page = await transport.list({ limit: 500, ...(cursor ? { cursor } : {}), signal });
                check(signal);
                for (const item of page.items) {
                    if (item.ownerAccountId !== options.accountId) continue;
                    const summary = readWidgetLayoutFragmentArtifactSummaryV1(item.artifactId, item.header);
                    if (summary) fragments.push(summary);
                }
                cursor = page.nextCursor;
            } while (cursor);
            return fragments;
        },
        async update(artifactId, patch, signal) {
            for (;;) {
                const artifact = await fetch(artifactId, signal);
                if (!artifact) throw new WidgetLayoutFragmentErrorV1('widget_fragment_not_found');
                const next = applyWidgetLayoutFragmentPatchV1(readWidgetLayoutFragmentArtifactV1(artifact), patch);
                check(signal);
                const result = await transport.update({ artifactId, expectedRevision: artifact.revision,
                    header: buildWidgetLayoutFragmentArtifactHeaderV1(next), body: JSON.stringify(next), signal });
                check(signal);
                if (result.ok) return next;
                if (result.errorCode !== 'version_mismatch') throw new WidgetLayoutFragmentErrorV1(result.errorCode);
            }
        },
        async duplicate(artifactId, newArtifactId, name, signal) {
            const current = await get(artifactId, signal);
            if (!current) throw new WidgetLayoutFragmentErrorV1('widget_fragment_not_found');
            return create({ ...current, id: newArtifactId, ...(name !== undefined ? { name } : {}) }, signal);
        },
        async delete(artifactId, signal) {
            for (;;) {
                const artifact = await fetch(artifactId, signal);
                if (!artifact) throw new WidgetLayoutFragmentErrorV1('widget_fragment_not_found');
                readWidgetLayoutFragmentArtifactV1(artifact);
                check(signal);
                const result = await transport.delete(artifactId, { expectedRevision: artifact.revision, signal });
                check(signal);
                if (result.ok) return;
                if (result.errorCode !== 'version_mismatch') throw new WidgetLayoutFragmentErrorV1(result.errorCode);
            }
        },
    };
}
