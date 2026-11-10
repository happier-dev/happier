import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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
import { PluginDefaultPlacementSchema } from './ui/defaultPlacement.js';
import { PluginUiIconTokenV1Schema } from './ui/tokens.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const ComposerControlStateBindingV1Schema = lazyZodSchema(() => z.strictObject({
  resource: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type ComposerControlStateBindingV1 = z.infer<typeof ComposerControlStateBindingV1Schema>;

export const ComposerControlChoiceEffectV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('action'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
    input: z.optional(PluginJsonValueV2Schema),
  }),
  z.strictObject({
    kind: z.literal('composerApply'),
    operations: z.array(ComposerOperationV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_CHOICES_V1)),
  }),
]));
export type ComposerControlChoiceEffectV1 = z.infer<typeof ComposerControlChoiceEffectV1Schema>;

export const ComposerControlChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  id: ComposerControlChoiceIdV1Schema,
  label: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  icon: z.optional(PluginUiIconTokenV1Schema),
  disabled: z.optional(z.boolean()),
  effect: ComposerControlChoiceEffectV1Schema,
}));
export type ComposerControlChoiceV1 = z.infer<typeof ComposerControlChoiceV1Schema>;

const ComposerControlChoicesInteractionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('choices'),
  selection: z.enum(['single', 'multiple']),
  options: z.array(ComposerControlChoiceV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_CHOICES_V1), z.superRefine((options, context) => {
      const seen = new Set<string>();
      options.forEach((option, index) => {
        if (seen.has(option.id)) {
          context.addIssue({
            code: "custom",
            path: [index, 'id'],
            message: 'Composer control choice ids must be unique.',
          });
        }
        seen.add(option.id);
      });
    })),
}));

export const ComposerControlInteractionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('action'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
  }),
  z.strictObject({
    kind: z.literal('attachmentPicker'),
    attachment: asProtocolZod(PluginContributionLocalIdSchema),
    presentation: z.enum(['popover', 'dialog']),
    layout: z.enum(['content', 'list', 'split']),
  }),
  ComposerControlChoicesInteractionV1Schema,
  z.strictObject({
    kind: z.literal('surface'),
    renderer: PluginUiRendererChainBindingV1Schema,
    presentation: z.enum(['popover', 'dialog']),
    layout: z.enum(['content', 'list', 'split']),
  }),
  z.strictObject({
    kind: z.literal('destination'),
    destination: asProtocolZod(PluginContributionReferenceV2Schema),
  }),
]));
export type ComposerControlInteractionV1 = z.infer<typeof ComposerControlInteractionV1Schema>;

export const ComposerControlOverflowFallbackV1Schema = lazyZodSchema(() => z.strictObject({
  label: PluginLocalizedStringV2Schema,
  icon: PluginUiIconTokenV1Schema,
  accessibilityLabel: z.optional(PluginLocalizedStringV2Schema),
  presentation: z.optional(z.strictObject({
    presentation: z.enum(['popover', 'dialog']),
    layout: z.optional(z.enum(['content', 'list', 'split'])),
  })),
}));
export type ComposerControlOverflowFallbackV1 = z.infer<typeof ComposerControlOverflowFallbackV1Schema>;

/** Static manifest facts for one independent composer control. */
export const PluginComposerControlContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  label: PluginLocalizedStringV2Schema,
  icon: PluginUiIconTokenV1Schema,
  scopes: z.optional(z.array(ComposerScopeKindV1Schema).check(z.minLength(1))),
  order: z.optional(z.number()),
  defaultPlacement: z.optional(PluginDefaultPlacementSchema),
  labelPolicy: z.optional(z.enum(['always', 'auto-hide'])),
  state: z.optional(ComposerControlStateBindingV1Schema),
  interaction: ComposerControlInteractionV1Schema,
  compactRenderer: z.optional(PluginUiRendererChainBindingV1Schema),
  overflow: z.optional(ComposerControlOverflowFallbackV1Schema),
}).check(z.superRefine((control, context) => {
  if (control.compactRenderer !== undefined && control.overflow === undefined) {
    context.addIssue({
      code: "custom",
      path: ['overflow'],
      message: 'Composer controls with compactRenderer require an overflow fallback.',
    });
  }
})));
export type PluginComposerControlContributionV1 = z.infer<
  typeof PluginComposerControlContributionV1Schema
>;
