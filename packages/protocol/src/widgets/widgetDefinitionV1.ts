import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { InputHintsSchema, InputPathSchema } from '../inputs/inputFields.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginDeclarativeDocumentV1Schema, readPluginDeclarativeDataSourcesV1, type PluginDeclarativeDocumentV1 } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { preflightPluginDeclarativeDocumentV1 } from '../plugins/contributions/ui/declarativeDocumentPreflightV1.js';
import { WidgetConnectedAccountPurposeBindingV1Schema } from './widgetConnectedAccountPurposeBindingV1.js';
import { BuiltinWidgetIdV1Schema, type BuiltinWidgetIdV1 } from './builtinWidgetDescriptorV1.js';
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { WidgetSizeDeclarationV1Schema } from './widgetPresentationV1.js';
import { WidgetPublicSnapshotPresentationV1Schema } from './widgetPublicSnapshotV1.js';
import { PluginHostedHtmlSourceV1Schema, type PluginHostedHtmlSourceV1 } from '../plugins/contributions/ui/hostedHtmlSourceV1.js';
import { UiSurfaceCapabilityRequestV1Schema, UiSurfaceNetworkRequestV1Schema,
    normalizeUiSurfaceCapabilityRequestV1, type UiSurfaceNetworkRequestV1, type UiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
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
export const WidgetDefinitionAuthorV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.enum(['person', 'agent', 'plugin']) }));
export type WidgetDefinitionAuthorV1 = z.infer<typeof WidgetDefinitionAuthorV1Schema>;
export const WidgetDefinitionProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
    authorAccountId: z.optional(id),
    /** Written when the definition is made; a definition saved before these facts existed has neither. */
    author: z.optional(WidgetDefinitionAuthorV1Schema),
    createdAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    source: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('authored') }),
        z.strictObject({ kind: z.literal('session'), serverId: id, sessionId: id, itemId: id }),
    ]),
}));
export type WidgetDefinitionProvenanceV1 = z.infer<typeof WidgetDefinitionProvenanceV1Schema>;

const document = lazyZodSchema(() => z.pipe(z.unknown().check(z.superRefine((value, context) => {
    const result = preflightPluginDeclarativeDocumentV1(value);
    if (!result.ok) context.addIssue({ code: 'custom', message: result.message });
})), PluginDeclarativeDocumentV1Schema));
export const WidgetInstalledDefinitionBodyV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('installed'), surface: asProtocolZod(PluginContributionIdentityV1Schema) }));
export type WidgetDefinitionBodyV1 = Readonly<
    | { kind: 'declarative'; document: PluginDeclarativeDocumentV1 }
    | { kind: 'installed'; surface: PluginContributionIdentityV1 }
    | { kind: 'builtin'; id: BuiltinWidgetIdV1 }
    | { kind: 'html'; source: PluginHostedHtmlSourceV1; requestedCapabilities?: UiSurfaceCapabilityRequestV1 }
