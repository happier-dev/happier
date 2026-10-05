import { z } from 'zod';
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex } from '@noble/hashes/utils';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { HomeHubArtifactTransportV1 } from '../home/homeHubArtifactV1.js';
import { WidgetInstanceV1Schema, WidgetInputBindingsV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { WidgetExpectedPresentationV1Schema, type WidgetActionSurfacePortV1, type WidgetSurfaceMutationV1, type WidgetMoveCaptureV1 } from './actionsV1.js';

export const WIDGET_SURFACE_ARTIFACT_KIND_V1 = 'widget-area-layout.v1';
export const WidgetAreaSurfaceRefV1Schema = WidgetSurfaceRefV1Schema.refine(surface => surface.owner.kind === 'project' || surface.owner.kind === 'pluginArea', 'Personal area required');
export const WidgetAreaLayoutV1Schema = z.object({
    v: z.literal(1), surface: WidgetAreaSurfaceRefV1Schema,
    instances: z.array(z.object({ instance: WidgetInstanceV1Schema, width: z.enum(['half', 'full']).optional(), frameStyle: z.enum(['card', 'plain']).optional() }).strict()),
}).strict().refine(layout => new Set(layout.instances.map(entry => entry.instance.id)).size === layout.instances.length, 'Duplicate instance');
export type WidgetAreaLayoutV1 = z.infer<typeof WidgetAreaLayoutV1Schema>;
const instanceId = WidgetInstanceV1Schema.shape.id;
const index = z.number().int().nonnegative().safe();
export const WidgetAreaLayoutIntentV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add'), instance: WidgetInstanceV1Schema, toIndex: index.optional(), width: z.enum(['half', 'full']).optional(), frameStyle: z.enum(['card', 'plain']).optional() }).strict(),
    z.object({ kind: z.literal('remove'), instanceId, expectedInstance: WidgetInstanceV1Schema.optional(), expectedPresentation: WidgetExpectedPresentationV1Schema.optional() }).strict(),
    z.object({ kind: z.literal('move'), instanceId, toIndex: index }).strict(),
    z.object({ kind: z.literal('rename'), instanceId, displayName: z.string().trim().min(1).nullable() }).strict(),
    z.object({ kind: z.literal('inputs'), instanceId, bindings: WidgetInputBindingsV1Schema }).strict(),
    z.object({ kind: z.literal('width'), instanceId, width: z.enum(['half', 'full']) }).strict(),
    z.object({ kind: z.literal('frame'), instanceId, frameStyle: z.enum(['card', 'plain']).nullable() }).strict(),
]);
export type WidgetAreaLayoutIntentV1 = z.infer<typeof WidgetAreaLayoutIntentV1Schema>;
export class WidgetAreaMutationErrorV1 extends Error {
    constructor(readonly code: string) { super(code); this.name = 'WidgetAreaMutationErrorV1'; }
}
/** Singleton identity contains only captured owner facts, never page context or checkout. */
export function buildWidgetSurfaceArtifactIdV1(raw: WidgetSurfaceRefV1): string {
    const surface = WidgetAreaSurfaceRefV1Schema.parse(raw);
    const bytes = sha1(new TextEncoder().encode(JSON.stringify([WIDGET_SURFACE_ARTIFACT_KIND_V1, surface]))).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function presentation(layout: WidgetAreaLayoutV1, id: string) {
    const nativeIndex = layout.instances.findIndex(entry => entry.instance.id === id);
    const entry = layout.instances[nativeIndex];
    if (!entry) throw new WidgetAreaMutationErrorV1('widget_instance_not_found');
    return { nativeIndex, frameStyle: entry.frameStyle ?? null, ...(entry.width ? { width: entry.width } : {}) };
}
export function applyWidgetAreaLayoutIntentV1(layout: WidgetAreaLayoutV1, raw: WidgetAreaLayoutIntentV1): WidgetAreaLayoutV1 {
    const intent = WidgetAreaLayoutIntentV1Schema.parse(raw);
    const instances = [...layout.instances];
    if (intent.kind === 'add') {
        if (instances.some(entry => entry.instance.id === intent.instance.id)) throw new WidgetAreaMutationErrorV1('widget_instance_already_exists');
        instances.splice(Math.min(intent.toIndex ?? instances.length, instances.length), 0, { instance: intent.instance,
            ...(layout.surface.owner.kind === 'pluginArea' ? { width: intent.width ?? 'half' } : {}), ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}) });
    } else {
        const at = instances.findIndex(entry => entry.instance.id === intent.instanceId);
        const current = instances[at];
        if (!current) throw new WidgetAreaMutationErrorV1('widget_instance_not_found');
        switch (intent.kind) {
            case 'remove':
                if (intent.expectedInstance && !sameStrictJsonValue(intent.expectedInstance, current.instance)) throw new WidgetAreaMutationErrorV1('widget_instance_changed');
                if (intent.expectedPresentation && !sameStrictJsonValue(intent.expectedPresentation, presentation(layout, intent.instanceId))) throw new WidgetAreaMutationErrorV1('widget_placement_changed');
                instances.splice(at, 1); break;
            case 'move': instances.splice(at, 1); instances.splice(Math.min(intent.toIndex, instances.length), 0, current); break;
            case 'rename': {
                const { displayName: _previous, ...instance } = current.instance;
                instances[at] = { ...current, instance: { ...instance, ...(intent.displayName ? { displayName: intent.displayName } : {}) } }; break;
            }
            case 'inputs': instances[at] = { ...current, instance: { ...current.instance, bindings: intent.bindings } }; break;
            case 'width':
                if (layout.surface.owner.kind === 'project') throw new WidgetAreaMutationErrorV1('widget_width_unsupported');
                instances[at] = { ...current, width: intent.width }; break;
            case 'frame': {
                const { frameStyle: _previous, ...entry } = current;
                instances[at] = { ...entry, ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}) }; break;
            }
        }
    }
    return sameStrictJsonValue(instances, layout.instances) ? layout : { ...layout, instances };
}
export type WidgetSurfaceArtifactPortV1 = Readonly<{
    surface: WidgetSurfaceRefV1;
    read(signal?: AbortSignal): Promise<WidgetAreaLayoutV1>;
    apply(intent: WidgetAreaLayoutIntentV1, signal?: AbortSignal): Promise<WidgetAreaLayoutV1>;
}>;
/** Account mode, encryption and network admission stay with the existing Artifact transport. */
export function createWidgetSurfaceArtifactPortV1(transport: HomeHubArtifactTransportV1, options: Readonly<{
    surface: WidgetSurfaceRefV1; isCurrent(): boolean;
}>): WidgetSurfaceArtifactPortV1 {
    const surface = WidgetAreaSurfaceRefV1Schema.parse(options.surface);
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!options.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired'); };
    const fetch = async (signal?: AbortSignal) => {
        check(signal); const row = await transport.read(artifactId, { signal }); check(signal);
        if (row && (row.artifactId !== artifactId || row.ownerAccountId !== surface.accountId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return row;
    };
    const open = (row: Awaited<ReturnType<typeof fetch>>): WidgetAreaLayoutV1 => {
        if (!row) return { v: 1, surface, instances: [] };
        if (row.header.kind !== WIDGET_SURFACE_ARTIFACT_KIND_V1 || row.header.v !== 1 || typeof row.body !== 'string') throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
        let parsed: ReturnType<typeof WidgetAreaLayoutV1Schema.safeParse>;
        try { parsed = WidgetAreaLayoutV1Schema.safeParse(JSON.parse(row.body)); } catch { throw new WidgetAreaMutationErrorV1('invalid_widget_area_record'); }
        if (!parsed.success || !sameStrictJsonValue(parsed.data.surface, surface)) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
        return parsed.data;
    };
    const header = { kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, v: 1, title: 'Widget area' };
    return { surface, read: async signal => open(await fetch(signal)), async apply(raw, signal) {
        const intent = WidgetAreaLayoutIntentV1Schema.parse(raw);
        for (;;) {
            const row = await fetch(signal);
            const current = open(row);
            const next = applyWidgetAreaLayoutIntentV1(current, intent);
            if (next === current) return current;
            check(signal);
            if (!row) {
                try {
                    // Create is idempotent at the Artifact service and may return an
                    // existing singleton. Initialize only; commit every edit through CAS.
                    await transport.create({ artifactId, header, body: JSON.stringify(current), signal });
                }
                catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'conflict')) throw error; }
                continue;
            }
            const result = await transport.update({ artifactId, expectedRevision: row.revision, header: { ...row.header, ...header }, body: JSON.stringify(next), signal });
            if (result.ok) return next; // Truthful durable acknowledgement even if the mount retired while awaiting it.
            if (result.errorCode !== 'version_mismatch') throw new WidgetAreaMutationErrorV1(result.errorCode);
            check(signal);
        }
    } };
}
/** Both area arms adapt to this writer. No consumer owns layout reduction or CAS. */
export function createWidgetAreaActionPortV1(resolve: (surface: WidgetSurfaceRefV1) => WidgetSurfaceArtifactPortV1 | Promise<WidgetSurfaceArtifactPortV1>): WidgetActionSurfacePortV1 {
    const failure = (error: unknown) => { if (error instanceof WidgetAreaMutationErrorV1) return { ok: false as const, errorCode: error.code, error: error.code }; throw error; };
    const portFor = async (surface: WidgetSurfaceRefV1) => { const port = await resolve(surface); if (!sameStrictJsonValue(port.surface, surface)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch'); return port; };
    const capture = (layout: WidgetAreaLayoutV1, id: string): WidgetMoveCaptureV1 => {
        const expectedPresentation = presentation(layout, id);
        return { expectedInstance: layout.instances[expectedPresentation.nativeIndex]!.instance, expectedPresentation };
    };
    return {
        async read(surface, _context, signal) { try { const layout = await (await portFor(surface)).read(signal); return { surface, canEdit: true, instances: layout.instances }; } catch (error) { return failure(error); } },
        async captureMove(surface, id, _context, signal) { try { return capture(await (await portFor(surface)).read(signal), id); } catch (error) { return failure(error); } },
        async apply(surface, mutation: WidgetSurfaceMutationV1, _context, signal) {
            try {
                if (mutation.kind === 'add' && (mutation.placement || mutation.position?.tabId) || mutation.kind === 'move' && 'tabId' in mutation && mutation.tabId) throw new WidgetAreaMutationErrorV1('widget_placement_unsupported');
                if (mutation.kind === 'width' && mutation.width !== 'half' && mutation.width !== 'full') throw new WidgetAreaMutationErrorV1('widget_width_unsupported');
                let intent: WidgetAreaLayoutIntentV1;
                if (mutation.kind === 'add') intent = { kind: 'add', instance: mutation.instance,
                    ...(mutation.position || mutation.toIndex !== undefined ? { toIndex: mutation.position?.index ?? mutation.toIndex } : {}),
                    ...(mutation.presentation?.width === 'half' || mutation.presentation?.width === 'full' ? { width: mutation.presentation.width } : {}),
                    ...(mutation.presentation?.frameStyle ? { frameStyle: mutation.presentation.frameStyle } : {}) };
                else if (mutation.kind === 'move') intent = { kind: 'move', instanceId: mutation.instanceId, toIndex: 'nativeIndex' in mutation ? mutation.nativeIndex : mutation.toIndex };
                else intent = WidgetAreaLayoutIntentV1Schema.parse(mutation);
                const layout = await (await portFor(surface)).apply(intent, signal);
                const id = intent.kind === 'add' ? intent.instance.id : intent.instanceId;
                return { ok: true, result: { ref: { surface, instanceId: id }, instance: layout.instances.find(entry => entry.instance.id === id)?.instance ?? null,
                    ...(mutation.kind === 'add' && mutation.captureForMove ? { moveCapture: capture(layout, id) } : {}) } };
            } catch (error) { return failure(error); }
        },
    };
}
