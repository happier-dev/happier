import { z } from 'zod';

import { MAX_INTERACTION_TRANSIENT_CHOICES_V1 } from '../interactions/transientV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import {
  ComposerControlChoiceIdV1Schema,
  ComposerOperationV1Schema,
  ComposerScopeKindV1Schema,
} from '../ui/composer.js';
import { PluginUiRendererChainBindingV1Schema } from './ui/rendererChainBinding.js';
import { PluginUiIconTokenV1Schema } from './ui/tokens.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const ComposerControlStateBindingV1Schema = z.object({
  resource: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type ComposerControlStateBindingV1 = z.infer<typeof ComposerControlStateBindingV1Schema>;

export const ComposerControlChoiceEffectV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
    input: PluginJsonValueV2Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('composerApply'),
    operations: z.array(ComposerOperationV1Schema).min(1).max(MAX_INTERACTION_TRANSIENT_CHOICES_V1),
  }).strict(),
]);
export type ComposerControlChoiceEffectV1 = z.infer<typeof ComposerControlChoiceEffectV1Schema>;

export const ComposerControlChoiceV1Schema = z.object({
  id: ComposerControlChoiceIdV1Schema,
  label: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
  disabled: z.boolean().optional(),
  effect: ComposerControlChoiceEffectV1Schema,
}).strict();
export type ComposerControlChoiceV1 = z.infer<typeof ComposerControlChoiceV1Schema>;

const ComposerControlChoicesInteractionV1Schema = z.object({
  kind: z.literal('choices'),
  selection: z.enum(['single', 'multiple']),
  options: z.array(ComposerControlChoiceV1Schema)
    .min(1)
    .max(MAX_INTERACTION_TRANSIENT_CHOICES_V1)
    .superRefine((options, context) => {
      const seen = new Set<string>();
      options.forEach((option, index) => {
        if (seen.has(option.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: 'Composer control choice ids must be unique.',
          });
        }
        seen.add(option.id);
      });
    }),
}).strict();

export const ComposerControlInteractionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
  z.object({
    kind: z.literal('attachmentPicker'),
    attachment: asProtocolZod(PluginContributionLocalIdSchema),
    presentation: z.enum(['popover', 'dialog']),
    layout: z.enum(['content', 'list', 'split']),
  }).strict(),
  ComposerControlChoicesInteractionV1Schema,
  z.object({
    kind: z.literal('surface'),
    renderer: PluginUiRendererChainBindingV1Schema,
    presentation: z.enum(['popover', 'dialog']),
    layout: z.enum(['content', 'list', 'split']),
  }).strict(),
  z.object({
    kind: z.literal('destination'),
    destination: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
]);
export type ComposerControlInteractionV1 = z.infer<typeof ComposerControlInteractionV1Schema>;

export const ComposerControlOverflowFallbackV1Schema = z.object({
  label: PluginLocalizedStringV2Schema,
  icon: PluginUiIconTokenV1Schema,
  accessibilityLabel: PluginLocalizedStringV2Schema.optional(),
  presentation: z.object({
    presentation: z.enum(['popover', 'dialog']),
    layout: z.enum(['content', 'list', 'split']).optional(),
  }).strict().optional(),
}).strict();
export type ComposerControlOverflowFallbackV1 = z.infer<typeof ComposerControlOverflowFallbackV1Schema>;

/** Static manifest facts for one independent composer control. */
export const PluginComposerControlContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  label: PluginLocalizedStringV2Schema,
  icon: PluginUiIconTokenV1Schema,
  scopes: z.array(ComposerScopeKindV1Schema).min(1).optional(),
  order: z.number().finite().optional(),
  labelPolicy: z.enum(['always', 'auto-hide']).optional(),
  state: ComposerControlStateBindingV1Schema.optional(),
  interaction: ComposerControlInteractionV1Schema,
  compactRenderer: PluginUiRendererChainBindingV1Schema.optional(),
  overflow: ComposerControlOverflowFallbackV1Schema.optional(),
}).strict().superRefine((control, context) => {
  if (control.compactRenderer !== undefined && control.overflow === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overflow'],
      message: 'Composer controls with compactRenderer require an overflow fallback.',
    });
  }
});
export type PluginComposerControlContributionV1 = z.infer<
  typeof PluginComposerControlContributionV1Schema
>;