>;
type WidgetDefinitionBodyV1Input = Exclude<WidgetDefinitionBodyV1, { kind: 'declarative' }> | Readonly<{ kind: 'declarative'; document: unknown }>;
export const WidgetDefinitionBodyV1Schema: z.ZodMiniType<WidgetDefinitionBodyV1, WidgetDefinitionBodyV1Input> = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('declarative'), document }),
    WidgetInstalledDefinitionBodyV1Schema,
    z.strictObject({ kind: z.literal('builtin'), id: BuiltinWidgetIdV1Schema }),
    z.strictObject({ kind: z.literal('html'), source: PluginHostedHtmlSourceV1Schema,
        requestedCapabilities: z.optional(UiSurfaceCapabilityRequestV1Schema) }),
]));
const shape = {
    sizeDeclaration: z.lazy(() => WidgetSizeDeclarationV1Schema),
    name: id, description: z.optional(z.string()), body: WidgetDefinitionBodyV1Schema,
    publicPresentation: z.optional(z.lazy(() => WidgetPublicSnapshotPresentationV1Schema)),
    inputs: InputHintsSchema, inputSchema: PluginJsonSchemaV2Schema,
    sessionInputPath: z.optional(InputPathSchema),
    connectedAccountPurposeBindings: z.optional(z.array(WidgetConnectedAccountPurposeBindingV1Schema)),
    /** Copied guest egress, not installed-plugin authority; new instances capture this choice. */
    networkOverride: z.optional(UiSurfaceNetworkRequestV1Schema),
};
export const WidgetDefinitionDraftV1Schema = lazyZodSchema(() => z.strictObject(shape));
export type WidgetDefinitionDraftV1 = z.infer<typeof WidgetDefinitionDraftV1Schema>;
export const WidgetDefinitionPatchV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.partial(z.object({ ...shape,
    description: z.optional(z.nullable(z.string())), sessionInputPath: z.optional(z.nullable(InputPathSchema)),
    connectedAccountPurposeBindings: z.optional(z.nullable(z.array(WidgetConnectedAccountPurposeBindingV1Schema))),
    networkOverride: z.optional(z.nullable(UiSurfaceNetworkRequestV1Schema)),
    publicPresentation: z.optional(z.nullable(WidgetPublicSnapshotPresentationV1Schema)),
}))));
export type WidgetDefinitionPatchV1 = z.infer<typeof WidgetDefinitionPatchV1Schema>;
export const WidgetDefinitionV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), id, ...shape,
    provenance: WidgetDefinitionProvenanceV1Schema,
}).check(z.superRefine((value, context) => {
    if (value.sessionInputPath && !value.inputs.fields.some(field => field.path === value.sessionInputPath)) {
        context.addIssue({ code: 'custom', path: ['sessionInputPath'], message: 'Session input must be declared' });
    }
    const paths = value.inputs.fields.map(field => field.path);
    if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Duplicate input path' });
})));
export type WidgetDefinitionV1 = z.infer<typeof WidgetDefinitionV1Schema>;
export const WidgetDefinitionV1StoredSchema = createStoredReadSchema(WidgetDefinitionV1Schema);

/** Authored references describe consumers; current Resource admission still owns execution. */
export function readWidgetDefinitionResourcesV1(definition: WidgetDefinitionV1): readonly PluginContributionIdentityV1[] {
    const references = new Map<string, PluginContributionIdentityV1>();
    switch (definition.body.kind) {
        case 'installed':
        case 'builtin': return [];
        case 'html':
            for (const resource of definition.body.requestedCapabilities?.resources ?? []) {
                references.set(`${resource.pluginId}/${resource.localId}`, resource);
            }
            break;
        case 'declarative':
            for (const source of readPluginDeclarativeDataSourcesV1(definition.body.document)) {
                if (source.kind === 'resource') {
                    const resource = source.resource;
                    references.set(`${resource.pluginId}/${resource.localId}`, resource);
                }
            }
            break;
    }
    return [...references.values()];
}

/** Anonymous viewers have neither a native/installed live runtime nor an authenticated Resource bridge. */
export function isWidgetDefinitionPubliclyRenderableV1(definition: WidgetDefinitionV1): definition is WidgetDefinitionV1 & {
    body: Exclude<WidgetDefinitionBodyV1, { kind: 'installed' | 'builtin' }>;
} {
    return definition.body.kind !== 'installed' && definition.body.kind !== 'builtin' && readWidgetDefinitionResourcesV1(definition).length === 0;
}

/** Capture the library copy's egress at placement, independently of later definition revisions. */
export function readWidgetDefinitionNetworkOverrideV1(definition: Pick<WidgetDefinitionV1, 'body' | 'networkOverride'>): UiSurfaceNetworkRequestV1 | undefined {
    if (definition.networkOverride !== undefined) return definition.networkOverride;
    if (definition.body.kind !== 'html') return undefined;
    const policy = normalizeUiSurfaceCapabilityRequestV1(definition.body.requestedCapabilities);
    return policy?.network === 'origins' ? { networkOrigins: [...policy.networkOrigins] }
        : { network: policy?.network === 'open' ? 'open' : 'none' };
}

/** Patch explicit clears, keeping concurrent edits to other fields on the CAS winner. */
export function applyWidgetDefinitionPatchV1(current: WidgetDefinitionV1, raw: WidgetDefinitionPatchV1): WidgetDefinitionV1 {
    const patch = WidgetDefinitionPatchV1Schema.parse(raw);
    const next = { ...current, ...patch };
    for (const key of ['description', 'sessionInputPath', 'connectedAccountPurposeBindings', 'networkOverride', 'publicPresentation'] as const) {
        if (next[key] === null) delete next[key];
    }
    return WidgetDefinitionV1Schema.parse(next);
}
