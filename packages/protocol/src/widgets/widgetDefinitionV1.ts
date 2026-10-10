import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { InputHintsSchema, InputPathSchema } from '../inputs/inputFields.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginDeclarativeDocumentV1Schema, readPluginDeclarativeDataSourcesV1 } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { preflightPluginDeclarativeDocumentV1 } from '../plugins/contributions/ui/declarativeDocumentPreflightV1.js';
import { WidgetConnectedAccountPurposeBindingV1Schema } from './widgetConnectedAccountPurposeBindingV1.js';
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { WidgetSizeDeclarationV1Schema } from './widgetPresentationV1.js';

const id = z.string().trim().min(1);
/** Explicit publication inherits resolved widget bindings, never a private static Resource expectation. */
export function projectWidgetDefinitionForSharedPublicationV1(definition: WidgetDefinitionV1): WidgetDefinitionV1 {
    const copy = WidgetDefinitionV1Schema.parse(JSON.parse(JSON.stringify(definition)));
    if (copy.body.kind === 'declarative') {
        for (const source of readPluginDeclarativeDataSourcesV1(copy.body.document)) {
            if (source.kind === 'resource') delete source.input;
        }
    }
    return WidgetDefinitionV1Schema.parse(copy);
}
/** Who made a definition: the person, their agent, or a trusted plugin acting for the Account. */
export const WidgetDefinitionAuthorV1Schema = lazyZodSchema(() => z.object({ kind: z.enum(['person', 'agent', 'plugin']) }).strict());
export type WidgetDefinitionAuthorV1 = z.infer<typeof WidgetDefinitionAuthorV1Schema>;
export const WidgetDefinitionProvenanceV1Schema = lazyZodSchema(() => z.object({
    authorAccountId: id.optional(),
    /** Written when the definition is made; a definition saved before these facts existed has neither. */
    author: WidgetDefinitionAuthorV1Schema.optional(),
    createdAt: z.number().int().nonnegative().optional(),
    source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('authored') }).strict(),
        z.object({ kind: z.literal('session'), serverId: id, sessionId: id, itemId: id }).strict(),
    ]),
}).strict());
export type WidgetDefinitionProvenanceV1 = z.infer<typeof WidgetDefinitionProvenanceV1Schema>;

const document = z.unknown().superRefine((value, context) => {
    const result = preflightPluginDeclarativeDocumentV1(value);
    if (!result.ok) context.addIssue({ code: 'custom', message: result.message });
}).pipe(PluginDeclarativeDocumentV1Schema);
export const WidgetDefinitionBodyV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('declarative'), document }).strict(),
    z.object({ kind: z.literal('installed'), surface: asProtocolZod(PluginContributionIdentityV1Schema) }).strict(),
]));
export type WidgetDefinitionBodyV1 = z.infer<typeof WidgetDefinitionBodyV1Schema>;
const shape = {
    sizeDeclaration: z.lazy(() => WidgetSizeDeclarationV1Schema),
    name: id, description: z.string().optional(), body: WidgetDefinitionBodyV1Schema,
    inputs: InputHintsSchema, inputSchema: PluginJsonSchemaV2Schema,
    sessionInputPath: InputPathSchema.optional(),
    connectedAccountPurposeBindings: z.array(WidgetConnectedAccountPurposeBindingV1Schema).optional(),
};
export const WidgetDefinitionDraftV1Schema = lazyZodSchema(() => z.object(shape).strict());
export type WidgetDefinitionDraftV1 = z.infer<typeof WidgetDefinitionDraftV1Schema>;
export const WidgetDefinitionPatchV1Schema = lazyZodSchema(() => z.object({ ...shape,
    description: z.string().nullable().optional(), sessionInputPath: InputPathSchema.nullable().optional(),
    connectedAccountPurposeBindings: z.array(WidgetConnectedAccountPurposeBindingV1Schema).nullable().optional(),
}).partial().strict());
export type WidgetDefinitionPatchV1 = z.infer<typeof WidgetDefinitionPatchV1Schema>;
export const WidgetDefinitionV1Schema = lazyZodSchema(() => z.object({ v: z.literal(1), id, ...shape,
    provenance: WidgetDefinitionProvenanceV1Schema,
}).strict().superRefine((value, context) => {
    if (value.sessionInputPath && !value.inputs.fields.some(field => field.path === value.sessionInputPath)) {
        context.addIssue({ code: 'custom', path: ['sessionInputPath'], message: 'Session input must be declared' });
    }
    const paths = value.inputs.fields.map(field => field.path);
    if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Duplicate input path' });
}));
export type WidgetDefinitionV1 = z.infer<typeof WidgetDefinitionV1Schema>;
export const WidgetDefinitionV1StoredSchema = createStoredReadSchema(WidgetDefinitionV1Schema);

/** Authored references describe consumers; current Resource admission still owns execution. */
export function readWidgetDefinitionResourcesV1(definition: WidgetDefinitionV1): readonly PluginContributionIdentityV1[] {
    if (definition.body.kind !== 'declarative') return [];
    const references = new Map<string, PluginContributionIdentityV1>();
    for (const source of readPluginDeclarativeDataSourcesV1(definition.body.document)) {
        if (source.kind === 'resource') {
            const resource = source.resource;
            references.set(`${resource.pluginId}/${resource.localId}`, resource);
        }
    }
    return [...references.values()];
}

/** Patch explicit clears, keeping concurrent edits to other fields on the CAS winner. */
export function applyWidgetDefinitionPatchV1(current: WidgetDefinitionV1, raw: WidgetDefinitionPatchV1): WidgetDefinitionV1 {
    const patch = WidgetDefinitionPatchV1Schema.parse(raw);
    const next = { ...current, ...patch };
    for (const key of ['description', 'sessionInputPath', 'connectedAccountPurposeBindings'] as const) {
        if (next[key] === null) delete next[key];
    }
    return WidgetDefinitionV1Schema.parse(next);
}
