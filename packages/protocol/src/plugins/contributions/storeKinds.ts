import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionLocalIdSchema, parseQualifiedPluginContributionKey, buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '../contributionIdentity.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import type { PluginUiViewV2 } from './ui/v2.js';

/** Store discovery binds an ordinary admitted app view and ordinary Actions. */
export const PluginStoreKindContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    title: PluginLocalizedStringV2Schema,
    description: z.optional(PluginLocalizedStringV2Schema),
    viewId: asProtocolZod(PluginContributionLocalIdSchema),
    operations: z.strictObject({
        list: asProtocolZod(PluginContributionLocalIdSchema),
        read: asProtocolZod(PluginContributionLocalIdSchema),
        installed: asProtocolZod(PluginContributionLocalIdSchema),
        prepare: asProtocolZod(PluginContributionLocalIdSchema),
        acquire: asProtocolZod(PluginContributionLocalIdSchema),
        manage: asProtocolZod(PluginContributionLocalIdSchema),
    }),
}));
export type PluginStoreKindContributionV1 = z.infer<typeof PluginStoreKindContributionV1Schema>;

/** Portable listing identity; plugin-specific payload schemas remain Action-owned. */
export const PluginStoreItemReferenceV1Schema = lazyZodSchema(() => z.strictObject({
    type: z.literal('storeKind'),
    kind: z.string().check(z.refine(value => parseQualifiedPluginContributionKey(value) !== null,
        'Store kinds require a qualified contribution identity.')),
    sourceId: z.string().check(z.minLength(1)),
    itemId: z.string(),
    version: z.optional(z.string().check(z.minLength(1))),
}));
export type PluginStoreItemReferenceV1 = z.infer<typeof PluginStoreItemReferenceV1Schema>;
export const PluginStoreItemReferenceV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(PluginStoreItemReferenceV1Schema));

export const PluginStoreItemV1Schema = lazyZodSchema(() => z.strictObject({
    sourceId: z.string().check(z.minLength(1)),
    itemId: z.string(),
    title: PluginLocalizedStringV2Schema,
    description: z.optional(PluginLocalizedStringV2Schema),
    version: z.optional(z.string().check(z.minLength(1))),
    installed: z.optional(z.boolean()),
    value: z.optional(PluginJsonValueV2Schema),
}));
export type PluginStoreItemV1 = z.infer<typeof PluginStoreItemV1Schema>;
export const PluginStoreItemV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(PluginStoreItemV1Schema));

/** Reference existence is catalog-owned; this family owns its app placement. */
export function validatePluginStoreKindContributionsV1(
    value: Readonly<{ storeKinds: readonly PluginStoreKindContributionV1[]; ui: Readonly<{ views: readonly PluginUiViewV2[] }> }>,
    context: z.core.$RefinementCtx,
): void {
    value.storeKinds.forEach((kind, index) => {
        const view = value.ui.views.find(candidate => candidate.id === kind.viewId);
        if (view && (view.container !== 'appPage' || view.target.kind !== 'app')) {
            context.addIssue({ code: 'custom', path: ['storeKinds', index, 'viewId'],
                message: 'Store kinds require a same-plugin app page view.' });
        }
    });
}

/** Cold Account declarations and daemon discovery share this qualified descriptor. */
export function projectPluginStoreKindDeclarationV1(input: Readonly<{
    pluginId: string;
    pluginVersion: string;
    definition: PluginStoreKindContributionV1;
}>): import('../../daemon/contributionRegistryProjection.js').PluginProjectedStoreKindEntryV1 {
    return { ...input, id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
        pluginId: input.pluginId, localId: input.definition.id,
    })) };
}
